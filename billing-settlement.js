'use strict';

require('dotenv').config();
const mysql = require('mysql2/promise');

const HOURS_IN_CYCLE = Object.freeze({ hourly: 1, daily: 24, weekly: 168, monthly: 720 });
const HETZNER_TRAFFIC_BLOCK_BYTES = 100_000_000; // Hetzner bills overage in 100 MB blocks.
const DECIMAL_TB_BYTES = 1_000_000_000_000;

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'hamooncloud_db',
  waitForConnections: true,
  connectionLimit: 6,
  queueLimit: 0
});

let schemaReadyPromise = null;

function mysqlDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error('INVALID_BILLING_DATE');
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function isoKeyDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error('INVALID_BILLING_DATE');
  return d.toISOString();
}

async function ensureBillingSettlementSchema() {
  if (schemaReadyPromise) return schemaReadyPromise;
  schemaReadyPromise = (async () => {
    const conn = await pool.getConnection();
    try {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS billing_events (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          event_key VARCHAR(191) NOT NULL,
          telegram_id VARCHAR(255) NOT NULL,
          server_id VARCHAR(255) NOT NULL,
          datacenter VARCHAR(64) NOT NULL,
          event_type VARCHAR(64) NOT NULL,
          amount_toman DECIMAL(18,2) NOT NULL DEFAULT 0,
          period_start DATETIME NULL,
          period_end DATETIME NULL,
          metadata JSON NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_billing_event_key (event_key),
          INDEX idx_billing_events_user_time (telegram_id, created_at),
          INDEX idx_billing_events_server_time (server_id, created_at)
        )
      `);

      await conn.execute(`
        CREATE TABLE IF NOT EXISTS hetzner_traffic_billing (
          server_id VARCHAR(255) NOT NULL,
          period_start DATETIME NOT NULL,
          telegram_id VARCHAR(255) NOT NULL,
          datacenter VARCHAR(64) NOT NULL,
          billed_overage_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
          billed_amount_toman DECIMAL(18,2) NOT NULL DEFAULT 0,
          last_outgoing_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
          included_traffic_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
          price_per_tb DECIMAL(18,8) NOT NULL DEFAULT 0,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (server_id, period_start),
          INDEX idx_hetzner_traffic_user_period (telegram_id, period_start)
        )
      `);
    } finally {
      conn.release();
    }
  })().catch(error => {
    schemaReadyPromise = null;
    throw error;
  });
  return schemaReadyPromise;
}

async function settleServerRenewalAtomic({
  telegramId,
  serverId,
  datacenter,
  serverName,
  renewalAmount,
  trafficCost = 0,
  billableTrafficGb = null,
  now = new Date()
}) {
  await ensureBillingSettlementSchema();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [purchaseRows] = await conn.execute(
      `SELECT telegram_id, server_id, datacenter, server_name, amount, duration, status,
              auto_renew, last_billed_at, created_at, last_billed_traffic_gb
       FROM purchases
       WHERE telegram_id = ? AND server_id = ? AND datacenter = ?
       LIMIT 1 FOR UPDATE`,
      [String(telegramId), String(serverId), String(datacenter)]
    );
    if (!purchaseRows.length) {
      await conn.rollback();
      return { status: 'purchase_missing', charged: 0 };
    }

    const purchase = purchaseRows[0];
    const cycle = String(purchase.duration || '');
    const cycleHours = HOURS_IN_CYCLE[cycle] || 0;
    if (!cycleHours) {
      await conn.rollback();
      return { status: 'invalid_cycle', charged: 0 };
    }

    const base = new Date(purchase.last_billed_at || purchase.created_at || now);
    const nowDate = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(base.getTime()) || Number.isNaN(nowDate.getTime())) {
      await conn.rollback();
      return { status: 'invalid_date', charged: 0 };
    }

    const dueAt = new Date(base.getTime() + cycleHours * 3600000);
    if (nowDate < dueAt) {
      await conn.commit();
      return { status: 'not_due', charged: 0, dueAt };
    }

    if (Number(purchase.auto_renew ?? 1) !== 1) {
      await conn.commit();
      return { status: 'auto_renew_disabled', charged: 0, dueAt };
    }

    const renewal = Math.max(0, Math.round(Number(renewalAmount || 0)));
    const traffic = Math.max(0, Math.round(Number(trafficCost || 0)));
    const total = renewal + traffic;
    if (!(renewal > 0) || !(total > 0)) {
      await conn.rollback();
      return { status: 'invalid_amount', charged: 0 };
    }

    const eventKey = `renewal:${String(serverId)}:${isoKeyDate(base)}:${cycle}`;
    const [existingEvents] = await conn.execute(
      'SELECT id FROM billing_events WHERE event_key = ? LIMIT 1',
      [eventKey]
    );
    if (existingEvents.length) {
      await conn.commit();
      return { status: 'already_settled', charged: 0, eventKey };
    }

    const [userRows] = await conn.execute(
      'SELECT wallet FROM users WHERE telegram_id = ? LIMIT 1 FOR UPDATE',
      [String(telegramId)]
    );
    if (!userRows.length) {
      await conn.rollback();
      return { status: 'user_missing', charged: 0 };
    }

    const balance = Number(userRows[0].wallet || 0);
    if (balance < total) {
      await conn.commit();
      return { status: 'insufficient', charged: 0, required: total, balance, missing: Math.max(0, total - balance) };
    }

    await conn.execute(
      'UPDATE users SET wallet = wallet - ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?',
      [total, String(telegramId)]
    );

    const parts = [`تمدید اتمیک سرور ${serverName || purchase.server_name || serverId}`];
    if (renewal > 0) parts.push(`هزینه دوره=${renewal}`);
    if (traffic > 0) parts.push(`ترافیک=${traffic}`);
    await conn.execute(
      'INSERT INTO wallet_logs (telegram_id, amount, description, type) VALUES (?, ?, ?, ?)',
      [String(telegramId), -total, parts.join('؛ '), 'billing']
    );

    const trafficGb = billableTrafficGb == null ? Number(purchase.last_billed_traffic_gb || 0) : Number(billableTrafficGb || 0);
    await conn.execute(
      `UPDATE purchases
       SET status = 'active',
           last_billed_at = ?,
           last_billed_traffic_gb = ?,
           suspend_reason = NULL,
           renewal_stopped_at = NULL,
           lifecycle_updated_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE telegram_id = ? AND server_id = ? AND datacenter = ?`,
      [mysqlDate(nowDate), trafficGb, String(telegramId), String(serverId), String(datacenter)]
    );

    await conn.execute(
      `INSERT INTO billing_events
       (event_key, telegram_id, server_id, datacenter, event_type, amount_toman, period_start, period_end, metadata)
       VALUES (?, ?, ?, ?, 'renewal', ?, ?, ?, ?)`,
      [
        eventKey,
        String(telegramId),
        String(serverId),
        String(datacenter),
        total,
        mysqlDate(base),
        mysqlDate(nowDate),
        JSON.stringify({ cycle, renewalAmount: renewal, trafficCost: traffic })
      ]
    );

    await conn.commit();
    return { status: 'charged', charged: total, renewalCharged: renewal, trafficCharged: traffic, newWallet: balance - total, eventKey };
  } catch (error) {
    await conn.rollback().catch(() => {});
    if (error?.code === 'ER_DUP_ENTRY') return { status: 'already_settled', charged: 0 };
    throw error;
  } finally {
    conn.release();
  }
}

async function settleHetznerTrafficOverage({
  telegramId,
  serverId,
  datacenter,
  serverName,
  periodStart,
  outgoingBytes,
  includedBytes,
  pricePerTb,
  currency = 'EUR'
}) {
  await ensureBillingSettlementSchema();
  const outgoing = Math.max(0, Math.floor(Number(outgoingBytes || 0)));
  const included = Math.max(0, Math.floor(Number(includedBytes || 0)));
  const providerPricePerTb = Math.max(0, Number(pricePerTb || 0));
  if (!(providerPricePerTb > 0)) return { status: 'pricing_unavailable', charged: 0 };

  const overage = Math.max(0, outgoing - included);
  if (!(overage > 0)) return { status: 'within_allowance', charged: 0, overageBytes: 0 };

  const roundedOverage = Math.ceil(overage / HETZNER_TRAFFIC_BLOCK_BYTES) * HETZNER_TRAFFIC_BLOCK_BYTES;
  const period = mysqlDate(periodStart);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.execute(
      `INSERT INTO hetzner_traffic_billing
       (server_id, period_start, telegram_id, datacenter, billed_overage_bytes, billed_amount_toman, last_outgoing_bytes, included_traffic_bytes, price_per_tb)
       VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?)
       ON DUPLICATE KEY UPDATE telegram_id = VALUES(telegram_id), datacenter = VALUES(datacenter)`,
      [String(serverId), period, String(telegramId), String(datacenter), included, providerPricePerTb]
    );

    const [rows] = await conn.execute(
      `SELECT billed_overage_bytes, billed_amount_toman
       FROM hetzner_traffic_billing
       WHERE server_id = ? AND period_start = ?
       LIMIT 1 FOR UPDATE`,
      [String(serverId), period]
    );
    const billedBytes = Math.max(0, Number(rows[0]?.billed_overage_bytes || 0));
    const deltaBytes = Math.max(0, roundedOverage - billedBytes);
    if (!(deltaBytes > 0)) {
      await conn.execute(
        `UPDATE hetzner_traffic_billing
         SET last_outgoing_bytes = ?, included_traffic_bytes = ?, price_per_tb = ?, updated_at = CURRENT_TIMESTAMP
         WHERE server_id = ? AND period_start = ?`,
        [outgoing, included, providerPricePerTb, String(serverId), period]
      );
      await conn.commit();
      return { status: 'already_billed', charged: 0, overageBytes: roundedOverage, billedBytes };
    }

    const fx = Number(process.env.HETZNER_EUR_TO_TOMAN || process.env.EUR_TO_TOMAN || 70000);
    const multiplier = Number(process.env.HETZNER_TRAFFIC_PRICE_MULTIPLIER || process.env.HETZNER_PRICE_MULTIPLIER || 1);
    const rawToman = (deltaBytes / DECIMAL_TB_BYTES) * providerPricePerTb * fx * multiplier;
    const amount = Math.max(1, Math.round(rawToman));

    const [userRows] = await conn.execute(
      'SELECT wallet FROM users WHERE telegram_id = ? LIMIT 1 FOR UPDATE',
      [String(telegramId)]
    );
    if (!userRows.length) {
      await conn.rollback();
      return { status: 'user_missing', charged: 0 };
    }
    const balance = Number(userRows[0].wallet || 0);
    if (balance < amount) {
      await conn.commit();
      return { status: 'insufficient', charged: 0, required: amount, balance, missing: Math.max(0, amount - balance), deltaBytes };
    }

    await conn.execute(
      'UPDATE users SET wallet = wallet - ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?',
      [amount, String(telegramId)]
    );
    await conn.execute(
      'INSERT INTO wallet_logs (telegram_id, amount, description, type) VALUES (?, ?, ?, ?)',
      [
        String(telegramId),
        -amount,
        `هزینه ترافیک مازاد Hetzner سرور ${serverName || serverId}؛ ${(deltaBytes / DECIMAL_TB_BYTES).toFixed(4)} TB؛ نرخ ${providerPricePerTb} ${currency}/TB`,
        'hetzner_traffic_overage'
      ]
    );
    await conn.execute(
      `UPDATE hetzner_traffic_billing
       SET billed_overage_bytes = ?,
           billed_amount_toman = billed_amount_toman + ?,
           last_outgoing_bytes = ?,
           included_traffic_bytes = ?,
           price_per_tb = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE server_id = ? AND period_start = ?`,
      [roundedOverage, amount, outgoing, included, providerPricePerTb, String(serverId), period]
    );

    const eventKey = `hetzner-traffic:${String(serverId)}:${period}:${roundedOverage}`;
    await conn.execute(
      `INSERT INTO billing_events
       (event_key, telegram_id, server_id, datacenter, event_type, amount_toman, period_start, period_end, metadata)
       VALUES (?, ?, ?, ?, 'hetzner_traffic_overage', ?, ?, NOW(), ?)`,
      [
        eventKey,
        String(telegramId),
        String(serverId),
        String(datacenter),
        amount,
        period,
        JSON.stringify({ outgoingBytes: outgoing, includedBytes: included, billedOverageBytes: roundedOverage, deltaBytes, pricePerTb: providerPricePerTb, currency, fx, multiplier })
      ]
    );

    await conn.commit();
    return { status: 'charged', charged: amount, newWallet: balance - amount, deltaBytes, overageBytes: roundedOverage, pricePerTb: providerPricePerTb };
  } catch (error) {
    await conn.rollback().catch(() => {});
    if (error?.code === 'ER_DUP_ENTRY') return { status: 'already_billed', charged: 0 };
    throw error;
  } finally {
    conn.release();
  }
}

module.exports = {
  HOURS_IN_CYCLE,
  HETZNER_TRAFFIC_BLOCK_BYTES,
  DECIMAL_TB_BYTES,
  ensureBillingSettlementSchema,
  settleServerRenewalAtomic,
  settleHetznerTrafficOverage
};
