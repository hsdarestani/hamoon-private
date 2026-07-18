'use strict';

const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const cloud = require('./cloud-api');
const datacenters = require('./datacenters');
const lifecycle = require('./services/hetzner-lifecycle');
const { isHetznerConfig } = require('./provider-detector');
const {
  getHetznerSellablePlans,
  createOrGetSshKey
} = require('./Hetzner/hetzner-api');

const minuteBuckets = new Map();

function apiError(res, status, code, message) {
  return res.status(status).json({
    ok: false,
    error: { code, message }
  });
}

function csvAllowed(text) {
  return String(text || '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
}

function isAllowed(listText, value) {
  const list = csvAllowed(listText);
  return !list.length ||
    list.includes(String(value || '').toLowerCase());
}

function clientIp(req) {
  return String(
    req.headers['x-forwarded-for'] ||
    req.ip ||
    ''
  )
    .split(',')[0]
    .trim()
    .slice(0, 64);
}

function checkRate(key, limit) {
  const now = Date.now();
  const minute = Math.floor(now / 60000);
  const bucket = `${key}:${minute}`;
  const count = (minuteBuckets.get(bucket) || 0) + 1;
  minuteBuckets.set(bucket, count);

  if (minuteBuckets.size > 5000) {
    for (const item of minuteBuckets.keys()) {
      if (!item.endsWith(String(minute))) {
        minuteBuckets.delete(item);
      }
    }
  }

  return count <= limit;
}

function isHetznerDc(dcConfigOrKey) {
  if (!dcConfigOrKey) return false;

  if (typeof dcConfigOrKey === 'string') {
    return isHetznerConfig(
      datacenters[dcConfigOrKey] ||
      { key: dcConfigOrKey }
    );
  }

  return isHetznerConfig(dcConfigOrKey);
}

function hetznerDcKeys() {
  return Object.keys(datacenters).filter(key =>
    isHetznerDc({ ...datacenters[key], key })
  );
}

async function findUserHetznerPurchase(
  telegramId,
  serverId
) {
  for (const dcKey of hetznerDcKeys()) {
    const purchase = await db.getPurchaseForUserServer(
      telegramId,
      serverId,
      dcKey
    );

    if (purchase) return purchase;
  }

  return null;
}

function publicIpFromServer(server) {
  return lifecycle.publicIpv4(server);
}

function providerErrorCode(error) {
  return String(
    error?.code ||
    error?.data?.error?.code ||
    error?.response?.data?.error?.code ||
    ''
  );
}

async function auth(req, res, next) {
  req.requestId = crypto.randomBytes(12).toString('hex');
  res.setHeader('X-Request-Id', req.requestId);

  const authorization = String(
    req.headers.authorization || ''
  );
  const token = authorization.startsWith('Bearer ')
    ? authorization.slice(7).trim()
    : '';

  if (!token || !token.startsWith('hm_live_')) {
    return apiError(
      res,
      401,
      'AUTH_REQUIRED',
      'کلید API معتبر ارسال نشده است.'
    );
  }

  const client = await db.authenticateApiKey(token);

  if (!client) {
    return apiError(
      res,
      401,
      'INVALID_API_KEY',
      'کلید API نامعتبر یا غیرفعال است.'
    );
  }

  const writeRequest = [
    'POST',
    'DELETE',
    'PUT',
    'PATCH'
  ].includes(req.method);

  if (!checkRate(client.key_prefix, writeRequest ? 10 : 60)) {
    return apiError(
      res,
      429,
      'RATE_LIMITED',
      'تعداد درخواست‌ها بیش از حد مجاز است.'
    );
  }

  req.apiClient = client;

  res.on('finish', () => {
    db.recordApiRequestLog({
      clientId: client.id,
      telegramId: client.telegram_id,
      keyPrefix: client.key_prefix,
      method: req.method,
      path: req.originalUrl.slice(0, 255),
      statusCode: res.statusCode,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'],
      requestId: req.requestId,
      errorMessage:
        res.statusCode >= 400
          ? res.statusMessage
          : null
    }).catch(() => {});
  });

  next();
}

async function userPurchase(req, res, next) {
  const purchase = await findUserHetznerPurchase(
    req.apiClient.telegram_id,
    req.params.id
  );

  if (!purchase) {
    return apiError(
      res,
      404,
      'SERVER_NOT_FOUND',
      'سرور پیدا نشد.'
    );
  }

  req.purchase = purchase;
  next();
}

function createJsonBodyParser() {
  return (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH'].includes(req.method)) {
      req.body = {};
      next();
      return;
    }

    let raw = '';
    let completed = false;
    req.setEncoding('utf8');

    req.on('data', chunk => {
      raw += chunk;

      if (raw.length > 65536 && !completed) {
        completed = true;
        apiError(
          res,
          413,
          'PAYLOAD_TOO_LARGE',
          'حجم درخواست بیش از حد مجاز است.'
        );
      }
    });

    req.on('end', () => {
      if (completed) return;

      const text = raw.trim();

      if (!text) {
        req.body = {};
        req.rawBodyText = '';
        next();
        return;
      }

      try {
        req.body = JSON.parse(text);
        req.rawBodyText = text;
        next();
      } catch {
        apiError(
          res,
          400,
          'INVALID_JSON',
          'بدنه JSON نامعتبر است.'
        );
      }
    });

    req.on('error', next);
  };
}

