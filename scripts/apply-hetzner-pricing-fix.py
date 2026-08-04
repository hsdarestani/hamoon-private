#!/usr/bin/env python3
from pathlib import Path
import json


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


# 1) Location-aware Hetzner prices and per-location cache.
path = Path("Hetzner/hetzner-api.js")
text = path.read_text(encoding="utf-8")
text = replace_once(
    text,
    "let serverTypeCache = { expires: 0, plans: null };",
    "const serverTypeCache = new Map();",
    "server type cache declaration",
)
text = replace_once(
    text,
    """function firstPrice(serverType) {
  const prices = Array.isArray(serverType?.prices) ? serverType.prices : [];
  return prices.find(p => p?.price_hourly || p?.price_monthly) || prices[0] || {};
}""",
    """function normalizeLocation(value) {
  return String(value?.name || value || '').trim().toLowerCase();
}

function configuredPriceLocations(config = {}) {
  const preferred = normalizeLocation(config.HETZNER_LOCATION || config.location);
  const fallbacks = String(config.HETZNER_LOCATION_FALLBACKS || '')
    .split(',')
    .map(normalizeLocation)
    .filter(Boolean);
  return [...new Set([preferred, ...fallbacks].filter(Boolean))];
}

function firstPrice(serverType, config = {}) {
  const prices = Array.isArray(serverType?.prices) ? serverType.prices : [];
  const usable = prices.filter(p => p?.price_hourly || p?.price_monthly);
  for (const location of configuredPriceLocations(config)) {
    const match = usable.find(p => normalizeLocation(p?.location) === location);
    if (match) return match;
  }
  return usable[0] || prices[0] || {};
}

function hetznerPlanCacheKey(config = {}) {
  return [
    String(config.key || config.name || 'hetzner').trim().toLowerCase(),
    ...configuredPriceLocations(config),
  ].join('|');
}""",
    "location-aware firstPrice",
)
text = replace_once(
    text,
    "function normalizeHetznerServerTypes(serverTypes = []) {",
    "function normalizeHetznerServerTypes(serverTypes = [], config = {}) {",
    "normalizeHetznerServerTypes signature",
)
text = replace_once(
    text,
    "const price = firstPrice(st);",
    "const price = firstPrice(st, config);",
    "firstPrice call",
)
text = replace_once(
    text,
    """async function getHetznerSellablePlans(config = {}) {
  const now = Date.now();
  if (serverTypeCache.plans && serverTypeCache.expires > now) return serverTypeCache.plans;
  try {
    const plans = normalizeHetznerServerTypes(await listHetznerServerTypes(config));
    if (plans.length) {
      serverTypeCache = { plans, expires: now + SERVER_TYPE_CACHE_MS };
      return plans;
    }
  } catch (e) {
    console.warn('[hetzner] using static plan fallback:', e.message);
  }
  const fallback = normalizeStaticHetznerPlans(config);
  if (fallback.length) return fallback;
  throw new Error('HETZNER_PLAN_CATALOG_UNAVAILABLE');
}""",
    """async function getHetznerSellablePlans(config = {}) {
  const now = Date.now();
  const cacheKey = hetznerPlanCacheKey(config);
  const cached = serverTypeCache.get(cacheKey);
  if (cached?.plans && cached.expires > now) return cached.plans;
  try {
    const plans = normalizeHetznerServerTypes(await listHetznerServerTypes(config), config);
    if (plans.length) {
      serverTypeCache.set(cacheKey, { plans, expires: now + SERVER_TYPE_CACHE_MS });
      return plans;
    }
  } catch (e) {
    console.warn('[hetzner] using static plan fallback:', e.message);
  }
  const fallback = normalizeStaticHetznerPlans(config);
  if (fallback.length) return fallback;
  throw new Error('HETZNER_PLAN_CATALOG_UNAVAILABLE');
}""",
    "location-aware plan cache",
)
text = replace_once(
    text,
    "  normalizeHetznerServerTypes,\n  getHetznerSellablePlans,",
    "  normalizeHetznerServerTypes,\n  firstPrice,\n  hetznerPlanCacheKey,\n  getHetznerSellablePlans,",
    "Hetzner exports",
)
path.write_text(text, encoding="utf-8")


