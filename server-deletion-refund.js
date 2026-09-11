'use strict';

const { ensureBillingSettlementSchema } = require('./billing-settlement');

const HOURS_IN_CYCLE = Object.freeze({ hourly: 1, daily: 24, weekly: 168, monthly: 720 });
const INITIAL_API_PAID_LOG_TYPE = 'server_api_purchase';

function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function calculateUnusedCycleRefund({ amount, cycle, lastBilledAt, createdAt, now = new Date() }) {
  const cycleHours = HOURS_IN_CYCLE[String(cycle || '').toLowerCase()] || 0;
  const paidAmount = Math.max(0, Number(amount || 0));
  const start = toDate(lastBilledAt) || toDate(createdAt);
  const current = toDate(now);
  if (!cycleHours || !(paidAmount > 0) || !start || !current) {
    return { refundToman: 0, remainingMs: 0, cycleMs: cycleHours * 3600000, periodStart: start };
  }

  const cycleMs = cycleHours * 3600000;
  const elapsedMs = Math.max(0, current.getTime() - start.getTime());
  const remainingMs = Math.max(0, cycleMs - Math.min(cycleMs, elapsedMs));
  const refundToman = Math.max(0, Math.floor((paidAmount * remainingMs) / cycleMs));
  return { refundToman, remainingMs, cycleMs, periodStart: start };
}

function isInitialApiCycle(purchase) {
  if (String(purchase?.boot_method || '').toLowerCase() !== 'api') return false;
  const created = toDate(purchase?.created_at);
  const billed = toDate(purchase?.last_billed_at);
  if (!created || !billed) return true;
  return Math.abs(billed.getTime() - created.getTime()) < 5 * 60 * 1000;
}

async function refundUnusedServerCycle({ db, telegramId, serverId, datacenter, now = new Date() }) {
  if (!db?.pool) throw new Error('DB_POOL_UNAVAILABLE');
  await ensureBillingSettlementSchema();

  const conn = await db.pool.getConnection();
  try {
    await conn.beginTransaction();
    const [purchaseRows] = await conn.execute(
      `SELECT telegram_id, server_id, datacenter, server_name, amount, duration, boot_method,
              status, created_at, last_billed_at
       FROM purchases
       WHERE telegram_id = ? AND server_id = ? AND datacenter = ?
       LIMIT 1 FOR UPDATE`,
      [String(telegramId), String(serverId), String(datacenter)]
    );
    if (!purchaseRows.length) {
      await conn.commit();
      return { status: 'purchase_missing', refunded: 0 };
    }

    const purchase = purchaseRows[0];
    const calc = calculateUnusedCycleRefund({
      amount: purchase.amount,
      cycle: purchase.duration,
      lastBilledAt: purchase.last_billed_at,
      createdAt: purchase.created_at,
      now
    });
    const periodStart = calc.periodStart;
    if (!periodStart || !(calc.refundToman > 0)) {
      await conn.commit();
      return { status: 'nothing_to_refund', refunded: 0, remainingMs: calc.remainingMs };
    }

    // Historically API provisioning created the server without charging the first
    // cycle. Do not generate free credit for those legacy unpaid initial cycles.
    // New API purchases create a negative server_api_purchase log containing the
    // server id before they become eligible for this refund.
    if (isInitialApiCycle(purchase)) {
      const [paidLogs] = await conn.execute(
        `SELECT id FROM wallet_logs
         WHERE telegram_id = ? AND type = ? AND amount < 0 AND description LIKE ?
         ORDER BY id DESC LIMIT 1`,
        [String(telegramId), INITIAL_API_PAID_LOG_TYPE, `%${String(serverId)}%`]
      );
      if (!paidLogs.length) {
        await conn.commit();
        return { status: 'unpaid_initial_api_cycle', refunded: 0, remainingMs: calc.remainingMs };
      }
    }

    const eventKey = `server-deletion-refund:${String(serverId)}:${periodStart.toISOString()}:${String(purchase.duration)}`;
    const [existing] = await conn.execute(
      'SELECT id, amount_toman FROM billing_events WHERE event_key = ? LIMIT 1',
      [eventKey]
    );
    if (existing.length) {
      await conn.commit();
      return { status: 'already_refunded', refunded: 0, previousRefund: Number(existing[0].amount_toman || 0), eventKey };
    }

    const [userRows] = await conn.execute(
      'SELECT wallet FROM users WHERE telegram_id = ? LIMIT 1 FOR UPDATE',
      [String(telegramId)]
    );
    if (!userRows.length) {
      await conn.rollback();
      return { status: 'user_missing', refunded: 0 };
    }

    const refund = calc.refundToman;
    const balanceBefore = Number(userRows[0].wallet || 0);
    await conn.execute(
      'UPDATE users SET wallet = wallet + ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?',
      [refund, String(telegramId)]
    );
    await conn.execute(
      'INSERT INTO wallet_logs (telegram_id, amount, description, type) VALUES (?, ?, ?, ?)',
      [
        String(telegramId),
        refund,
        `بازگشت مانده دوره سرور ${purchase.server_name || serverId} پس از حذف؛ server_id=${serverId}`,
        'server_deletion_refund'
      ]
    );
    await conn.execute(
      `INSERT INTO billing_events
       (event_key, telegram_id, server_id, datacenter, event_type, amount_toman, period_start, period_end, metadata)
       VALUES (?, ?, ?, ?, 'server_deletion_refund', ?, ?, ?, ?)`,
      [
        eventKey,
        String(telegramId),
        String(serverId),
        String(datacenter),
        refund,
        periodStart.toISOString().slice(0, 19).replace('T', ' '),
        toDate(now).toISOString().slice(0, 19).replace('T', ' '),
        JSON.stringify({
          cycle: purchase.duration,
          cycleAmount: Number(purchase.amount || 0),
          remainingMs: calc.remainingMs,
          cycleMs: calc.cycleMs,
          source: 'server_delete'
        })
      ]
    );

    await conn.commit();
    return {
      status: 'refunded',
      refunded: refund,
      newWallet: balanceBefore + refund,
      remainingMs: calc.remainingMs,
      eventKey
    };
  } catch (error) {
    await conn.rollback().catch(() => {});
    if (error?.code === 'ER_DUP_ENTRY') return { status: 'already_refunded', refunded: 0 };
    throw error;
  } finally {
    conn.release();
  }
}

module.exports = {
  HOURS_IN_CYCLE,
  INITIAL_API_PAID_LOG_TYPE,
  calculateUnusedCycleRefund,
  isInitialApiCycle,
  refundUnusedServerCycle
};
