'use strict';

const assert = require('assert');
const { PRICING_MODE_LEGACY, PRICING_MODE_MONTHLY_PRORATED, createApiPricingSnapshot, priceFromMonthly, resolvePurchaseCycleAmount, calculateUnusedCycleRefund } = require('../api-pricing');

const plan = { amount_hourly: 25, amount_monthly: 12000 };
assert.deepStrictEqual(createApiPricingSnapshot({ monthly_prorated_pricing: 0 }, plan, 'hourly'), { pricingMode: PRICING_MODE_LEGACY, monthlyBasisPrice: null, amount: 25, duration: 'hourly' });
assert.strictEqual(createApiPricingSnapshot({ monthly_prorated_pricing: 0 }, plan, 'monthly').amount, 12000);
assert.strictEqual(priceFromMonthly(12000, 'hourly'), 16.66);
assert.strictEqual(priceFromMonthly(12000, 'daily'), 400);
assert.strictEqual(priceFromMonthly(12000, 'weekly'), 2800);
assert.strictEqual(priceFromMonthly(12000, 'monthly'), 12000);
assert.deepStrictEqual(createApiPricingSnapshot({ monthly_prorated_pricing: 1 }, plan, 'weekly'), { pricingMode: PRICING_MODE_MONTHLY_PRORATED, monthlyBasisPrice: 12000, amount: 2800, duration: 'weekly' });

assert.strictEqual(resolvePurchaseCycleAmount({ amount: 999, duration: 'hourly', pricing_mode: PRICING_MODE_MONTHLY_PRORATED, monthly_basis_price: 12000 }, 999), 16.66);

const start = new Date('2026-01-01T00:00:00.000Z');
assert.strictEqual(calculateUnusedCycleRefund({ amount: 999, cycle: 'hourly', lastBilledAt: start, now: new Date('2026-01-01T00:30:00.000Z'), pricingMode: PRICING_MODE_MONTHLY_PRORATED, monthlyBasisPrice: 12000 }).refundToman, 8.33);
assert.strictEqual(calculateUnusedCycleRefund({ amount: 25, cycle: 'hourly', lastBilledAt: start, now: new Date('2026-01-01T00:30:00.000Z') }).refundToman, 12);

console.log('API monthly prorated pricing tests passed');
