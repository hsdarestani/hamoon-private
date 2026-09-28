'use strict';

async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS zibal_rounding_refunds (
      track_id VARCHAR(64) NOT NULL PRIMARY KEY,
      telegram_id VARCHAR(64) NOT NULL,
      refund_toman DECIMAL(14,2) NOT NULL,
      delta_rial BIGINT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_zibal_rounding_refunds_user (telegram_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function refundLegacyRoundingDifference(pool, {
  trackId,
  telegramId,
  paidRial,
  expectedRial
}) {
  const deltaRial = Number(paidRial || 0) - Number(expectedRial || 0);
  if (deltaRial !== 10) {
    return { status: deltaRial === 0 ? 'not_needed' : 'unsupported_delta', refundedToman: 0, deltaRial };
  }

  await ensureSchema(pool);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const refundToman = 1;
    const [claim] = await conn.execute(
      `INSERT IGNORE INTO zibal_rounding_refunds
        (track_id, telegram_id, refund_toman, delta_rial)
       VALUES (?, ?, ?, ?)`,
      [String(trackId), String(telegramId), refundToman, deltaRial]
    );

    if (claim.affectedRows === 0) {
      await conn.commit();
      return { status: 'already_refunded', refundedToman: 0, deltaRial };
    }

    const [userUpdate] = await conn.execute(
      'UPDATE users SET wallet=COALESCE(wallet,0)+?,updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?',
      [refundToman, String(telegramId)]
    );
    if (userUpdate.affectedRows !== 1) {
      throw Object.assign(new Error('ZIBAL_ROUNDING_REFUND_USER_MISSING'), { code: 'ZIBAL_ROUNDING_REFUND_USER_MISSING' });
    }

    await conn.execute(
      'INSERT INTO wallet_logs (telegram_id,amount,description,type) VALUES (?,?,?,?)',
      [
        String(telegramId),
        refundToman,
        `اصلاح گردکردن پرداخت زیبال؛ بازگشت ۱ تومان - trackId: ${String(trackId)}`,
        'zibal_rounding_refund'
      ]
    );

    await conn.commit();
    return { status: 'refunded', refundedToman, deltaRial };
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }
}

module.exports = {
  ensureSchema,
  refundLegacyRoundingDifference
};