function createCustomerApiRouter() {
  const router = express.Router();

  router.use(createJsonBodyParser());
  router.use(auth);

  router.get('/me', (req, res) => {
    res.json({
      ok: true,
      client: {
        id: req.apiClient.id,
        telegram_id: req.apiClient.telegram_id,
        name: req.apiClient.name,
        is_active: req.apiClient.is_active,
        max_servers: req.apiClient.max_servers,
        max_monthly_spend: req.apiClient.max_monthly_spend,
        max_hourly_spend: req.apiClient.max_hourly_spend,
        allowed_datacenters:
          req.apiClient.allowed_datacenters,
        allowed_plans: req.apiClient.allowed_plans,
        allowed_images: req.apiClient.allowed_images,
        allowed_locations:
          req.apiClient.allowed_locations,
        min_wallet_balance:
          req.apiClient.min_wallet_balance
      }
    });
  });

  router.get('/wallet', async (req, res, next) => {
    try {
      res.json({
        ok: true,
        wallet: {
          balance: await db.getUserWallet(
            req.apiClient.telegram_id
          )
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/prices', async (req, res, next) => {
    try {
      const dcKey = String(
        req.query.datacenter || 'hetzner'
      ).toLowerCase();
      const dc = datacenters[dcKey];

      if (!dc || !isHetznerDc({ ...dc, key: dcKey })) {
        return apiError(
          res,
          404,
          'HETZNER_DATACENTER_NOT_FOUND',
          'دیتاسنتر هتزنر پیدا نشد.'
        );
      }

      const config = {
        ...dc,
        key: dcKey,
        HETZNER_LOCATION:
          String(
            req.query.location ||
            dc.HETZNER_LOCATION ||
            ''
          ).toLowerCase()
      };

      const plans = await getHetznerSellablePlans(config);

      res.json({
        ok: true,
        datacenter: dcKey,
        location: config.HETZNER_LOCATION,
        plans
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/usage', async (req, res, next) => {
    try {
      res.json({
        ok: true,
        usage: await db.getApiClientUsageSummary(
          req.apiClient.id
        )
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/servers', async (req, res, next) => {
    try {
      const data = await db.listAdminServers({
        userId: req.apiClient.telegram_id,
        limit: 200
      });

      res.json({
        ok: true,
        servers: data.rows.filter(row =>
          isHetznerDc(row.datacenter)
        )
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/servers/:id', userPurchase, (req, res) => {
    res.json({
      ok: true,
      server: req.purchase
    });
  });

  router.post('/servers', async (req, res, next) => {
    try {
      const client = req.apiClient;
      const body = {
        ...(req.query || {}),
        ...(
          req.body &&
          typeof req.body === 'object' &&
          !Array.isArray(req.body)
            ? req.body
            : {}
        )
      };

      const dcKey = String(
        body.datacenter || 'hetzner'
      ).trim().toLowerCase();
      const dcBase = datacenters[dcKey];

      if (
        !dcBase ||
        !isHetznerDc({ ...dcBase, key: dcKey })
      ) {
        return apiError(
          res,
          503,
          'HETZNER_UNAVAILABLE',
          'دیتاسنتر هتزنر فعال نیست.'
        );
      }

      const duration = [
        'hourly',
        'daily',
        'weekly',
        'monthly'
      ].includes(body.duration)
        ? body.duration
        : 'hourly';
      const location = String(
        body.location ||
        dcBase.HETZNER_LOCATION ||
        'nbg1'
      ).trim().toLowerCase();
      const dc = {
        ...dcBase,
        key: dcKey,
        HETZNER_LOCATION: location
      };

      const plans = await getHetznerSellablePlans(dc);
      const requestedPlan = String(
        body.server_type || ''
      ).trim().toLowerCase();
      const plan = plans.find(item =>
        [
          item.id,
          item.hetzner_type,
          item.server_type
        ]
          .map(value => String(value || '').toLowerCase())
          .includes(requestedPlan)
      );

      if (!plan || plan.available === false) {
        return apiError(
          res,
          409,
          'HETZNER_PLAN_UNAVAILABLE',
          'این پلن در لوکیشن انتخاب‌شده فعلاً قابل فروش نیست.'
        );
      }

      const image = String(
        body.image || 'ubuntu-24.04'
      ).trim();

      if (
        !isAllowed(client.allowed_datacenters, dcKey) ||
        !isAllowed(client.allowed_plans, plan.id) ||
        !isAllowed(client.allowed_images, image) ||
        !isAllowed(client.allowed_locations, location)
      ) {
        return apiError(
          res,
          403,
          'NOT_ALLOWED',
          'این پلن، ایمیج یا لوکیشن برای این کلاینت مجاز نیست.'
        );
      }

      const wallet = Number(
        await db.getUserWallet(client.telegram_id) || 0
      );

      if (
        wallet <
        Number(client.min_wallet_balance || 0)
      ) {
        return apiError(
          res,
          402,
          'INSUFFICIENT_WALLET',
          'موجودی کیف پول کافی نیست.'
        );
      }

      if (
        await db.getApiClientActiveServerCount(client.id) >=
        Number(client.max_servers || 2)
      ) {
        return apiError(
          res,
          403,
          'SERVER_LIMIT_REACHED',
          'سقف تعداد سرورهای مجاز پر شده است.'
        );
      }

      const price = lifecycle.getFlavorCyclePrice(
        plan,
        duration
      );
      const name = String(
        body.name || `api-${Date.now()}`
      )
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .slice(0, 63);

      let keyId = null;

      if (body.ssh_key) {
        const publicKey = String(body.ssh_key).trim();

        if (publicKey.length > 4096) {
          return apiError(
            res,
            400,
            'SSH_KEY_TOO_LARGE',
            'کلید SSH بیش از حد بزرگ است.'
          );
        }

        const key = await createOrGetSshKey({
          token:
            dc.HETZNER_API_TOKEN ||
            dc.HETZNER_TOKEN ||
            dc.token ||
            process.env.HETZNER_API_TOKEN,
          name: `api-${client.id}-${Date.now()}`.slice(
            0,
            63
          ),
          publicKey
        });

        keyId = key?.id || null;
      }

      const server = await cloud.createServer(
        dc,
        null,
        {
          name,
          serverType:
            plan.hetzner_type || plan.id,
          image,
          location,
          key_id: keyId,
          userLabel: client.telegram_id
        }
      );

      await db.recordPurchase(
        client.telegram_id,
        String(server.id),
        dcKey,
        server.name || name,
        plan.id,
        price,
        duration,
        0,
        0,
        null,
        'api',
        image,
        0,
        0,
        0,
        0,
        0,
        keyId,
        'provisioning',
        2,
        {
          providerActionId:
            server.action?.id || null
        }
      );

      const readiness = await lifecycle.waitForReadiness(
        dc,
        server.id,
        {
          waitActionId: server.action?.id
        }
      );

      await db.updateScopedStatus(
        client.telegram_id,
        String(server.id),
        dcKey,
        readiness.status
      );

      if (readiness.ready) {
        await db.markDelivered(
          client.telegram_id,
          String(server.id),
          dcKey,
          readiness.ip
        );

        await db.recordWalletLog(
          client.telegram_id,
          0,
          `API server ready ${server.id}`,
          'server_api_ready'
        ).catch(() => {});

        return res.status(201).json({
          ok: true,
          operation: 'ready',
          server: {
            id: String(server.id),
            name: server.name || name,
            status: 'active',
            public_ip: readiness.ip,
            server_type: plan.id,
            price,
            duration,
            root_password:
              server.root_password || undefined
          }
        });
      }

      await db.recordWalletLog(
        client.telegram_id,
        0,
        `API server provisioning ${server.id}`,
        'server_api_provisioning'
      ).catch(() => {});

      return res.status(202).json({
        ok: true,
        operation: 'provisioning',
        server: {
          id: String(server.id),
          name: server.name || name,
          status: readiness.status,
          public_ip: null,
          server_type: plan.id,
          price,
          duration
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.delete(
    '/servers/:id',
    userPurchase,
    async (req, res, next) => {
      try {
        const dc = {
          ...datacenters[req.purchase.datacenter],
          key: req.purchase.datacenter
        };

        await lifecycle.deletePurchaseServer({
          db,
          dc,
          telegramId: req.apiClient.telegram_id,
          serverId: req.params.id,
          datacenter: req.purchase.datacenter
        });

        res.json({
          ok: true,
          status: 'deleted'
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    '/servers/:id/poweron',
    userPurchase,
    async (req, res, next) => {
      try {
        const dc = {
          ...datacenters[req.purchase.datacenter],
          key: req.purchase.datacenter
        };
        const action = await cloud.startServer(
          dc,
          null,
          req.params.id
        );

        if (action?.id) {
          await cloud.waitHetznerAction(
            dc,
            action.id,
            180000
          );
        }

        await db.updateScopedStatus(
          req.apiClient.telegram_id,
          req.params.id,
          req.purchase.datacenter,
          'active'
        );

        res.json({ ok: true, status: 'active' });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    '/servers/:id/poweroff',
    userPurchase,
    async (req, res, next) => {
      try {
        const dc = {
          ...datacenters[req.purchase.datacenter],
          key: req.purchase.datacenter
        };
        const action = await cloud.suspendServer(
          dc,
          null,
          req.params.id
        );

        if (action?.id) {
          await cloud.waitHetznerAction(
            dc,
            action.id,
            180000
          );
        }

        await db.updateScopedStatus(
          req.apiClient.telegram_id,
          req.params.id,
          req.purchase.datacenter,
          'suspended'
        );

        res.json({ ok: true, status: 'suspended' });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    '/servers/:id/rebuild',
    userPurchase,
    async (req, res, next) => {
      try {
        const image = String(
          req.body?.image || ''
        ).trim();

        if (!image) {
          return apiError(
            res,
            400,
            'IMAGE_REQUIRED',
            'شناسه یا نام ایمیج الزامی است.'
          );
        }

        const dc = {
          ...datacenters[req.purchase.datacenter],
          key: req.purchase.datacenter
        };
        const result =
          await lifecycle.rebuildServerLifecycle({
            db,
            dc,
            telegramId:
              req.apiClient.telegram_id,
            serverId: req.params.id,
            datacenter:
              req.purchase.datacenter,
            imageId: image
          });

        res.status(result.ok ? 200 : 202).json({
          ok: true,
          operation: result.ok
            ? 'rebuild_ready'
            : 'rebuild_provisioning',
          status: result.status,
          public_ip:
            result.ok ? result.ip : null,
          root_password:
            result.ok
              ? result.root_password || undefined
              : undefined
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    '/servers/:id/change-ip',
    userPurchase,
    async (req, res, next) => {
      try {
        const dc = {
          ...datacenters[req.purchase.datacenter],
          key: req.purchase.datacenter
        };
        const result =
          await lifecycle.changePublicIpLifecycle({
            db,
            dc,
            telegramId:
              req.apiClient.telegram_id,
            serverId: req.params.id,
            datacenter:
              req.purchase.datacenter
          });

        res.json({
          ok: true,
          operation: 'change_ip_completed',
          status: result.status,
          old_ip: result.old_ip,
          new_ip: result.new_ip
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    '/servers/:id/upgrade',
    userPurchase,
    async (req, res, next) => {
      try {
        const dc = {
          ...(
            datacenters[req.purchase.datacenter] ||
            datacenters.hetzner
          ),
          key: req.purchase.datacenter
        };
        const plans = await getHetznerSellablePlans(dc);
        const targetId = String(
          req.body?.target_server_type || ''
        ).toLowerCase();
        const target = plans.find(
          plan => plan.id === targetId
        );

        if (!target) {
          return apiError(
            res,
            400,
            'INVALID_PLAN',
            'پلن هدف معتبر نیست.'
          );
        }

        const action =
          await cloud.changeHetznerServerType(
            dc,
            req.params.id,
            target.hetzner_type,
            Boolean(req.body?.upgrade_disk)
          );

        await cloud.waitHetznerAction(
          dc,
          action?.id,
          300000
        );

        const amount =
          lifecycle.getFlavorCyclePrice(
            target,
            req.purchase.duration || 'monthly'
          );

        await db.updatePurchasePlan(
          req.apiClient.telegram_id,
          req.params.id,
          req.purchase.datacenter,
          target.id,
          amount
        );

        res.json({
          ok: true,
          status: 'active',
          server_type: target.id,
          price: amount
        });
      } catch (error) {
        next(error);
      }
    }
  );

  router.use((error, _req, res, _next) => {
    const code = providerErrorCode(error);
    const status = Number(
      error?.status ||
      error?.response?.status ||
      0
    );

    console.error('[CUSTOMER_API_ERROR]', {
      code: code || error.message,
      status
    });

    if (
      code === 'HETZNER_PLACEMENT_UNAVAILABLE' ||
      code === 'resource_unavailable'
    ) {
      return apiError(
        res,
        409,
        'HETZNER_PLACEMENT_UNAVAILABLE',
        lifecycle.safeProviderMessage(error)
      );
    }

    if (code === 'OPERATION_IN_PROGRESS') {
      return apiError(
        res,
        409,
        code,
        lifecycle.safeProviderMessage(error)
      );
    }

    if (code === 'CHANGE_IP_FAILED') {
      return apiError(
        res,
        502,
        code,
        lifecycle.safeProviderMessage(error)
      );
    }

    if (
      status === 422 ||
      status === 412 ||
      status === 503
    ) {
      return apiError(
        res,
        409,
        'HETZNER_OPERATION_UNAVAILABLE',
        'این عملیات یا پلن در Hetzner فعلاً در دسترس نیست.'
      );
    }

    apiError(
      res,
      500,
      'INTERNAL_ERROR',
      'خطای داخلی رخ داد.'
    );
  });

  return router;
}

module.exports = {
  createCustomerApiRouter
};
