'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');

const envPath = path.resolve(process.argv[2] || '.env');
const currentText = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
const current = dotenv.parse(currentText);

function decrypt(payload, rawKey) {
  const parsed = JSON.parse(payload);
  const key = crypto.createHash('sha256').update(String(rawKey)).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(parsed.data, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

function envFiles(root, depth = 0, out = []) {
  if (depth > 4) return out;
  let items = [];
  try { items = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const item of items) {
    const f = path.join(root, item.name);
    if (item.isDirectory()) {
      if (!['node_modules', '.git', 'proc', 'sys', 'dev'].includes(item.name)) envFiles(f, depth + 1, out);
    } else if (item.isFile() && (item.name === '.env' || item.name.startsWith('.env.'))) {
      out.push(f);
    }
  }
  return out;
}

(async () => {
  const dbCfg = {
    host: current.DB_HOST || 'localhost',
    user: current.DB_USER || 'root',
    password: current.DB_PASSWORD || '',
    database: current.DB_NAME || 'hamooncloud_db'
  };
  const c = await mysql.createConnection(dbCfg);
  const [rows] = await c.query('SELECT secret_value_enc FROM server_secrets ORDER BY id DESC LIMIT 10');
  await c.end();

  if (!rows.length) {
    if (!current.SERVER_SECRET_KEY) throw new Error('No encrypted rows exist to identify SERVER_SECRET_KEY safely');
    console.log('SERVER_SECRET_KEY_PRESENT=yes; verification_skipped=no_rows');
    return;
  }

  const candidates = [];
  if (current.SERVER_SECRET_KEY) candidates.push(current.SERVER_SECRET_KEY);
  for (const f of envFiles('/root')) {
    try {
      const parsed = dotenv.parse(fs.readFileSync(f, 'utf8'));
      if (parsed.SERVER_SECRET_KEY && !candidates.includes(parsed.SERVER_SECRET_KEY)) candidates.push(parsed.SERVER_SECRET_KEY);
    } catch {}
  }

  let best = null;
  for (const candidate of candidates) {
    let score = 0;
    for (const row of rows) {
      try { if (decrypt(row.secret_value_enc, candidate)) score += 1; } catch {}
    }
    if (!best || score > best.score) best = { key: candidate, score };
  }

  if (!best || best.score < 1) {
    throw new Error('Could not verify any historical SERVER_SECRET_KEY against existing encrypted records');
  }

  if (!current.SERVER_SECRET_KEY || current.SERVER_SECRET_KEY !== best.key) {
    let next = currentText.replace(/^SERVER_SECRET_KEY=.*$/m, '').trimEnd();
    next += `\nSERVER_SECRET_KEY=${best.key}\n`;
    fs.writeFileSync(envPath, next, { mode: 0o600 });
  }

  console.log(`SERVER_SECRET_KEY_VERIFIED=yes; verified_rows=${best.score}`);
})().catch(error => {
  console.error('SERVER_SECRET_KEY_RESTORE_FAILED=' + error.message);
  process.exit(1);
});
