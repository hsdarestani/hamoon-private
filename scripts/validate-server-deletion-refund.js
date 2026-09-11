'use strict';

const assert = require('assert');
const fs = require('fs');
const refund = require('../server-deletion-refund');

const base = new Date('2026-09-11T00:00:00.000Z');
let r = refund.calculateUnusedCycleRefund({
  amount: 240000,
  cycle: 'daily',
  lastBilledAt: base,
  now: new Date(base.getTime() + 12 * 3600000)
});
assert.strictEqual(r.refundToman, 120000);

r = refund.calculateUnusedCycleRefund({
  amount: 10000,
  cycle: 'hourly',
  lastBilledAt: base,
  now: new Date(base.getTime() + 30 * 60000)
});
assert.strictEqual(r.refundToman, 5000);

r = refund.calculateUnusedCycleRefund({
  amount: 720000,
  cycle: 'monthly',
  lastBilledAt: base,
  now: new Date(base.getTime() + 720 * 3600000)
});
assert.strictEqual(r.refundToman, 0);

assert.strictEqual(refund.isInitialApiCycle({ boot_method: 'api', created_at: base, last_billed_at: base }), true);
assert.strictEqual(refund.isInitialApiCycle({ boot_method: 'volume', created_at: base, last_billed_at: base }), false);

const lifecycle = fs.readFileSync('services/hetzner-lifecycle.js', 'utf8');
const api = fs.readFileSync('customer-api.js', 'utf8');
const core = fs.readFileSync('index-core.js', 'utf8');
assert(lifecycle.includes('refundUnusedServerCycle'));
assert(lifecycle.includes("status: 'refund_retry_failed'"));
assert(api.includes('chargeApiInitialCycle'));
assert(api.includes('rollbackApiInitialCycle'));
assert(core.includes('server-deletion-refund'));
assert(core.includes('مانده دوره'));

console.log('validate-server-deletion-refund: ok');
