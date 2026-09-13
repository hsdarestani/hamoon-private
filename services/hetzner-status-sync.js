'use strict';

const db = require('../db');
const datacenters = require('../datacenters');
const { listAllHetznerServers } = require('./hetzner-list-all-servers');

let syncInFlight = null;

function isHetznerDatacenter(key, dc = {}) {
  const provider = String(dc.provider || dc.apiType || '').toLowerCase();
  return provider === 'hetzner' || String(key || '').toLowerCase() === 'hetzner' || String(key || '').toLowerCase().startsWith('hetzner-');
}

function normalizeProviderStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  if (['running', 'active', 'on'].includes(value)) return 'active';
  if (['off', 'stopped', 'shutoff', 'suspended', 'powered_off', 'poweroff'].includes(value)) return 'suspended';
  if (['initializing', 'starting'].includes(value)) return 'starting';
  if (['stopping'].includes(value)) return 'stopping';
  if (['rebuilding', 'migrating', 'deleting', 'creating'].includes(value)) return value;
  return value || null;
}

async function runSync() {
  const hetznerKeys = Object.keys(datacenters).filter(key => isHetznerDatacenter(key, datacenters[key]));
  if (!hetznerKeys.length) return { checked: 0, updated: 0, reason: 'no_hetzner_datacenters' };

  const placeholders = hetznerKeys.map(() => '?').join(',');
  const [purchases] = await db.pool.query(
    `SELECT server_id
       FROM purchases
      WHERE datacenter IN (${placeholders})
        AND status NOT IN ('deleted','deletion_pending','provider_missing')`,
    hetznerKeys
  );
  if (!purchases.length) return { checked: 0, updated: 0, reason: 'no_purchases' };

  // All virtual Hetzner locations share one project, so one paginated provider
  // listing is enough for every purchase.
  const dc = datacenters[hetznerKeys[0]];
  const providerServers = await listAllHetznerServers(dc);
  const providerById = new Map(
    (providerServers || []).map(server => [
      String(server.id ?? server.uuid ?? ''),
      normalizeProviderStatus(server.status ?? server.state)
    ])
  );

  const snapshots = purchases
    .map(purchase => ({
      serverId: String(purchase.server_id || ''),
      status: providerById.get(String(purchase.server_id || ''))
    }))
    .filter(item => item.serverId && item.status);

  if (!snapshots.length) return { checked: purchases.length, updated: 0, reason: 'no_matching_provider_servers' };

  const cases = snapshots.map(() => 'WHEN ? THEN ?').join(' ');
  const ids = snapshots.map(() => '?').join(',');
  const params = snapshots.flatMap(item => [item.serverId, item.status]);
  params.push(...snapshots.map(item => item.serverId));

  await db.pool.query(
    `UPDATE purchases
        SET provider_status = CASE server_id ${cases} ELSE provider_status END,
            provider_status_checked_at = NOW()
      WHERE server_id IN (${ids})`,
    params
  );

  return { checked: purchases.length, updated: snapshots.length };
}

function syncHetznerProviderStatuses() {
  if (syncInFlight) return syncInFlight;
  syncInFlight = runSync().finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

module.exports = {
  isHetznerDatacenter,
  normalizeProviderStatus,
  syncHetznerProviderStatuses
};
