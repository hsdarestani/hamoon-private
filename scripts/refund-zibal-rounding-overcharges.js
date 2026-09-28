#!/usr/bin/env node
'use strict';

require('dotenv').config();
const db = require('../db');
const { ensureSchema } = require('../services/zibal-rounding-refund');

const APPLY = process.argv.includes('--apply');

async function main() {
  await ensureSchema(db.pool);
  const conn = await db.pool.getConnection();
  try {
    const [rows] = await conn.query(`
      SELECT z.track_id,z.telegram_id,z.amount_toman,z.paid_rial,
             (z.amount_toman + CEIL(z.amount_toman / 10)) * 10 AS expected_rial,
             z.paid_rial - ((z.amount_toman + CEIL(z.amount_toman / 10)) * 10) AS delta_rial
        FROM zibal_payments z
        LEFT JOIN zibal_rounding_refunds r ON r.track_id=z.track_id
       WHERE z.credited=1
         AND r.track_id IS NULL
         AND z.paid_rial - ((z.amount_toman + CEIL(z.amount_toman / 10)) * 10) = 10
       ORDER BY z.created_at ASC,z.id ASC
    `);

    const summary = {
      mode: APPLY ? 'apply' : 'dry-run',
      payments: rows.length,
      users: new Set(rows.map(x => String(x.telegram_id))).size,
      total_refund_toman: rows.length
    };
    console.log('ZIBAL_ROUNDING_REPAIR_SUMMARY=' + JSON.stringify(summary));

    if (!APPLY || !rows.length) return;

    await conn.beginTransaction();
    try {
      let applied = 0;
      for (const row of rows) {
        const [claim] = await conn.execute(
          `INSERT IGNORE INTO zibal_rounding_refunds
            (track_id,telegram_id,refund_toman,delta_rial)
           VALUES (?,?,1,10)`,
          [String(row.track_id), String(row.telegram_id)]
        );
        if (claim.affectedRows !== 1) continue;

        const [userUpdate] = await conn.execute(
          'UPDATE users SET wallet=COALESCE(wallet,0)+1,updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?',
          [String(row.telegram_id)]
        );
        if (userUpdate.affectedRows !== 1) {
          throw new Error('ZIBAL_ROUNDING_REPAIR_USER_MISSING:' + String(row.telegram_id));
        }

        await conn.execute(
          'INSERT INTO wallet_logs (telegram_id,amount,description,type) VALUES (?,1,?,?)',
          [
            String(row.telegram_id),
            `اصلاح گردکردن پرداخت زیبال؛ بازگشت ۱ تومان - trackId: ${String(row.track_id)}`,
            'zibal_rounding_refund'
          ]
        );
        applied += 1;
      }

      await conn.commit();
      console.log('ZIBAL_ROUNDING_REPAIR_APPLIED=' + JSON.stringify({
        payments: applied,
        total_refund_toman: applied
      }));
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    }

    const [[target]] = await conn.query(`
      SELECT u.wallet,
             EXISTS(SELECT 1 FROM zibal_rounding_refunds r WHERE r.track_id='4814436321') target_refunded
        FROM zibal_payments z
        JOIN users u ON u.telegram_id=z.telegram_id
       WHERE z.track_id='4814436321'
       LIMIT 1
    `);
    console.log('ZIBAL_ROUNDING_TARGET=' + JSON.stringify(target || null));
  } finally {
    conn.release();
    await db.pool.end();
  }
}

main().catch(async error => {
  console.error('ZIBAL_ROUNDING_REPAIR_FAILED=' + JSON.stringify({
    code: error?.code || null,
    message: error?.message || String(error)
  }));
  try { await db.pool.end(); } catch {}
  process.exit(1);
});
