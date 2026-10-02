'use strict';

const DEFAULT_MAX_ADDITIONAL_IPV4 = 5;

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

function belongsToServer(floatingIp, serverId) {
  return floatingIpServerId(floatingIp) === String(serverId);
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

async function deleteAdditionalIp({ dc, serverId, floatingIpId, request, waitAction }) {
  const api = require('../Hetzner/hetzner-api');
  const call = request || ((...args) => api.hetznerRequest(...args));
  const id = encodeURIComponent(floatingIpId);
  const data = await call(dc, 'GET', `/floating_ips/${id}`);
  if (!data?.floating_ip || !belongsToServer(data.floating_ip, serverId)) {
    const error = new Error('ADDITIONAL_IP_NOT_FOUND');
    error.code = 'ADDITIONAL_IP_NOT_FOUND';
    throw error;
  }
  if (data.floating_ip.protection?.delete) {
    const error = new Error('ADDITIONAL_IP_DELETE_PROTECTED');
    error.code = 'ADDITIONAL_IP_DELETE_PROTECTED';
    throw error;
  }

  // Since May 2026 Hetzner no longer allows deleting an assigned Floating IP.
  // Unassign first, wait for the action, then delete the resource.
  const unassign = await call(dc, 'POST', `/floating_ips/${id}/actions/unassign`, {});
  const actionId = unassign?.action?.id ?? unassign?.id ?? null;
  if (actionId) {
    if (typeof waitAction === 'function') {
      await waitAction(actionId);
    } else if (!request) {
      await api.waitHetznerAction(dc, actionId, 60000);
    }
  }

  await call(dc, 'DELETE', `/floating_ips/${id}`);
  return normalizeFloatingIp(data.floating_ip);
}

module.exports = {
  DEFAULT_MAX_ADDITIONAL_IPV4,
  floatingIpServerId,
  normalizeFloatingIp,
  listAdditionalIps,
  addAdditionalIpv4,
  deleteAdditionalIp
};
