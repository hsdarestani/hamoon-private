#!/usr/bin/env node
'use strict';

require('dotenv').config();
const axios = require('axios');
const db = require('../db');
const cloud = require('../cloud-api');
const datacenters = require('../datacenters');
const { settleServerRenewalAtomic } = require('../billing-settlement');
const { rollbackServerRenewalAtomic } = require('../billing-settlement-recovery');

const HOURS_IN_CYCLE = Object.freeze({ hourly: 1, daily: 24, weekly: 168, monthly: 720 });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function cyclePrice(flavor, cycle) {
  const hours = HOURS_IN_CYCLE[cycle] || 0;
  if (!hours) return 0;
  const monthly = Number(
    flavor?.amount_monthly ?? flavor?.monthly_toman ?? flavor?.monthly_price_toman ?? flavor?.monthly_price ?? 0
  );
  const hourly = Number(
    flavor?.amount_hourly ?? flavor?.hourly_price_toman ?? flavor?.price ?? (monthly > 0 ? monthly / 720 : 0)
  );
  if (cycle === 'monthly') return Math.round(monthly || hourly * 720);
  return Math.round(hourly * hours);
}

function normalizeStoredCycleAmount(purchase, dcConfig = {}) {
  const amount = Number(purchase?.amount || 0);
  const cycle = String(purchase?.duration || 'hourly');
  const hours = HOURS_IN_CYCLE[cycle] || 0;
  if (!(amount > 0) || !hours || cycle === 'hourly') return amount;
  if (Number(purchase?.billing_amount_version || 1) >= 2) return amount;

  const flavorId = String(purchase?.flavor_id || '').trim().toLowerCase();
  const flavor = (dcConfig.flavors || []).find(item =>
    [item?.id, item?.hetzner_type, item?.server_type]
      .map(value => String(value || '').trim().toLowerCase())
      .includes(flavorId)
  );
  const expected = flavor ? cyclePrice(flavor, cycle) : 0;
  if (!(expected > 0)) return Math.round(amount * hours);

  const expandedLegacy = Math.round(amount * hours);
  const tolerance = Math.max(1, expected * 0.03);
  return Math.abs(expandedLegacy - expected) + tolerance < Math.abs(amount - expected)
    ? expandedLegacy
    : amount;
}

async function getProviderState(dcConfig, serverId) {
  try {
    const server = await cloud.getServer(dcConfig, null, serverId);
    const status = String(server?.status || '').toLowerCase();
    return { running: status === 'running' || status === 'active', status };
  } catch (error) {
    return { running: false, status: 'lookup_failed', error };
  }
}

async function waitRunning(dcConfig, serverId, attempts = 18) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await getProviderState(dcConfig, serverId);
    if (last.running) return last;
    if (attempt + 1 < attempts) await sleep(2000);
  }
  return last || { running: false, status: 'unknown' };
}

async function sendTelegram(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN_MISSING');
  const response = await axios.post(
    `https://api.telegram.org/bot${token}/sendMessage`,
    { chat_id: String(chatId), text },
    { timeout: 15000 }
  );
  if (!response.data?.ok) throw new Error('TELEGRAM_SEND_FAILED');
}

async function findPurchaseByName(serverName) {
  const [rows] = await db.pool.execute(
    `SELECT * FROM purchases
     WHERE server_name = ?
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1`,
    [String(serverName)]
  );
  return rows[0] || null;
}

async function notificationAlreadySent(telegramId, serverName) {
  const marker = `ops-recovery-complete:${serverName}`;
  const [rows] = await db.pool.execute(
    `SELECT id FROM wallet_logs
     WHERE telegram_id = ? AND type = 'ops_recovery' AND description = ?
     ORDER BY id DESC LIMIT 1`,
    [String(telegramId), marker]
  );
  return rows.length > 0;
}

async function markNotificationSent(telegramId, serverName) {
  await db.recordWalletLog(
    telegramId,
    0,
    `ops-recovery-complete:${serverName}`,
    'ops_recovery'
  );
}

