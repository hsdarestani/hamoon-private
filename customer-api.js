'use strict';
const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const cloud = require('./cloud-api');
const datacenters = require('./datacenters');
const lifecycle = require('./services/hetzner-lifecycle');
const { changeHetznerPublicIp, userMessageForError: changeIpUserMessage } = require('./services/hetzner-change-ip');
const additionalIps = require('./services/hetzner-additional-ips');
const additionalIpBilling = require('./services/hetzner-additional-ip-billing');
const { getHetznerSellablePlans, createOrGetSshKey, hetznerRequest } = require('./Hetzner/hetzner-api');
const { createApiPricingSnapshot, isMonthlyProrated } = require('./api-pricing');
const {
  normalizeServerDisplayName,
  getServerDisplayName,
  getServerDisplayNameMap,
  getServerDisplayNameFromMap,
  setServerDisplayName,
  clearServerDisplayName
} = require('./server-display-names');

const minuteBuckets = new Map();
function apiError(res, status, code, message, details) {
  const error = { code, message };
  if (details && typeof details === 'object') error.details = details;
  return res.status(status).json({ ok: false, error });
}
function csvAllowed(text) { return String(text || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean); }
function isAllowed(listText, value) { const list = csvAllowed(listText); return !list.length || list.includes(String(value || '').toLowerCase()); }
function clientIp(req) { return String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 64); }
function checkRate(key, limit) {
  const now = Date.now();
  const currentMinute = Math.floor(now / 60000);
  const bucket = `${key}:${currentMinute}`;
  const n = (minuteBuckets.get(bucket) || 0) + 1;
  minuteBuckets.set(bucket, n);
  if (minuteBuckets.size > 5000) {
    for (const k of minuteBuckets.keys()) {
      if (!k.endsWith(`:${currentMinute}`)) minuteBuckets.delete(k);
    }
  }
  return n <= limit;
}
function requestInput(req) {
  return { ...(req.query || {}), ...(req.body && typeof req.body === 'object' ? req.body : {}) };
}
function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function nonNegativeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
function isHetznerDc(dcConfigOrKey) {
  if (!dcConfigOrKey) return false;
  if (typeof dcConfigOrKey === 'string') return isHetznerDc(datacenters[dcConfigOrKey] || { key: dcConfigOrKey });
  const provider = String(dcConfigOrKey.provider || '').toLowerCase();
  const apiType = String(dcConfigOrKey.apiType || dcConfigOrKey.type || '').toLowerCase();
  const key = String(dcConfigOrKey.key || '').toLowerCase();
  return provider === 'hetzner' || apiType === 'hetzner' || key === 'hetzner' || key.startsWith('hetzner-') || !!dcConfigOrKey.HETZNER_LOCATION;
}
function hetznerDcKeys() { return Object.keys(datacenters).filter(key => isHetznerDc(datacenters[key])); }
async function findUserHetznerPurchase(telegramId, serverId) {
  for (const dcKey of hetznerDcKeys()) {
    const p = await db.getPurchaseForUserServer(telegramId, serverId, dcKey);
    if (p) return p;
  }
  return null;
}
function publicIpFromServer(srv) {
  return srv?.public_net?.ipv4?.ip || srv?.addresses?.public?.find?.(a => Number(a.version) === 4)?.addr || srv?.public_ip || null;
}
function purchaseDc(purchase) {
  return datacenters[purchase?.datacenter] || datacenters.hetzner;
}
function ensureHetznerDc(res, purchase) {
  const dc = purchaseDc(purchase);
  if (!dc || !isHetznerDc(dc)) {
    apiError(res, 503, 'HETZNER_UNAVAILABLE', 'دیتاسنتر هتزنر فعال نیست.');
    return null;
  }
  return dc;
}
function sanitizeSnapshotDescription(value, serverId) {
  const text = String(value || `HamoonCloud snapshot ${serverId}`).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.slice(0, 255) || `HamoonCloud snapshot ${serverId}`;
}

