'use strict';

const net = require('net');
const clean = require('./hetzner-clean-ip-change');
const cloud = require('../cloud-api');
const hetznerApi = require('../Hetzner/hetzner-api');

const HYDRATION_MARK = Symbol.for('hamoon.hetznerPrimaryIdHydrationInstalled');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function normalizeIpv4(value) {
  const ip = String(value || '').trim();
  return net.isIP(ip) === 4 ? ip : null;
}

function serverIpv4(server) {
  return normalizeIpv4(server?.public_net?.ipv4?.ip || server?.public_ip || server?.ip);
}

async function findPrimaryIpv4ByIp(dc, ip) {
  const normalized = normalizeIpv4(ip);
  if (!normalized) return null;
  const data = await hetznerApi.hetznerRequest(
    dc,
    'GET',
    `/primary_ips?ip=${encodeURIComponent(normalized)}&per_page=50`
  );
  return (data?.primary_ips || []).find(item =>
    String(item?.type || '').toLowerCase() === 'ipv4' &&
    normalizeIpv4(item?.ip) === normalized
  ) || null;
}

function installPrimaryIdHydration() {
  if (hetznerApi[HYDRATION_MARK]) return false;
  const originalGet = hetznerApi.getHetznerServer.bind(hetznerApi);
  hetznerApi.getHetznerServer = async function getHetznerServerWithPrimaryId(dc, serverId) {
    const server = await originalGet(dc, serverId);
    const ipv4 = serverIpv4(server);
    const existingId = server?.public_net?.ipv4?.id ?? server?.primary_ipv4_id ?? null;
    if (!ipv4 || existingId != null) return server;

    try {
      const primary = await findPrimaryIpv4ByIp(dc, ipv4);
      if (!primary?.id) return server;
      const assigneeId = primary.assignee_id == null ? null : String(primary.assignee_id);
      if (assigneeId && assigneeId !== String(serverId)) return server;
      server.public_net = server.public_net || {};
      server.public_net.ipv4 = { ...(server.public_net.ipv4 || {}), ip: ipv4, id: String(primary.id) };
      console.log('[HETZNER_PRIMARY_ID_HYDRATED]', {
        server_id: String(serverId),
        primary_ip_id: String(primary.id),
        ip: ipv4
      });
    } catch (error) {
      console.warn('[HETZNER_PRIMARY_ID_HYDRATE_FAILED]', {
        server_id: String(serverId),
        ip: ipv4,
        message: error?.message || String(error)
      });
    }
    return server;
  };
  hetznerApi[HYDRATION_MARK] = true;
  return true;
}

installPrimaryIdHydration();

async function waitForAttachedIpv4(dc, serverId, expectedIp, timeoutMs = 120000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await hetznerApi.getHetznerServer(dc, serverId);
    const ip = serverIpv4(last);
    const status = String(last?.status || '').toLowerCase();
    if (ip === expectedIp && ['running', 'active', 'started'].includes(status)) return last;
    await sleep(1500);
  }
  const error = new Error(`PERSISTED_PRIMARY_REATTACH_NOT_READY:${serverIpv4(last) || 'no-ip'}`);
  error.code = 'PERSISTED_PRIMARY_REATTACH_NOT_READY';
  throw error;
}

async function ensurePersistedPrimaryAttached(args) {
  const { db, dc, telegramId, serverId, datacenter } = args;
  const purchase = await db.getPurchaseForOwner(telegramId, serverId, datacenter);
  if (!purchase) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });

  let server = await hetznerApi.getHetznerServer(dc, serverId);
  if (serverIpv4(server)) return { repaired: false, server };

  const persistedIp = normalizeIpv4(purchase.public_ip);
  if (!persistedIp) {
    const error = new Error('PERSISTED_PRIMARY_IPV4_NOT_FOUND');
    error.code = 'PERSISTED_PRIMARY_IPV4_NOT_FOUND';
    throw error;
  }

  const primary = await findPrimaryIpv4ByIp(dc, persistedIp);
  if (!primary?.id) {
    const error = new Error('PERSISTED_PRIMARY_RESOURCE_NOT_FOUND');
    error.code = 'PERSISTED_PRIMARY_RESOURCE_NOT_FOUND';
    error.currentIp = persistedIp;
    throw error;
  }

  const assigneeId = primary.assignee_id == null ? null : String(primary.assignee_id);
  if (assigneeId && assigneeId !== String(serverId)) {
    const error = new Error('PERSISTED_PRIMARY_OWNERSHIP_CONFLICT');
    error.code = 'PERSISTED_PRIMARY_OWNERSHIP_CONFLICT';
    error.currentIp = persistedIp;
    error.assigneeId = assigneeId;
    throw error;
  }

  const wasRunning = ['running', 'active', 'started'].includes(String(server?.status || '').toLowerCase());
  if (!assigneeId) {
    if (wasRunning) {
      const off = await cloud.powerOffHetznerServer(dc, serverId);
      const offId = off?.id ?? off?.action?.id ?? null;
      if (offId) await cloud.waitHetznerAction(dc, offId, 180000);
    }

    const assign = await cloud.assignPrimaryIp(dc, null, String(primary.id), String(serverId));
    const assignId = assign?.id ?? assign?.action?.id ?? null;
    if (assignId) await cloud.waitHetznerAction(dc, assignId, 180000);

    if (wasRunning) {
      const on = await cloud.powerOnHetznerServer(dc, serverId);
      const onId = on?.id ?? on?.action?.id ?? null;
      if (onId) await cloud.waitHetznerAction(dc, onId, 180000);
      server = await waitForAttachedIpv4(dc, serverId, persistedIp);
    } else {
      server = await hetznerApi.getHetznerServer(dc, serverId);
    }
  } else if (wasRunning) {
    server = await waitForAttachedIpv4(dc, serverId, persistedIp);
  }

  await db.updatePublicIp(telegramId, serverId, datacenter, persistedIp).catch(() => {});
  console.log('[HETZNER_CHANGE_IP_REATTACHED_PERSISTED_PRIMARY]', {
    server_id: String(serverId),
    primary_ip_id: String(primary.id),
    ip: persistedIp,
    was_running: wasRunning
  });
  return { repaired: true, server, primary };
}

async function changeHetznerPublicIp(args) {
  await ensurePersistedPrimaryAttached(args);
  return clean.changeHetznerPublicIp(args);
}

function userMessageForError(error) {
  const code = String(error?.code || error?.message || '');
  if (code === 'PERSISTED_PRIMARY_RESOURCE_NOT_FOUND') {
    return 'IPv4 قبلی در حساب Hetzner پیدا نشد و برای جلوگیری از قطعی، تغییر IP متوقف شد. لطفاً با پشتیبانی تماس بگیرید.';
  }
  if (code === 'PERSISTED_PRIMARY_OWNERSHIP_CONFLICT') {
    return 'IPv4 ثبت‌شده به منبع دیگری متصل است. برای جلوگیری از تغییر اشتباه، عملیات متوقف شد و نیاز به بررسی پشتیبانی دارد.';
  }
  if (code === 'PERSISTED_PRIMARY_REATTACH_NOT_READY') {
    return 'IPv4 قبلی بازیابی شد اما شبکه سرور هنوز آماده نشد. عملیات تغییر IP متوقف شد تا اتصال فعلی حفظ شود.';
  }
  return clean.userMessageForError(error);
}

module.exports = {
  ...clean,
  findPrimaryIpv4ByIp,
  installPrimaryIdHydration,
  ensurePersistedPrimaryAttached,
  changeHetznerPublicIp,
  userMessageForError
};
