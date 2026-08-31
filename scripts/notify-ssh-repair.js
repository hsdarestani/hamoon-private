'use strict';

require('dotenv').config();
const net = require('net');
const db = require('../db');

function tcpOpen(host, port = 22, timeoutMs = 5000) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function findPurchaseByIp(ip) {
  const purchases = await db.getAllPurchases();
  return purchases.find(p => String(p.public_ip || '').trim() === ip) || null;
}

async function alreadyNotified(serverId) {
  await db.ensureAdminAuditLogsTable?.().catch(() => {});
  const [rows] = await db.pool.execute(
    `SELECT id FROM admin_audit_logs
     WHERE action = 'server_ssh_repair_notified'
       AND target_type = 'server'
       AND target_id = ?
     ORDER BY id DESC LIMIT 1`,
    [String(serverId)]
  );
  return rows.length > 0;
}

async function sendTelegram(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN_MISSING');
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: String(chatId), text })
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) throw new Error(`TELEGRAM_SEND_FAILED_${response.status}`);
}

async function main() {
  const ip = String(process.argv[2] || '').trim();
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) throw new Error('VALID_IPV4_REQUIRED');

  if (!await tcpOpen(ip)) throw new Error('SSH_NOT_REACHABLE_NO_NOTIFICATION');

  const purchase = await findPurchaseByIp(ip);
  if (!purchase) throw new Error('PURCHASE_NOT_FOUND_FOR_IP');
  const serverId = String(purchase.server_id);

  if (await alreadyNotified(serverId)) {
    console.log('[SSH_REPAIR_NOTIFY] already sent', { server_id: serverId, ip });
    return;
  }

  const text = [
    '✅ مشکل اتصال SSH سرور شما برطرف شد.',
    '',
    `IP: ${ip}`,
    'پورت SSH دوباره فعال و قابل دسترسی است.',
    'می‌توانید با همان اطلاعات ورود قبلی دوباره متصل شوید.',
    '',
    'HamoonCloud'
  ].join('\n');

  await sendTelegram(purchase.telegram_id, text);
  await db.adminAuditLog?.(
    'server_ssh_repair_notified',
    'automation',
    { type: 'server', id: serverId },
    { result: 'ok', datacenter: purchase.datacenter, ip, telegram_id: String(purchase.telegram_id) },
    null
  );

  console.log('[SSH_REPAIR_NOTIFY] sent', { server_id: serverId, ip, telegram_id: String(purchase.telegram_id) });
}

main()
  .catch(error => {
    console.error('[SSH_REPAIR_NOTIFY] FAILED:', String(error?.message || error).slice(0, 200));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.pool.end().catch(() => {});
  });
