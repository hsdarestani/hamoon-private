'use strict';

const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const cloud = require('./cloud-api');
const datacenters = require('./datacenters');
const { getHetznerSellablePlans } = require('./Hetzner/hetzner-api');
const { createApiPricingSnapshot } = require('./api-pricing');
const { listCompatibleImages } = require('./hetzner-purchase-images');
const { getServerTraffic } = require('./hetzner-traffic');
const trafficAddons = require('./hetzner-traffic-addons');
const { ensureBillingSettlementSchema } = require('./billing-settlement');

const writeBuckets = new Map();

function apiError(res, status, code, message, details) {
  const error = { code, message };
  if (details && typeof details === 'object') error.details = details;
  return res.status(status).json({ ok: false, error });
}

function isHetznerDc(dcOrKey) {
  const dc = typeof dcOrKey === 'string' ? (datacenters[dcOrKey] || { key: dcOrKey }) : (dcOrKey || {});
  const provider = String(dc.provider || '').toLowerCase();
  const apiType = String(dc.apiType || dc.type || '').toLowerCase();
  const key = String(dc.key || '').toLowerCase();
  return provider === 'hetzner' || apiType === 'hetzner' || key === 'hetzner' || key.startsWith('hetzner-') || !!dc.HETZNER_LOCATION;
}

function hetznerDcKeys() {
  return Object.keys(datacenters).filter(key => isHetznerDc({ ...datacenters[key], key }));
}