async function auth(req, res, next) {
  try {
    req.requestId = crypto.randomBytes(12).toString('hex');
    res.setHeader('X-Request-Id', req.requestId);
    const authz = String(req.headers.authorization || '');
    const token = authz.startsWith('Bearer ') ? authz.slice(7).trim() : '';
    if (!token || !token.startsWith('hm_live_')) return apiError(res, 401, 'AUTH_REQUIRED', 'کلید API معتبر ارسال نشده است.');
    const client = await db.authenticateApiKey(token);
    if (!client) return apiError(res, 401, 'INVALID_API_KEY', 'کلید API نامعتبر یا غیرفعال است.');
    if (!checkRate(client.key_prefix, ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? 10 : 60)) {
      return apiError(res, 429, 'RATE_LIMITED', 'تعداد درخواست‌ها بیش از حد مجاز است.');
    }
    req.apiClient = client;
    res.on('finish', () => db.recordApiRequestLog({
      clientId: client.id,
      telegramId: client.telegram_id,
      keyPrefix: client.key_prefix,
      method: req.method,
      path: req.originalUrl.slice(0, 255),
      statusCode: res.statusCode,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'],
      requestId: req.requestId,
      errorMessage: res.statusCode >= 400 ? res.statusMessage : null
    }).catch(() => {}));
    next();
  } catch (error) {
    next(error);
  }
}
async function userPurchase(req, res, next) {
  try {
    const p = await findUserHetznerPurchase(req.apiClient.telegram_id, req.params.id);
    if (!p) return apiError(res, 404, 'SERVER_NOT_FOUND', 'سرور پیدا نشد.');
    req.purchase = p;
    next();
  } catch (error) {
    next(error);
  }
}

function createCustomerApiRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));
  router.use(auth);

  router.get('/me', (req, res) => res.json({
    ok: true,
    client: {
      id: req.apiClient.id,
      telegram_id: req.apiClient.telegram_id,
      name: req.apiClient.name,
      max_servers: req.apiClient.max_servers,
      min_wallet_balance: req.apiClient.min_wallet_balance,
      max_monthly_spend: req.apiClient.max_monthly_spend,
      max_hourly_spend: req.apiClient.max_hourly_spend
      ,monthly_prorated_pricing: !!req.apiClient.monthly_prorated_pricing
    }
  }));

  router.get('/wallet', async (req, res, next) => {
    try { res.json({ ok: true, wallet: { balance: await db.getUserWallet(req.apiClient.telegram_id) } }); }
    catch (e) { next(e); }
  });

  router.get('/prices', async (_req, res, next) => {
    try { res.json({ ok: true, plans: await getHetznerSellablePlans(datacenters.hetzner) }); }
    catch (e) { next(e); }
  });

  router.get('/usage', async (req, res, next) => {
    try { res.json({ ok: true, usage: await db.getApiClientUsageSummary(req.apiClient.id) }); }
    catch (e) { next(e); }
  });

  router.get('/servers', async (req, res, next) => {
    try {
      const data = await db.listAdminServers({ userId: req.apiClient.telegram_id, limit: 200 });
      const displayNames = await getServerDisplayNameMap(req.apiClient.telegram_id);
      const servers = data.rows
        .filter(r => isHetznerDc(r.datacenter))
        .map(r => ({
          ...r,
          display_name: getServerDisplayNameFromMap(displayNames, r.datacenter, r.server_id || r.id) || null
        }));
      res.json({ ok: true, servers });
    } catch (e) { next(e); }
  });

  router.get('/servers/:id', userPurchase, async (req, res, next) => {
    try {
      const dc = purchaseDc(req.purchase);
      const displayName = await getServerDisplayName(req.apiClient.telegram_id, req.params.id, req.purchase.datacenter).catch(() => null);
      let provider = null;
      try {
        const srv = await cloud.getServer(dc, null, req.params.id);
        provider = {
          status: srv?.status || null,
          public_ip: publicIpFromServer(srv),
          server_type: srv?.server_type?.name || srv?.server_type || null,
          location: srv?.datacenter?.location?.name || srv?.location?.name || srv?.location || null
        };
      } catch (_) {}
      res.json({ ok: true, server: { ...req.purchase, display_name: displayName }, provider });
    } catch (e) { next(e); }
  });

  router.post('/servers', async (req, res, next) => {
    let createdServer = null;
    let createdDc = null;
    try {
      const client = req.apiClient;
      const input = requestInput(req);
      const dcKey = String(input.datacenter || 'hetzner').trim().toLowerCase();
      const dc = datacenters[dcKey];
      createdDc = dc;
      if (!dc || !isHetznerDc(dc)) return apiError(res, 503, 'HETZNER_UNAVAILABLE', 'دیتاسنتر هتزنر فعال نیست.');

      const requestedDuration = String(input.duration || 'hourly').toLowerCase();
      const allowedDurations = isMonthlyProrated(client.monthly_prorated_pricing)
        ? ['hourly', 'daily', 'weekly', 'monthly']
        : ['hourly', 'monthly'];
      if (!allowedDurations.includes(requestedDuration)) return apiError(res, 400, 'INVALID_DURATION', 'دوره صورتحساب انتخاب‌شده معتبر نیست.');
      const duration = requestedDuration;
      const plans = await getHetznerSellablePlans(dc);
      const requestedType = String(input.server_type || '').trim().toLowerCase();
      const plan = plans.find(p => String(p.id || '').toLowerCase() === requestedType || String(p.hetzner_type || '').toLowerCase() === requestedType);
      if (!plan || plan.available === false) return apiError(res, 400, 'INVALID_PLAN', 'پلن انتخاب‌شده معتبر نیست.');

      const image = String(input.image || 'ubuntu-24.04').trim();
      const location = String(input.location || dc.HETZNER_LOCATION || 'nbg1').trim().toLowerCase();
      if (!isAllowed(client.allowed_datacenters, dcKey) || !isAllowed(client.allowed_plans, plan.id) || !isAllowed(client.allowed_images, image) || !isAllowed(client.allowed_locations, location)) {
        return apiError(res, 403, 'NOT_ALLOWED', 'این پلن، ایمیج یا لوکیشن برای این کلاینت مجاز نیست.');
      }
      const pricing = createApiPricingSnapshot(client, plan, duration);
      const price = pricing.amount;
      if (!Number.isFinite(price) || price <= 0) return apiError(res, 503, 'PRICE_UNAVAILABLE', 'قیمت این پلن در حال حاضر در دسترس نیست.');
      const wallet = Number(await db.getUserWallet(client.telegram_id) || 0);
      const reserve = Math.max(0, Number(client.min_wallet_balance || 0));
      const requiredBalance = price + reserve;
      if (wallet < requiredBalance) return apiError(res, 402, 'INSUFFICIENT_WALLET', 'موجودی کیف پول برای ایجاد این سرور کافی نیست.', { balance: wallet, required_balance: requiredBalance, server_price: price, reserved_balance: reserve });
      const maxMonthlySpend = finitePositive(client.max_monthly_spend);
      if (maxMonthlySpend) {
        const currentSpend = Number(await db.getApiClientMonthlySpend(client.id) || 0);
        const addedMonthlySpend = pricing.monthlyBasisPrice || price;
        if (currentSpend + addedMonthlySpend > maxMonthlySpend) return apiError(res, 403, 'MONTHLY_SPEND_LIMIT_REACHED', 'سقف هزینه ماهانه این حساب API پر شده است.');
      }
      const maxHourlySpend = finitePositive(client.max_hourly_spend);
      if (duration === 'hourly' && maxHourlySpend && price > maxHourlySpend) return apiError(res, 403, 'HOURLY_SPEND_LIMIT_REACHED', 'هزینه این پلن از سقف ساعتی حساب API بیشتر است.');
      if (await db.getApiClientActiveServerCount(client.id) >= Number(client.max_servers || 2)) return apiError(res, 403, 'SERVER_LIMIT_REACHED', 'سقف تعداد سرورهای مجاز پر شده است.');

      const name = String(input.name || `api-${Date.now()}`).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || `api-${Date.now()}`;
      let keyId = null;
      if (input.ssh_key) {
        if (String(input.ssh_key).length > 4096) return apiError(res, 400, 'SSH_KEY_TOO_LARGE', 'کلید SSH بیش از حد بزرگ است.');
        const key = await createOrGetSshKey({ token: dc.HETZNER_API_TOKEN || dc.token || process.env.HETZNER_API_TOKEN, name: `api-${client.id}-${Date.now()}`.slice(0, 63), publicKey: String(input.ssh_key) });
        keyId = key?.id || null;
      }
      createdServer = await cloud.createServer(dc, null, { name, serverType: plan.hetzner_type, image, location, key_id: keyId, userLabel: client.telegram_id });
      const serverId = String(createdServer.id);
      const ip = publicIpFromServer(createdServer);

      // HETZNER_API_PASSWORD_PRESTORE_V1
      // API provisioning shares the same safe-delivery requirement as Telegram purchases.
      // Persist and read-back the credential before exposing the purchase to the reconciler.
      let rootPassword = createdServer?.root_password || null;
      if (!rootPassword) {
        if (createdServer?.action?.id) {
          await cloud.waitHetznerAction(
            dc,
            createdServer.action.id,
            Number(process.env.HETZNER_PASSWORD_RECOVERY_ACTION_TIMEOUT_MS || 120000)
          );
        }
        rootPassword = await cloud.resetServerPassword(dc, null, serverId);
      }
      if (!rootPassword) {
        const passwordError = new Error('HETZNER_PASSWORD_RECOVERY_EMPTY');
        passwordError.code = 'HETZNER_PASSWORD_RECOVERY_EMPTY';
        throw passwordError;
      }
      await db.upsertServerSecret({
        telegramId: client.telegram_id,
        serverId,
        datacenter: dcKey,
        secretType: 'root_password',
        secretValue: rootPassword
      });
      const verifiedRootPassword = await db.getServerSecret(serverId, 'root_password');
      if (!verifiedRootPassword || verifiedRootPassword !== rootPassword) {
        const passwordError = new Error('HETZNER_PASSWORD_SECRET_VERIFY_FAILED');
        passwordError.code = 'HETZNER_PASSWORD_SECRET_VERIFY_FAILED';
        throw passwordError;
      }

      // API purchases are prepaid exactly like Telegram purchases. The debit
      // and its financial log are committed atomically, so deletion refunds can
      // prove that the current cycle was actually paid.
      const deletionRefunds = require('./server-deletion-refund');
      const initialCharge = await deletionRefunds.chargeApiInitialCycle({
        db,
        telegramId: client.telegram_id,
        serverId,
        amount: price,
        reserve,
        pricingMode: pricing.pricingMode
      });
      if (!['charged', 'already_charged'].includes(initialCharge.status)) {
        await cloud.deleteServer(dc, null, serverId).catch(() => {});
        return apiError(res, 402, 'INSUFFICIENT_WALLET', 'موجودی کیف پول هم‌زمان تغییر کرده و برای ساخت سرور کافی نیست.');
      }
      try {
        await db.recordPurchase(client.telegram_id, serverId, dcKey, createdServer.name || name, plan.id, price, duration, 0, 0, null, 'api', image, 0, 0, 0, 0, 0, keyId, 'provisioning', pricing.pricingMode === 'monthly_prorated' ? 2 : 1, { pricingMode: pricing.pricingMode, monthlyBasisPrice: pricing.monthlyBasisPrice });
        if (ip && db.updatePublicIp) await db.updatePublicIp(client.telegram_id, serverId, dcKey, ip).catch(() => {});
      } catch (recordError) {
        await deletionRefunds.rollbackApiInitialCycle({
          db,
          telegramId: client.telegram_id,
          serverId,
          amount: price
        }).catch(() => {});
        await cloud.deleteServer(dc, null, serverId).catch(() => {});
        throw recordError;
      }
      res.status(202).json({ ok: true, operation: 'provisioning', server: { id: serverId, name: createdServer.name || name, status: 'provisioning', public_ip: ip, server_type: plan.id, image, location, duration, price, pricing_mode: pricing.pricingMode, monthly_basis_price: pricing.monthlyBasisPrice } });
    } catch (e) {
      if (createdServer && createdDc && e?.code === 'HETZNER_PLACEMENT_UNAVAILABLE') await cloud.deleteServer(createdDc, null, createdServer.id).catch(() => {});
      next(e);
    }
  });

  router.delete('/servers/:id', userPurchase, async (req, res, next) => {
    try {
      await lifecycle.deletePurchaseServer({ db, dc: datacenters[req.purchase.datacenter], telegramId: req.apiClient.telegram_id, serverId: req.params.id, datacenter: req.purchase.datacenter });
      await clearServerDisplayName(req.apiClient.telegram_id, req.params.id, req.purchase.datacenter).catch(() => {});
      res.json({ ok: true, status: 'deleted' });
    } catch (e) { next(e); }
  });

  router.post('/servers/:id/poweron', userPurchase, async (req, res, next) => {
    try {
      const dc = ensureHetznerDc(res, req.purchase); if (!dc) return;
      await cloud.resumeServer(dc, null, req.params.id);
      await db.updateScopedStatus?.(req.apiClient.telegram_id, req.params.id, req.purchase.datacenter, 'active');
      res.json({ ok: true, status: 'active' });
    } catch (e) { next(e); }
  });

  router.post('/servers/:id/poweroff', userPurchase, async (req, res, next) => {
    try {
      const dc = ensureHetznerDc(res, req.purchase); if (!dc) return;
      await cloud.suspendServer(dc, null, req.params.id);
      await db.updateScopedStatus?.(req.apiClient.telegram_id, req.params.id, req.purchase.datacenter, 'stopped');
      res.json({ ok: true, status: 'stopped' });
    } catch (e) { next(e); }
  });

  router.post('/servers/:id/reboot', userPurchase, (_req, res) => apiError(res, 501, 'UNSUPPORTED_ACTION', 'ریبوت مستقیم در این نسخه فعال نیست.'));

  router.patch('/servers/:id/name', userPurchase, async (req, res, next) => {
    try {
      const input = requestInput(req);
      if (!Object.prototype.hasOwnProperty.call(input, 'name')) return apiError(res, 400, 'NAME_REQUIRED', 'فیلد name الزامی است.');
      const rawName = String(input.name ?? '').trim();
      if (!rawName) {
        await clearServerDisplayName(req.apiClient.telegram_id, req.params.id, req.purchase.datacenter);
        return res.json({ ok: true, status: 'name_cleared', name: null });
      }
      const name = normalizeServerDisplayName(rawName);
      await setServerDisplayName(req.apiClient.telegram_id, req.params.id, req.purchase.datacenter, name);
      return res.json({ ok: true, status: 'renamed', name });
    } catch (e) { next(e); }
  });

  router.post('/servers/:id/reset-password', userPurchase, async (req, res, next) => {
    try {
      const dc = ensureHetznerDc(res, req.purchase); if (!dc) return;
      const rootPassword = await cloud.resetServerPassword(dc, null, req.params.id);
      if (!rootPassword) return apiError(res, 502, 'ROOT_PASSWORD_UNAVAILABLE', 'Hetzner رمز جدید را در پاسخ برنگرداند.');
      return res.json({ ok: true, status: 'password_reset', root_password: rootPassword });
    } catch (e) { next(e); }
  });

  router.post('/servers/:id/snapshots', userPurchase, async (req, res, next) => {
    try {
      const dc = ensureHetznerDc(res, req.purchase); if (!dc) return;
      const input = requestInput(req);
      const data = await hetznerRequest(dc, 'POST', `/servers/${encodeURIComponent(req.params.id)}/actions/create_image`, { type: 'snapshot', description: sanitizeSnapshotDescription(input.description, req.params.id) });
      return res.status(202).json({ ok: true, status: 'snapshot_creating', snapshot: data?.image ? { id: String(data.image.id), name: data.image.name || null, description: data.image.description || null, status: data.image.status || null, type: data.image.type || 'snapshot', created: data.image.created || null } : null, action: data?.action ? { id: String(data.action.id), status: data.action.status || null } : null });
    } catch (e) { next(e); }
  });

  router.get('/servers/:id/snapshots', userPurchase, async (req, res, next) => {
    try {
      const dc = ensureHetznerDc(res, req.purchase); if (!dc) return;
      const data = await hetznerRequest(dc, 'GET', '/images?type=snapshot&sort=created:desc&per_page=100');
      const serverId = String(req.params.id);
      const snapshots = (data?.images || []).filter(image => String(image?.created_from?.id || '') === serverId).map(image => ({ id: String(image.id), name: image.name || null, description: image.description || null, status: image.status || null, type: image.type || 'snapshot', created: image.created || null, size: image.image_size || null }));
      return res.json({ ok: true, snapshots });
    } catch (e) { next(e); }
  });

  router.post('/servers/:id/rebuild', userPurchase, async (req, res, next) => {
    try {
      const dc = ensureHetznerDc(res, req.purchase); if (!dc) return;
      const input = requestInput(req);
      const image = String(input.image || '').trim();
      if (!image) return apiError(res, 400, 'IMAGE_REQUIRED', 'فیلد image الزامی است.');
      if (!isAllowed(req.apiClient.allowed_images, image)) return apiError(res, 403, 'NOT_ALLOWED', 'این ایمیج برای این کلاینت مجاز نیست.');
      const result = await cloud.rebuildServer(dc, null, req.params.id, image);
      return res.status(202).json({ ok: true, status: 'rebuilding', image, root_password: result?.root_password || null, action: result?.action ? { id: String(result.action.id), status: result.action.status || null } : null });
    } catch (e) { next(e); }
  });

  router.get('/servers/:id/traffic', userPurchase, async (req, res, next) => {
    try {
      const dc = ensureHetznerDc(res, req.purchase); if (!dc) return;
      const data = await hetznerRequest(dc, 'GET', `/servers/${encodeURIComponent(req.params.id)}`);
      const server = data?.server || {};
      const incoming = nonNegativeNumber(server.ingoing_traffic);
      const outgoing = nonNegativeNumber(server.outgoing_traffic);
      const included = nonNegativeNumber(server.included_traffic);
      const used = incoming + outgoing;
      return res.json({ ok: true, traffic: { ingoing_bytes: incoming, outgoing_bytes: outgoing, used_bytes: used, included_bytes: included, remaining_bytes: Math.max(0, included - used), overage_bytes: Math.max(0, used - included) } });
    } catch (e) { next(e); }
  });

  router.get('/servers/:id/additional-ips', userPurchase, async (req, res, next) => {
    try {
      const dc = ensureHetznerDc(res, req.purchase); if (!dc) return;
      const ips = await additionalIps.listAdditionalIps({ dc, serverId: req.params.id });
      return res.json({ ok: true, additional_ips: ips });
    } catch (e) { next(e); }
  });

  router.post('/servers/:id/additional-ips', userPurchase, async (req, res, next) => {
    try {
      const status = String(req.purchase.status || '').toLowerCase();
      if (!['active', 'running', 'suspended', 'stopped', 'shutoff'].includes(status)) return apiError(res, 409, 'SERVER_STATE_CONFLICT', 'وضعیت فعلی سرور اجازه افزودن IP را نمی‌دهد.');
      const dc = ensureHetznerDc(res, req.purchase); if (!dc) return;
      const input = requestInput(req);
      await additionalIpBilling.assertAffordable(db, req.apiClient.telegram_id);
      const result = await additionalIps.addAdditionalIpv4({
        dc,
        serverId: req.params.id,
        description: input.description,
        maxIps: process.env.HETZNER_MAX_ADDITIONAL_IPV4
      });
      let pricing;
      try {
        pricing = await additionalIpBilling.activate({
          db,
          telegramId: req.apiClient.telegram_id,
          serverId: req.params.id,
          datacenter: req.purchase.datacenter,
          floatingIp: result.ip
        });
      } catch (billingError) {
        await additionalIps.deleteAdditionalIp({ dc, serverId: req.params.id, floatingIpId: result.ip.id }).catch(() => {});
        throw billingError;
      }
      return res.status(201).json({
        ok: true,
        status: 'additional_ip_created',
        additional_ip: result.ip,
        pricing,
        configuration_required: true,
        configuration_note: 'Floating IP باید داخل سیستم‌عامل سرور نیز پیکربندی شود.'
      });
    } catch (e) { next(e); }
  });

  router.delete('/servers/:id/additional-ips/:floatingIpId', userPurchase, async (req, res, next) => {
    try {
      const dc = ensureHetznerDc(res, req.purchase); if (!dc) return;
      const deleted = await additionalIps.deleteAdditionalIp({
        dc,
        serverId: req.params.id,
        floatingIpId: req.params.floatingIpId
      });
      await additionalIpBilling.cancel({ db, floatingIpId: req.params.floatingIpId });
      return res.json({ ok: true, status: 'additional_ip_deleted', additional_ip: deleted });
    } catch (e) { next(e); }
  });

  router.post('/servers/:id/change-ip', userPurchase, async (req, res, next) => {
    try {
      const status = String(req.purchase.status || '').toLowerCase();
      if (!['active', 'running', 'suspended', 'stopped', 'shutoff'].includes(status)) return apiError(res, 409, 'SERVER_STATE_CONFLICT', 'وضعیت فعلی سرور اجازه تغییر IP را نمی‌دهد.');
      const dc = ensureHetznerDc(res, req.purchase); if (!dc) return;
      const result = await changeHetznerPublicIp({ db, dc, telegramId: req.apiClient.telegram_id, serverId: req.params.id, datacenter: req.purchase.datacenter });
      return res.json({ ok: true, status: 'ip_changed', old_ip: result.oldIp, new_ip: result.newIp });
    } catch (e) { next(e); }
  });

  router.post('/servers/:id/upgrade', userPurchase, async (req, res, next) => {
    try {
      const input = requestInput(req);
      const dc = ensureHetznerDc(res, req.purchase); if (!dc) return;
      const plans = await getHetznerSellablePlans(dc);
      const target = plans.find(p => String(p.id || '').toLowerCase() === String(input.target_server_type || '').toLowerCase());
      if (!target || target.available === false) return apiError(res, 400, 'INVALID_PLAN', 'پلن هدف معتبر نیست.');
      if (!isAllowed(req.apiClient.allowed_plans, target.id)) return apiError(res, 403, 'NOT_ALLOWED', 'پلن هدف برای این کلاینت مجاز نیست.');
      await cloud.changeHetznerServerType(dc, req.params.id, target.hetzner_type, String(input.upgrade_disk || '').toLowerCase() === 'true' || input.upgrade_disk === true);
      const pricing = createApiPricingSnapshot(
        { monthly_prorated_pricing: req.purchase.pricing_mode === 'monthly_prorated' },
        target,
        req.purchase.duration
      );
      await db.updatePurchasePlan(req.apiClient.telegram_id, req.params.id, req.purchase.datacenter, target.id, pricing.amount, pricing.pricingMode, pricing.monthlyBasisPrice);
      res.json({ ok: true, status: 'upgraded', server_type: target.id });
    } catch (e) { next(e); }
  });

  router.use((err, _req, res, _next) => {
    console.error('[CUSTOMER_API_ERROR]', err.code || err.message);
    const providerStatus = Number(err?.status || err?.response?.status || 0);
    const providerCode = String(err?.data?.error?.code || err?.response?.data?.error?.code || '').toUpperCase();
    const providerMessage = String(err?.data?.error?.message || err?.response?.data?.error?.message || '').trim();
    if (err.code === 'INSUFFICIENT_WALLET') return apiError(res, 402, 'INSUFFICIENT_WALLET', 'موجودی کیف پول برای خرید IP اضافه کافی نیست.', { balance: err.balance, required_balance: err.required });
    if (err.code === 'ADDITIONAL_IP_LIMIT_REACHED') return apiError(res, 409, 'ADDITIONAL_IP_LIMIT_REACHED', 'سقف IP اضافه برای این سرور پر شده است.', { limit: err.limit });
    if (err.code === 'ADDITIONAL_IP_NOT_FOUND') return apiError(res, 404, 'ADDITIONAL_IP_NOT_FOUND', 'IP اضافه برای این سرور پیدا نشد.');
    if (err.code === 'ADDITIONAL_IP_DELETE_PROTECTED') return apiError(res, 409, 'ADDITIONAL_IP_DELETE_PROTECTED', 'محافظت حذف این IP در Hetzner فعال است.');
    if (err.code === 'FLOATING_IP_CREATE_FAILED') return apiError(res, 502, 'FLOATING_IP_CREATE_FAILED', 'Hetzner اطلاعات IP جدید را برنگرداند.');
    if (err.code === 'DISPLAY_NAME_TOO_LONG') return apiError(res, 400, 'NAME_TOO_LONG', err.message);
    if (err.code === 'HETZNER_PLACEMENT_UNAVAILABLE') return apiError(res, 409, 'HETZNER_PLACEMENT_UNAVAILABLE', lifecycle.safeProviderMessage(err));
    if (err.code === 'NOT_FOUND' || providerStatus === 404) return apiError(res, 404, 'SERVER_NOT_FOUND', 'سرور یا منبع موردنظر پیدا نشد.');
    if (err.code === 'OPERATION_IN_PROGRESS' || providerStatus === 423) return apiError(res, 409, 'OPERATION_IN_PROGRESS', changeIpUserMessage(err));
    if (err.code === 'INVALID_SERVER_STATE') return apiError(res, 409, 'SERVER_STATE_CONFLICT', changeIpUserMessage(err));
    if (err.code === 'NO_UNUSED_PRIMARY_IPV4_AVAILABLE') return apiError(res, 409, 'NO_UNUSED_PRIMARY_IPV4_AVAILABLE', changeIpUserMessage(err));
    if (err.code === 'PRIMARY_IPV4_NOT_FOUND') return apiError(res, 502, 'PRIMARY_IPV4_NOT_FOUND', changeIpUserMessage(err));
    if (err.code === 'NEW_IP_NOT_READY') return apiError(res, 504, 'NEW_IP_NOT_READY', changeIpUserMessage(err));
    if (err.code === 'CANDIDATE_REJECTED') return apiError(res, 409, 'CANDIDATE_REJECTED', changeIpUserMessage(err));
    if (err.code === 'CANDIDATE_REJECTED_ROLLBACK_FAILED') return apiError(res, 502, 'CANDIDATE_REJECTED_ROLLBACK_FAILED', changeIpUserMessage(err));
    if (err.code === 'OLD_PRIMARY_IP_CLEANUP_FAILED') return apiError(res, 502, 'OLD_PRIMARY_IP_CLEANUP_FAILED', changeIpUserMessage(err));
    if (err.code === 'CONFLICT' || providerStatus === 409 || providerCode === 'CONFLICT') return apiError(res, 409, 'SERVER_STATE_CONFLICT', providerMessage || 'وضعیت فعلی سرور اجازه این عملیات را نمی‌دهد.');
    if (providerStatus >= 400 && providerStatus < 500) return apiError(res, providerStatus, providerCode || 'PROVIDER_REQUEST_FAILED', providerMessage || 'درخواست توسط Hetzner رد شد.');
    if (providerStatus >= 500) return apiError(res, 502, 'PROVIDER_ERROR', 'Hetzner در حال حاضر پاسخ معتبر برنگرداند.');
    return apiError(res, 500, 'INTERNAL_ERROR', 'خطای داخلی رخ داد.');
  });
  return router;
}

module.exports = { createCustomerApiRouter };
