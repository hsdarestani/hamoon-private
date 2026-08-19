'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { applyProviderVisibilityPatches } = require('./provider-visibility-bootstrap');
const { applyPatches: applyFeaturePatches } = require('./hetzner-console-bootstrap');
const { applyHetznerTrafficPatches } = require('./hetzner-traffic-bootstrap');
const { applyHetznerChangeIpPatches } = require('./hetzner-change-ip-bootstrap');
const { applyBillingCyclePatches } = require('./billing-cycle-bootstrap');
const { applyRebuildPatches } = require('./rebuild-bootstrap');
const { applyHetznerPurchaseArchitecturePatches } = require('./hetzner-purchase-architecture-bootstrap');

function applyRuntimeSafetyDefaults() {
  // Afracloud/Afranet is fully retired. Remove it from the runtime datacenter map
  // so users never see it and management flows never call its API.
  const datacenters = require('./datacenters');
  if (datacenters && Object.prototype.hasOwnProperty.call(datacenters, 'afracloud')) {
    delete datacenters.afracloud;
  }

  // Strict Hetzner IP quality defaults. Never fail-open an unverified IP during
  // normal purchase lifetime; instead keep checking/rotating until Iran reachability passes.
  const defaults = {
    HETZNER_IP_QUALITY_INCONCLUSIVE_FAIL_OPEN_MS: String(10 * 365 * 24 * 60 * 60 * 1000),
    HETZNER_MAX_IP_QUALITY_ROTATIONS: '20',
    HETZNER_IP_QUALITY_IR_NODES: '6',
    HETZNER_IP_QUALITY_IR_MIN_SUCCESS: '4',
    HETZNER_IP_QUALITY_GLOBAL_NODES: '6',
    HETZNER_IP_QUALITY_GLOBAL_MIN_RATIO: '0.67',
    HETZNER_CHANGE_IP_UNIQUE_ATTEMPTS: '20',
    HETZNER_CHANGE_IP_CLEAN_ATTEMPTS: '20',
    HETZNER_CHANGE_IP_QUALITY_PROBE_ATTEMPTS: '3'
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (process.env[key] == null || process.env[key] === '') process.env[key] = value;
  }
}

function installCleanIpChangeModule() {
  // Keep the existing bootstrap/callback code untouched, but transparently replace
  // the manual change-IP service with the Iran-quality-aware wrapper at runtime.
  const legacyPath = require.resolve('./services/hetzner-change-ip');
  const cleanModule = require('./services/hetzner-clean-ip-change');
  if (require.cache[legacyPath]) require.cache[legacyPath].exports = cleanModule;
}

function applyPatches(coreSource) {
  return applyHetznerPurchaseArchitecturePatches(
    applyRebuildPatches(
      applyBillingCyclePatches(
        applyHetznerChangeIpPatches(
          applyHetznerTrafficPatches(
            applyFeaturePatches(
              applyProviderVisibilityPatches(coreSource)
            )
          )
        )
      )
    )
  );
}

function run() {
  applyRuntimeSafetyDefaults();
  installCleanIpChangeModule();
  const corePath = path.join(__dirname, 'index-core.js');
  const source = applyPatches(fs.readFileSync(corePath, 'utf8'));
  const child = new Module(corePath, module.parent);
  child.filename = corePath;
  child.paths = Module._nodeModulePaths(path.dirname(corePath));
  require.cache[corePath] = child;
  child._compile(source, corePath);
  return child.exports;
}

module.exports = { applyPatches, applyRuntimeSafetyDefaults, installCleanIpChangeModule, run };