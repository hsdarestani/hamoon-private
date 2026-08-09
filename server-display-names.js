'use strict';

require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'hamooncloud_db',
  waitForConnections: true,
  connectionLimit: 2,
  queueLimit: 0
});

const MAX_DISPLAY_NAME_LENGTH = 64;
let tableReadyPromise = null;

function aliasKey(datacenter, serverId) {
  return `${String(datacenter || '')}\u0000${String(serverId || '')}`;
}

function normalizeServerDisplayName(value) {
  const normalized = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return '';
  if ([...normalized].length > MAX_DISPLAY_NAME_LENGTH) {
    const err = new Error(`نام نمایشی باید حداکثر ${MAX_DISPLAY_NAME_LENGTH} کاراکتر باشد.`);
    err.code = 'DISPLAY_NAME_TOO_LONG';
    throw err;
  }
  return normalized;
}

async function ensureServerDisplayNamesTable() {
  if (!tableReadyPromise) {
    tableReadyPromise = pool.execute(`
      CREATE TABLE IF NOT EXISTS server_display_names (
        telegram_id VARCHAR(64) NOT NULL,
        datacenter VARCHAR(191) NOT NULL,
        server_id VARCHAR(191) NOT NULL,
        display_name VARCHAR(64) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (telegram_id, datacenter, server_id),
        KEY idx_server_display_names_lookup (datacenter, server_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `).catch(err => {
      tableReadyPromise = null;
      throw err;
    });
  }
  await tableReadyPromise;
}

async function getServerDisplayName(userId, serverId, datacenter) {
  await ensureServerDisplayNamesTable();
  const [rows] = await pool.execute(
    `SELECT display_name
       FROM server_display_names
      WHERE telegram_id = ? AND datacenter = ? AND server_id = ?
      LIMIT 1`,
    [String(userId), String(datacenter), String(serverId)]
  );
  return rows?.[0]?.display_name || null;
}

async function getServerDisplayNameMap(userId) {
  await ensureServerDisplayNamesTable();
  const [rows] = await pool.execute(
    `SELECT datacenter, server_id, display_name
       FROM server_display_names
      WHERE telegram_id = ?`,
    [String(userId)]
  );
  return new Map((rows || []).map(row => [aliasKey(row.datacenter, row.server_id), row.display_name]));
}

function getServerDisplayNameFromMap(map, datacenter, serverId) {
  if (!map || typeof map.get !== 'function') return null;
  return map.get(aliasKey(datacenter, serverId)) || null;
}

async function setServerDisplayName(userId, serverId, datacenter, value) {
  const displayName = normalizeServerDisplayName(value);
  if (!displayName) {
    await clearServerDisplayName(userId, serverId, datacenter);
    return null;
  }

  await ensureServerDisplayNamesTable();
  await pool.execute(
    `INSERT INTO server_display_names (telegram_id, datacenter, server_id, display_name)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), updated_at = CURRENT_TIMESTAMP`,
    [String(userId), String(datacenter), String(serverId), displayName]
  );
  return displayName;
}

async function clearServerDisplayName(userId, serverId, datacenter) {
  await ensureServerDisplayNamesTable();
  const [result] = await pool.execute(
    `DELETE FROM server_display_names
      WHERE telegram_id = ? AND datacenter = ? AND server_id = ?`,
    [String(userId), String(datacenter), String(serverId)]
  );
  return Number(result?.affectedRows || 0) > 0;
}

module.exports = {
  MAX_DISPLAY_NAME_LENGTH,
  normalizeServerDisplayName,
  getServerDisplayName,
  getServerDisplayNameMap,
  getServerDisplayNameFromMap,
  setServerDisplayName,
  clearServerDisplayName,
};
