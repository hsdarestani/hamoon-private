#!/usr/bin/env node
'use strict';

require('dotenv').config();
const db = require('../db');
const datacenters = require('../datacenters');
const hetznerApi = require('../Hetzner/hetzner-api');

async function findPurchase(telegramId, ip) {
  const [rows] = await db.pool.execute(
    `SELECT * FROM purchases
      WHERE telegram_id = ?
        AND (? = '' OR public_ip = ?)
        AND COALESCE(status, '') NOT IN ('deleted','provider_missing')
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1`,
    [String(telegramId), String(ip || ''), String(ip || '')]
  );
  return rows[0] || null;
}

function slimPrimary(p) {
  if (!p) return null;
  return {
    id: p.id == null ? null : String(p.id),
    ip: p.ip || null,
    type: p.type || null,
    assignee_id: p.assignee_id == null ? null : String(p.assignee_id),
    assignee_type: p.assignee_type || null,
    auto_delete: !!p.auto_delete,
    location: p.location?.name || p.location || null,
    name: p.name || null
  };
}

async function inspect(telegramId, ip) {
  const purchase = await findPurchase(telegramId, ip);
  if (!purchase) throw new Error('PURCHASE_NOT_FOUND');
  const dcKey = String(purchase.datacenter || '').trim();
  const dc = datacenters[dcKey];
  if (!dc) throw new Error(`DATACENTER_NOT_FOUND:${dcKey}`);

  const serverData = await hetznerApi.hetznerRequest(dc, 'GET', `/servers/${encodeURIComponent(purchase.server_id)}`);
  const server = serverData?.server || null;
  const byAssignee = await hetznerApi.hetznerRequest(
    dc,
    'GET',
    `/primary_ips?assignee_id=${encodeURIComponent(purchase.server_id)}&assignee_type=server&per_page=50`
  ).catch(error => ({ primary_ips: [], query_error: error?.message || String(error) }));
  const byIp = purchase.public_ip
    ? await hetznerApi.hetznerRequest(
        dc,
        'GET',
        `/primary_ips?ip=${encodeURIComponent(purchase.public_ip)}&per_page=50`
      ).catch(error => ({ primary_ips: [], query_error: error?.message || String(error) }))
    : { primary_ips: [] };

  const result = {
    telegram_id: String(telegramId),
    purchase: {
      server_id: String(purchase.server_id),
      datacenter: dcKey,
      status: purchase.status || null,
      public_ip: purchase.public_ip || null,
      server_name: purchase.server_name || null
    },
    server: server ? {
      id: String(server.id),
      status: server.status || null,
      ipv4: server.public_net?.ipv4 || null,
      ipv6: server.public_net?.ipv6 ? { ip: server.public_net.ipv6.ip || null } : null,
      location: server.datacenter?.location?.name || server.location?.name || null
    } : null,
    primary_ips_by_assignee: (byAssignee.primary_ips || []).map(slimPrimary),
    primary_ips_by_persisted_ip: (byIp.primary_ips || []).map(slimPrimary),
    assignee_query_error: byAssignee.query_error || null,
    ip_query_error: byIp.query_error || null
  };
  console.log('[OPS_SERVER_NETWORK_INSPECT]', JSON.stringify(result));
  return result;
}

async function main() {
  const [telegramId, ip = ''] = process.argv.slice(2);
  if (!telegramId) throw new Error('Usage: node scripts/ops-inspect-server-network.js <telegram-id> [persisted-ip]');
  try {
    await inspect(telegramId, ip);
  } finally {
    await db.pool.end().catch(() => {});
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('[OPS_SERVER_NETWORK_INSPECT_FAILED]', JSON.stringify({ code: error?.code || null, message: error?.message || String(error) }));
    process.exit(1);
  });
}

module.exports = { inspect, findPurchase };
