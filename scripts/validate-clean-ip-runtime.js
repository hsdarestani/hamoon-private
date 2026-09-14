#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const runtime = require('../runtime-bootstrap');
const datacenters = require('../datacenters');
const baseChange = require('../services/hetzner-change-ip');
const lifecycle = require('../services/hetzner-lifecycle');
const cleanChange = require('../services/hetzner-clean-ip-change');
const strictCheckHost = require('../services/check-host-strict-fetch');
const reconcilePolicy = require('../services/hetzner-reconcile-policy');
const safeLifecycle = require('../services/hetzner-lifecycle-safe-bootstrap');
const fastFallback = require('../services/hetzner-location-fallback-fast-bootstrap');

(async () => {
  assert(datacenters.afracloud, 'fixture should start with Afracloud configured');
  runtime.applyRuntimeSafetyDefaults();
  assert(!datacenters.afracloud, 'Afracloud must be removed from runtime datacenters');
  assert.strictEqual(process.env.HETZNER_IP_QUALITY_REQUIRED, 'true');
  assert.strictEqual(process.env.HETZNER_IP_QUALITY_IR_NODES, '6');
  assert.strictEqual(process.env.HETZNER_IP_QUALITY_IR_MIN_SUCCESS, '3');
  assert.strictEqual(process.env.HETZNER_MAX_IP_QUALITY_ROTATIONS, '20');
  assert(Number(process.env.HETZNER_IP_QUALITY_INCONCLUSIVE_FAIL_OPEN_MS) > 300 * 24 * 60 * 60 * 1000);
  assert.strictEqual(Number(process.env.HETZNER_CHANGE_IP_RECENT_REUSE_COOLDOWN_MS), 30 * 60 * 1000);
  assert.strictEqual(Number(process.env.HETZNER_CHANGE_IP_REJECTED_COOLDOWN_MS), 0);
  assert.strictEqual(process.env.HETZNER_CHANGE_IP_QUALITY_PROBE_ATTEMPTS, '1');
  assert.strictEqual(process.env.HETZNER_CHANGE_IP_QUALITY_POLLS, '15');
  assert.strictEqual(process.env.HETZNER_CHANGE_IP_QUALITY_POLL_DELAY_MS, '1500');
  assert.strictEqual(process.env.HETZNER_CHANGE_IP_QUALITY_SETTLE_MS, '6000');
  assert.strictEqual(process.env.HETZNER_PROVISIONING_QUALITY_SETTLE_MS, '6000');

  assert.strictEqual(strictCheckHost.strictPingState([[['OK'], ['TIMEOUT'], ['TIMEOUT'], ['TIMEOUT']]]), false);
  assert.strictEqual(strictCheckHost.strictPingState([[['OK'], ['OK'], ['OK'], ['TIMEOUT']]]), true);
  assert.strictEqual(strictCheckHost.tcpNodeState([{ time: 0.12, address: '1.2.3.4' }]), true);
  assert.strictEqual(strictCheckHost.tcpNodeState([{ error: 'Connection timed out' }]), false);
  assert.strictEqual(reconcilePolicy.shouldCountInconclusive({
    status: 'pending_ip_quality', ip: '1.2.3.4',
    quality: { checked: true, definitive: false, reason: 'insufficient_results' }
  }), true);

  const now = Date.now();
  const mockDb = {
    pool: {
      async query(sql) {
        const text = String(sql);
        if (text.includes('CREATE TABLE IF NOT EXISTS server_ip_history')) return [[], []];
        if (text.includes('FROM server_ip_history')) return [[
          { ip_address: '2.2.2.2', last_seen_at: new Date(now - 2 * 60 * 60 * 1000), last_event: 'current_before_change' },
          { ip_address: '3.3.3.3', last_seen_at: new Date(now - 10 * 60 * 1000), last_event: 'clean_ip_verified' },
          { ip_address: '4.4.4.4', last_seen_at: new Date(now - 2 * 60 * 60 * 1000), last_event: 'clean_ip_rejected_rolled_back' }
        ], []];
        if (text.includes('FROM purchases')) return [[{ ip_address: '1.1.1.1' }], []];
        throw new Error(`unexpected query: ${text}`);
      }
    }
  };
  const blocked = await baseChange.usedIps(mockDb, { datacenter: 'hetzner', serverId: 's', now });
  assert(blocked.has('1.1.1.1'));
  assert(blocked.has('3.3.3.3'));
  assert(!blocked.has('2.2.2.2'));
  assert(!blocked.has('4.4.4.4'));

  // Dirty IPs must be rejected by Iran/global quality before we spend time on SSH.
  let sshCalls = 0;
  let qualityCalls = 0;
  const dirty = await cleanChange.verifyCleanCandidate('2.2.2.2', {
    sshProbe: async () => { sshCalls += 1; return { ok: true }; },
    qualityProbe: async () => {
      qualityCalls += 1;
      return { ok: false, definitive: true, checked: true, reason: 'failed_threshold', iran: { success: 0, selected: 6 }, global: { success: 6, selected: 6 } };
    }
  });
  assert.strictEqual(dirty.ok, false);
  assert.strictEqual(dirty.reason, 'failed_threshold');
  assert.strictEqual(qualityCalls, 1);
  assert.strictEqual(sshCalls, 0, 'dirty IP must not enter SSH retry loop');

  const healthy = await cleanChange.verifyCleanCandidate('3.3.3.3', {
    sshProbe: async () => { sshCalls += 1; return { ok: true, reason: 'connected' }; },
    qualityProbe: async () => ({ ok: true, definitive: true, checked: true, reason: 'ok', iran: { success: 6, selected: 6 }, global: { success: 6, selected: 6 } })
  });
  assert.strictEqual(healthy.ok, true);
  assert.strictEqual(sshCalls, 1, 'clean IP must still pass SSH before commit');

  const originalQualityCheck = lifecycle.checkIpQuality;
  let observedProbeOptions = null;
  lifecycle.checkIpQuality = async (_ip, options) => {
    observedProbeOptions = options;
    return { ok: true, definitive: true, checked: true, reason: 'ok', iran: { success: 3, selected: 6 }, global: { success: 6, selected: 6 } };
  };
  const oldSettle = process.env.HETZNER_CHANGE_IP_QUALITY_SETTLE_MS;
  process.env.HETZNER_CHANGE_IP_QUALITY_SETTLE_MS = '0';
  try {
    const patientProbe = await cleanChange.probeIranQuality('3.3.3.3');
    assert.strictEqual(patientProbe.ok, true);
    assert.deepStrictEqual(observedProbeOptions, { polls: 15, pollDelayMs: 1500 });
  } finally {
    lifecycle.checkIpQuality = originalQualityCheck;
    process.env.HETZNER_CHANGE_IP_QUALITY_SETTLE_MS = oldSettle;
  }

  const originalChange = baseChange.changeHetznerPublicIp;
  const originalRemember = baseChange.rememberIp;
  const originalSummary = lifecycle.qualitySummary;
  let changes = 0;
  baseChange.changeHetznerPublicIp = async args => {
    changes += 1;
    const ip = changes === 1 ? '2.2.2.2' : '3.3.3.3';
    const verification = await args.verifyCandidate({ ip });
    if (changes === 1) {
      const error = Object.assign(new Error('CANDIDATE_REJECTED'), {
        code: 'CANDIDATE_REJECTED', oldIp: '1.1.1.1', candidateIp: ip,
        rollbackDone: true, verification
      });
      throw error;
    }
    return { oldIp: '1.1.1.1', newIp: ip, verification };
  };
  baseChange.rememberIp = async () => true;
  lifecycle.qualitySummary = q => q?.reason || 'unknown';
  process.env.HETZNER_CHANGE_IP_CLEAN_ATTEMPTS = '3';
  try {
    const result = await cleanChange.changeHetznerPublicIp({
      db: {}, dc: {}, telegramId: 'u', serverId: 's', datacenter: 'hetzner',
      sshProbe: async () => ({ ok: true }),
      qualityProbe: async ip => ip === '2.2.2.2'
        ? { ok: false, definitive: true, reason: 'failed_threshold' }
        : { ok: true, definitive: true, reason: 'ok' }
    });
    assert.strictEqual(changes, 2);
    assert.strictEqual(result.newIp, '3.3.3.3');
    assert.strictEqual(result.attempts, 2);
  } finally {
    baseChange.changeHetznerPublicIp = originalChange;
    baseChange.rememberIp = originalRemember;
    lifecycle.qualitySummary = originalSummary;
  }

  const baseSource = fs.readFileSync(path.join(__dirname, '../services/hetzner-change-ip.js'), 'utf8');
  const verifyIndex = baseSource.indexOf("if (typeof verifyCandidate === 'function')");
  const deleteIndex = baseSource.indexOf('await deletePrimaryIpWithRetry(dc, oldPrimaryId);');
  assert(verifyIndex >= 0 && deleteIndex > verifyIndex, 'old IP must survive candidate verification');
  assert(baseSource.includes('CANDIDATE_REJECTED_ROLLBACK_FAILED'));

  const lifecycleSource = fs.readFileSync(path.join(__dirname, '../services/hetzner-lifecycle.js'), 'utf8');
  const patchedLifecycleSource = safeLifecycle.patchLifecycleSource(lifecycleSource);
  const qualityIndex = patchedLifecycleSource.indexOf('const quality = await checkQuality(ip);');
  const sshIndex = patchedLifecycleSource.indexOf('const reachable = await waitTcp(ip, sshTimeoutMs);');
  assert(qualityIndex >= 0 && sshIndex > qualityIndex, 'provisioning candidate must quality-check before long SSH wait');
  assert(patchedLifecycleSource.includes('HETZNER_PROVISIONING_IP_REJECTED_ROLLED_BACK'));
  new vm.Script(patchedLifecycleSource, { filename: 'hetzner-lifecycle.patched.js' });

  const fallbackSource = fs.readFileSync(path.join(__dirname, '../services/hetzner-location-fallback.js'), 'utf8');
  const patchedFallbackSource = fastFallback.patchLocationFallbackSource(fallbackSource);
  assert(patchedFallbackSource.includes('HETZNER_LOCATION_FALLBACK_IP_POOL_RECOVERED'));
  assert(patchedFallbackSource.includes('lifecycle.rotateProvisioningIp'));
  assert(patchedFallbackSource.includes('rotationDb.updatePublicIp = async () => true'));
  new vm.Script(patchedFallbackSource, { filename: 'hetzner-location-fallback.fast.patched.js' });

  console.log('validate-clean-ip-runtime: ok');
})().catch(error => {
  console.error(error);
  process.exit(1);
});