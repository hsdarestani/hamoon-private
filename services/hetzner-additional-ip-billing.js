'use strict';

const HETZNER_FLOATING_IPV4_EUR_MONTHLY = 3;
const HETZNER_ADDITIONAL_IP_EUR_TOMAN = 250000;
const BILLING_CYCLE_HOURS = 720;
const MONTHLY_PRICE_TOMAN = HETZNER_FLOATING_IPV4_EUR_MONTHLY * HETZNER_ADDITIONAL_IP_EUR_TOMAN;

function quote() {
  return { amount: MONTHLY_PRICE_TOMAN, currency: 'TOMAN', cycle: 'monthly', cycle_hours: BILLING_CYCLE_HOURS, provider_price_eur: HETZNER_FLOATING_IPV4_EUR_MONTHLY, eur_rate_toman: HETZNER_ADDITIONAL_IP_EUR_TOMAN };
}

async function ensureTable(db) {
  await db.pool.execute(`CREATE TABLE IF NOT EXISTS hetzner_additional_ip_billing (
    floating_ip_id VARCHAR(64) PRIMARY KEY,
    floating_ip VARCHAR(64) NOT NULL,
    server_id VARCHAR(255) NOT NULL,
    telegram_id VARCHAR(255) NOT NULL,
    datacenter VARCHAR(64) NOT NULL,
    amount DECIMAL(14,2) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    last_billed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_additional_ip_due (status, last_billed_at),
    INDEX idx_additional_ip_owner (telegram_id, server_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

async function assertAffordable(db, telegramId) {
  const balance = Number(await db.getUserWallet(telegramId) || 0);
  if (balance < MONTHLY_PRICE_TOMAN) {
    const error = new Error('INSUFFICIENT_WALLET');
    error.code = 'INSUFFICIENT_WALLET';
    error.balance = balance;
    error.required = MONTHLY_PRICE_TOMAN;
    throw error;
  }
  return balance;
}

async function activate({ db, telegramId, serverId, datacenter, floatingIp }) {
  await ensureTable(db);
  const conn = await db.pool.getConnection();
  try {
    await conn.beginTransaction();
    const [users] = await conn.execute('SELECT wallet FROM users WHERE telegram_id = ? FOR UPDATE', [String(telegramId)]);
    const balance = Number(users[0]?.wallet || 0);
    if (balance < MONTHLY_PRICE_TOMAN) throw Object.assign(new Error('INSUFFICIENT_WALLET'), { code: 'INSUFFICIENT_WALLET', balance, required: MONTHLY_PRICE_TOMAN });
    await conn.execute('UPDATE users SET wallet = wallet - ? WHERE telegram_id = ?', [MONTHLY_PRICE_TOMAN, String(telegramId)]);
    await conn.execute(`INSERT INTO hetzner_additional_ip_billing
      (floating_ip_id, floating_ip, server_id, telegram_id, datacenter, amount, status, last_billed_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP)`, [String(floatingIp.id), String(floatingIp.ip), String(serverId), String(telegramId), String(datacenter), MONTHLY_PRICE_TOMAN]);
    await conn.execute('INSERT INTO wallet_logs (telegram_id, amount, description, type) VALUES (?, ?, ?, ?)', [String(telegramId), -MONTHLY_PRICE_TOMAN, `خرید IP اضافه Hetzner ${floatingIp.ip} برای سرور ${serverId} (ماهانه)`, 'hetzner_additional_ip']);
    await conn.commit();
    return quote();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally { conn.release(); }
}

async function cancel({ db, floatingIpId }) {
  await ensureTable(db);
  await db.pool.execute("UPDATE hetzner_additional_ip_billing SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE floating_ip_id = ?", [String(floatingIpId)]);
}

async function listDue(db, now = new Date()) {
  await ensureTable(db);
  const cutoff = new Date(now.getTime() - BILLING_CYCLE_HOURS * 3600000);
  const [rows] = await db.pool.execute("SELECT * FROM hetzner_additional_ip_billing WHERE status = 'active' AND last_billed_at <= ?", [cutoff]);
  return rows;
}

async function renew({ db, floatingIpId }) {
  await ensureTable(db);
  const conn = await db.pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute("SELECT * FROM hetzner_additional_ip_billing WHERE floating_ip_id = ? AND status = 'active' FOR UPDATE", [String(floatingIpId)]);
    const row = rows[0];
    if (!row) { await conn.rollback(); return { status: 'inactive' }; }
    const [users] = await conn.execute('SELECT wallet FROM users WHERE telegram_id = ? FOR UPDATE', [String(row.telegram_id)]);
    if (Number(users[0]?.wallet || 0) < Number(row.amount)) { await conn.rollback(); return { status: 'insufficient', row }; }
    await conn.execute('UPDATE users SET wallet = wallet - ? WHERE telegram_id = ?', [row.amount, String(row.telegram_id)]);
    await conn.execute('UPDATE hetzner_additional_ip_billing SET last_billed_at = CURRENT_TIMESTAMP WHERE floating_ip_id = ?', [String(floatingIpId)]);
    await conn.execute('INSERT INTO wallet_logs (telegram_id, amount, description, type) VALUES (?, ?, ?, ?)', [String(row.telegram_id), -Number(row.amount), `تمدید IP اضافه Hetzner ${row.floating_ip} برای سرور ${row.server_id} (ماهانه)`, 'hetzner_additional_ip_renewal']);
    await conn.commit();
    return { status: 'charged', row, pricing: quote() };
  } catch (error) { await conn.rollback(); throw error; }
  finally { conn.release(); }
}

module.exports = { HETZNER_FLOATING_IPV4_EUR_MONTHLY, HETZNER_ADDITIONAL_IP_EUR_TOMAN, BILLING_CYCLE_HOURS, MONTHLY_PRICE_TOMAN, quote, assertAffordable, activate, cancel, listDue, renew };
