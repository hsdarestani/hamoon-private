'use strict';

require('dotenv').config();
const db = require('../db');
const dcs = require('../datacenters');
const cloud = require('../cloud-api');
const hetznerApi = require('../Hetzner/hetzner-api');
const baseChange = require('../services/hetzner-change-ip');
const cleanChange = require('../services/hetzner-clean-ip-change');

function currentIp(raw) {
  return raw?.public_net?.ipv4?.ip || null;
}

function isHetzner(dc) {
  return dc && (String(dc.provider || '').toLowerCase() === 'hetzner' || String(dc.apiType || '').toLowerCase() === 'hetzner');
}

async function waitAction(dc, action) {
  const id = action?.id || action?.action?.id;
  if (id) await cloud.waitHetznerAction(dc, id, 180000);
}

async function repair(serverId) {
  const purchase = await db.getPurchaseByServerId(serverId);
  if (!purchase) return { server_id: String(serverId), result: 'skip', reason: 'purchase_not_found' };
  const dc = dcs[purchase.datacenter];
  if (!isHetzner(dc)) return { server_id: String(serverId), result: 'skip', reason: 'not_hetzner' };
  if (purchase.delivered_at) return { server_id: String(serverId), result: 'skip', reason: 'already_delivered' };

  const allowed = new Set(['provisioning', 'pending_ip', 'pending_ssh', 'pending_ip_quality', 'manual_review']);
  if (!allowed.has(String(purchase.status || '').toLowerCase())) {
    return { server_id: String(serverId), result: 'skip', reason: `status_${purchase.status}` };
  }

  let password;
  try { password = await db.getServerSecret(serverId, 'root_password'); } catch (e) {
    return { server_id: String(serverId), result: 'skip', reason: `secret_${e.code || e.message}` };
  }
  if (!password) return { server_id: String(serverId), result: 'skip', reason: 'password_missing' };

  let raw = await hetznerApi.getHetznerServer(dc, serverId);
  let providerIp = currentIp(raw);
  if (!providerIp) return { server_id: String(serverId), result: 'skip', reason: 'provider_ip_missing' };
  await db.updatePublicIp(purchase.telegram_id, serverId, purchase.datacenter, providerIp).catch(() => {});

  // First try the least invasive repair: a clean power cycle so the guest network
  // learns the Primary IPv4 currently attached at Hetzner.
  if (String(raw.status || '').toLowerCase() === 'running') {
    await waitAction(dc, await cloud.powerOffHetznerServer(dc, serverId));
  }
  await waitAction(dc, await cloud.powerOnHetznerServer(dc, serverId));
  await baseChange.waitForNewIp(dc, serverId, providerIp, 180000);

  let ssh = await cleanChange.probeSshReachability(providerIp, {
    attempts: 12,
    settleMs: 10000,
    retryDelayMs: 5000,
    timeoutMs: 8000
  });

  if (ssh?.ok) {
    await db.updateScopedStatus(purchase.telegram_id, serverId, purchase.datacenter, 'pending_ip_quality');
    return { server_id: String(serverId), result: 'reboot_recovered', ssh: true, ip_changed: false };
  }

  // The previous failed rollback may have left the guest/provider network state unusable.
  // Rotate transactionally, but for this undelivered recovery only require proven SSH.
  // Final customer delivery remains gated by the normal Iran/global quality reconciler.
  const rotated = await cleanChange.changeHetznerPublicIp({
    db,
    dc,
    telegramId: purchase.telegram_id,
    serverId,
    datacenter: purchase.datacenter,
    verifyCandidate: async ({ ip }) => {
      const candidateSsh = await cleanChange.probeSshReachability(ip, {
        attempts: 12,
        settleMs: 10000,
        retryDelayMs: 5000,
        timeoutMs: 8000
      });
      return {
        ok: Boolean(candidateSsh?.ok),
        definitive: true,
        reason: candidateSsh?.ok ? 'ssh_recovered_quality_pending' : 'ssh_unreachable_after_settle',
        ssh: candidateSsh,
        quality: null
      };
    }
  });

  await db.updateScopedStatus(purchase.telegram_id, serverId, purchase.datacenter, 'pending_ip_quality');
  return {
    server_id: String(serverId),
    result: 'ip_rotated_for_network_recovery',
    ssh: true,
    ip_changed: Boolean(rotated?.newIp && rotated?.oldIp && rotated.newIp !== rotated.oldIp)
  };
}

(async () => {
  const ids = process.argv.slice(2).filter(Boolean);
  if (!ids.length) throw new Error('SERVER_ID_REQUIRED');
  const results = [];
  for (const id of ids) {
    try { results.push(await repair(String(id))); }
    catch (e) { results.push({ server_id: String(id), result: 'failed', reason: String(e.code || e.message || e).slice(0, 120) }); }
  }
  console.log('HETZNER_UNDELIVERED_NETWORK_REPAIR=' + JSON.stringify(results));
  await db.pool.end();
})().catch(async e => {
  console.error('HETZNER_UNDELIVERED_NETWORK_REPAIR_FATAL=' + String(e.code || e.message || e));
  try { await db.pool.end(); } catch (_) {}
  process.exit(1);
});