function csvAllowed(text) {
  return String(text || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
}

function isAllowed(text, value) {
  const list = csvAllowed(text);
  return !list.length || list.includes(String(value || '').trim().toLowerCase());
}

function architectureFromType(value) {
  const type = String(value || '').trim().toLowerCase();
  if (type.startsWith('cax')) return 'arm';
  if (/^(cx|cpx|ccx)/.test(type)) return 'x86';
  return '';
}

function providerType(server) {
  return String(server?.server_type?.name || server?.server_type || server?.type || '').trim().toLowerCase();
}

function providerStatus(server) {
  return String(server?.status || '').trim().toLowerCase();
}

function requestInput(req) {
  return { ...(req.query || {}), ...(req.body && typeof req.body === 'object' ? req.body : {}) };
}

function allowWrite(key, maxPerMinute = 20) {
  const minute = Math.floor(Date.now() / 60000);
  const bucket = `${key}:${minute}`;
  const next = (writeBuckets.get(bucket) || 0) + 1;
  writeBuckets.set(bucket, next);
  if (writeBuckets.size > 3000) {
    for (const k of writeBuckets.keys()) if (!k.endsWith(`:${minute}`)) writeBuckets.delete(k);
  }
  return next <= maxPerMinute;
}

async function auth(req, res, next) {
  try {
    const authz = String(req.headers.authorization || '');
    const token = authz.startsWith('Bearer ') ? authz.slice(7).trim() : '';
    if (!token || !token.startsWith('hm_live_')) return apiError(res, 401, 'AUTH_REQUIRED', 'کلید API معتبر ارسال نشده است.');
    const client = await db.authenticateApiKey(token);
    if (!client) return apiError(res, 401, 'INVALID_API_KEY', 'کلید API نامعتبر یا غیرفعال است.');
    const isWriteRequest = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    const writeLimit = Math.max(20, Number(process.env.RESELLER_API_EXTENSION_WRITE_RPM || 30));
    if (isWriteRequest && !allowWrite(`${client.key_prefix || client.id}:write`, writeLimit)) {
      return apiError(res, 429, 'RATE_LIMITED', 'تعداد درخواست‌ها بیش از حد مجاز است.');
    }
    req.apiClient = client;
    if (!res.hasHeader('X-Request-Id')) res.setHeader('X-Request-Id', crypto.randomUUID());
    next();
  } catch (error) {
    next(error);
  }
}

async function findOwnedPurchase(client, serverId) {
  for (const dcKey of hetznerDcKeys()) {
    const purchase = await db.getPurchaseForUserServer(client.telegram_id, serverId, dcKey).catch(() => null);
    if (purchase) return purchase;
  }
  return null;
}

async function ownedPurchase(req, res, next) {
  try {
    const purchase = await findOwnedPurchase(req.apiClient, req.params.id);
    if (!purchase) return apiError(res, 404, 'SERVER_NOT_FOUND', 'سرور پیدا نشد.');
    req.purchase = purchase;
    req.dc = datacenters[purchase.datacenter] || datacenters.hetzner;
    if (!req.dc || !isHetznerDc(req.dc)) return apiError(res, 503, 'HETZNER_UNAVAILABLE', 'دیتاسنتر Hetzner فعال نیست.');
    next();
  } catch (error) {
    next(error);
  }
}

async function waitAction(dc, action) {
  if (action?.id) await cloud.waitHetznerAction(dc, action.id, 180000);
}

function createResellerApiExtensionsRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));

  router.post('/servers/:id/billing-cycle', auth, ownedPurchase, async (req, res, next) => {
    try {
      const duration = String(requestInput(req).duration || '').trim().toLowerCase();
      if (!['hourly', 'monthly'].includes(duration)) return apiError(res, 400, 'INVALID_DURATION', 'دوره پرداخت معتبر نیست.');
      if (String(req.purchase.duration || '').toLowerCase() === duration) {
        return res.json({ ok: true, status: 'unchanged', duration, price: Number(req.purchase.amount || 0) });
      }
      const plans = await getHetznerSellablePlans(req.dc);
      const plan = plans.find(p => String(p.id || '').toLowerCase() === String(req.purchase.flavor_id || '').toLowerCase());
      if (!plan) return apiError(res, 404, 'PLAN_NOT_FOUND', 'پلن فعلی سرور در کاتالوگ پیدا نشد.');
      const pricing = createApiPricingSnapshot(req.apiClient, plan, duration);
      if (!(Number(pricing.amount) > 0)) return apiError(res, 503, 'PRICE_UNAVAILABLE', 'قیمت دوره جدید در دسترس نیست.');
      await db.updatePurchaseCycle(req.params.id, duration, pricing.amount, 2);
      return res.json({
        ok: true,
        status: 'billing_cycle_changed',
        duration,
        price: Number(pricing.amount),
        pricing_mode: pricing.pricingMode,
        monthly_basis_price: pricing.monthlyBasisPrice
      });
    } catch (error) { next(error); }
  });

  router.get('/servers/:id/rebuild-images', auth, ownedPurchase, async (req, res, next) => {
    try {
      const images = await listCompatibleImages(req.dc, req.purchase.flavor_id);
      const allowed = images.filter(image => isAllowed(req.apiClient.allowed_images, image.id) || isAllowed(req.apiClient.allowed_images, image.name));
      return res.json({ ok: true, images: allowed.slice(0, 80) });
    } catch (error) { next(error); }
  });

  router.post('/servers/:id/traffic-addons', auth, ownedPurchase, async (req, res, next) => {
    try {
      const input = requestInput(req);
      const packageTb = Number(input.package_tb || input.packageTb || 0);
      trafficAddons.ALLOWED_PACKAGE_TB.add(1);
      if (![1, 5, 10, 20].includes(packageTb)) return apiError(res, 400, 'INVALID_TRAFFIC_PACKAGE', 'بسته ترافیک معتبر نیست.');
      const traffic = await getServerTraffic(req.dc, req.params.id, 'current');
      if (!traffic?.traffic_period_start) return apiError(res, 503, 'TRAFFIC_PERIOD_UNAVAILABLE', 'دوره ترافیک Hetzner در دسترس نیست.');
      await ensureBillingSettlementSchema();
      const nonce = String(input.nonce || crypto.randomBytes(12).toString('hex'));
      const result = await trafficAddons.purchaseTrafficAddonAtomic({
        telegramId: req.apiClient.telegram_id,
        serverId: req.params.id,
        datacenter: req.purchase.datacenter,
        serverName: traffic.server_name || req.purchase.server_name || req.params.id,
        periodStart: traffic.traffic_period_start,
        includedBytes: traffic.included_traffic,
        pricePerTb: traffic.price_per_tb_traffic,
        packageTb,
        nonce
      });
      if (result.status === 'insufficient') {
        return apiError(res, 402, 'INSUFFICIENT_WALLET', 'موجودی حساب تأمین برای خرید ترافیک کافی نیست.', {
          balance: result.balance,
          required_balance: result.required,
          missing: result.missing
        });
      }
      if (result.status === 'already_purchased') {
        return res.json({ ok: true, status: 'already_purchased', package_tb: result.packageTb || packageTb, charged: 0 });
      }
      if (result.status !== 'purchased') return apiError(res, 409, 'TRAFFIC_ADDON_FAILED', 'خرید ترافیک اضافه انجام نشد.', { status: result.status });
      return res.status(201).json({
        ok: true,
        status: 'purchased',
        package_tb: result.packageTb,
        charged: result.charged,
        period_start: traffic.traffic_period_start,
        period_reset: traffic.traffic_period_reset
      });
    } catch (error) { next(error); }
  });

  router.post('/servers/:id/upgrade-safe', auth, ownedPurchase, async (req, res, next) => {
    let poweredOff = false;
    let wasRunning = false;
    try {
      const input = requestInput(req);
      const plans = await getHetznerSellablePlans(req.dc);
      const targetId = String(input.target_server_type || '').trim().toLowerCase();
      const target = plans.find(p => String(p.id || '').toLowerCase() === targetId);
      if (!target || target.available === false) return apiError(res, 400, 'INVALID_PLAN', 'پلن هدف معتبر نیست.');
      if (!isAllowed(req.apiClient.allowed_plans, target.id)) return apiError(res, 403, 'NOT_ALLOWED', 'پلن هدف برای این حساب فعال نیست.');
      if (String(req.purchase.flavor_id || '').toLowerCase() === targetId) return res.json({ ok: true, status: 'unchanged', server_type: target.id });

      const current = await cloud.getServer(req.dc, null, req.params.id);
      const currentArch = architectureFromType(providerType(current) || req.purchase.flavor_id);
      const targetArch = architectureFromType(target.hetzner_type || target.id);
      if (currentArch && targetArch && currentArch !== targetArch) {
        return apiError(res, 409, 'ARCHITECTURE_MISMATCH', 'ارتقا بین معماری x86 و ARM امکان‌پذیر نیست.');
      }

      const status = providerStatus(current);
      wasRunning = !['off', 'stopped'].includes(status);
      if (wasRunning) {
        const offAction = await cloud.powerOffHetznerServer(req.dc, req.params.id);
        await waitAction(req.dc, offAction);
        poweredOff = true;
      }

      const action = await cloud.changeHetznerServerType(
        req.dc,
        req.params.id,
        target.hetzner_type || target.id,
        String(input.upgrade_disk || '').toLowerCase() === 'true' || input.upgrade_disk === true
      );
      await waitAction(req.dc, action);

      const pricing = createApiPricingSnapshot(
        { monthly_prorated_pricing: req.purchase.pricing_mode === 'monthly_prorated' },
        target,
        req.purchase.duration || 'monthly'
      );
      await db.updatePurchasePlan(
        req.apiClient.telegram_id,
        req.params.id,
        req.purchase.datacenter,
        target.id,
        pricing.amount,
        pricing.pricingMode,
        pricing.monthlyBasisPrice
      );

      let powerOnOk = true;
      if (wasRunning) {
        try {
          const onAction = await cloud.powerOnHetznerServer(req.dc, req.params.id);
          await waitAction(req.dc, onAction);
        } catch (powerError) {
          powerOnOk = false;
          console.error('[RESELLER_UPGRADE_POWERON_FAILED]', { server_id: req.params.id, message: powerError.message });
        }
      }
      return res.json({ ok: true, status: 'upgraded', server_type: target.id, power_on_ok: powerOnOk });
    } catch (error) {
      if (poweredOff && wasRunning) {
        try {
          const onAction = await cloud.powerOnHetznerServer(req.dc, req.params.id);
          await waitAction(req.dc, onAction);
        } catch (recoveryError) {
          console.error('[RESELLER_UPGRADE_RECOVERY_FAILED]', { server_id: req.params.id, message: recoveryError.message });
        }
      }
      next(error);
    }
  });

  router.use((err, _req, res, _next) => {
    console.error('[RESELLER_API_EXTENSION_ERROR]', err.code || err.message);
    const status = Number(err?.status || err?.response?.status || 0);
    if (err.code === 'OPERATION_IN_PROGRESS' || status === 423) return apiError(res, 409, 'OPERATION_IN_PROGRESS', 'عملیات دیگری روی این سرور در حال انجام است.');
    if (err.code === 'HETZNER_PLACEMENT_UNAVAILABLE') return apiError(res, 409, 'HETZNER_PLACEMENT_UNAVAILABLE', 'پلن هدف در این لوکیشن موقتاً ظرفیت ندارد.');
    if (status >= 400 && status < 500) return apiError(res, status, err.code || 'PROVIDER_REQUEST_FAILED', 'درخواست توسط ارائه‌دهنده رد شد.');
    if (status >= 500) return apiError(res, 502, 'PROVIDER_ERROR', 'ارائه‌دهنده در حال حاضر پاسخ معتبر برنگرداند.');
    return apiError(res, 500, 'INTERNAL_ERROR', 'خطای داخلی رخ داد.');
  });

  return router;
}

module.exports = { createResellerApiExtensionsRouter };
