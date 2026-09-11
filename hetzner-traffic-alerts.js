'use strict';

require('dotenv').config();
const mysql = require('mysql2/promise');

const DECIMAL_TB_BYTES = 1_000_000_000_000;

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'hamooncloud_db',
  waitForConnections: true,
  connectionLimit: 3,
  queueLimit: 0
});

let schemaPromise = null;

function mysqlDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('INVALID_TRAFFIC_ALERT_PERIOD');
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function shouldNotifyTrafficQuotaExhausted(outgoingBytes, allowanceBytes) {
  const outgoing = Math.max(0, Number(outgoingBytes || 0));
  const allowance = Math.max(0, Number(allowanceBytes || 0));
  return allowance > 0 && outgoing >= allowance;
}

async function ensureTrafficAlertSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    const conn = await pool.getConnection();
    try {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS hetzner_traffic_alerts (
          server_id VARCHAR(255) NOT NULL,
          period_start DATETIME NOT NULL,
          allowance_bytes BIGINT UNSIGNED NOT NULL,
          telegram_id VARCHAR(255) NOT NULL,
          datacenter VARCHAR(64) NOT NULL,
          outgoing_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
          notified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (server_id, period_start, allowance_bytes),
          INDEX idx_hetzner_traffic_alert_user_period (telegram_id, period_start)
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

async function claimTrafficQuotaExhaustedAlert({
  telegramId,
  serverId,
  datacenter,
  periodStart,
  outgoingBytes,
  allowanceBytes
}) {
  if (!shouldNotifyTrafficQuotaExhausted(outgoingBytes, allowanceBytes)) return false;
  await ensureTrafficAlertSchema();

  const conn = await pool.getConnection();
  try {
    const [result] = await conn.execute(
      `INSERT IGNORE INTO hetzner_traffic_alerts
       (server_id, period_start, allowance_bytes, telegram_id, datacenter, outgoing_bytes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        String(serverId),
        mysqlDate(periodStart),
        Math.max(0, Math.floor(Number(allowanceBytes || 0))),
        String(telegramId),
        String(datacenter),
        Math.max(0, Math.floor(Number(outgoingBytes || 0)))
      ]
    );
    return Number(result?.affectedRows || 0) === 1;
  } finally {
    conn.release();
  }
}

async function releaseTrafficQuotaExhaustedAlert({
  telegramId,
  serverId,
  datacenter,
  periodStart,
  allowanceBytes
}) {
  await ensureTrafficAlertSchema();
  const conn = await pool.getConnection();
  try {
    await conn.execute(
      `DELETE FROM hetzner_traffic_alerts
       WHERE server_id = ? AND period_start = ? AND allowance_bytes = ?
         AND telegram_id = ? AND datacenter = ?`,
      [
        String(serverId),
        mysqlDate(periodStart),
        Math.max(0, Math.floor(Number(allowanceBytes || 0))),
        String(telegramId),
        String(datacenter)
      ]
    );
  } finally {
    conn.release();
  }
}

module.exports = {
  DECIMAL_TB_BYTES,
  shouldNotifyTrafficQuotaExhausted,
  ensureTrafficAlertSchema,
  claimTrafficQuotaExhaustedAlert,
  releaseTrafficQuotaExhaustedAlert
};
