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

  const patched = source
    .replace(providerMarker, providerReplacement)
    .replace(ownershipMarker, ownershipReplacement);

  // Refuse to boot with a silently ineffective patch. This prevents a future
  // refactor from bringing back cross-location duplicates unnoticed.
  if (!patched.includes("const isHetzner = dcConfig.provider === 'hetzner' || dcConfig.apiType === 'hetzner';") ||
      !patched.includes('if (isAfra || isHetzner) return idMatch;')) {
    const err = new Error('HETZNER_MANAGEMENT_SCOPE_PATCH_FAILED');
    err.code = 'HETZNER_MANAGEMENT_SCOPE_PATCH_FAILED';
    throw err;
  }

  return patched;
}

module.exports = { applyHetznerManagementScopePatch };
