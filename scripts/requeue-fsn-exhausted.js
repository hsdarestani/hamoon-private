#!/usr/bin/env node
'use strict';

require('dotenv').config();
const mysql = require('mysql2/promise');

const explicitIds = process.argv.slice(2).map(String).filter(Boolean);
const lookbackHoursRaw = Number(process.env.HETZNER_DELIVERY_RECOVERY_LOOKBACK_HOURS || 72);
const lookbackHours = Number.isFinite(lookbackHoursRaw)
  ? Math.max(1, Math.min(24 * 14, Math.floor(lookbackHoursRaw)))
  : 72;
const cutoff = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

(async () => {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'hamooncloud_db'
  });

  try {
    const idClause = explicitIds.length
      ? ` AND p.server_id IN (${explicitIds.map(() => '?').join(',')})`
      : '';
    const params = [cutoff, ...explicitIds];

    // Only requeue undelivered Hetzner rows that actually reached the IP-quality
    // stage and still have a stored root password. This excludes unrelated manual
    // reviews such as missing-secret/provider-account failures.
    const [before] = await connection.query(
      `SELECT p.telegram_id, p.server_id, p.datacenter, p.status, p.public_ip,
              p.ip_quality_attempts, p.ip_quality_summary, p.lifecycle_error_code,
              p.delivered_at, p.updated_at
         FROM purchases p
        WHERE LOWER(p.datacenter) LIKE 'hetzner%'
          AND p.delivered_at IS NULL
          AND p.status = 'manual_review'
          AND p.updated_at >= ?
          AND (COALESCE(p.ip_quality_attempts, 0) > 0 OR p.ip_quality_summary IS NOT NULL)
          AND EXISTS (
                SELECT 1
                  FROM server_secrets s
                 WHERE s.server_id = p.server_id
                   AND s.secret_type = 'root_password'
              )
          ${idClause}
        ORDER BY p.updated_at ASC`,
      params
    );

    console.log('HETZNER_DELIVERY_RECOVERY_MATCHED=' + before.length);
    console.log('HETZNER_DELIVERY_RECOVERY_BEFORE=' + JSON.stringify(before.map(row => ({
      telegram_id: row.telegram_id,
      server_id: row.server_id,
      datacenter: row.datacenter,
      status: row.status,
      public_ip: row.public_ip,
      ip_quality_attempts: row.ip_quality_attempts,
      ip_quality_summary: row.ip_quality_summary,
      lifecycle_error_code: row.lifecycle_error_code,
      updated_at: row.updated_at
    }))));

    if (!before.length) {
      console.log('HETZNER_DELIVERY_RECOVERY_REQUEUED=0');
      return;
    }

    const serverIds = before.map(row => String(row.server_id));
    const placeholders = serverIds.map(() => '?').join(',');
    const [result] = await connection.query(
      `UPDATE purchases
          SET status = 'pending_ip_quality',
              lifecycle_error_code = NULL,
              lifecycle_updated_at = NOW(),
              updated_at = NOW()
        WHERE server_id IN (${placeholders})
          AND LOWER(datacenter) LIKE 'hetzner%'
          AND delivered_at IS NULL
          AND status = 'manual_review'`,
      serverIds
    );

    console.log('HETZNER_DELIVERY_RECOVERY_REQUEUED=' + Number(result.affectedRows || 0));
  } finally {
    await connection.end();
  }
})().catch(error => {
  console.error('HETZNER_DELIVERY_RECOVERY_FAILED=' + String(error?.message || error));
  process.exit(1);
});
