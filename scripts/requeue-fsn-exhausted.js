#!/usr/bin/env node
'use strict';

require('dotenv').config();
const mysql = require('mysql2/promise');

const serverIds = process.argv.slice(2).map(String).filter(Boolean);
if (!serverIds.length) {
  console.log('FSN_RECOVERY_NO_IDS');
  process.exit(0);
}

(async () => {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'hamooncloud_db'
  });

  try {
    const placeholders = serverIds.map(() => '?').join(',');
    const [before] = await connection.query(
      `SELECT telegram_id, server_id, status, delivered_at, ip_quality_attempts, ip_quality_summary
         FROM purchases
        WHERE server_id IN (${placeholders})
          AND LOWER(datacenter) = 'hetzner'
        ORDER BY updated_at DESC`,
      serverIds
    );
    console.log('FSN_RECOVERY_BEFORE=' + JSON.stringify(before));

    const [result] = await connection.query(
      `UPDATE purchases
          SET status = 'pending_ip_quality',
              lifecycle_error_code = NULL,
              lifecycle_updated_at = NOW(),
              updated_at = NOW()
        WHERE server_id IN (${placeholders})
          AND LOWER(datacenter) = 'hetzner'
          AND delivered_at IS NULL
          AND status = 'manual_review'`,
      serverIds
    );
    console.log('FSN_RECOVERY_REQUEUED=' + Number(result.affectedRows || 0));

    const [after] = await connection.query(
      `SELECT telegram_id, server_id, status, delivered_at, ip_quality_attempts, ip_quality_summary
         FROM purchases
        WHERE server_id IN (${placeholders})
          AND LOWER(datacenter) = 'hetzner'
        ORDER BY updated_at DESC`,
      serverIds
    );
    console.log('FSN_RECOVERY_AFTER=' + JSON.stringify(after));
  } finally {
    await connection.end();
  }
})().catch(error => {
  console.error('FSN_RECOVERY_FAILED=' + String(error?.message || error));
  process.exit(1);
});