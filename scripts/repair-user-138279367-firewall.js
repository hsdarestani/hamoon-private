'use strict';

const net = require('net');
require('dotenv').config();
const mysql = require('mysql2/promise');
const dcs = require('../datacenters');
const hetzner = require('../Hetzner/hetzner-api');

const USER_ID = '138279367';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function dbConnection() {
  return mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'hamooncloud_db'
  });
}

function targetsServer(fw, serverId) {
  return (fw?.applied_to || []).some(item =>
    String(item?.type || '').toLowerCase() === 'server' &&
    String(item?.server?.id ?? item?.server_id ?? '') === String(serverId)
  );
}

function blocksAllInbound(fw) {
  return !(fw?.rules || []).some(rule => String(rule?.direction || '').toLowerCase() === 'in');
}

function tcp22(ip, timeout = 4000) {
  return new Promise(resolve => {
    if (!ip) return resolve(false);
    const socket = net.createConnection({ host: ip, port: 22 });
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function waitTcp(ip, attempts = 30) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const ok = await tcp22(ip);
    console.log('TCP22', { attempt, ip, ok });
    if (ok) return true;
    if (attempt < attempts) await sleep(3000);
  }
  return false;
}

async function main() {
  const conn = await dbConnection();
  let purchases;
  try {
    [purchases] = await conn.execute(
      "SELECT server_id,datacenter,public_ip,status FROM purchases WHERE telegram_id=? AND status<>'deleted' ORDER BY created_at DESC",
      [USER_ID]
    );
  } finally {
    await conn.end();
  }

  if (purchases.length !== 1) throw new Error(`EXPECTED_ONE_LIVE_PURCHASE_GOT_${purchases.length}`);
  const purchase = purchases[0];
  const dc = dcs[purchase.datacenter];
  if (!dc || String(dc.provider || dc.apiType || '').toLowerCase() !== 'hetzner') throw new Error('LIVE_PURCHASE_NOT_HETZNER');

  const serverId = String(purchase.server_id);
  let server = (await hetzner.hetznerRequest(dc, 'GET', `/servers/${serverId}`)).server;
  const ip = server?.public_net?.ipv4?.ip || purchase.public_ip || null;
  if (!ip) throw new Error('SERVER_IPV4_MISSING');

  const all = (await hetzner.hetznerRequest(dc, 'GET', '/firewalls?per_page=50')).firewalls || [];
  const attached = all.filter(fw => targetsServer(fw, serverId));
  const blocking = attached.filter(blocksAllInbound);
  console.log('FIREWALL_STATE', JSON.stringify({attached:attached.map(f=>({id:f.id,name:f.name,rules:(f.rules||[]).length})),blocking:blocking.map(f=>({id:f.id,name:f.name}))}));

  if (!blocking.length) throw new Error('NO_BLOCKING_FIREWALL_FOUND');

  for (const fw of blocking) {
    console.log('DETACH_FIREWALL', { id: fw.id, name: fw.name, server_id: serverId });
    const response = await hetzner.hetznerRequest(dc, 'POST', `/firewalls/${fw.id}/actions/remove_from_resources`, {
      remove_from: [{ type: 'server', server: { id: Number(serverId) } }]
    });
    if (response?.action?.id) await hetzner.waitHetznerAction(dc, response.action.id, 120000);
  }

  const afterAll = (await hetzner.hetznerRequest(dc, 'GET', '/firewalls?per_page=50')).firewalls || [];
  const afterAttached = afterAll.filter(fw => targetsServer(fw, serverId));
  console.log('FIREWALL_AFTER', JSON.stringify(afterAttached.map(f=>({id:f.id,name:f.name}))));

  // Rescue boot is one-shot, but reboot once after detaching to guarantee the normal disk is booted.
  const reboot = await hetzner.hetznerRequest(dc, 'POST', `/servers/${serverId}/actions/reboot`, {});
  if (reboot?.action?.id) await hetzner.waitHetznerAction(dc, reboot.action.id, 180000);
  await sleep(8000);

  const reachable = await waitTcp(ip, 30);
  server = (await hetzner.hetznerRequest(dc, 'GET', `/servers/${serverId}`)).server;
  const currentIp = server?.public_net?.ipv4?.ip || ip;

  const sync = await dbConnection();
  try {
    await sync.execute(
      "UPDATE purchases SET public_ip=?,status='active',suspend_reason=NULL,lifecycle_error_code=NULL,lifecycle_updated_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE telegram_id=? AND server_id=? AND datacenter=? AND status<>'deleted'",
      [currentIp, USER_ID, serverId, String(purchase.datacenter)]
    );
  } finally {
    await sync.end();
  }

  console.log('FINAL', JSON.stringify({server_id:serverId,status:server?.status||null,ip:currentIp,tcp22:reachable,firewalls_remaining:afterAttached.length}));
  if (!reachable) throw Object.assign(new Error('TCP22_STILL_UNREACHABLE_AFTER_FIREWALL_DETACH'), { code: 'TCP22_STILL_UNREACHABLE_AFTER_FIREWALL_DETACH' });
}

main().catch(error => {
  console.error('FIREWALL_REPAIR_FATAL', JSON.stringify({code:error?.code||null,message:String(error?.message||error).slice(0,400)}));
  process.exitCode = 1;
});
