#!/usr/bin/env node
'use strict';

require('dotenv').config();
const mysql = require('mysql2/promise');
const runtime = require('../runtime-bootstrap');
const { installStrictCheckHostFetch } = require('../services/check-host-strict-fetch');

runtime.applyRuntimeSafetyDefaults();
installStrictCheckHostFetch();
runtime.installSafeLifecycleModule();
runtime.installCleanIpChangeModule();

// This is a one-time incident recovery path, not the normal customer button.
// Give it a few more verified candidates while preserving the exact same
// fail-closed Iran checks and rollback semantics.
process.env.HETZNER_CHANGE_IP_CLEAN_ATTEMPTS = String(
  Math.max(4, Math.min(8, Number(process.env.HETZNER_INCIDENT_CHANGE_IP_ATTEMPTS || 8)))
);

const db = require('../db');
const datacenters = require('../datacenters');
const { changeHetznerPublicIp, userMessageForError } = require('../services/hetzner-change-ip');

const lookbackHoursRaw = Number(process.env.HETZNER_CHANGE_IP_RECOVERY_LOOKBACK_HOURS || 12);
const lookbackHours = Number.isFinite(lookbackHoursRaw)
  ? Math.max(1, Math.min(72, Math.floor(lookbackHoursRaw)))
  : 12;
const cutoff = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
const token = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '';

async function telegramSend(chatId, text) {
  if (!token || !chatId) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: String(chatId), text: String(text) }),
      signal: controller.signal
    });
    return response.ok;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'hamooncloud_db'
  });

  let candidates = [];
  try {
    // A Change-IP incident is unresolved only when the latest manual clean-IP
    // rejection is newer than the latest successful clean-IP commit. Provisioning
    // rejection events use different names and are intentionally excluded here.
    const [rows] = await connection.query(
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
          AND LOWER(p.status) IN ('active','running','suspended','stopped','shutoff')
          AND h.last_seen_at >= ?
        GROUP BY p.telegram_id, p.server_id, p.datacenter, p.public_ip
       HAVING last_failure_at IS NOT NULL
          AND (last_success_at IS NULL OR last_success_at < last_failure_at)
        ORDER BY last_failure_at ASC`,
      [cutoff]
    );
    candidates = rows || [];
  } finally {
    await connection.end();
  }

  console.log('HETZNER_CHANGE_IP_RECOVERY_MATCHED=' + candidates.length);
  const results = [];

  for (const row of candidates) {
    const dc = datacenters[row.datacenter];
    if (!dc) {
      results.push({ server_id: row.server_id, status: 'missing_datacenter' });
      continue;
    }

    try {
      const result = await changeHetznerPublicIp({
        db,
        dc,
        telegramId: row.telegram_id,
        serverId: row.server_id,
        datacenter: row.datacenter
      });

      const notified = await telegramSend(
        row.telegram_id,
        `✅ درخواست تغییر IP قبلی شما به‌صورت خودکار تکمیل شد.\n` +
        `IP قبلی: ${result.oldIp}\n` +
        `IP جدید: ${result.newIp}\n\n` +
        `✅ IP جدید از ایران بررسی و تأیید شده است. نیازی به پیام به پشتیبانی نیست.`
      );

      results.push({
        telegram_id: row.telegram_id,
        server_id: row.server_id,
        status: 'recovered',
        old_ip: result.oldIp,
        new_ip: result.newIp,
        attempts: result.attempts,
        notified
      });
    } catch (error) {
      // The clean-IP module has already rolled the server back to its previous IP
      // when verification failed. Never leave an unverified candidate committed.
      const notified = await telegramSend(
        row.telegram_id,
        `⏳ درخواست تغییر IP قبلی شما دوباره به‌صورت خودکار بررسی شد، اما فعلاً IP سالم جدیدی در لوکیشن فعلی پیدا نشد.\n` +
        `IP قبلی شما حفظ شده و سرور بدون IP تأییدنشده باقی مانده است.\n` +
        `نیازی به پیام به پشتیبانی نیست.`
      );
      results.push({
        telegram_id: row.telegram_id,
        server_id: row.server_id,
        status: 'not_recovered',
        code: error?.code || null,
        message: userMessageForError(error),
        notified
      });
    }
  }

  console.log('HETZNER_CHANGE_IP_RECOVERY_RESULTS=' + JSON.stringify(results));
})().catch(error => {
  console.error('HETZNER_CHANGE_IP_RECOVERY_FAILED=' + String(error?.message || error));
  process.exit(1);
});
