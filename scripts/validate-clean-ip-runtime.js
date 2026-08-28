#!/usr/bin/env node
'use strict';

const assert = require('assert');
const runtime = require('../runtime-bootstrap');
const datacenters = require('../datacenters');
const baseChange = require('../services/hetzner-change-ip');
const lifecycle = require('../services/hetzner-lifecycle');
const cleanChange = require('../services/hetzner-clean-ip-change');
const strictCheckHost = require('../services/check-host-strict-fetch');
const reconcilePolicy = require('../services/hetzner-reconcile-policy');

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

  // Regression: the previous parser considered a node healthy if only one out of
  // four ICMP attempts returned OK. Strict mode must reject that case.
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

  // Candidate verification must require SSH before Iran quality.
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
  assert.strictEqual(qualityCalls, 0, 'Iran quality must not run for an SSH-dead candidate');

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
    assert.strictEqual(typeof args.verifyCandidate, 'function', 'clean wrapper must verify before base commits/deletes old IP');
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
    assert.strictEqual(changes, 2, 'a definitively bad candidate must rollback, then rotate again');
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

  // Static regression guard: base must verify before deleting the old Primary IP
  // and only persist the new public IP after the old resource is successfully retired.
  const fs = require('fs');
  const path = require('path');
  const baseSource = fs.readFileSync(path.join(__dirname, '../services/hetzner-change-ip.js'), 'utf8');
  const verifyIndex = baseSource.indexOf("if (typeof verifyCandidate === 'function')");
  const deleteIndex = baseSource.indexOf('await deletePrimaryIpWithRetry(dc, oldPrimaryId);');
  const updateNewIndex = baseSource.indexOf('await db.updatePublicIp(telegramId, serverId, datacenter, ready.ip);');
  assert(verifyIndex >= 0 && deleteIndex > verifyIndex, 'old Primary IP must survive candidate verification');
  assert(updateNewIndex > deleteIndex, 'DB must not publish candidate IP until commit succeeds');
  assert(baseSource.includes('CANDIDATE_REJECTED_ROLLBACK_FAILED'));
  assert(baseSource.includes('await waitForNewIp(dc, serverId, oldIp)'));

  console.log('validate-clean-ip-runtime: ok');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
