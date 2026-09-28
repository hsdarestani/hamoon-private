#!/usr/bin/env node
'use strict';

require('dotenv').config();
const db = require('../db');

const APPLY = process.argv.includes('--apply');

function fa(value) {
  return Number(value || 0).toLocaleString('fa-IR');
}

async function main() {
  const conn = await db.pool.getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT w.id,w.telegram_id,w.description,
              z.track_id,z.amount_toman,z.paid_rial
         FROM wallet_logs w
         JOIN zibal_payments z
           ON z.telegram_id=w.telegram_id
          AND w.type='payment'
          AND LOCATE(CONCAT('trackId: ',z.track_id),w.description) > 0
        WHERE z.credited=1
          AND w.description NOT LIKE '%پرداخت بانکی:%'
        ORDER BY w.id ASC`
    );

    console.log('ZIBAL_WALLET_HISTORY_BACKFILL_SUMMARY=' + JSON.stringify({
      mode: APPLY ? 'apply' : 'dry-run',
      rows: rows.length,
      users: new Set(rows.map(r => String(r.telegram_id))).size
    }));

    if (!APPLY || !rows.length) return;

    await conn.beginTransaction();
    try {
      let updated = 0;
      for (const row of rows) {
        const credit = Number(row.amount_toman || 0);
        const tax = Math.ceil(credit / 10);
        const paidToman = Number(row.paid_rial || 0) / 10;
        const description =
          `شارژ کیف پول از طریق زیبال؛ اعتبار کیف پول: ${fa(credit)} تومان؛ ` +
          `مالیات: ${fa(tax)} تومان؛ پرداخت بانکی: ${fa(paidToman)} تومان؛ ` +
          `trackId: ${String(row.track_id)}`;

        const [result] = await conn.execute(
          `UPDATE wallet_logs
              SET description=?
            WHERE id=?
              AND telegram_id=?
              AND type='payment'
              AND description NOT LIKE '%پرداخت بانکی:%'`,
          [description, row.id, String(row.telegram_id)]
        );
        updated += Number(result.affectedRows || 0);
      }
      await conn.commit();
      console.log('ZIBAL_WALLET_HISTORY_BACKFILL_APPLIED=' + JSON.stringify({updated}));
    } catch (error) {
      await conn.rollback().catch(() => {});
      throw error;
    }
  } finally {
    conn.release();
    await db.pool.end();
  }
}

main().catch(async error => {
  console.error('ZIBAL_WALLET_HISTORY_BACKFILL_FAILED=' + JSON.stringify({
    code: error?.code || null,
    message: error?.message || String(error)
  }));
  try { await db.pool.end(); } catch {}
  process.exit(1);
});
