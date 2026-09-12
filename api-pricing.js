'use strict';

const HOURS_IN_CYCLE = Object.freeze({ hourly: 1, daily: 24, weekly: 168, monthly: 720 });
const PRICING_MODE_LEGACY = 'legacy';
const PRICING_MODE_MONTHLY_PRORATED = 'monthly_prorated';

function roundMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function floorMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.floor((n + Number.EPSILON) * 100) / 100;
}

function isMonthlyProrated(value) {
  return value === true || Number(value) === 1 || String(value || '').toLowerCase() === PRICING_MODE_MONTHLY_PRORATED;
}

function priceFromMonthly(monthlyPrice, duration) {
  const monthly = Number(monthlyPrice);
  const hours = HOURS_IN_CYCLE[String(duration || '').toLowerCase()] || 0;
  if (!(monthly > 0) || !hours) return 0;
  return floorMoney((monthly / 30 / 24) * hours);
}

function createApiPricingSnapshot(client, plan, duration) {
  const cycle = String(duration || 'hourly').toLowerCase();
  if (!HOURS_IN_CYCLE[cycle]) throw new Error('INVALID_BILLING_CYCLE');
  if (isMonthlyProrated(client?.monthly_prorated_pricing)) {
    const monthlyBasisPrice = Number(plan?.amount_monthly);
    const amount = priceFromMonthly(monthlyBasisPrice, cycle);
    if (!(amount > 0)) throw new Error('MONTHLY_PRICE_UNAVAILABLE');
    return { pricingMode: PRICING_MODE_MONTHLY_PRORATED, monthlyBasisPrice, amount, duration: cycle };
  }
  const amount = Number(cycle === 'monthly' ? plan?.amount_monthly : plan?.amount_hourly);
  if (!(amount > 0)) throw new Error('PRICE_UNAVAILABLE');
  return { pricingMode: PRICING_MODE_LEGACY, monthlyBasisPrice: null, amount, duration: cycle };
}

function resolvePurchaseCycleAmount(purchase, fallbackAmount) {
  if (String(purchase?.pricing_mode || '').toLowerCase() === PRICING_MODE_MONTHLY_PRORATED) {
    return priceFromMonthly(purchase?.monthly_basis_price, purchase?.duration);
  }
  const amount = Number(fallbackAmount ?? purchase?.amount);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function calculateUnusedCycleRefund({ amount, cycle, lastBilledAt, createdAt, now = new Date(), pricingMode = 'legacy', monthlyBasisPrice = null }) {
  const cycleHours = HOURS_IN_CYCLE[String(cycle || '').toLowerCase()] || 0;
  const paidAmount = Math.max(0, resolvePurchaseCycleAmount({ amount, duration: cycle, pricing_mode: pricingMode, monthly_basis_price: monthlyBasisPrice }, amount));
  const start = lastBilledAt ? new Date(lastBilledAt) : (createdAt ? new Date(createdAt) : null);
  const current = now instanceof Date ? now : new Date(now);
  if (!cycleHours || !(paidAmount > 0) || !start || Number.isNaN(start.getTime()) || Number.isNaN(current.getTime())) {
    return { refundToman: 0, remainingMs: 0, cycleMs: cycleHours * 3600000, periodStart: start };
  }
  const cycleMs = cycleHours * 3600000;
  const elapsedMs = Math.max(0, current.getTime() - start.getTime());
  const remainingMs = Math.max(0, cycleMs - Math.min(cycleMs, elapsedMs));
  const rawRefund = (paidAmount * remainingMs) / cycleMs;
  const refundToman = Math.max(0, pricingMode === PRICING_MODE_MONTHLY_PRORATED ? floorMoney(rawRefund) : Math.floor(rawRefund));
  return { refundToman, remainingMs, cycleMs, periodStart: start };
}

module.exports = { HOURS_IN_CYCLE, PRICING_MODE_LEGACY, PRICING_MODE_MONTHLY_PRORATED, roundMoney, floorMoney, isMonthlyProrated, priceFromMonthly, createApiPricingSnapshot, resolvePurchaseCycleAmount, calculateUnusedCycleRefund };
