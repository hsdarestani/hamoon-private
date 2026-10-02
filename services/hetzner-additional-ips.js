'use strict';

const DEFAULT_MAX_ADDITIONAL_IPV4 = 5;
const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

function positiveLimit(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_ADDITIONAL_IPV4;
}

function floatingIpServerId(floatingIp) {
  const assigned = floatingIp?.server;
  if (assigned == null) return null;

  // Hetzner's current Cloud API returns floating_ip.server as a numeric
  // server ID. Older fixtures/clients may expose { id }. Accept both.
  if (typeof assigned === 'object') {
    return assigned.id != null ? String(assigned.id) : null;
  }
  return String(assigned);
}

function normalizeFloatingIp(floatingIp) {
  return {
    id: String(floatingIp.id),
    ip: floatingIp.ip,
    type: floatingIp.type || 'ipv4',
    description: floatingIp.description || null,
    server_id: floatingIpServerId(floatingIp),
    home_location: floatingIp.home_location?.name || floatingIp.home_location || null,
    blocked: Boolean(floatingIp.blocked),
    protection: floatingIp.protection || {}
  };
}

function managedDescriptionServerId(floatingIp) {
  const match = String(floatingIp?.description || '').trim()
    .match(/^HamoonCloud user \d+ server (\d+)$/i);
  return match ? String(match[1]) : null;
}

function belongsToServer(floatingIp, serverId) {
  return floatingIpServerId(floatingIp) === String(serverId);
}

function belongsToServerOrManagedOrphan(floatingIp, serverId) {
  const assigned = floatingIpServerId(floatingIp);
  if (assigned != null) return assigned === String(serverId);
  return managedDescriptionServerId(floatingIp) === String(serverId);
}

function providerStatus(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  return Number.isFinite(status) ? status : 0;
}

async function retryProviderLocked(fn, {
  attempts = 6,
  baseDelayMs = 1200,
  maxDelayMs = 5000
} = {}) {
  let lastError = null;
  const total = Math.max(1, Number(attempts) || 1);
  for (let attempt = 1; attempt <= total; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (providerStatus(error) !== 423 || attempt >= total) throw error;
      const delayMs = Math.min(
        Math.max(250, Number(maxDelayMs) || 5000),
        Math.max(250, (Number(baseDelayMs) || 1200) * attempt)
      );
      console.warn('[HETZNER_ADDITIONAL_IP_LOCKED_RETRY]', {
        attempt,
        attempts: total,
        delay_ms: delayMs
      });
      await sleep(delayMs);
    }
  }
  throw lastError;
}

async function listAdditionalIps({ dc, serverId, request }) {
  const call = request || ((...args) => require('../Hetzner/hetzner-api').hetznerRequest(...args));
  const data = await call(dc, 'GET', '/floating_ips?per_page=50');
  return (data?.floating_ips || []).filter(ip => belongsToServer(ip, serverId)).map(normalizeFloatingIp);
}

async function addAdditionalIpv4({ dc, serverId, description, maxIps, request }) {
  const call = request || ((...args) => require('../Hetzner/hetzner-api').hetznerRequest(...args));
  const serverData = await call(dc, 'GET', `/servers/${encodeURIComponent(serverId)}`);
  if (!serverData?.server?.id) {
    const error = new Error('SERVER_NOT_FOUND');
    error.code = 'SERVER_NOT_FOUND';
    throw error;
  }

  const current = await listAdditionalIps({ dc, serverId, request: call });
  const limit = positiveLimit(maxIps ?? process.env.HETZNER_MAX_ADDITIONAL_IPV4);
  if (current.length >= limit) {
    const error = new Error('ADDITIONAL_IP_LIMIT_REACHED');
    error.code = 'ADDITIONAL_IP_LIMIT_REACHED';
    error.limit = limit;
    throw error;
  }

  const safeDescription = String(description || `HamoonCloud server ${serverId}`)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  const data = await call(dc, 'POST', '/floating_ips', {
    type: 'ipv4',
    server: Number(serverId),
    description: safeDescription || `HamoonCloud server ${serverId}`
  });
  if (!data?.floating_ip?.id || !data?.floating_ip?.ip) {
    const error = new Error('FLOATING_IP_CREATE_FAILED');
    error.code = 'FLOATING_IP_CREATE_FAILED';
    throw error;
  }
  return { ip: normalizeFloatingIp(data.floating_ip), action: data.action || null };
}

