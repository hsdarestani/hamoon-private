'use strict';

// All virtual Hetzner locations use the same Hetzner project/token. The core
// management screen therefore receives the same account-wide server list for
// Germany, Finland, US East, US West and Singapore. For Hetzner, a provider
// label alone is not enough to decide which virtual datacenter owns a server;
// the purchase row is the source of truth.
function applyHetznerManagementScopePatch(source) {
  const providerMarker = "const isAfra = dcConfig.provider === 'afracloud' || dcConfig.apiType === 'afracloud';";
  const providerReplacement = `${providerMarker}\n     const isHetzner = dcConfig.provider === 'hetzner' || dcConfig.apiType === 'hetzner';`;
  const ownershipMarker = 'if (isAfra) return idMatch;';
  const ownershipReplacement = 'if (isAfra || isHetzner) return idMatch;';
  const helperMarker = 'function makeShortCb(uid, payload) {';
  const helperReplacement = `function compactServerStatusIcon(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (new Set(['active', 'running', 'on']).has(normalized)) return '🟢';
  if (new Set(['off', 'shutoff', 'stopped', 'suspended', 'paused']).has(normalized)) return '🔴';
  if (new Set(['initializing', 'starting', 'stopping', 'rebuilding', 'migrating', 'deleting', 'creating']).has(normalized)) return '🟡';
  return '⚪';
}

const HETZNER_MANAGEMENT_CACHE_MS = Math.max(5000, Number(process.env.HETZNER_MANAGEMENT_CACHE_MS || 30000));
let hetznerManagementServerCache = null;
let hetznerManagementServerListInFlight = null;

async function listServersForManagement(dcConfig, token) {
  const isHetznerProvider = dcConfig?.provider === 'hetzner' || dcConfig?.apiType === 'hetzner';
  if (!isHetznerProvider) return openstackApi.listServers(dcConfig, token);

  const now = Date.now();
  if (hetznerManagementServerCache?.expiresAt > now) {
    return hetznerManagementServerCache.servers;
  }
  if (hetznerManagementServerListInFlight) return hetznerManagementServerListInFlight;

  const { listAllHetznerServers } = require('./services/hetzner-list-all-servers');
  hetznerManagementServerListInFlight = listAllHetznerServers(dcConfig)
    .then(servers => {
      const normalized = Array.isArray(servers) ? servers : [];
      hetznerManagementServerCache = {
        servers: normalized,
        expiresAt: Date.now() + HETZNER_MANAGEMENT_CACHE_MS
      };
      return normalized;
    })
    .finally(() => {
      hetznerManagementServerListInFlight = null;
    });

  return hetznerManagementServerListInFlight;
}

${helperMarker}`;
  const listServersMarker = 'return openstackApi.listServers(dcConfig, tok);';
  const listServersReplacement = 'return listServersForManagement(dcConfig, tok);';
  const buttonTextMarker = 'text: `${getServerDisplayNameFromMap(serverDisplayNames, s.datacenter, s.id) || s.purchase?.server_name || s.name}';
  const buttonTextReplacement = 'text: `${compactServerStatusIcon(s.status)} ${getServerDisplayNameFromMap(serverDisplayNames, s.datacenter, s.id) || s.purchase?.server_name || s.name}';

  if (!source.includes(providerMarker)) {
    const err = new Error('HETZNER_MANAGEMENT_SCOPE_PROVIDER_MARKER_MISSING');
    err.code = 'HETZNER_MANAGEMENT_SCOPE_PROVIDER_MARKER_MISSING';
    throw err;
  }
  if (!source.includes(ownershipMarker)) {
    const err = new Error('HETZNER_MANAGEMENT_SCOPE_OWNERSHIP_MARKER_MISSING');
    err.code = 'HETZNER_MANAGEMENT_SCOPE_OWNERSHIP_MARKER_MISSING';
    throw err;
  }
  if (!source.includes(helperMarker)) {
    const err = new Error('HETZNER_MANAGEMENT_STATUS_HELPER_MARKER_MISSING');
    err.code = 'HETZNER_MANAGEMENT_STATUS_HELPER_MARKER_MISSING';
    throw err;
  }
  if (!source.includes(listServersMarker)) {
    const err = new Error('HETZNER_MANAGEMENT_LIST_SERVERS_MARKER_MISSING');
    err.code = 'HETZNER_MANAGEMENT_LIST_SERVERS_MARKER_MISSING';
    throw err;
  }
  if (!source.includes(buttonTextMarker)) {
    const err = new Error('HETZNER_MANAGEMENT_STATUS_BUTTON_MARKER_MISSING');
    err.code = 'HETZNER_MANAGEMENT_STATUS_BUTTON_MARKER_MISSING';
    throw err;
  }

  const patched = source
    .replace(helperMarker, helperReplacement)
    .replace(listServersMarker, listServersReplacement)
    .replace(providerMarker, providerReplacement)
    .replace(ownershipMarker, ownershipReplacement)
    .replace(buttonTextMarker, buttonTextReplacement);

  // Refuse to boot with a silently ineffective patch. This prevents a future
  // refactor from bringing back cross-location duplicates or hiding live state.
  if (!patched.includes("const isHetzner = dcConfig.provider === 'hetzner' || dcConfig.apiType === 'hetzner';") ||
      !patched.includes('if (isAfra || isHetzner) return idMatch;') ||
      !patched.includes('function compactServerStatusIcon(status)') ||
      !patched.includes('async function listServersForManagement(dcConfig, token)') ||
      !patched.includes('hetznerManagementServerListInFlight') ||
      !patched.includes('HETZNER_MANAGEMENT_CACHE_MS') ||
      !patched.includes("require('./services/hetzner-list-all-servers')") ||
      !patched.includes('return listServersForManagement(dcConfig, tok);') ||
      !patched.includes('${compactServerStatusIcon(s.status)} ${getServerDisplayNameFromMap(serverDisplayNames, s.datacenter, s.id) || s.purchase?.server_name || s.name}')) {
    const err = new Error('HETZNER_MANAGEMENT_SCOPE_PATCH_FAILED');
    err.code = 'HETZNER_MANAGEMENT_SCOPE_PATCH_FAILED';
    throw err;
  }

  return patched;
}

module.exports = { applyHetznerManagementScopePatch };
