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

(async () => {
  assert(datacenters.afracloud, 'fixture should start with Afracloud configured');
  runtime.applyRuntimeSafetyDefaults();
  assert(!datacenters.afracloud, 'Afracloud must be removed from runtime datacenters');
  assert.strictEqual(process.env.HETZNER_IP_QUALITY_REQUIRED, 'true');
  assert.strictEqual(process.env.HETZNER_IP_QUALITY_IR_NODES, '6');
  assert.strictEqual(process.env.HETZNER_IP_QUALITY_IR_MIN_SUCCESS, '4');
  assert.strictEqual(process.env.HETZNER_IP_QUALITY_INCONCLUSIVE_ROTATE_PROBES, '2');
  assert.strictEqual(process.env.HETZNER_MAX_IP_QUALITY_ROTATIONS, '20');
  assert(Number(process.env.HETZNER_IP_QUALITY_INCONCLUSIVE_FAIL_OPEN_MS) > 300 * 24 * 60 * 60 * 1000);
  assert.strictEqual(Number(process.env.HETZNER_CHANGE_IP_RECENT_REUSE_COOLDOWN_MS), 30 * 60 * 1000);
  assert.strictEqual(Number(process.env.HETZNER_CHANGE_IP_REJECTED_COOLDOWN_MS), 0);

  assert.strictEqual(strictCheckHost.strictPingState([[['OK'], ['TIMEOUT'], ['TIMEOUT'], ['TIMEOUT']]]), false);
  assert.strictEqual(strictCheckHost.strictPingState([[['OK'], ['OK'], ['OK'], ['TIMEOUT']]]), true);
  assert.strictEqual(strictCheckHost.tcpNodeState([{ time: 0.12, address: '1.2.3.4' }]), true);
  assert.strictEqual(strictCheckHost.tcpNodeState([{ error: 'Connection timed out' }]), false);

  assert.strictEqual(reconcilePolicy.shouldCountInconclusive({
    status: 'pending_ip_quality', ip: '1.2.3.4',
    quality: { checked: true, definitive: false, reason: 'insufficient_results' }
  }), true);
  assert.strictEqual(reconcilePolicy.shouldCountInconclusive({
    status: 'pending_ip_quality', ip: '1.2.3.4',
    quality: { checked: false, definitive: false, reason: 'probe_error:timeout' }
  }), false);

  // IP history must not be a permanent blacklist. Rejected candidates older than
  // the short general recent-IP window are eligible to be re-tested; the clean
  // wrapper still requires SSH + Iran quality before any candidate is committed.
  const now = Date.now();
  const mockDb = {
    pool: {
      async query(sql) {
        const text = String(sql);
        if (text.includes('CREATE TABLE IF NOT EXISTS server_ip_history')) return [[], []];
        if (text.includes('FROM server_ip_history')) return [[
          { ip_address: '2.2.2.2', last_seen_at: new Date(now - 2 * 60 * 60 * 1000), last_event: 'current_before_change' },
          { ip_address: '3.3.3.3', last_seen_at: new Date(now - 10 * 60 * 1000), last_event: 'clean_ip_verified' },
          { ip_address: '4.4.4.4', last_seen_at: new Date(now - 2 * 60 * 60 * 1000), last_event: 'clean_ip_rejected_rolled_back' },
          { ip_address: '5.5.5.5', last_seen_at: new Date(now - 8 * 24 * 60 * 60 * 1000), last_event: 'candidate_verification_rejected' }
        ], []];
        if (text.includes('FROM purchases')) return [[{ ip_address: '1.1.1.1' }], []];
        throw new Error(`unexpected query: ${text}`);
      }
    }
  };
  const blocked = await baseChange.usedIps(mockDb, { datacenter: 'hetzner', serverId: 's', now });
  assert(blocked.has('1.1.1.1'), 'current IP must always be blocked');
  assert(blocked.has('3.3.3.3'), 'recent IP must be briefly blocked');
  assert(!blocked.has('2.2.2.2'), 'older healthy IP must become reusable');
  assert(!blocked.has('4.4.4.4'), 'older rejected IP must be eligible for safe re-test');
  assert(!blocked.has('5.5.5.5'), 'old rejected IP must not exhaust pool forever');

  let qualityCalls = 0;
  const noSsh = await cleanChange.verifyCleanCandidate('2.2.2.2', {
    sshProbe: async () => ({ ok: false, reason: 'timeout' }),
    qualityProbe: async () => {
      qualityCalls += 1;
      return { ok: true, definitive: true, reason: 'ok' };
    }
  });
  assert.strictEqual(noSsh.ok, false);
  assert.strictEqual(noSsh.definitive, true);
  assert.strictEqual(noSsh.reason, 'ssh_unreachable');
  assert.strictEqual(qualityCalls, 0, 'Iran quality must not run for SSH-dead candidate');

  const healthy = await cleanChange.verifyCleanCandidate('3.3.3.3', {
    sshProbe: async () => ({ ok: true, reason: 'connected' }),
    qualityProbe: async () => ({
      ok: true, definitive: true, checked: true, reason: 'ok',
      iran: { success: 6, selected: 6 }, global: { success: 6, selected: 6 }
    })
  });
  assert.strictEqual(healthy.ok, true);

  const originalChange = baseChange.changeHetznerPublicIp;
  const originalRemember = baseChange.rememberIp;
  const originalSummary = lifecycle.qualitySummary;
  let changes = 0;
  let verifierSeen = 0;
  baseChange.changeHetznerPublicIp = async args => {
    changes += 1;
    assert.strictEqual(typeof args.verifyCandidate, 'function');
    verifierSeen += 1;
    if (changes === 1) {
      const verification = await args.verifyCandidate({ ip: '2.2.2.2' });
      const error = new Error('CANDIDATE_REJECTED');
      error.code = 'CANDIDATE_REJECTED';
      error.oldIp = '1.1.1.1';
      error.candidateIp = '2.2.2.2';
      error.rollbackDone = true;
      error.verification = verification;
      throw error;
    }
    const verification = await args.verifyCandidate({ ip: '3.3.3.3' });
    return { oldIp: '1.1.1.1', newIp: '3.3.3.3', verification };
  };
  baseChange.rememberIp = async () => true;
  lifecycle.qualitySummary = q => q?.reason || 'unknown';
  process.env.HETZNER_CHANGE_IP_CLEAN_ATTEMPTS = '3';
  process.env.HETZNER_CHANGE_IP_QUALITY_PROBE_ATTEMPTS = '1';

  try {
    const result = await cleanChange.changeHetznerPublicIp({
      db: {}, dc: {}, telegramId: 'u', serverId: 's', datacenter: 'hetzner',
      sshProbe: async () => ({ ok: true, reason: 'connected' }),
      qualityProbe: async ip => ip === '2.2.2.2'
        ? { ok: false, definitive: true, checked: true, reason: 'failed_threshold', iran: { success: 0, selected: 6 }, global: { success: 6, selected: 6 } }
        : { ok: true, definitive: true, checked: true, reason: 'ok', iran: { success: 6, selected: 6 }, global: { success: 6, selected: 6 } }
    });
    assert.strictEqual(changes, 2);
    assert.strictEqual(verifierSeen, 2);
    assert.strictEqual(result.oldIp, '1.1.1.1');
    assert.strictEqual(result.newIp, '3.3.3.3');
    assert.strictEqual(result.attempts, 2);
    assert.strictEqual(result.quality.ok, true);
  } finally {
    baseChange.changeHetznerPublicIp = originalChange;
    baseChange.rememberIp = originalRemember;
    lifecycle.qualitySummary = originalSummary;
  }

  const baseSource = fs.readFileSync(path.join(__dirname, '../services/hetzner-change-ip.js'), 'utf8');
  const verifyIndex = baseSource.indexOf("if (typeof verifyCandidate === 'function')");
  const deleteIndex = baseSource.indexOf('await deletePrimaryIpWithRetry(dc, oldPrimaryId);');
  const updateNewIndex = baseSource.indexOf('await db.updatePublicIp(telegramId, serverId, datacenter, ready.ip);');
  assert(verifyIndex >= 0 && deleteIndex > verifyIndex, 'old Primary IP must survive candidate verification');
  assert(updateNewIndex > deleteIndex, 'DB must not publish candidate IP until commit succeeds');
  assert(baseSource.includes('CANDIDATE_REJECTED_ROLLBACK_FAILED'));
  assert(baseSource.includes('await waitForNewIp(dc, serverId, oldIp)'));
  assert(baseSource.includes('HETZNER_CHANGE_IP_REJECTED_COOLDOWN_MS'));

  const lifecyclePath = path.join(__dirname, '../services/hetzner-lifecycle.js');
  const patchedLifecycleSource = safeLifecycle.patchLifecycleSource(fs.readFileSync(lifecyclePath, 'utf8'));
  assert(patchedLifecycleSource.includes('verifyProvisioningCandidate'));
  assert(patchedLifecycleSource.includes('verifyCandidate: async ({ ip }) => verifyProvisioningCandidate(ip)'));
  assert(patchedLifecycleSource.includes('[HETZNER_PROVISIONING_IP_REJECTED_ROLLED_BACK]'));
  assert(!patchedLifecycleSource.includes('newIp = await reserveUniquePrimaryIpv4(db'));
  new vm.Script(patchedLifecycleSource, { filename: 'hetzner-lifecycle.patched.js' });

  console.log('validate-clean-ip-runtime: ok');
})().catch(error => {
  console.error(error);
  process.exit(1);
});