async function deleteAdditionalIp({
  dc,
  serverId,
  floatingIpId,
  request,
  waitAction,
  unassignTimeoutMs,
  pollDelayMs
}) {
  const api = require('../Hetzner/hetzner-api');
  const call = request || ((...args) => api.hetznerRequest(...args));
  const id = encodeURIComponent(floatingIpId);
  const data = await call(dc, 'GET', `/floating_ips/${id}`);
  if (!data?.floating_ip || !belongsToServerOrManagedOrphan(data.floating_ip, serverId)) {
    const error = new Error('ADDITIONAL_IP_NOT_FOUND');
    error.code = 'ADDITIONAL_IP_NOT_FOUND';
    throw error;
  }
  if (data.floating_ip.protection?.delete) {
    const error = new Error('ADDITIONAL_IP_DELETE_PROTECTED');
    error.code = 'ADDITIONAL_IP_DELETE_PROTECTED';
    throw error;
  }

  const original = normalizeFloatingIp(data.floating_ip);
  let assignedServerId = floatingIpServerId(data.floating_ip);

  // Hetzner action status can remain "running" long after the Floating IP is
  // already detached. Use the resource assignment itself as the source of
  // truth and keep this wait short so Telegram flows never hang on cleanup.
  if (assignedServerId != null) {
    const unassign = await retryProviderLocked(
      () => call(dc, 'POST', `/floating_ips/${id}/actions/unassign`, {}),
      { attempts: 6, baseDelayMs: 1200, maxDelayMs: 5000 }
    );
    const actionId = unassign?.action?.id ?? unassign?.id ?? null;
    const timeoutMs = Math.max(
      2000,
      Math.min(30000, Number(unassignTimeoutMs ?? process.env.HETZNER_ADDITIONAL_IP_UNASSIGN_TIMEOUT_MS ?? 12000))
    );
    const delayMs = Math.max(
      250,
      Math.min(3000, Number(pollDelayMs ?? process.env.HETZNER_ADDITIONAL_IP_UNASSIGN_POLL_MS ?? 1200))
    );
    const deadline = Date.now() + timeoutMs;
    let last = data.floating_ip;

    while (Date.now() < deadline) {
      await sleep(Math.min(delayMs, Math.max(1, deadline - Date.now())));
      try {
        const latest = await call(dc, 'GET', `/floating_ips/${id}`);
        if (!latest?.floating_ip) return original;
        last = latest.floating_ip;
      } catch (error) {
        if (Number(error?.status || error?.response?.status || 0) === 404) return original;
        throw error;
      }

      assignedServerId = floatingIpServerId(last);
      if (assignedServerId == null) break;
      if (assignedServerId !== String(serverId)) {
        const error = new Error('ADDITIONAL_IP_OWNERSHIP_CHANGED');
        error.code = 'ADDITIONAL_IP_OWNERSHIP_CHANGED';
        throw error;
      }
    }

    if (assignedServerId != null) {
      const error = new Error('ADDITIONAL_IP_UNASSIGN_PENDING');
      error.code = 'ADDITIONAL_IP_UNASSIGN_PENDING';
      error.actionId = actionId == null ? null : String(actionId);
      error.serverId = String(serverId);
      error.floatingIpId = String(floatingIpId);
      throw error;
    }
  }

  await retryProviderLocked(
    () => call(dc, 'DELETE', `/floating_ips/${id}`),
    { attempts: 8, baseDelayMs: 1500, maxDelayMs: 6000 }
  );
  return original;
}

module.exports = {
  DEFAULT_MAX_ADDITIONAL_IPV4,
  floatingIpServerId,
  managedDescriptionServerId,
  normalizeFloatingIp,
  listAdditionalIps,
  addAdditionalIpv4,
  deleteAdditionalIp
};
