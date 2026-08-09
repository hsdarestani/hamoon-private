'use strict';

const crypto = require('crypto');
const db = require('./db');

let tableReady = false;
let tablePromise = null;

function sessionSecret() {
  const raw = String(process.env.CONSOLE_SESSION_SECRET || '').trim();
  if (raw.length < 32) {
    const err = new Error('CONSOLE_SESSION_SECRET_MISSING');
    err.code = 'CONSOLE_SESSION_SECRET_MISSING';
    throw err;
  }
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function encryptPayload(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sessionSecret(), iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final()
  ]);
  return JSON.stringify({
    v: 1,
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    body: body.toString('base64url')
  });
}

function decryptPayload(encoded) {
  const parsed = JSON.parse(String(encoded || ''));
  if (parsed.v !== 1 || !parsed.iv || !parsed.tag || !parsed.body) {
    throw new Error('CONSOLE_SESSION_PAYLOAD_INVALID');
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    sessionSecret(),
    Buffer.from(parsed.iv, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64url'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(parsed.body, 'base64url')),
    decipher.final()
  ]);
  return JSON.parse(plain.toString('utf8'));
}

async function ensureConsoleSessionsTable() {
  if (tableReady) return;
  if (tablePromise) return tablePromise;
  tablePromise = (async () => {
    await db.pool.execute(`
      CREATE TABLE IF NOT EXISTS console_sessions (
        token_hash CHAR(64) PRIMARY KEY,
        telegram_id VARCHAR(255) NOT NULL,
        server_id VARCHAR(255) NOT NULL,
        payload_enc TEXT NOT NULL,
        expires_at DATETIME NOT NULL,
        consumed_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_console_sessions_expires (expires_at),
        INDEX idx_console_sessions_owner (telegram_id, server_id)
      )
    `);
    tableReady = true;
  })();
  try {
    await tablePromise;
  } finally {
    tablePromise = null;
  }
}

async function cleanupExpiredConsoleSessions() {
  await ensureConsoleSessionsTable();
  await db.pool.execute(
    `DELETE FROM console_sessions
     WHERE expires_at < DATE_SUB(NOW(), INTERVAL 10 MINUTE)
        OR consumed_at < DATE_SUB(NOW(), INTERVAL 10 MINUTE)`
  ).catch(() => {});
}

async function createConsoleSession({ telegramId, serverId, wssUrl, password, ttlMs = 120000 }) {
  if (!/^wss:\/\//i.test(String(wssUrl || ''))) {
    const err = new Error('CONSOLE_WSS_URL_INVALID');
    err.code = 'CONSOLE_WSS_URL_INVALID';
    throw err;
  }
  if (!password) {
    const err = new Error('CONSOLE_PASSWORD_MISSING');
    err.code = 'CONSOLE_PASSWORD_MISSING';
    throw err;
  }
  await ensureConsoleSessionsTable();
  cleanupExpiredConsoleSessions().catch(() => {});

  const token = crypto.randomBytes(24).toString('base64url');
  const hash = tokenHash(token);
  const ttl = Math.max(30000, Math.min(Number(ttlMs) || 120000, 180000));
  const expiresAt = new Date(Date.now() + ttl);
  const payloadEnc = encryptPayload({
    wssUrl: String(wssUrl),
    password: String(password),
    telegramId: String(telegramId),
    serverId: String(serverId)
  });

  await db.pool.execute(
    `INSERT INTO console_sessions
       (token_hash, telegram_id, server_id, payload_enc, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [hash, String(telegramId), String(serverId), payloadEnc, expiresAt]
  );

  return { token, expiresAt };
}

async function consumeConsoleSession(token) {
  const cleanToken = String(token || '').trim();
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(cleanToken)) return null;
  await ensureConsoleSessionsTable();

  const hash = tokenHash(cleanToken);
  const conn = await db.pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      `SELECT token_hash, telegram_id, server_id, payload_enc, expires_at
       FROM console_sessions
       WHERE token_hash = ?
         AND consumed_at IS NULL
         AND expires_at > NOW()
       LIMIT 1
       FOR UPDATE`,
      [hash]
    );
    if (!rows.length) {
      await conn.rollback();
      return null;
    }

    const [result] = await conn.execute(
      `UPDATE console_sessions
       SET consumed_at = NOW()
       WHERE token_hash = ? AND consumed_at IS NULL`,
      [hash]
    );
    if (result.affectedRows !== 1) {
      await conn.rollback();
      return null;
    }

    await conn.commit();
    const payload = decryptPayload(rows[0].payload_enc);
    return {
      wssUrl: String(payload.wssUrl || ''),
      password: String(payload.password || ''),
      serverId: String(rows[0].server_id || payload.serverId || ''),
      expiresAt: new Date(rows[0].expires_at).toISOString()
    };
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }
}

module.exports = {
  ensureConsoleSessionsTable,
  createConsoleSession,
  consumeConsoleSession
};
