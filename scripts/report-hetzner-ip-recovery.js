#!/usr/bin/env node
'use strict';

require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'hamooncloud_db'
  });

  try {
    const [delivery] = await connection.query(
      `SELECT telegram_id, server_id, datacenter, status, public_ip,
              ip_quality_attempts, ip_quality_summary, delivered_at, updated_at
         FROM purchases
        WHERE LOWER(datacenter) LIKE 'hetzner%'
          AND updated_at >= DATE_SUB(NOW(), INTERVAL 72 HOUR)
          AND (COALESCE(ip_quality_attempts, 0) > 0 OR ip_quality_summary IS NOT NULL)
          AND (delivered_at IS NULL OR status <> 'active')
        ORDER BY updated_at DESC`
    );

    const [changeIp] = await connection.query(
      `SELECT p.telegram_id, p.server_id, p.datacenter, p.public_ip,
              MAX(CASE WHEN h.last_event IN (
                    'clean_ip_rejected_rolled_back',
                    'clean_ip_unverified_rolled_back'
                  ) THEN h.last_seen_at END) AS last_failure_at,
              MAX(CASE WHEN h.last_event = 'clean_ip_verified'
                       THEN h.last_seen_at END) AS last_success_at
         FROM purchases p
         JOIN server_ip_history h
           ON h.server_id = p.server_id
          AND h.datacenter = p.datacenter
        WHERE p.delivered_at IS NOT NULL
          AND LOWER(p.datacenter) LIKE 'hetzner%'
          AND h.last_seen_at >= DATE_SUB(NOW(), INTERVAL 12 HOUR)
        GROUP BY p.telegram_id, p.server_id, p.datacenter, p.public_ip
       HAVING last_failure_at IS NOT NULL
          AND (last_success_at IS NULL OR last_success_at < last_failure_at)
        ORDER BY last_failure_at DESC`
    );

    console.log('HETZNER_RECOVERY_DELIVERY_REMAINING=' + delivery.length);
    console.log('HETZNER_RECOVERY_DELIVERY_ROWS=' + JSON.stringify(delivery));
    console.log('HETZNER_RECOVERY_CHANGE_IP_REMAINING=' + changeIp.length);
    console.log('HETZNER_RECOVERY_CHANGE_IP_ROWS=' + JSON.stringify(changeIp));
  } finally {
    await connection.end();
  }
})().catch(error => {
  console.error('HETZNER_RECOVERY_REPORT_FAILED=' + String(error?.message || error));
  process.exit(1);
});
