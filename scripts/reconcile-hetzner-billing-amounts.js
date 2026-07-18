#!/usr/bin/env node
const db = require('../db');
const { getFlavorCyclePrice } = require('../services/hetzner-lifecycle');
const { datacenters } = require('../datacenters');
const { getHetznerSellablePlans } = require('../Hetzner/hetzner-api');

(async () => {
  const apply = process.argv.includes('--apply');
  console.log(`[hetzner-billing-reconcile] mode=${apply ? 'APPLY' : 'DRY_RUN'}`);
  await db.initializeDatabase?.();
  const rows = (await db.getAllPurchases()).filter(p => String(p.datacenter || '').toLowerCase().includes('hetzner'));
  const dc = datacenters?.hetzner || Object.values(datacenters || {}).find(d => d?.provider === 'hetzner' || d?.apiType === 'hetzner') || {};
  const plans = await getHetznerSellablePlans(dc).catch(() => []);
  for (const p of rows) {
    const plan = plans.find(x => x.id === String(p.flavor_id || '').toLowerCase() || x.hetzner_type === String(p.flavor_id || '').toLowerCase());
    if (!plan) continue;
    const expected = getFlavorCyclePrice(plan, p.duration);
    const current = Number(p.amount || 0);
    if (expected > 0 && Math.abs(current - expected) > 1) {
      console.log(JSON.stringify({ server_id: p.server_id, datacenter: p.datacenter, duration: p.duration, before: current, after: expected }));
      if (apply) await db.updatePurchasePlan(p.telegram_id, p.server_id, p.datacenter, p.flavor_id, expected);
    }
  }
  process.exit(0);
})().catch(e => { console.error('[hetzner-billing-reconcile] failed:', e.code || e.message); process.exit(1); });