async function recover(serverName, { notify = true } = {}) {
  const purchase = await findPurchaseByName(serverName);
  if (!purchase) throw new Error(`RECOVERY_PURCHASE_NOT_FOUND:${serverName}`);

  const userId = String(purchase.telegram_id);
  const dcKey = String(purchase.datacenter || '').trim();
  const dcConfig = datacenters[dcKey];
  if (!dcConfig) throw new Error(`RECOVERY_DATACENTER_NOT_FOUND:${dcKey}`);
  const provider = String(dcConfig.provider || dcConfig.apiType || '').toLowerCase();
  if (provider !== 'hetzner') throw new Error(`RECOVERY_PROVIDER_NOT_HETZNER:${provider || 'unknown'}`);

  const walletBefore = Number(await db.getUserWallet(userId) || 0);
  const cycle = String(purchase.duration || 'hourly');
  const cycleHours = HOURS_IN_CYCLE[cycle] || 0;
  if (!cycleHours) throw new Error(`RECOVERY_INVALID_CYCLE:${cycle}`);

  const base = new Date(purchase.last_billed_at || purchase.created_at || Date.now());
  if (Number.isNaN(base.getTime())) throw new Error('RECOVERY_INVALID_BILLING_DATE');
  const dueAt = new Date(base.getTime() + cycleHours * 3600000);
  const cycleDue = dueAt.getTime() <= Date.now();
  const renewalAmount = normalizeStoredCycleAmount(purchase, dcConfig);

  console.log('[OPS_RECOVERY_BEGIN]', {
    server_name: serverName,
    server_id: purchase.server_id,
    datacenter: dcKey,
    db_status: purchase.status,
    cycle,
    cycle_due: cycleDue,
    wallet_before: Math.floor(walletBefore)
  });

  let settlement = { status: 'not_due', charged: 0, eventKey: null };
  if (cycleDue) {
    if (Number(purchase.auto_renew ?? 1) !== 1) throw new Error('RECOVERY_AUTO_RENEW_DISABLED');
    if (!(renewalAmount > 0)) throw new Error('RECOVERY_RENEWAL_AMOUNT_INVALID');
    settlement = await settleServerRenewalAtomic({
      telegramId: userId,
      serverId: purchase.server_id,
      datacenter: dcKey,
      serverName: serverName,
      renewalAmount,
      trafficCost: 0,
      billableTrafficGb: purchase.last_billed_traffic_gb,
      now: new Date()
    });
    if (settlement.status === 'insufficient') {
      const error = new Error(`RECOVERY_WALLET_INSUFFICIENT:required=${settlement.required};balance=${settlement.balance}`);
      error.code = 'RECOVERY_WALLET_INSUFFICIENT';
      throw error;
    }
    if (!['charged', 'not_due', 'already_settled'].includes(settlement.status)) {
      throw new Error(`RECOVERY_SETTLEMENT_FAILED:${settlement.status}`);
    }
  }

  let state = await getProviderState(dcConfig, purchase.server_id);
  let powerError = null;
  if (!state.running) {
    try {
      await cloud.resumeServer(dcConfig, null, purchase.server_id);
    } catch (error) {
      powerError = error;
      console.warn('[OPS_RECOVERY_POWER_REQUEST_ERROR]', {
        server_name: serverName,
        status: error?.status || error?.response?.status || null,
        code: error?.code || error?.data?.error?.code || null,
        message: error?.message || String(error)
      });
    }
    state = await waitRunning(dcConfig, purchase.server_id, powerError ? 20 : 15);
  }

  if (!state.running) {
    if (settlement.status === 'charged' && settlement.eventKey) {
      await rollbackServerRenewalAtomic({
        telegramId: userId,
        serverId: purchase.server_id,
        datacenter: dcKey,
        eventKey: settlement.eventKey,
        reason: 'resume_failed'
      });
    } else {
      await db.updatePurchaseStatus(purchase.server_id, 'suspended').catch(() => {});
      await db.updatePurchaseSuspendReason(purchase.server_id, 'resume_failed').catch(() => {});
    }
    const error = powerError || new Error(`RECOVERY_POWER_ON_NOT_CONFIRMED:${state.status}`);
    error.code = error.code || 'RECOVERY_POWER_ON_NOT_CONFIRMED';
    throw error;
  }

  await db.updatePurchaseStatus(purchase.server_id, 'active');
  await db.updatePurchaseSuspendReason(purchase.server_id, null).catch(() => {});
  const walletAfter = Number(await db.getUserWallet(userId) || 0);

  let notified = false;
  if (notify && !(await notificationAlreadySent(userId, serverName))) {
    const lines = [
      '✅ مشکل روشن‌کردن سرور برطرف شد و سرور شما مجدداً روشن و فعال است.',
      '',
      `سرور: ${serverName}`,
      'وضعیت: فعال'
    ];
    if (settlement.status === 'charged' && Number(settlement.charged || 0) > 0) {
      lines.push(`هزینه تمدید دوره جدید طبق روال از کیف پول کسر شد: ${Math.round(settlement.charged).toLocaleString('en-US')} تومان`);
    }
    lines.push('', 'صورتحساب و موجودی کیف پول نیز بررسی شد. بابت اختلال پیش‌آمده پوزش می‌خواهیم.');
    await sendTelegram(userId, lines.join('\n'));
    await markNotificationSent(userId, serverName);
    notified = true;
  }

  const result = {
    ok: true,
    server_name: serverName,
    server_id: purchase.server_id,
    user_id: userId,
    provider_status: state.status,
    settlement_status: settlement.status,
    charged: Math.round(Number(settlement.charged || 0)),
    wallet_before: Math.floor(walletBefore),
    wallet_after: Math.floor(walletAfter),
    notified
  };
  console.log('[OPS_RECOVERY_SUCCESS]', result);
  return result;
}

async function main() {
  const serverName = String(process.argv[2] || '').trim();
  if (!serverName) throw new Error('Usage: node scripts/recover-suspended-server.js <server-name> [--no-notify]');
  const notify = !process.argv.includes('--no-notify');
  try {
    await recover(serverName, { notify });
  } finally {
    await db.pool.end().catch(() => {});
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('[OPS_RECOVERY_FAILED]', {
      code: error?.code || null,
      status: error?.status || error?.response?.status || null,
      message: error?.message || String(error)
    });
    process.exit(1);
  });
}

module.exports = { recover, normalizeStoredCycleAmount, waitRunning };
