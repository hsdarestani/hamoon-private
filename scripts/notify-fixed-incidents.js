#!/usr/bin/env node
'use strict';

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const mysql = require('mysql2/promise');
const TelegramBot = require('node-telegram-bot-api');

const INCIDENT_IP = String(process.env.INCIDENT_CHANGE_IP_OLD_IP || '5.75.195.244').trim();
const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
if (!token) throw new Error('TELEGRAM_BOT_TOKEN_MISSING');

function latestFailedUpgradeUser() {
  const candidates = [
    path.join(os.homedir(), '.pm2/logs/hamoonbot-error.log'),
    path.join(os.homedir(), '.pm2/logs/hamoonbot-out.log')
  ];
  const matches = [];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const stat = fs.statSync(file);
    const readBytes = Math.min(stat.size, 2 * 1024 * 1024);
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(readBytes);
    fs.readSync(fd, buffer, 0, readBytes, Math.max(0, stat.size - readBytes));
    fs.closeSync(fd);
    const text = buffer.toString('utf8');
    const re = /\[HETZNER_UPGRADE\]\s*\{([\s\S]*?)\n\}/g;
    let match;
    while ((match = re.exec(text))) {
      const block = match[1];
      if (!/status:\s*['"]failed['"]/.test(block)) continue;
      const user = block.match(/user:\s*['"](\d+)['"]/i)?.[1];
      const server = block.match(/server_id:\s*['"]([^'"]+)['"]/i)?.[1] || null;
      if (user) matches.push({ user, server, position: match.index, file });
    }
  }
  if (!matches.length) return null;
  // Error log contains the actual failed upgrade records. Prefer its latest match;
  // otherwise use the latest match from the available PM2 logs.
  const errors = matches.filter(item => item.file.endsWith('hamoonbot-error.log'));
  return (errors.length ? errors : matches).at(-1) || null;
}

async function main() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'hamooncloud_db'
  });
  const bot = new TelegramBot(token, { polling: false });

  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS incident_fix_notifications (
        incident_key VARCHAR(96) NOT NULL,
        telegram_id VARCHAR(64) NOT NULL,
        sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (incident_key, telegram_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const upgrade = latestFailedUpgradeUser();
    let upgradeSent = 0;
    if (upgrade?.user) {
      const [already] = await db.execute(
        'SELECT 1 FROM incident_fix_notifications WHERE incident_key=? AND telegram_id=? LIMIT 1',
        ['hetzner-upgrade-safety-20260902', upgrade.user]
      );
      if (!already.length) {
        const message = [
          'سلام 👋',
          '',
          'مشکلی که در «ارتقای پلن سرور» باعث می‌شد در صورت ناموفق بودن عملیات، سرور بعد از خاموش شدن به‌صورت خودکار روشن نشود برطرف شد ✅',
          '',
          'همچنین پلن‌های ناسازگار ARM و x86 دیگر برای ارتقای مستقیم پیشنهاد نمی‌شوند. از این پس اگر ارتقا در Hetzner خطا بخورد، پلن و هزینه تغییر نمی‌کند و اگر ربات سرور را برای ارتقا خاموش کرده باشد، آن را به وضعیت روشن قبلی برمی‌گرداند.',
          '',
          'می‌توانید مجدداً از بخش ارتقای سرور استفاده کنید.',
          'سپاس بابت گزارش مشکل 🌹'
        ].join('\n');
        await bot.sendMessage(upgrade.user, message);
        await db.execute(
          'INSERT IGNORE INTO incident_fix_notifications (incident_key, telegram_id) VALUES (?,?)',
          ['hetzner-upgrade-safety-20260902', upgrade.user]
        );
        upgradeSent = 1;
      }
    }

    const [ipRows] = await db.execute(
      'SELECT telegram_id FROM purchases WHERE public_ip=? ORDER BY updated_at DESC LIMIT 1',
      [INCIDENT_IP]
    );
    let changeIpSent = 0;
    const changeIpUser = ipRows?.[0]?.telegram_id ? String(ipRows[0].telegram_id) : '';
    if (changeIpUser) {
      const [already] = await db.execute(
        'SELECT 1 FROM incident_fix_notifications WHERE incident_key=? AND telegram_id=? LIMIT 1',
        ['hetzner-change-ip-inconclusive-20260902', changeIpUser]
      );
      if (!already.length) {
        const message = [
          'سلام 👋',
          '',
          'مشکل «تغییر IP» که در بعضی مواقع با نتیجه نامشخص بررسی دسترسی از ایران، عملیات را بعد از اولین IP جدید متوقف می‌کرد برطرف شد ✅',
          '',
          'از این پس اگر نتیجه یک IP جدید قطعی نباشد، ربات به‌صورت امن IP قبلی را برمی‌گرداند و چند IP جدید دیگر را هم بررسی می‌کند تا شانس دریافت IP سالم بیشتر شود. هیچ IP تأییدنشده‌ای روی سرور نهایی نمی‌شود.',
          '',
          'می‌توانید مجدداً از گزینه «تغییر IP» استفاده کنید.',
          'سپاس بابت گزارش مشکل 🌹'
        ].join('\n');
        await bot.sendMessage(changeIpUser, message);
        await db.execute(
          'INSERT IGNORE INTO incident_fix_notifications (incident_key, telegram_id) VALUES (?,?)',
          ['hetzner-change-ip-inconclusive-20260902', changeIpUser]
        );
        changeIpSent = 1;
      }
    }

    const refundResolutionUser = '278773395';
    let refundResolutionSent = 0;
    const [refundAlready] = await db.execute(
      'SELECT 1 FROM incident_fix_notifications WHERE incident_key=? AND telegram_id=? LIMIT 1',
      ['hoseinzadeh-refund-resolution-20260919', refundResolutionUser]
    );
    if (!refundAlready.length) {
      const message = [
        '✅ وضعیت سرور و کیف پول شما بررسی و اصلاح شد.',
        '',
        'سرور Srv-FIN-581e23 هیچ‌وقت تحویل نهایی نشده بود. از مبلغ کسرشده، ۱۱۶۴ تومان باقی‌مانده به کیف پول شما برگشت داده شد.',
        'موجودی فعلی کیف پول شما: ۱۰۳٬۳۵۱ تومان',
        '',
        'سرور Srv-FIN-9f6daa هم تحویل نشده بود و مبلغ ۲۹۶۲ تومان آن قبلاً به‌طور کامل برگشت داده شده است.',
        '',
        'کسرهای ساعتی حدود ۳۰۰۰ تومان مربوط به این دو سرور نیست و مربوط به Srv-FIN-7b24a5 است که فعال و تحویل‌شده است.',
        '',
        'برای سرورهای Hetzner تا قبل از تحویل نهایی، تمدید و Billing شروع نمی‌شود و در صورت حذف بدون تحویل، مبلغ خرید باید کامل Refund شود. 🙏'
      ].join('\n');
      await bot.sendMessage(refundResolutionUser, message);
      await db.execute(
        'INSERT IGNORE INTO incident_fix_notifications (incident_key, telegram_id) VALUES (?,?)',
        ['hoseinzadeh-refund-resolution-20260919', refundResolutionUser]
      );
      refundResolutionSent = 1;
    }

    console.log(`upgrade_notifications_sent=${upgradeSent}`);
    console.log(`change_ip_notifications_sent=${changeIpSent}`);\n    console.log(`refund_resolution_notifications_sent=${refundResolutionSent}`);
    console.log(`upgrade_recipient_resolved=${Boolean(upgrade?.user)}`);
    console.log(`change_ip_recipient_resolved=${Boolean(changeIpUser)}`);
  } finally {
    await db.end().catch(() => {});
    bot.stopPolling?.().catch?.(() => {});
  }
}

main().catch(error => {
  console.error('INCIDENT_NOTIFICATION_FAILED', error.code || error.message);
  process.exit(1);
});
