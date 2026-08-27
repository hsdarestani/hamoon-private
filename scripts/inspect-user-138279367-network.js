'use strict';

require('dotenv').config();
const mysql = require('mysql2/promise');
const dcs = require('../datacenters');
const hetzner = require('../Hetzner/hetzner-api');

const USER_ID = '138279367';

async function dbConnection() {
  return mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'hamooncloud_db'
  });
}

function firewallTargetsServer(fw, serverId) {
  return (fw?.applied_to || []).some(item =>
    String(item?.type || '').toLowerCase() === 'server' &&
    String(item?.server?.id ?? item?.server_id ?? '') === String(serverId)
  );
}

async function main() {
  const conn = await dbConnection();
  let rows;
  try {
    [rows] = await conn.execute(
      "SELECT server_id,datacenter,public_ip,status,suspend_reason FROM purchases WHERE telegram_id=? AND status<>'deleted' ORDER BY created_at DESC",
      [USER_ID]
    );
  } finally {
    await conn.end();
  }
  if (rows.length !== 1) throw new Error(`EXPECTED_ONE_LIVE_PURCHASE_GOT_${rows.length}`);
  const p = rows[0];
  const dc = dcs[p.datacenter];
  if (!dc || String(dc.provider || dc.apiType || '').toLowerCase() !== 'hetzner') throw new Error('LIVE_PURCHASE_NOT_HETZNER');

  const server = (await hetzner.hetznerRequest(dc, 'GET', `/servers/${encodeURIComponent(String(p.server_id))}`)).server;
  const ipv4 = server?.public_net?.ipv4 || null;
  const ipv6 = server?.public_net?.ipv6 || null;
  console.log('SERVER_NETWORK', JSON.stringify({
    id: String(server?.id || ''),
    name: server?.name || null,
    status: server?.status || null,
    rescue_enabled: Boolean(server?.rescue_enabled),
    locked: Boolean(server?.locked),
    location: server?.datacenter?.location?.name || null,
    datacenter: server?.datacenter?.name || null,
    ipv4: ipv4 ? { id: ipv4.id, ip: ipv4.ip, blocked: ipv4.blocked, dns_ptr: ipv4.dns_ptr } : null,
    ipv6: ipv6 ? { id: ipv6.id, ip: ipv6.ip, blocked: ipv6.blocked } : null,
    private_net_count: Array.isArray(server?.private_net) ? server.private_net.length : 0,
    db_ip: p.public_ip || null,
    db_status: p.status || null,
    db_suspend_reason: p.suspend_reason || null
  }));

  if (ipv4?.id) {
    try {
      const primary = (await hetzner.hetznerRequest(dc, 'GET', `/primary_ips/${ipv4.id}`)).primary_ip;
      console.log('PRIMARY_IPV4', JSON.stringify({
        id: primary?.id,
        ip: primary?.ip,
        blocked: primary?.blocked,
        assignee_id: primary?.assignee_id,
        assignee_type: primary?.assignee_type,
        auto_delete: primary?.auto_delete,
        location: primary?.datacenter?.location?.name || primary?.location?.name || null
      }));
    } catch (e) {
      console.log('PRIMARY_IPV4_ERROR', JSON.stringify({status:e?.status||e?.response?.status||null,code:e?.data?.error?.code||null,message:String(e?.message||e).slice(0,180)}));
    }
  }

  const firewalls = (await hetzner.hetznerRequest(dc, 'GET', '/firewalls?per_page=50')).firewalls || [];
  const attached = firewalls.filter(fw => firewallTargetsServer(fw, p.server_id));
  console.log('ATTACHED_FIREWALL_COUNT=' + attached.length);
  for (const fw of attached) {
    console.log('ATTACHED_FIREWALL', JSON.stringify({
      id: fw.id,
      name: fw.name,
      rules: (fw.rules || []).map(rule => ({
        direction: rule.direction,
        protocol: rule.protocol,
        port: rule.port || null,
        source_ips: rule.source_ips || [],
        destination_ips: rule.destination_ips || [],
        description: rule.description || null
      }))
    }));
  }

  const allActions = await hetzner.hetznerRequest(dc, 'GET', `/servers/${p.server_id}/actions?sort=id:desc&per_page=20`).catch(() => ({actions:[]}));
  console.log('RECENT_ACTIONS', JSON.stringify((allActions.actions || []).map(a => ({id:a.id,command:a.command,status:a.status,error:a.error||null,started:a.started,finished:a.finished})).slice(0,20)));
}

main().catch(error => {
  console.error('INSPECT_FATAL', JSON.stringify({code:error?.code||null,message:String(error?.message||error).slice(0,300)}));
  process.exitCode = 1;
});
