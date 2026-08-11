'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { applyProviderVisibilityPatches } = require('./provider-visibility-bootstrap');
const { applyPatches: applyFeaturePatches } = require('./hetzner-console-bootstrap');
const { applyHetznerTrafficPatches } = require('./hetzner-traffic-bootstrap');
const { applyHetznerChangeIpPatches } = require('./hetzner-change-ip-bootstrap');
const { applyBillingCyclePatches } = require('./billing-cycle-bootstrap');

function applyPatches(coreSource) {
  return applyBillingCyclePatches(
    applyHetznerChangeIpPatches(
      applyHetznerTrafficPatches(
        applyFeaturePatches(
          applyProviderVisibilityPatches(coreSource)
        )
      )
    )
  );
}

function run() {
  const corePath = path.join(__dirname, 'index-core.js');
  const source = applyPatches(fs.readFileSync(corePath, 'utf8'));
  const child = new Module(corePath, module.parent);
  child.filename = corePath;
  child.paths = Module._nodeModulePaths(path.dirname(corePath));
  require.cache[corePath] = child;
  child._compile(source, corePath);
  return child.exports;
}

module.exports = { applyPatches, run };
