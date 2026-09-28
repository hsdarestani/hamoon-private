'use strict';

require('dotenv').config();
const db = require('../db');

const APPLY = process.argv.includes('--apply');
const LEGACY_CUTOFF = process.env.LEGACY_DELIVERY_CUTOFF || '2026-09-19 00:00:00';
const RECENT_PROVIDER_HOURS = Math.max(1, Number(process.env.LEGACY_DELIVERY_PROVIDER_MAX_AGE_HOURS || 24));

async function main() {
  const conn = await db.pool.getConnection();
  try {
    const [candidates] = await conn.query(
      `SELECT p.telegram_id,p.server_id,p.server_name,p.datacenter,p.status,p.duration,p.amount,
              p.last_billed_at,p.delivered_at,p.provider_status,p.provider_status_checked_at,p.created_at,
              (SELECT MAX(b.created_at)
                 FROM billing_events b
                WHERE b.server_id=p.server_id
                  AND b.telegram_id=p.telegram_id
                  AND b.datacenter=p.datacenter
                  AND b.event_type='renewal') AS last_renewal_event_at
         FROM purchases p
        WHERE p.delivered_at IS NULL
          AND p.deleted_at IS NULL
          AND p.created_at < ?
          AND p.status IN ('active','running','suspended','stopped','shutoff')
          AND LOWER(COALESCE(p.provider_status,'')) IN ('active','running','suspended','off','stopped','shutoff')
          AND p.provider_status_checked_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
          AND EXISTS (
            SELECT 1
              FROM billing_events b
             WHERE b.server_id=p.server_id
               AND b.telegram_id=p.telegram_id
               AND b.datacenter=p.datacenter
               AND b.event_type='renewal'
          )
        ORDER BY p.telegram_id,p.server_id`,
      [LEGACY_CUTOFF, RECENT_PROVIDER_HOURS]
    );

    const summary = {
      mode: APPLY ? 'apply' : 'dry-run',
      cutoff: LEGACY_CUTOFF,
      provider_max_age_hours: RECENT_PROVIDER_HOURS,
      candidates: candidates.length,
      by_cycle: {},
      one_cycle_value_toman: 0
    };
    for (const row of candidates) {
      const cycle = String(row.duration || 'unknown');
      summary.by_cycle[cycle] = (summary.by_cycle[cycle] || 0) + 1;
      summary.one_cycle_value_toman += Math.max(0, Number(row.amount || 0));
    }
    summary.one_cycle_value_toman = Math.round(summary.one_cycle_value_toman * 100) / 100;
    console.log('LEGACY_DELIVERY_REPAIR_SUMMARY=' + JSON.stringify(summary));
    console.log('LEGACY_DELIVERY_REPAIR_CANDIDATES=' + JSON.stringify(candidates.map(row => ({
      telegram_id: String(row.telegram_id),
      server_id: String(row.server_id),
      server_name: row.server_name,
      datacenter: row.datacenter,
      status: row.status,
      provider_status: row.provider_status,
      duration: row.duration,
      amount: Number(row.amount || 0),
      last_billed_at: row.last_billed_at,
      last_renewal_event_at: row.last_renewal_event_at
    }))));

    if (!APPLY || candidates.length === 0) return;

    await conn.beginTransaction();
    try {
      const ids = candidates.map(row => String(row.server_id));
      const placeholders = ids.map(() => '?').join(',');
      const [result] = await conn.query(
        `UPDATE purchases p
            SET p.delivered_at = COALESCE(p.last_billed_at,p.created_at,NOW()),
                p.lifecycle_error_code = NULL,
                p.lifecycle_updated_at = NOW()
          WHERE p.server_id IN (${placeholders})
            AND p.delivered_at IS NULL
            AND p.deleted_at IS NULL`,
        ids
      );
      if (Number(result.affectedRows || 0) !== candidates.length) {
        throw new Error('LEGACY_DELIVERY_REPAIR_AFFECTED_ROWS_MISMATCH:' + result.affectedRows + ':' + candidates.length);
      }
      await conn.commit();
      console.log('LEGACY_DELIVERY_REPAIR_APPLIED=' + JSON.stringify({affected_rows:Number(result.affectedRows || 0)}));
    } catch (error) {
      await conn.rollback();
      throw error;
    }
  } finally {
    conn.release();
    await db.pool.end();
  }
}

main().catch(async error => {
  console.error('LEGACY_DELIVERY_REPAIR_FAILED=' + JSON.stringify({message:error?.message || String(error),code:error?.code || null}));
  try { await db.pool.end(); } catch {}
  process.exit(1);
});
