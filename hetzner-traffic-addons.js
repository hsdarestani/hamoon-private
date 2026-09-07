'use strict';

require('dotenv').config();
const mysql = require('mysql2/promise');

const DECIMAL_TB_BYTES = 1_000_000_000_000;
const ALLOWED_PACKAGE_TB = new Set([5, 10, 20]);

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'hamooncloud_db',
  waitForConnections: true,
  connectionLimit: 4,
  queueLimit: 0
});

let schemaPromise = null;

function mysqlDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error('INVALID_TRAFFIC_PERIOD');
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function getCustomerTrafficPrice(pricePerTb) {
  const providerPricePerTb = Math.max(0, Number(pricePerTb || 0));
  const fx = Math.max(0, Number(process.env.HETZNER_TRAFFIC_EUR_TO_TOMAN || process.env.HETZNER_EUR_TO_TOMAN || process.env.EUR_TO_TOMAN || 70000));
  const multiplier = Math.max(0, Number(process.env.HETZNER_TRAFFIC_PRICE_MULTIPLIER || process.env.HETZNER_PRICE_MULTIPLIER || 1));
  return {
    providerPricePerTb,
    fx,
    multiplier,
    customerPricePerTbToman: providerPricePerTb * fx * multiplier
  };
}

function quoteTrafficAddon(pricePerTb, packageTb) {
  const tb = Number(packageTb);
  if (!ALLOWED_PACKAGE_TB.has(tb)) return { ok: false, reason: 'invalid_package' };
  const pricing = getCustomerTrafficPrice(pricePerTb);
  if (!(pricing.providerPricePerTb > 0) || !(pricing.customerPricePerTbToman > 0)) {
    return { ok: false, reason: 'pricing_unavailable' };
  }
  return {
    ok: true,
    packageTb: tb,
    extraBytes: Math.round(tb * DECIMAL_TB_BYTES),
    amountToman: Math.max(1, Math.round(tb * pricing.customerPricePerTbToman)),
    ...pricing
  };
}

