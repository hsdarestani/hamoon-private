#!/usr/bin/env node
'use strict';

require('dotenv').config();
const db = require('../db');
const datacenters = require('../datacenters');
const cloud = require('../cloud-api');
const { installHetznerPowerStateBarrier } = require('../services/hetzner-power-state-barrier');
installHetznerPowerStateBarrier();
const cleanIp = require('../services/hetzner-clean-ip-change');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function findPurchase(telegramId, ip) {
  const [rows] = await db.pool.execute(
    `SELECT * FROM purchases
      WHERE telegram_id = ? AND public_ip = ?
        AND COALESCE(status, '') NOT IN ('deleted','provider_missing')
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1`,
    [String(telegramId), String(ip)]
  );
  return rows[0] || null;
}

function dcForPurchase(purchase) {
  const key = String(purchase?.datacenter || '').trim();
  const dc = datacenters[key];
  if (!dc) throw new Error(`DATACENTER_NOT_FOUND:${key}`);
  return { key, dc };
}

async function waitRunning(dc, serverId, timeoutMs = 120000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await cloud.getServer(dc, null, serverId);
    const status = String(last?.status || last?.state || '').toLowerCase();
    if (['running','active','started'].includes(status)) return last;
    await sleep(2500);
  }
  const err = new Error(`POWER_ON_NOT_CONFIRMED:${last?.status || last?.state || 'unknown'}`);
  err.code = 'POWER_ON_NOT_CONFIRMED';
  throw err;
}

async function powerOn(telegramId, ip) {
  const purchase = await findPurchase(telegramId, ip);
  if (!purchase) throw new Error('PURCHASE_NOT_FOUND');
  const { key, dc } = dcForPurchase(purchase);
  const before = await cloud.getServer(dc, null, purchase.server_id);
  const beforeStatus = String(before?.status || before?.state || '').toLowerCase();
  if (!['running','active','started'].includes(beforeStatus)) {
    await cloud.resumeServer(dc, null, purchase.server_id);
  }
  const after = await waitRunning(dc, purchase.server_id);
  await db.updateScopedStatus?.(telegramId, purchase.server_id, key, 'active').catch(() => null);
  await db.updatePurchaseStatus(purchase.server_id, 'active').catch(() => null);
  const result = {
    action: 'power-on',
    ok: true,
    telegram_id: String(telegramId),
    server_id: String(purchase.server_id),
    datacenter: key,
    ip: String(ip),
    status_before: beforeStatus,
    status_after: String(after?.status || after?.state || '').toLowerCase()
  };
  console.log('[OPS_OWNER_IP_POWER_ON]', JSON.stringify(result));
  return result;
}

async function changeIp(telegramId, ip) {
  const purchase = await findPurchase(telegramId, ip);
  if (!purchase) throw new Error('PURCHASE_NOT_FOUND');
  const { key, dc } = dcForPurchase(purchase);
  const provider = String(dc.provider || dc.apiType || '').toLowerCase();
  if (provider !== 'hetzner') throw new Error(`PROVIDER_NOT_HETZNER:${provider || 'unknown'}`);

  process.env.HETZNER_CHANGE_IP_CLEAN_ATTEMPTS = process.env.HETZNER_CHANGE_IP_CLEAN_ATTEMPTS || '8';
  process.env.HETZNER_CHANGE_IP_INCONCLUSIVE_CANDIDATES = process.env.HETZNER_CHANGE_IP_INCONCLUSIVE_CANDIDATES || '2';
  process.env.HETZNER_CHANGE_IP_REJECTED_COOLDOWN_MS = process.env.HETZNER_CHANGE_IP_REJECTED_COOLDOWN_MS || '0';

  try {
    const result = await cleanIp.changeHetznerPublicIp({
      db,
      dc,
      telegramId: String(telegramId),
      serverId: String(purchase.server_id),
      datacenter: key
    });
    const out = {
      action: 'change-ip',
      ok: true,
      telegram_id: String(telegramId),
      server_id: String(purchase.server_id),
      datacenter: key,
      old_ip: result.oldIp,
      new_ip: result.newIp,
      attempts: result.attempts || null
    };
    console.log('[OPS_OWNER_IP_CHANGE_IP]', JSON.stringify(out));
    return out;
  } catch (error) {
    const out = {
      action: 'change-ip',
      ok: false,
      telegram_id: String(telegramId),
      server_id: String(purchase.server_id),
      datacenter: key,
      current_ip: error?.currentIp || ip,
      candidate_ip: error?.candidateIp || error?.lastCandidateIp || null,
      attempts: error?.attempts || null,
      code: error?.code || null,
      message: error?.message || String(error)
    };
    console.error('[OPS_OWNER_IP_CHANGE_IP_FAILED]', JSON.stringify(out));
    throw Object.assign(error, { opsResult: out });
  }
}

async function main() {
  const [action, telegramId, ip] = process.argv.slice(2);
  if (!['power-on','change-ip'].includes(action) || !telegramId || !ip) {
    throw new Error('Usage: node scripts/ops-server-by-owner-ip.js <power-on|change-ip> <telegram-id> <current-ip>');
  }
  try {
    if (action === 'power-on') await powerOn(telegramId, ip);
    else await changeIp(telegramId, ip);
  } finally {
    await db.pool.end().catch(() => {});
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('[OPS_OWNER_IP_FAILED]', JSON.stringify({
      code: error?.code || null,
      message: error?.message || String(error),
      result: error?.opsResult || null
    }));
    process.exit(1);
  });
}

module.exports = { findPurchase, powerOn, changeIp, waitRunning };
