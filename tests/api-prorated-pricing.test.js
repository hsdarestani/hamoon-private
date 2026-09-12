'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const pricing = require('../api-prorated-pricing');

const plan = { amount_hourly: 25, amount_monthly: 12000 };

assert.strictEqual(pricing.getApiCyclePrice(plan, 'hourly', false), 25, 'normal API user must preserve hourly catalog price');
assert.strictEqual(pricing.getApiCyclePrice(plan, 'monthly', false), 12000, 'normal API user must preserve monthly catalog price');

assert.strictEqual(pricing.calculateMonthlyProratedCyclePrice(12000, 'hourly'), 16.666667);
assert.strictEqual(pricing.calculateMonthlyProratedCyclePrice(12000, 'daily'), 400);
assert.strictEqual(pricing.calculateMonthlyProratedCyclePrice(12000, 'weekly'), 2800);
assert.strictEqual(pricing.calculateMonthlyProratedCyclePrice(12000, 'monthly'), 12000);

assert.strictEqual(pricing.getApiCyclePrice(plan, 'hourly', true), 16.666667, 'monthly basis must override provider hourly price');
assert.strictEqual(pricing.getApiCyclePrice(plan, 'daily', true), 400);
assert.strictEqual(pricing.getApiCyclePrice(plan, 'weekly', true), 2800);
assert.strictEqual(pricing.getApiCyclePrice(plan, 'monthly', true), 12000);

const refund = pricing.calculateUnusedProratedRefund({
  amount: 400,
  cycle: 'daily',
  lastBilledAt: new Date('2026-09-12T00:00:00Z'),
  now: new Date('2026-09-12T12:00:00Z')
});
assert.strictEqual(refund.refundToman, 200, 'half-used prorated daily cycle must refund half the paid cycle');

const root = path.resolve(__dirname, '..');
if (fs.existsSync(path.join(root, 'index-core.js'))) {
  const patchedCore = pricing.applyIndexCorePricingPatch(fs.readFileSync(path.join(root, 'index-core.js'), 'utf8'));
  assert(patchedCore.includes("Number(purchase?.api_monthly_prorated_pricing || 0) === 1"), 'renewal path must preserve snapshotted prorated amount');
}
if (fs.existsSync(path.join(root, 'customer-api.js'))) {
  const patchedApi = pricing.applyCustomerApiPatches(fs.readFileSync(path.join(root, 'customer-api.js'), 'utf8'));
  assert(patchedApi.includes("['hourly', 'daily', 'weekly', 'monthly']"), 'API server creation must support all billing cycles');
  assert(patchedApi.includes('recordApiPurchaseWithPricing'), 'API server creation must persist the pricing snapshot atomically with the purchase');
}
if (fs.existsSync(path.join(root, 'billing-settlement.js'))) {
  const patchedSettlement = pricing.applyBillingSettlementPatches(fs.readFileSync(path.join(root, 'billing-settlement.js'), 'utf8'));
  assert(patchedSettlement.includes("pricingMode:"), 'renewal event must report the pricing mode');
  assert(patchedSettlement.includes('Math.round(renewalRaw * 100) / 100'), 'prorated renewal must preserve wallet precision');
}
if (fs.existsSync(path.join(root, 'server-deletion-refund.js'))) {
  const patchedRefund = pricing.applyDeletionRefundPatches(fs.readFileSync(path.join(root, 'server-deletion-refund.js'), 'utf8'));
  assert(patchedRefund.includes('calculateUnusedProratedRefund'), 'deletion refund must use the snapshotted prorated mode');
}

console.log('api-prorated-pricing tests: ok');
