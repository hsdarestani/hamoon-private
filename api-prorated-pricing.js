'use strict';

const HOURS_IN_CYCLE = Object.freeze({ hourly: 1, daily: 24, weekly: 168, monthly: 720 });
const INSTALL_MARK = Symbol.for('hamoon.apiProratedPricingInstalled');

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function roundSix(value) {
  return Number(Number(value || 0).toFixed(6));
}

function roundWallet(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function getMonthlyPriceFromPlan(plan) {
  return finitePositive(
    plan?.amount_monthly ??
    plan?.monthly_toman ??
    plan?.monthly_price_toman ??
    plan?.monthly_price ??
    plan?.monthlyPrice
  );
}

function getHourlyPriceFromPlan(plan) {
  const monthly = getMonthlyPriceFromPlan(plan);
  return finitePositive(
    plan?.amount_hourly ??
    plan?.hourly_price_toman ??
    plan?.hourly_price ??
    plan?.hourlyPrice ??
    plan?.price ??
    (monthly > 0 ? monthly / HOURS_IN_CYCLE.monthly : 0)
  );
}

function calculateMonthlyProratedCyclePrice(monthlyPrice, cycle) {
  const monthly = finitePositive(monthlyPrice);
  const hours = HOURS_IN_CYCLE[String(cycle || '').toLowerCase()] || 0;
  if (!(monthly > 0) || !hours) return 0;
  if (hours === HOURS_IN_CYCLE.monthly) return roundSix(monthly);
  return roundSix((monthly / 30 / 24) * hours);
}

function calculateLegacyCyclePrice(plan, cycle) {
  const normalized = String(cycle || '').toLowerCase();
  const hours = HOURS_IN_CYCLE[normalized] || 0;
  if (!hours) return 0;
  const monthly = getMonthlyPriceFromPlan(plan);
  const hourly = getHourlyPriceFromPlan(plan);
  if (normalized === 'monthly') return roundSix(monthly || hourly * HOURS_IN_CYCLE.monthly);
  return roundSix(hourly * hours);
}

function getApiCyclePrice(plan, cycle, monthlyProratedPricing) {
  return monthlyProratedPricing
    ? calculateMonthlyProratedCyclePrice(getMonthlyPriceFromPlan(plan), cycle)
    : calculateLegacyCyclePrice(plan, cycle);
}

function getCyclePriceMap(plan, monthlyProratedPricing) {
  return Object.fromEntries(
    Object.keys(HOURS_IN_CYCLE).map(cycle => [cycle, getApiCyclePrice(plan, cycle, monthlyProratedPricing)])
  );
}

function decoratePlanForClient(plan, monthlyProratedPricing) {
  const enabled = !!monthlyProratedPricing;
  return {
    ...plan,
    api_pricing_mode: enabled ? 'monthly_prorated' : 'standard',
    api_effective_prices: getCyclePriceMap(plan, enabled)
  };
}

function calculateUnusedProratedRefund({ amount, cycle, lastBilledAt, createdAt, now = new Date() }) {
  const cycleHours = HOURS_IN_CYCLE[String(cycle || '').toLowerCase()] || 0;
  const paidAmount = finitePositive(amount);
  const start = new Date(lastBilledAt || createdAt || 0);
  const current = now instanceof Date ? now : new Date(now);
  if (!cycleHours || !(paidAmount > 0) || Number.isNaN(start.getTime()) || Number.isNaN(current.getTime())) {
    return { refundToman: 0, remainingMs: 0, cycleMs: cycleHours * 3600000, periodStart: Number.isNaN(start.getTime()) ? null : start };
  }
  const cycleMs = cycleHours * 3600000;
  const elapsedMs = Math.max(0, current.getTime() - start.getTime());
  const remainingMs = Math.max(0, cycleMs - Math.min(cycleMs, elapsedMs));
  const refundToman = Math.max(0, Math.floor(((paidAmount * remainingMs) / cycleMs) * 100) / 100);
  return { refundToman, remainingMs, cycleMs, periodStart: start };
}

async function ensureColumn(db, tableName, columnName, definition) {
  const [rows] = await db.pool.execute(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [tableName, columnName]
  );
  if (rows.length) return false;
  try {
    await db.pool.execute(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${definition}`);
    return true;
  } catch (error) {
    if (error?.code === 'ER_DUP_FIELDNAME') return false;
    throw error;
  }
}

let schemaPromise = null;
async function ensureApiProratedPricingSchema(db) {
  if (!db?.pool) throw new Error('DB_POOL_UNAVAILABLE');
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    await ensureColumn(db, 'api_clients', 'monthly_prorated_pricing', 'TINYINT(1) NOT NULL DEFAULT 0');
    await ensureColumn(db, 'purchases', 'api_monthly_prorated_pricing', 'TINYINT(1) NOT NULL DEFAULT 0');
    await ensureColumn(db, 'purchases', 'api_monthly_price', 'DECIMAL(14,6) NULL');
    await db.pool.execute('UPDATE api_clients SET monthly_prorated_pricing = 0 WHERE monthly_prorated_pricing IS NULL');
    await db.pool.execute('UPDATE purchases SET api_monthly_prorated_pricing = 0 WHERE api_monthly_prorated_pricing IS NULL');
    return true;
  })().catch(error => {
    schemaPromise = null;
    throw error;
  });
  return schemaPromise;
}

function installApiProratedPricing(db) {
  if (!db || db[INSTALL_MARK]) return db;
  const ready = ensureApiProratedPricingSchema(db);
  ready.catch(error => console.error('[API_PRORATED_SCHEMA]', error.code || error.message));

  const originalCreateApiClient = db.createApiClient?.bind(db);
  const originalUpdateApiClient = db.updateApiClient?.bind(db);

  if (originalCreateApiClient) {
    db.createApiClient = async function createApiClientWithPricing(input = {}) {
      await ready;
      const client = await originalCreateApiClient(input);
      if (Object.prototype.hasOwnProperty.call(input, 'monthlyProratedPricing')) {
        await db.pool.execute(
          'UPDATE api_clients SET monthly_prorated_pricing = ? WHERE id = ?',
          [input.monthlyProratedPricing ? 1 : 0, client.id]
        );
        return db.getApiClientById(client.id);
      }
      return client;
    };
  }

  if (originalUpdateApiClient) {
    db.updateApiClient = async function updateApiClientWithPricing(clientId, fields = {}) {
      await ready;
      await originalUpdateApiClient(clientId, fields);
      if (Object.prototype.hasOwnProperty.call(fields, 'monthlyProratedPricing')) {
        await db.pool.execute(
          'UPDATE api_clients SET monthly_prorated_pricing = ? WHERE id = ?',
          [fields.monthlyProratedPricing ? 1 : 0, clientId]
        );
      }
      return db.getApiClientById(clientId);
    };
  }

  db.apiProratedPricingReady = ready;
  db[INSTALL_MARK] = true;
  return db;
}

async function chargeApiInitialCycleProrated({ db, telegramId, serverId, amount, reserve = 0 }) {
  if (!db?.pool) throw new Error('DB_POOL_UNAVAILABLE');
  const charge = Math.max(0, roundWallet(amount));
  const minimumReserve = Math.max(0, roundWallet(reserve));
  if (!(charge > 0)) return { status: 'invalid_amount', charged: 0 };

  const conn = await db.pool.getConnection();
  try {
    await conn.beginTransaction();
    const [existing] = await conn.execute(
      `SELECT id, amount FROM wallet_logs
       WHERE telegram_id = ? AND type = 'server_api_purchase' AND description LIKE ?
       ORDER BY id DESC LIMIT 1`,
      [String(telegramId), `%${String(serverId)}%`]
    );
    if (existing.length) {
      await conn.commit();
      return { status: 'already_charged', charged: Math.abs(Number(existing[0].amount || 0)) };
    }
    const [userRows] = await conn.execute(
      'SELECT wallet FROM users WHERE telegram_id = ? LIMIT 1 FOR UPDATE',
      [String(telegramId)]
    );
    if (!userRows.length) {
      await conn.rollback();
      return { status: 'user_missing', charged: 0 };
    }
    const balance = Number(userRows[0].wallet || 0);
    if (balance + 1e-9 < charge + minimumReserve) {
      await conn.commit();
      return { status: 'insufficient', charged: 0, balance, required: charge + minimumReserve };
    }
    await conn.execute(
      'UPDATE users SET wallet = wallet - ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?',
      [charge, String(telegramId)]
    );
    await conn.execute(
      'INSERT INTO wallet_logs (telegram_id, amount, description, type) VALUES (?, ?, ?, ?)',
      [String(telegramId), -charge, `API server purchase ${serverId}; pricing=monthly_prorated`, 'server_api_purchase']
    );
    await conn.commit();
    return { status: 'charged', charged: charge, newWallet: roundWallet(balance - charge) };
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }
}

async function recordApiPurchaseWithPricing({
  db,
  telegramId,
  serverId,
  datacenter,
  serverName,
  flavorId,
  amount,
  duration,
  image,
  keyId = null,
  status = 'provisioning',
  monthlyProratedPricing = false,
  monthlyPrice = null
}) {
  if (!db?.pool) throw new Error('DB_POOL_UNAVAILABLE');
  await ensureApiProratedPricingSchema(db);
  const conn = await db.pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      `INSERT INTO purchases (
         server_id, telegram_id, datacenter, server_name, flavor_id, amount, duration,
         price_per_gb, download_only, boot_volume_id, boot_method, os_label, status,
         last_billed_traffic_gb, free_traffic_hourly_gb, free_traffic_daily_gb,
         free_traffic_weekly_gb, free_traffic_monthly_gb, ssh_key_id, billing_amount_version,
         api_monthly_prorated_pricing, api_monthly_price,
         lifecycle_updated_at, created_at, last_billed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, 'api', ?, ?, 0, 0, 0, 0, 0, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON DUPLICATE KEY UPDATE
         telegram_id = VALUES(telegram_id), datacenter = VALUES(datacenter), server_name = VALUES(server_name),
         flavor_id = VALUES(flavor_id), amount = VALUES(amount), duration = VALUES(duration),
         price_per_gb = VALUES(price_per_gb), download_only = VALUES(download_only), boot_volume_id = VALUES(boot_volume_id),
         boot_method = VALUES(boot_method), os_label = VALUES(os_label), status = VALUES(status),
         last_billed_traffic_gb = VALUES(last_billed_traffic_gb), free_traffic_hourly_gb = VALUES(free_traffic_hourly_gb),
         free_traffic_daily_gb = VALUES(free_traffic_daily_gb), free_traffic_weekly_gb = VALUES(free_traffic_weekly_gb),
         free_traffic_monthly_gb = VALUES(free_traffic_monthly_gb), ssh_key_id = VALUES(ssh_key_id),
         billing_amount_version = VALUES(billing_amount_version),
         api_monthly_prorated_pricing = VALUES(api_monthly_prorated_pricing),
         api_monthly_price = VALUES(api_monthly_price), lifecycle_updated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`,
      [
        String(serverId), String(telegramId), String(datacenter), String(serverName), String(flavorId),
        Number(amount), String(duration), image || null, status, keyId,
        monthlyProratedPricing ? 2 : 1, monthlyProratedPricing ? 1 : 0,
        monthlyProratedPricing ? getMonthlyPriceFromPlan({ amount_monthly: monthlyPrice }) : null
      ]
    );
    await conn.commit();
    return true;
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }
}

function applyCustomerApiPatches(input) {
  let source = String(input || '');
  const requireNeedle = "const datacenters = require('./datacenters');";
  if (!source.includes("const apiProratedPricing = require('./api-prorated-pricing');")) {
    if (!source.includes(requireNeedle)) throw new Error('API_PRORATED_CUSTOMER_REQUIRE_MARKER_MISSING');
    source = source.replace(requireNeedle, `${requireNeedle}\nconst apiProratedPricing = require('./api-prorated-pricing');`);
  }

  source = source.replace(
    '      max_hourly_spend: req.apiClient.max_hourly_spend\n',
    '      max_hourly_spend: req.apiClient.max_hourly_spend,\n      monthly_prorated_pricing: Number(req.apiClient.monthly_prorated_pricing || 0) === 1\n'
  );

  const pricesNeedle = `  router.get('/prices', async (_req, res, next) => {\n    try { res.json({ ok: true, plans: await getHetznerSellablePlans(datacenters.hetzner) }); }\n    catch (e) { next(e); }\n  });`;
  const pricesReplacement = `  router.get('/prices', async (req, res, next) => {\n    try {\n      const enabled = Number(req.apiClient.monthly_prorated_pricing || 0) === 1;\n      const plans = await getHetznerSellablePlans(datacenters.hetzner);\n      res.json({ ok: true, monthly_prorated_pricing: enabled, plans: plans.map(plan => apiProratedPricing.decoratePlanForClient(plan, enabled)) });\n    } catch (e) { next(e); }\n  });`;
  if (!source.includes(pricesNeedle)) throw new Error('API_PRORATED_CUSTOMER_PRICES_MARKER_MISSING');
  source = source.replace(pricesNeedle, pricesReplacement);

  const durationNeedle = "      const duration = ['hourly', 'monthly'].includes(String(input.duration || '').toLowerCase()) ? String(input.duration).toLowerCase() : 'hourly';";
  const durationReplacement = "      const duration = ['hourly', 'daily', 'weekly', 'monthly'].includes(String(input.duration || '').toLowerCase()) ? String(input.duration).toLowerCase() : 'hourly';";
  if (!source.includes(durationNeedle)) throw new Error('API_PRORATED_CUSTOMER_DURATION_MARKER_MISSING');
  source = source.replace(durationNeedle, durationReplacement);

  const priceNeedle = "      const price = Number(duration === 'monthly' ? plan.amount_monthly : plan.amount_hourly);";
  const priceReplacement = `      const monthlyProratedPricing = Number(client.monthly_prorated_pricing || 0) === 1;\n      const monthlyPrice = apiProratedPricing.getMonthlyPriceFromPlan(plan);\n      const price = apiProratedPricing.getApiCyclePrice(plan, duration, monthlyProratedPricing);`;
  if (!source.includes(priceNeedle)) throw new Error('API_PRORATED_CUSTOMER_PRICE_MARKER_MISSING');
  source = source.replace(priceNeedle, priceReplacement);

  const chargeNeedle = `      const initialCharge = await deletionRefunds.chargeApiInitialCycle({\n        db,\n        telegramId: client.telegram_id,\n        serverId,\n        amount: price,\n        reserve\n      });`;
  const chargeReplacement = `      const initialCharge = monthlyProratedPricing\n        ? await apiProratedPricing.chargeApiInitialCycleProrated({ db, telegramId: client.telegram_id, serverId, amount: price, reserve })\n        : await deletionRefunds.chargeApiInitialCycle({\n            db,\n            telegramId: client.telegram_id,\n            serverId,\n            amount: price,\n            reserve\n          });`;
  if (!source.includes(chargeNeedle)) throw new Error('API_PRORATED_CUSTOMER_CHARGE_MARKER_MISSING');
  source = source.replace(chargeNeedle, chargeReplacement);

  const recordNeedle = "        await db.recordPurchase(client.telegram_id, serverId, dcKey, createdServer.name || name, plan.id, price, duration, 0, 0, null, 'api', image, 0, 0, 0, 0, 0, keyId, 'provisioning');";
  const recordReplacement = `        await apiProratedPricing.recordApiPurchaseWithPricing({\n          db,\n          telegramId: client.telegram_id,\n          serverId,\n          datacenter: dcKey,\n          serverName: createdServer.name || name,\n          flavorId: plan.id,\n          amount: price,\n          duration,\n          image,\n          keyId,\n          status: 'provisioning',\n          monthlyProratedPricing,\n          monthlyPrice\n        });`;
  if (!source.includes(recordNeedle)) throw new Error('API_PRORATED_CUSTOMER_RECORD_MARKER_MISSING');
  source = source.replace(recordNeedle, recordReplacement);

  const responseNeedle = "      res.status(202).json({ ok: true, operation: 'provisioning', server: { id: serverId, name: createdServer.name || name, status: 'provisioning', public_ip: ip, server_type: plan.id, image, location, duration, price } });";
  const responseReplacement = "      res.status(202).json({ ok: true, operation: 'provisioning', server: { id: serverId, name: createdServer.name || name, status: 'provisioning', public_ip: ip, server_type: plan.id, image, location, duration, price, pricing_mode: monthlyProratedPricing ? 'monthly_prorated' : 'standard', monthly_price_basis: monthlyProratedPricing ? monthlyPrice : null } });";
  if (!source.includes(responseNeedle)) throw new Error('API_PRORATED_CUSTOMER_RESPONSE_MARKER_MISSING');
  source = source.replace(responseNeedle, responseReplacement);

  return source;
}

function applyIndexCorePricingPatch(input) {
  let source = String(input || '');
  const needle = "  if (!(amount > 0) || !cycleHours || cycle === 'hourly') return amount;";
  const replacement = "  if (Number(purchase?.api_monthly_prorated_pricing || 0) === 1) return amount;\n  if (!(amount > 0) || !cycleHours || cycle === 'hourly') return amount;";
  if (!source.includes(needle)) throw new Error('API_PRORATED_CORE_NORMALIZE_MARKER_MISSING');
  return source.replace(needle, replacement);
}

function applyBillingCycleOutputPatch(input) {
  let source = String(input || '');
  const priceNeedle = "    const catalogTargetPrice = Number(getFlavorCyclePrice(selectedFlavor, newCycle) || 0);";
  const priceReplacement = `    const catalogTargetPrice = Number(purchase?.api_monthly_prorated_pricing || 0) === 1\n      ? Number(require('./api-prorated-pricing').calculateMonthlyProratedCyclePrice(\n          Number(purchase.api_monthly_price || require('./api-prorated-pricing').getMonthlyPriceFromPlan(selectedFlavor) || 0),\n          newCycle\n        ) || 0)\n      : Number(getFlavorCyclePrice(selectedFlavor, newCycle) || 0);`;
  if (!source.includes(priceNeedle)) throw new Error('API_PRORATED_CYCLE_PRICE_MARKER_MISSING');
  source = source.replace(priceNeedle, priceReplacement);

  const roundedNeedle = '    const newCyclePrice = Math.max(1, Math.round(catalogTargetPrice));';
  const roundedReplacement = `    const newCyclePrice = Number(purchase?.api_monthly_prorated_pricing || 0) === 1\n      ? Math.max(0.000001, Number(catalogTargetPrice.toFixed(6)))\n      : Math.max(1, Math.round(catalogTargetPrice));`;
  if (!source.includes(roundedNeedle)) throw new Error('API_PRORATED_CYCLE_ROUNDING_MARKER_MISSING');
  return source.replace(roundedNeedle, roundedReplacement);
}

function applyBillingSettlementPatches(input) {
  let source = String(input || '');
  const selectNeedle = `      \`SELECT telegram_id, server_id, datacenter, server_name, amount, duration, status,\n              auto_renew, last_billed_at, created_at, last_billed_traffic_gb`;
  const selectReplacement = `      \`SELECT telegram_id, server_id, datacenter, server_name, amount, duration, status,\n              api_monthly_prorated_pricing, api_monthly_price,\n              auto_renew, last_billed_at, created_at, last_billed_traffic_gb`;
  if (!source.includes(selectNeedle)) throw new Error('API_PRORATED_SETTLEMENT_SELECT_MARKER_MISSING');
  source = source.replace(selectNeedle, selectReplacement);

  const renewalNeedle = '    const renewal = Math.max(0, Math.round(Number(renewalAmount || 0)));';
  const renewalReplacement = `    const renewalRaw = Math.max(0, Number(renewalAmount || 0));\n    const renewal = Number(purchase.api_monthly_prorated_pricing || 0) === 1\n      ? Math.round(renewalRaw * 100) / 100\n      : Math.round(renewalRaw);`;
  if (!source.includes(renewalNeedle)) throw new Error('API_PRORATED_SETTLEMENT_AMOUNT_MARKER_MISSING');
  source = source.replace(renewalNeedle, renewalReplacement);

  const metadataNeedle = '        JSON.stringify({ cycle, renewalAmount: renewal, trafficCost: traffic })';
  const metadataReplacement = `        JSON.stringify({\n          cycle,\n          renewalAmount: renewal,\n          trafficCost: traffic,\n          pricingMode: Number(purchase.api_monthly_prorated_pricing || 0) === 1 ? 'monthly_prorated' : 'standard',\n          monthlyPriceBasis: Number(purchase.api_monthly_price || 0) || null\n        })`;
  if (!source.includes(metadataNeedle)) throw new Error('API_PRORATED_SETTLEMENT_METADATA_MARKER_MISSING');
  return source.replace(metadataNeedle, metadataReplacement);
}

function applyDeletionRefundPatches(input) {
  let source = String(input || '');
  const selectNeedle = `      \`SELECT telegram_id, server_id, datacenter, server_name, amount, duration, boot_method,\n              status, created_at, last_billed_at`;
  const selectReplacement = `      \`SELECT telegram_id, server_id, datacenter, server_name, amount, duration, boot_method,\n              api_monthly_prorated_pricing, api_monthly_price,\n              status, created_at, last_billed_at`;
  if (!source.includes(selectNeedle)) throw new Error('API_PRORATED_REFUND_SELECT_MARKER_MISSING');
  source = source.replace(selectNeedle, selectReplacement);

  const calcNeedle = `    const calc = calculateUnusedCycleRefund({\n      amount: purchase.amount,\n      cycle: purchase.duration,\n      lastBilledAt: purchase.last_billed_at,\n      createdAt: purchase.created_at,\n      now\n    });`;
  const calcReplacement = `    const calc = Number(purchase.api_monthly_prorated_pricing || 0) === 1\n      ? require('./api-prorated-pricing').calculateUnusedProratedRefund({\n          amount: purchase.amount,\n          cycle: purchase.duration,\n          lastBilledAt: purchase.last_billed_at,\n          createdAt: purchase.created_at,\n          now\n        })\n      : calculateUnusedCycleRefund({\n          amount: purchase.amount,\n          cycle: purchase.duration,\n          lastBilledAt: purchase.last_billed_at,\n          createdAt: purchase.created_at,\n          now\n        });`;
  if (!source.includes(calcNeedle)) throw new Error('API_PRORATED_REFUND_CALC_MARKER_MISSING');
  source = source.replace(calcNeedle, calcReplacement);

  const metadataNeedle = "          source: 'server_delete'";
  const metadataReplacement = `          source: 'server_delete',\n          pricingMode: Number(purchase.api_monthly_prorated_pricing || 0) === 1 ? 'monthly_prorated' : 'standard',\n          monthlyPriceBasis: Number(purchase.api_monthly_price || 0) || null`;
  if (!source.includes(metadataNeedle)) throw new Error('API_PRORATED_REFUND_METADATA_MARKER_MISSING');
  return source.replace(metadataNeedle, metadataReplacement);
}

module.exports = {
  HOURS_IN_CYCLE,
  roundWallet,
  getMonthlyPriceFromPlan,
  getHourlyPriceFromPlan,
  calculateMonthlyProratedCyclePrice,
  calculateLegacyCyclePrice,
  getApiCyclePrice,
  getCyclePriceMap,
  decoratePlanForClient,
  calculateUnusedProratedRefund,
  ensureApiProratedPricingSchema,
  installApiProratedPricing,
  chargeApiInitialCycleProrated,
  recordApiPurchaseWithPricing,
  applyCustomerApiPatches,
  applyIndexCorePricingPatch,
  applyBillingCycleOutputPatch,
  applyBillingSettlementPatches,
  applyDeletionRefundPatches
};
