'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const pricing = require('./api-prorated-pricing');

const COMPILED_MARK = Symbol.for('hamoon.apiProratedCompiled');
const BILLING_CYCLE_MARK = Symbol.for('hamoon.apiProratedBillingCycleWrapped');

function compilePatched(relativePath, patcher) {
  const filename = require.resolve(relativePath);
  const cached = require.cache[filename];
  if (cached?.exports?.[COMPILED_MARK]) return cached.exports;
  const source = patcher(fs.readFileSync(filename, 'utf8'));
  const child = new Module(filename, module.parent);
  child.filename = filename;
  child.paths = Module._nodeModulePaths(path.dirname(filename));
  require.cache[filename] = child;
  child._compile(source, filename);
  if (child.exports && (typeof child.exports === 'object' || typeof child.exports === 'function')) {
    Object.defineProperty(child.exports, COMPILED_MARK, { value: true, configurable: false });
  }
  return child.exports;
}

function installShared() {
  const db = pricing.installApiProratedPricing(require('./db'));
  compilePatched('./billing-settlement.js', pricing.applyBillingSettlementPatches);
  compilePatched('./server-deletion-refund.js', pricing.applyDeletionRefundPatches);
  return db;
}

function installForDashboard() {
  installShared();
  compilePatched('./customer-api.js', pricing.applyCustomerApiPatches);
  return () => {};
}

function installForBot() {
  installShared();

  const cycleBootstrap = require('./billing-cycle-bootstrap');
  if (!cycleBootstrap[BILLING_CYCLE_MARK]) {
    const original = cycleBootstrap.applyBillingCyclePatches;
    cycleBootstrap.applyBillingCyclePatches = function applyBillingCyclePatchesWithApiProration(source) {
      return pricing.applyBillingCycleOutputPatch(original(source));
    };
    Object.defineProperty(cycleBootstrap, BILLING_CYCLE_MARK, { value: true });
  }

  const corePath = path.resolve(__dirname, 'index-core.js');
  const originalReadFileSync = fs.readFileSync;
  let patched = false;
  fs.readFileSync = function apiProratedReadFileSync(filename, options) {
    const output = originalReadFileSync.call(fs, filename, options);
    if (!patched && path.resolve(String(filename)) === corePath) {
      patched = true;
      if (Buffer.isBuffer(output)) {
        return Buffer.from(pricing.applyIndexCorePricingPatch(output.toString('utf8')), 'utf8');
      }
      return pricing.applyIndexCorePricingPatch(String(output));
    }
    return output;
  };

  return function cleanup() {
    fs.readFileSync = originalReadFileSync;
  };
}

module.exports = { compilePatched, installForDashboard, installForBot };
