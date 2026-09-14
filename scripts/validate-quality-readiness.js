#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const cleanChange = require('../services/hetzner-clean-ip-change');
const safeLifecycle = require('../services/hetzner-lifecycle-safe-bootstrap');

(async () => {
  let qualityCalls = 0;
  let sshCalls = 0;
  const bootingThenClean = await cleanChange.verifyCleanCandidate('10.0.0.2', {
    readinessRechecks: 2,
    readinessRecheckDelayMs: 500,
    sshProbe: async () => {
      sshCalls += 1;
      return { ok: true, reason: 'connected' };
    },
    qualityProbe: async () => {
      qualityCalls += 1;
      if (qualityCalls === 1) {
        return {
          ok: false,
          definitive: true,
          checked: true,
          reason: 'failed_threshold',
          iran: { selected: 6, success: 0, completed: 6, required: 3 },
          global: { selected: 6, success: 0, completed: 6, required: 5 }
        };
      }
      return {
        ok: true,
        definitive: true,
        checked: true,
        reason: 'ok',
        iran: { selected: 6, success: 6, completed: 6, required: 3 },
        global: { selected: 6, success: 6, completed: 6, required: 5 }
      };
    }
  });

  assert.strictEqual(bootingThenClean.ok, true, 'globally-dead first probe must be rechecked after guest readiness');
  assert.strictEqual(sshCalls, 1, 'network readiness must be checked once before the quality recheck');
  assert.strictEqual(qualityCalls, 2, 'quality must be checked again after the guest becomes reachable');

  let dirtySshCalls = 0;
  const iranBlocked = await cleanChange.verifyCleanCandidate('10.0.0.3', {
    sshProbe: async () => {
      dirtySshCalls += 1;
      return { ok: true };
    },
    qualityProbe: async () => ({
      ok: false,
      definitive: true,
      checked: true,
      reason: 'failed_threshold',
      iran: { selected: 6, success: 0, completed: 6, required: 3 },
      global: { selected: 6, success: 6, completed: 6, required: 5 }
    })
  });
  assert.strictEqual(iranBlocked.ok, false);
  assert.strictEqual(iranBlocked.definitive, true);
  assert.strictEqual(dirtySshCalls, 0, 'globally reachable but Iran-blocked IP should still fail fast');

  const lifecycleSource = fs.readFileSync(path.join(__dirname, '../services/hetzner-lifecycle.js'), 'utf8');
  const patched = safeLifecycle.patchLifecycleSource(lifecycleSource);
  assert(patched.includes('provisioningGlobalReady'));
  assert(patched.includes("reason: 'network_not_ready'"));
  assert(patched.includes("HETZNER_PROVISIONING_READINESS_RECHECKS"));
  new vm.Script(patched, { filename: 'hetzner-lifecycle.readiness.patched.js' });

  console.log('validate-quality-readiness: ok');
})().catch(error => {
  console.error(error);
  process.exit(1);
});