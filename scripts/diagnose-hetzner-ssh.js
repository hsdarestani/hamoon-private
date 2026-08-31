'use strict';

require('dotenv').config();
const net = require('net');
const db = require('../db');
const datacenters = require('../datacenters');
const hetzner = require('../Hetzner/hetzner-api');
const { installStrictCheckHostFetch } = require('../services/check-host-strict-fetch');
const { checkIpQuality } = require('../services/hetzner-lifecycle');

installStrictCheckHostFetch();

function tcp(host, port, timeoutMs = 3000) {
  return new Promise(resolve => {
    const s = net.createConnection({ host, port });
    let done = false;
    const finish = value => { if (done) return; done = true; s.destroy(); resolve(value); };
    s.setTimeout(timeoutMs, () => finish(false));
    s.once('connect', () => finish(true));
    s.once('error', () => finish(false));
  });
}

async function main() {
  const ip = String(process.argv[2] || '').trim();
  const purchases = await db.getAllPurchases();
  const p = purchases.find(x => String(x.public_ip || '').trim() === ip);
  if (!p) throw new Error('PURCHASE_NOT_FOUND_FOR_IP');
  const dc = datacenters[p.datacenter] || { provider: 'hetzner' };
  const server = await hetzner.getHetznerServer(dc, p.server_id);
  const firewalls = await hetzner.hetznerRequest(dc, 'GET', `/firewalls?bound_to=server:${encodeURIComponent(String(p.server_id))}&per_page=50`).catch(error => ({ error: String(error?.message || error) }));
  const actions = await hetzner.hetznerRequest(dc, 'GET', `/servers/${encodeURIComponent(String(p.server_id))}/actions?sort=id:desc&per_page=20`).catch(error => ({ error: String(error?.message || error) }));
  const strictIranSsh = await checkIpQuality(ip, {
    iranCount: 6,
    iranMin: 4,
    globalCount: 6,
    globalRatio: 0.67,
    polls: 8,
    pollDelayMs: 1500
  });

  console.log(JSON.stringify({
    purchase: {
      server_id: String(p.server_id),
      telegram_id: String(p.telegram_id),
      datacenter: p.datacenter,
      status: p.status,
      public_ip: p.public_ip
    },
    provider: {
      status: server?.status || null,
      rescue_enabled: server?.rescue_enabled ?? null,
      locked: server?.locked ?? null,
      location: server?.datacenter?.location?.name || null,
      ipv4: server?.public_net?.ipv4?.ip || null,
      firewalls: Array.isArray(firewalls?.firewalls) ? firewalls.firewalls.map(f => ({
        id: f.id,
        name: f.name,
        rules: (f.rules || []).map(r => ({ direction: r.direction, protocol: r.protocol, port: r.port, source_ips: r.source_ips }))
      })) : firewalls,
      recent_actions: Array.isArray(actions?.actions) ? actions.actions.slice(0, 12).map(a => ({ id: a.id, command: a.command, status: a.status, started: a.started, finished: a.finished, error: a.error || null })) : actions
    },
    network: {
      port22_from_hamoon: await tcp(ip, 22),
      port80_from_hamoon: await tcp(ip, 80),
      port443_from_hamoon: await tcp(ip, 443),
      strict_iran_ssh: strictIranSsh
    }
  }, null, 2));
}

main().catch(error => {
  console.error('[DIAGNOSE_HETZNER_SSH] FAILED:', String(error?.message || error).slice(0, 240));
  process.exitCode = 1;
}).finally(async () => {
  await db.pool.end().catch(() => {});
});
