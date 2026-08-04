#!/usr/bin/env node
const db = require('../db');
const datacenters = require('../datacenters');
const { getFlavorCyclePrice } = require('../services/hetzner-lifecycle');
const { getHetznerSellablePlans } = require('../Hetzner/hetzner-api');

const HOURS_IN_CYCLE = { hourly: 1, daily: 24, weekly: 168, monthly: 720 };

(async () => {
  const apply = process.argv.includes('--apply');
  console.log(`[hetzner-billing-reconcile] mode=${apply ? 'APPLY' : 'DRY_RUN'}`);
  await db.initializeDatabase?.();
  const rows = (await db.getAllPurchases()).filter((purchase) =>
    String(purchase.datacenter || '').toLowerCase().includes('hetzner')
  );
  const planCache = new Map();

  for (const purchase of rows) {
    const dc = datacenters[purchase.datacenter] || datacenters.hetzner || {};
    const cacheKey = String(dc.key || purchase.datacenter || 'hetzner');
    if (!planCache.has(cacheKey)) {
      planCache.set(cacheKey, await getHetznerSellablePlans(dc).catch(() => dc.flavors || []));
    }
    const plans = planCache.get(cacheKey);
    const flavorId = String(purchase.flavor_id || '').toLowerCase();
    const plan = plans.find((item) =>
      [item.id, item.hetzner_type, item.server_type]
        .map((value) => String(value || '').toLowerCase())
        .includes(flavorId)
    );
    if (!plan) continue;

    const expected = getFlavorCyclePrice(plan, purchase.duration);
    const current = Number(purchase.amount || 0);
    const hours = HOURS_IN_CYCLE[purchase.duration];
    if (!(expected > 0) || !(current > 0) || !hours) continue;

    const expandedLegacy = Math.round(current * hours);
    const storedDistanceRatio = Math.abs(current - expected) / expected;
    const expandedDistanceRatio = Math.abs(expandedLegacy - expected) / expected;
    const likelyHourlyStorage = purchase.duration !== 'hourly' &&
      expandedDistanceRatio <= 0.45 &&
      expandedDistanceRatio + 0.05 < storedDistanceRatio;

    if (likelyHourlyStorage) {
      console.log(JSON.stringify({
        server_id: purchase.server_id,
        datacenter: purchase.datacenter,
        duration: purchase.duration,
        before: current,
        after: expandedLegacy,
        reason: 'legacy_hourly_storage',
      }));
      if (apply) {
        await db.updatePurchasePlan(
          purchase.telegram_id,
          purchase.server_id,
          purchase.datacenter,
          purchase.flavor_id,
          expandedLegacy
        );
      }
    } else if (Math.abs(current - expected) > 1) {
      console.log(JSON.stringify({
        server_id: purchase.server_id,
        datacenter: purchase.datacenter,
        duration: purchase.duration,
        current,
        current_catalog: expected,
        reason: 'preserved_cycle_price',
      }));
    }
  }
  process.exit(0);
})().catch((error) => {
  console.error('[hetzner-billing-reconcile] failed:', error.code || error.message);
  process.exit(1);
});
