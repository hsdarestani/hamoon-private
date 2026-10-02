#!/usr/bin/env node
'use strict';

require('dotenv').config();
const db = require('../db');
const datacenters = require('../datacenters');
const api = require('../Hetzner/hetzner-api');
const additionalIps = require('../services/hetzner-additional-ips');

function isHetzner(dc = {}) {
  return String(dc.provider || dc.apiType || '').toLowerCase() === 'hetzner';
}

function isManaged(ip = {}) {
  return /^HamoonCloud user \d+ server \d+$/i.test(String(ip.description || '').trim());
}

async function main() {
  const apply = process.argv.includes('--apply');
  const minAgeMs = Math.max(60_000, Number(process.env.HETZNER_ADDITIONAL_IP_ORPHAN_MIN_AGE_MS || 5 * 60_000));
  const dc = Object.values(datacenters).find(isHetzner);
  if (!dc) throw new Error('HETZNER_DC_NOT_FOUND');

  const [rows] = await db.pool.query(
    "SELECT floating_ip_id FROM hetzner_additional_ip_billing WHERE status = 'active'"
  ).catch(() => [[]]);
  const billed = new Set((rows || []).map(row => String(row.floating_ip_id)));

  const data = await api.hetznerRequest(dc, 'GET', '/floating_ips?per_page=50');
  const now = Date.now();
  const candidates = (data?.floating_ips || []).filter(ip => {
    if (!isManaged(ip) || billed.has(String(ip.id))) return false;
    const serverId =
      additionalIps.floatingIpServerId(ip) ||
      additionalIps.managedDescriptionServerId(ip);
    if (!serverId) return false;
    const created = Date.parse(String(ip.created || ''));
    return Number.isFinite(created) && now - created >= minAgeMs;
  });

  const summary = {
    apply,
    provider_count: Number(data?.floating_ips?.length || 0),
    billed_active_count: billed.size,
    orphan_count: candidates.length,
    deleted: [],
    failed: []
  };

  for (const ip of candidates) {
    const serverId =
      additionalIps.floatingIpServerId(ip) ||
      additionalIps.managedDescriptionServerId(ip);
    if (!apply) {
      summary.deleted.push({ id: String(ip.id), server_id: serverId, dry_run: true });
      continue;
    }
    try {
      await additionalIps.deleteAdditionalIp({
        dc,
        serverId,
        floatingIpId: String(ip.id)
      });
      summary.deleted.push({ id: String(ip.id), server_id: serverId });
    } catch (error) {
      summary.failed.push({
        id: String(ip.id),
        server_id: serverId,
        code: error?.code || null,
        message: String(error?.message || error).slice(0, 140)
      });
    }
  }

  console.log(JSON.stringify(summary, null, 2));
  if (summary.failed.length) process.exitCode = 2;
}

main()
  .catch(error => {
    console.error('[HETZNER_ADDITIONAL_IP_ORPHAN_RECONCILE_FAILED]', error?.code || error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.pool.end().catch(() => {});
  });
