#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');

process.env.HETZNER_EUR_TO_TOMAN = '100000';
process.env.HETZNER_PRICE_MULTIPLIER = '1';
process.env.HETZNER_HOURLY_PRICE_MULTIPLIER = '1';
process.env.HETZNER_MONTHLY_PRICE_MULTIPLIER = '1';
process.env.HETZNER_PRICE_ROUND_TO = '1';

const api = require('../Hetzner/hetzner-api');
const sample = [{
  name: 'cx23', cores: 2, memory: 4, disk: 40,
  deprecated: false, deprecation: null,
  prices: [
    { location: 'nbg1', price_hourly: { gross: '0.0100' }, price_monthly: { gross: '5.00' } },
    { location: 'hel1', price_hourly: { gross: '0.0140' }, price_monthly: { gross: '7.00' } },
  ],
}];

const germany = api.normalizeHetznerServerTypes(sample, { key: 'hetzner', HETZNER_LOCATION: 'nbg1' });
const finland = api.normalizeHetznerServerTypes(sample, { key: 'hetzner-finland', HETZNER_LOCATION: 'hel1' });
assert.strictEqual(germany[0].amount_monthly, 500000);
assert.strictEqual(finland[0].amount_monthly, 700000);
assert.notStrictEqual(
  api.hetznerPlanCacheKey({ key: 'hetzner', HETZNER_LOCATION: 'nbg1' }),
  api.hetznerPlanCacheKey({ key: 'hetzner-finland', HETZNER_LOCATION: 'hel1' })
);

const indexSource = fs.readFileSync(require.resolve('../index.js'), 'utf8');
assert(indexSource.includes('const amountForDb = finalPrice;'));
assert(indexSource.includes('function normalizeStoredCycleAmount('));
assert(indexSource.includes('instanceCost = normalizeStoredCycleAmount(purchase)'));

const reconcileSource = fs.readFileSync(require.resolve('./reconcile-hetzner-billing-amounts.js'), 'utf8');
assert(reconcileSource.includes("reason: 'legacy_hourly_storage'"));
assert(reconcileSource.includes("reason: 'preserved_cycle_price'"));
assert(!reconcileSource.includes('const dc = datacenters?.hetzner'));

console.log('validate-hetzner-pricing: ok');
