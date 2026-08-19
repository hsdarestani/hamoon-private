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

  const originalChange = baseChange.changeHetznerPublicIp;
  const originalRemember = baseChange.rememberIp;
  const originalCheck = lifecycle.checkIpQuality;
  const originalSummary = lifecycle.qualitySummary;

  let changes = 0;
  baseChange.changeHetznerPublicIp = async () => {
    changes += 1;
    return changes === 1
      ? { oldIp: '1.1.1.1', newIp: '2.2.2.2' }
      : { oldIp: '2.2.2.2', newIp: '3.3.3.3' };
  };
  baseChange.rememberIp = async () => true;
  lifecycle.checkIpQuality = async ip => ip === '2.2.2.2'
    ? { ok: false, definitive: true, checked: true, reason: 'failed_threshold', iran: { success: 0, selected: 6 }, global: { success: 6, selected: 6 } }
    : { ok: true, definitive: true, checked: true, reason: 'ok', iran: { success: 6, selected: 6 }, global: { success: 6, selected: 6 } };
  lifecycle.qualitySummary = q => q.reason;
  process.env.HETZNER_CHANGE_IP_CLEAN_ATTEMPTS = '3';
  process.env.HETZNER_CHANGE_IP_QUALITY_PROBE_ATTEMPTS = '1';

  try {
    const result = await cleanChange.changeHetznerPublicIp({
      db: {}, dc: {}, telegramId: 'u', serverId: 's', datacenter: 'hetzner'
    });
    assert.strictEqual(changes, 2, 'a definitively bad Iran IP must be rotated again');
    assert.strictEqual(result.oldIp, '1.1.1.1');
    assert.strictEqual(result.newIp, '3.3.3.3');
    assert.strictEqual(result.attempts, 2);
    assert.strictEqual(result.quality.ok, true);
  } finally {
    baseChange.changeHetznerPublicIp = originalChange;
    baseChange.rememberIp = originalRemember;
    lifecycle.checkIpQuality = originalCheck;
    lifecycle.qualitySummary = originalSummary;
  }

  console.log('validate-clean-ip-runtime: ok');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