# 2) Store full cycle prices and safely interpret legacy hourly rows.
path = Path("index.js")
text = path.read_text(encoding="utf-8")
text = replace_once(
    text,
    """function getFlavorCyclePrice(flavor, cycle) {
  if (flavor?.pricesByCycle && Number(flavor.pricesByCycle[cycle]) > 0) {
    return Math.round(Number(flavor.pricesByCycle[cycle]));
  }
  if (cycle === 'monthly' && Number(flavor?.monthly_price || flavor?.monthlyPrice) > 0) {
    return Math.round(Number(flavor.monthly_price || flavor.monthlyPrice));
  }
  return Math.round(Number(flavor?.price || 0) * HOURS_IN_CYCLE[cycle]);
}""",
    """function getFlavorCyclePrice(flavor, cycle) {
  const cycleHours = HOURS_IN_CYCLE[cycle];
  if (!cycleHours) return 0;
  if (flavor?.pricesByCycle && Number(flavor.pricesByCycle[cycle]) > 0) {
    return Math.round(Number(flavor.pricesByCycle[cycle]));
  }
  const monthly = Number(
    flavor?.amount_monthly ??
    flavor?.monthly_toman ??
    flavor?.monthly_price_toman ??
    flavor?.monthly_price ??
    flavor?.monthlyPrice ??
    0
  );
  const hourly = Number(
    flavor?.amount_hourly ??
    flavor?.hourly_price_toman ??
    flavor?.price ??
    (monthly > 0 ? monthly / HOURS_IN_CYCLE.monthly : 0)
  );
  if (cycle === 'monthly') return Math.round(monthly || hourly * HOURS_IN_CYCLE.monthly);
  return Math.round(hourly * cycleHours);
}

function normalizeStoredCycleAmount(purchase, dcConfig = null) {
  const amount = Number(purchase?.amount || 0);
  const cycle = String(purchase?.duration || 'hourly');
  const cycleHours = HOURS_IN_CYCLE[cycle];
  if (!(amount > 0) || !cycleHours || cycle === 'hourly') return amount;

  const dc = dcConfig || baseDatacenters[purchase?.datacenter] || null;
  const flavorId = String(purchase?.flavor_id || '').toLowerCase();
  const configuredFlavor = (dc?.flavors || []).find((flavor) => {
    const ids = [flavor?.id, flavor?.hetzner_type, flavor?.server_type]
      .map((value) => String(value || '').toLowerCase());
    return ids.includes(flavorId);
  });
  const expectedCycleAmount = configuredFlavor ? getFlavorCyclePrice(configuredFlavor, cycle) : 0;
  if (!(expectedCycleAmount > 0)) return amount;

  const expandedLegacyAmount = Math.round(amount * cycleHours);
  const storedDistance = Math.abs(amount - expectedCycleAmount);
  const expandedDistance = Math.abs(expandedLegacyAmount - expectedCycleAmount);
  return expandedDistance < storedDistance ? expandedLegacyAmount : amount;
}""",
    "cycle price helpers",
)
text = replace_once(
    text,
    "const amountForDb = finalPrice / HOURS_IN_CYCLE[selectedCycle];",
    "const amountForDb = finalPrice;",
    "purchase amount storage",
)
text = replace_once(
    text,
    """    // ۲) اعتبار زمان استفاده‌نشده در سیکل فعلی (بر اساس نرخ ساعتی ثبت‌شده در purchase.amount)
    const currentCycleHours  = HOURS_IN_CYCLE[purchase.duration];
    if (!currentCycleHours) {
      return sendMessage(chatId, `❌ سیکل فعلی نامعتبر است: ${escapeMarkdownV2(String(purchase.duration))}`);
    }
    const hourlyPrice        = Number(purchase.amount) || 0; // نرخ ساعتی فعلی
    const unusedHours        = Math.max(0, currentCycleHours - elapsedHours);
    const creditForUnusedTime= unusedHours * hourlyPrice;

    // ۳) هزینه سیکل جدید (باز هم با همان نرخ ساعتی)
    const targetCycleHours   = HOURS_IN_CYCLE[newCycle];
    if (!targetCycleHours) {
      return sendMessage(chatId, `❌ سیکل انتخابی نامعتبر است: ${escapeMarkdownV2(String(newCycle))}`);
    }
    const newCyclePrice      = hourlyPrice * targetCycleHours;""",
    """    // ۲) اعتبار زمان استفاده‌نشده در سیکل فعلی بر اساس مبلغ کامل دوره
    const currentCycleHours  = HOURS_IN_CYCLE[purchase.duration];
    if (!currentCycleHours) {
      return sendMessage(chatId, `❌ سیکل فعلی نامعتبر است: ${escapeMarkdownV2(String(purchase.duration))}`);
    }
    const currentCycleAmount = normalizeStoredCycleAmount(purchase);
    const hourlyPrice        = currentCycleAmount / currentCycleHours;
    const unusedHours        = Math.max(0, currentCycleHours - elapsedHours);
    const creditForUnusedTime= unusedHours * hourlyPrice;

    // ۳) هزینه سیکل جدید با همان نرخ ساعتی مؤثر
    const targetCycleHours   = HOURS_IN_CYCLE[newCycle];
    if (!targetCycleHours) {
      return sendMessage(chatId, `❌ سیکل انتخابی نامعتبر است: ${escapeMarkdownV2(String(newCycle))}`);
    }
    const newCyclePrice      = Math.round(hourlyPrice * targetCycleHours);""",
    "cycle change calculation",
)
text = replace_once(
    text,
    "const oldAmount = Number(purchase.amount || (current ? getFlavorCyclePrice(current, purchase.duration || 'monthly') : 0));",
    "const oldAmount = normalizeStoredCycleAmount(purchase, liveDc) || (current ? getFlavorCyclePrice(current, purchase.duration || 'monthly') : 0);",
    "upgrade old amount",
)
text = replace_once(
    text,
    "const cycleAmount = Number(purchase.amount || 0);",
    "const cycleAmount = normalizeStoredCycleAmount(purchase, dcConfig);",
    "auto-renew cycle amount",
)
text = replace_once(
    text,
    "instanceCost = parseFloat(amount); // amount = هزینه دوره انتخاب‌شده",
    "instanceCost = normalizeStoredCycleAmount(purchase); // مبلغ کامل دوره؛ رکوردهای ساعتی قدیمی نیز نرمال می‌شوند",
    "billing cycle amount",
)
path.write_text(text, encoding="utf-8")


# 3) Reconciliation only fixes hourly-storage rows; valid grandfathered prices remain unchanged.
Path("scripts/reconcile-hetzner-billing-amounts.js").write_text(
    """#!/usr/bin/env node
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
""",
    encoding="utf-8",
)


# 4) Regression validator.
Path("scripts/validate-hetzner-pricing.js").write_text(
    """#!/usr/bin/env node
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
""",
    encoding="utf-8",
)


package_path = Path("package.json")
package = json.loads(package_path.read_text(encoding="utf-8"))
scripts = package.setdefault("scripts", {})
scripts["validate:hetzner-pricing"] = "node scripts/validate-hetzner-pricing.js"
test_parts = scripts.get("test", "").split(" && ")
command = "npm run validate:hetzner-pricing"
if command not in test_parts:
    test_parts.append(command)
scripts["test"] = " && ".join(part for part in test_parts if part)
package_path.write_text(json.dumps(package, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

print("apply-hetzner-pricing-fix: patched")
