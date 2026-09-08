'use strict';

require('dotenv').config();
const { pool } = require('./db');

async function rollbackServerRenewalAtomic({
  telegramId,
  serverId,
  datacenter,
  eventKey,
  reason = 'resume_failed'
}) {
  if (!eventKey) return { status: 'no_event_key', refunded: 0 };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [events] = await conn.execute(
      `SELECT id, event_key, telegram_id, server_id, datacenter, event_type,
              amount_toman, period_start
       FROM billing_events
       WHERE event_key = ?
       LIMIT 1 FOR UPDATE`,
      [String(eventKey)]
    );
    if (!events.length) {
      await conn.commit();
      return { status: 'already_rolled_back', refunded: 0 };
    }

    const event = events[0];
    if (
      String(event.event_type) !== 'renewal' ||
      String(event.telegram_id) !== String(telegramId) ||
      String(event.server_id) !== String(serverId) ||
      String(event.datacenter) !== String(datacenter)
    ) {
      const error = new Error('RENEWAL_ROLLBACK_EVENT_MISMATCH');
      error.code = 'RENEWAL_ROLLBACK_EVENT_MISMATCH';
      throw error;
    }

    const amount = Math.max(0, Number(event.amount_toman || 0));
    if (!(amount > 0)) {
      const error = new Error('RENEWAL_ROLLBACK_INVALID_AMOUNT');
      error.code = 'RENEWAL_ROLLBACK_INVALID_AMOUNT';
      throw error;
    }

    const [users] = await conn.execute(
      'SELECT wallet FROM users WHERE telegram_id = ? LIMIT 1 FOR UPDATE',
      [String(telegramId)]
    );
    if (!users.length) {
      const error = new Error('RENEWAL_ROLLBACK_USER_MISSING');
      error.code = 'RENEWAL_ROLLBACK_USER_MISSING';
      throw error;
    }

    await conn.execute(
      'UPDATE users SET wallet = wallet + ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?',
      [amount, String(telegramId)]
    );
    await conn.execute(
      'INSERT INTO wallet_logs (telegram_id, amount, description, type) VALUES (?, ?, ?, ?)',
      [
        String(telegramId),
        amount,
        `بازگشت خودکار هزینه تمدید ناموفق سرور ${String(serverId)}`,
        'billing_refund'
      ]
    );

    // Restore the exact billing boundary that the atomic settlement advanced.
    // This makes the next successful resume eligible for a fresh, correct renewal.
    await conn.execute(
      `UPDATE purchases
       SET status = 'suspended',
           last_billed_at = COALESCE(?, last_billed_at),
           suspend_reason = ?,
           lifecycle_updated_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE telegram_id = ? AND server_id = ? AND datacenter = ?`,
      [
        event.period_start || null,
        String(reason || 'resume_failed').slice(0, 64),
        String(telegramId),
        String(serverId),
        String(datacenter)
      ]
    );

    // Removing the idempotency event is intentional: the failed renewal is fully
    // compensated, so a later successful resume must be able to settle again.
    await conn.execute('DELETE FROM billing_events WHERE id = ?', [event.id]);

    await conn.commit();
    return { status: 'refunded', refunded: amount, restoredPeriodStart: event.period_start || null };
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }
}

module.exports = { rollbackServerRenewalAtomic };
