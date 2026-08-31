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
  return '⚪';
}
${helperMarker}`;
  const buttonMarker = "{ text: `${s.purchase?.server_name || s.name} (${userDCs[s.datacenter]?.name || s.datacenter})`, callback_data: token }";
  const buttonReplacement = "{ text: `${compactServerStatusIcon(s.status)} ${s.purchase?.server_name || s.name} (${userDCs[s.datacenter]?.name || s.datacenter})`, callback_data: token }";

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
  if (!source.includes(buttonMarker)) {
    const err = new Error('HETZNER_MANAGEMENT_STATUS_BUTTON_MARKER_MISSING');
    err.code = 'HETZNER_MANAGEMENT_STATUS_BUTTON_MARKER_MISSING';
    throw err;
  }

  const patched = source
    .replace(helperMarker, helperReplacement)
    .replace(providerMarker, providerReplacement)
    .replace(ownershipMarker, ownershipReplacement)
    .replace(buttonMarker, buttonReplacement);

  // Refuse to boot with a silently ineffective patch. This prevents a future
  // refactor from bringing back cross-location duplicates or hiding live state.
  if (!patched.includes("const isHetzner = dcConfig.provider === 'hetzner' || dcConfig.apiType === 'hetzner';") ||
      !patched.includes('if (isAfra || isHetzner) return idMatch;') ||
      !patched.includes('function compactServerStatusIcon(status)') ||
      !patched.includes('${compactServerStatusIcon(s.status)} ${s.purchase?.server_name || s.name}')) {
    const err = new Error('HETZNER_MANAGEMENT_SCOPE_PATCH_FAILED');
    err.code = 'HETZNER_MANAGEMENT_SCOPE_PATCH_FAILED';
    throw err;
  }

  return patched;
}

module.exports = { applyHetznerManagementScopePatch };