async function ensureAddonSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    const conn = await pool.getConnection();
    try {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS hetzner_traffic_addons (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          event_key VARCHAR(191) NOT NULL,
          telegram_id VARCHAR(255) NOT NULL,
          server_id VARCHAR(255) NOT NULL,
          datacenter VARCHAR(64) NOT NULL,
          period_start DATETIME NOT NULL,
          extra_bytes BIGINT UNSIGNED NOT NULL,
          amount_toman DECIMAL(18,2) NOT NULL,
          provider_price_per_tb DECIMAL(18,8) NOT NULL,
          fx_toman_per_eur DECIMAL(18,4) NOT NULL,
          price_multiplier DECIMAL(18,6) NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_hetzner_traffic_addon_event (event_key),
          INDEX idx_hetzner_traffic_addon_server_period (server_id, period_start),
          INDEX idx_hetzner_traffic_addon_user_period (telegram_id, period_start)
        )
      `);
    } finally {
      conn.release();
    }
  })().catch(error => {
    schemaPromise = null;
    throw error;
  });
  return schemaPromise;
}

async function getTrafficAddonSummary({ telegramId, serverId, datacenter, periodStart, connection = null }) {
  await ensureAddonSchema();
  const conn = connection || await pool.getConnection();
  try {
    const [rows] = await conn.execute(
      `SELECT COALESCE(SUM(extra_bytes), 0) AS extra_bytes,
              COALESCE(SUM(amount_toman), 0) AS amount_toman,
              COUNT(*) AS purchase_count
       FROM hetzner_traffic_addons
       WHERE telegram_id = ? AND server_id = ? AND datacenter = ? AND period_start = ?`,
      [String(telegramId), String(serverId), String(datacenter), mysqlDate(periodStart)]
    );
    return {
      extraBytes: Math.max(0, Number(rows[0]?.extra_bytes || 0)),
      amountToman: Math.max(0, Number(rows[0]?.amount_toman || 0)),
      purchaseCount: Math.max(0, Number(rows[0]?.purchase_count || 0))
    };
  } finally {
    if (!connection) conn.release();
  }
}

async function purchaseTrafficAddonAtomic({
  telegramId,
  serverId,
  datacenter,
  serverName,
  periodStart,
  includedBytes,
  pricePerTb,
  packageTb,
  nonce
}) {
  await ensureAddonSchema();
  const quote = quoteTrafficAddon(pricePerTb, packageTb);
  if (!quote.ok) return { status: quote.reason, charged: 0 };
  if (!nonce || String(nonce).length < 8) return { status: 'invalid_nonce', charged: 0 };

  const period = mysqlDate(periodStart);
  const eventKey = `hetzner-addon:${String(serverId)}:${period}:${String(nonce)}`;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [existing] = await conn.execute(
      'SELECT id, amount_toman, extra_bytes FROM hetzner_traffic_addons WHERE event_key = ? LIMIT 1',
      [eventKey]
    );
    if (existing.length) {
      await conn.commit();
      return {
        status: 'already_purchased',
        charged: 0,
        packageTb: Number(existing[0].extra_bytes || 0) / DECIMAL_TB_BYTES,
        priorAmountToman: Number(existing[0].amount_toman || 0)
      };
    }

    // Serialize package purchases with the automatic overage settlement for the
    // same server/month. The billing table is created by billing-settlement.
    await conn.execute(
      `INSERT INTO hetzner_traffic_billing
       (server_id, period_start, telegram_id, datacenter, billed_overage_bytes, billed_amount_toman,
        last_outgoing_bytes, included_traffic_bytes, price_per_tb)
       VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?)
       ON DUPLICATE KEY UPDATE telegram_id = VALUES(telegram_id), datacenter = VALUES(datacenter)`,
      [String(serverId), period, String(telegramId), String(datacenter), Math.max(0, Math.floor(Number(includedBytes || 0))), quote.providerPricePerTb]
    );
    await conn.execute(
      'SELECT server_id FROM hetzner_traffic_billing WHERE server_id = ? AND period_start = ? FOR UPDATE',
      [String(serverId), period]
    );

    const [userRows] = await conn.execute(
      'SELECT wallet FROM users WHERE telegram_id = ? LIMIT 1 FOR UPDATE',
      [String(telegramId)]
    );
    if (!userRows.length) {
      await conn.rollback();
      return { status: 'user_missing', charged: 0 };
    }
    const balance = Number(userRows[0].wallet || 0);
    if (balance < quote.amountToman) {
      await conn.commit();
      return {
        status: 'insufficient', charged: 0,
        required: quote.amountToman,
        balance,
        missing: Math.max(0, quote.amountToman - balance)
      };
    }

    await conn.execute(
      'UPDATE users SET wallet = wallet - ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?',
      [quote.amountToman, String(telegramId)]
    );

    await conn.execute(
      `INSERT INTO hetzner_traffic_addons
       (event_key, telegram_id, server_id, datacenter, period_start, extra_bytes, amount_toman,
        provider_price_per_tb, fx_toman_per_eur, price_multiplier)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        eventKey, String(telegramId), String(serverId), String(datacenter), period,
        quote.extraBytes, quote.amountToman, quote.providerPricePerTb, quote.fx, quote.multiplier
      ]
    );

    await conn.execute(
      'INSERT INTO wallet_logs (telegram_id, amount, description, type) VALUES (?, ?, ?, ?)',
      [
        String(telegramId),
        -quote.amountToman,
        `خرید ${quote.packageTb} TB ترافیک اضافه Hetzner برای سرور ${serverName || serverId} تا ریست ماهانه؛ نرخ پایه ${quote.providerPricePerTb} EUR/TB`,
        'hetzner_traffic_addon'
      ]
    );

    await conn.commit();
    return {
      status: 'purchased',
      charged: quote.amountToman,
      newWallet: balance - quote.amountToman,
      packageTb: quote.packageTb,
      extraBytes: quote.extraBytes,
      eventKey
    };
  } catch (error) {
    await conn.rollback().catch(() => {});
    if (error?.code === 'ER_DUP_ENTRY') return { status: 'already_purchased', charged: 0 };
    throw error;
  } finally {
    conn.release();
  }
}

module.exports = {
  DECIMAL_TB_BYTES,
  ALLOWED_PACKAGE_TB,
  ensureAddonSchema,
  getCustomerTrafficPrice,
  quoteTrafficAddon,
  getTrafficAddonSummary,
  purchaseTrafficAddonAtomic
};
