const path = require('path');
require('dotenv').config({
  path: path.join(__dirname, '..', '.env')
});
const axios  = require('axios');

const BASE = 'https://api.hetzner.cloud/v1';


function getHetznerApiToken(config = {}) {
  return config?.HETZNER_API_TOKEN || config?.HETZNER_TOKEN || config?.apiToken || config?.token ||
    process.env.HETZNER_API_TOKEN || process.env.HETZNER_TOKEN || process.env.HCLOUD_TOKEN || null;
}

async function hetznerRequest(config, method, reqPath, body) {
  const token = getHetznerApiToken(config);
  if (!token) throw new Error('Hetzner API token is missing');
  const res = await axios({
    baseURL: BASE,
    url: reqPath,
    method,
    data: body,
    timeout: 30000,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    validateStatus: () => true
  });
  if (res.status >= 200 && res.status < 300) return res.data;
  const err = new Error(`Hetzner API ${method} ${reqPath} failed HTTP ${res.status}`);
  err.status = res.status;
  err.data = res.data;
  throw err;
}

async function listHetznerServerTypes(config) {
  const data = await hetznerRequest(config, 'GET', '/server_types?per_page=200');
  return data.server_types || [];
}

const SERVER_TYPE_CACHE_MS = Number(process.env.HETZNER_PLAN_CACHE_MS || 20 * 60 * 1000);
const UNAVAILABLE_PLAN_CACHE_MS = Number(
  process.env.HETZNER_UNAVAILABLE_PLAN_CACHE_MS || 10 * 60 * 1000
);
let serverTypeCache = { expires: 0, plans: null };
const unavailablePlans = new Map();

function planAvailabilityKey(location, serverType) {
  return `${String(location || '').toLowerCase()}:${String(serverType || '').toLowerCase()}`;
}

function markServerTypeUnavailable(location, serverType, ttlMs = UNAVAILABLE_PLAN_CACHE_MS) {
  unavailablePlans.set(
    planAvailabilityKey(location, serverType),
    Date.now() + Math.max(1000, Number(ttlMs || UNAVAILABLE_PLAN_CACHE_MS))
  );
}

function isServerTypeTemporarilyUnavailable(location, serverType) {
  const key = planAvailabilityKey(location, serverType);
  const expires = unavailablePlans.get(key);
  if (!expires) return false;
  if (expires <= Date.now()) {
    unavailablePlans.delete(key);
    return false;
  }
  return true;
}

function csvSet(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map(item => item.trim().toLowerCase())
      .filter(Boolean)
  );
}

function filterConfiguredServerTypes(plans, config = {}) {
  const allowed = csvSet(
    config.HETZNER_ALLOWED_SERVER_TYPES ||
    process.env.HETZNER_ALLOWED_SERVER_TYPES
  );
  const disabled = csvSet(
    config.HETZNER_DISABLED_SERVER_TYPES ||
    process.env.HETZNER_DISABLED_SERVER_TYPES
  );
  const location =
    config.HETZNER_LOCATION ||
    process.env.HETZNER_LOCATION ||
    '';

  return (plans || []).filter(plan => {
    const id = String(
      plan?.id ||
      plan?.hetzner_type ||
      plan?.server_type ||
      ''
    ).toLowerCase();

    return Boolean(id) &&
      (!allowed.size || allowed.has(id)) &&
      !disabled.has(id) &&
      !isServerTypeTemporarilyUnavailable(location, id);
  });
}

function roundPrice(value) {
  const roundTo = Math.max(1, Number(process.env.HETZNER_PRICE_ROUND_TO || 1000));
  return Math.max(roundTo, Math.ceil(Number(value || 0) / roundTo) * roundTo);
}

function firstPrice(serverType, location = null) {
  const prices = Array.isArray(serverType?.prices)
    ? serverType.prices
    : [];
  const normalizedLocation = String(
    location || ''
  ).toLowerCase();

  return (
    prices.find(price =>
      normalizedLocation &&
      String(price?.location || '').toLowerCase() === normalizedLocation
    ) ||
    prices.find(price =>
      price?.price_hourly ||
      price?.price_monthly
    ) ||
    prices[0] ||
    {}
  );
}

function hetznerFamily(name) {
  return String(name || '').replace(/[0-9].*$/, '').toUpperCase() || 'OTHER';
}

function normalizeHetznerServerTypes(serverTypes = [], config = {}) {
  const eurToToman = Number(process.env.HETZNER_EUR_TO_TOMAN || process.env.EUR_TO_TOMAN || 70000);
  const baseMultiplier = Number(process.env.HETZNER_PRICE_MULTIPLIER || 1);
  const hourlyMultiplier = Number(process.env.HETZNER_HOURLY_PRICE_MULTIPLIER || baseMultiplier);
  const monthlyMultiplier = Number(process.env.HETZNER_MONTHLY_PRICE_MULTIPLIER || baseMultiplier);
  const minHourly = Number(process.env.HETZNER_MIN_HOURLY_TOMAN || 1);
  const minMonthly = Number(process.env.HETZNER_MIN_MONTHLY_TOMAN || 1);
  const allowedHetznerTypesRaw = String(process.env.HETZNER_ALLOWED_SERVER_TYPES || '')
    .split(',')
    .map(x => x.trim().toLowerCase())
    .filter(Boolean);
  const allowedHetznerTypes = allowedHetznerTypesRaw.length ? new Set(allowedHetznerTypesRaw) : null;

  return (serverTypes || [])
    .filter(st => st && st.name && !st.deprecated && st.deprecation === null)
    .filter(st => !allowedHetznerTypes || allowedHetznerTypes.has(String(st.name || '').toLowerCase()))
    .map(st => {
      const price = firstPrice(st, config.HETZNER_LOCATION || process.env.HETZNER_LOCATION);
      const hourlyEur = Number(price?.price_hourly?.gross || price?.price_hourly?.net || 0);
      const monthlyEur = Number(price?.price_monthly?.gross || price?.price_monthly?.net || (hourlyEur * 720));
      const hourlyToman = roundPrice(Math.max(minHourly, hourlyEur * eurToToman * hourlyMultiplier));
      const monthlyToman = roundPrice(Math.max(minMonthly, monthlyEur * eurToToman * monthlyMultiplier));
      const id = String(st.name).toLowerCase();
      const family = hetznerFamily(id);
      return {
        id, hetzner_type: id, server_type: id,
        label: `${id.toUpperCase()} - ${st.cores} vCPU / ${st.memory} GB RAM / ${st.disk} GB`,
        family, cores: Number(st.cores || 0), memory: Number(st.memory || 0), disk: Number(st.disk || 0),
        architecture: st.architecture || (family === 'CAX' ? 'arm' : 'x86'), storage_type: st.storage_type || null,
        hourly_price_eur: hourlyEur, monthly_price_eur: monthlyEur,
        hourly_price_toman: hourlyToman, monthly_price_toman: monthlyToman,
        amount_hourly: hourlyToman, amount_monthly: monthlyToman,
        price: hourlyToman,
        monthly_toman: monthlyToman,
        monthly_price: monthlyToman,
        monthlyPrice: monthlyToman,
        pricesByCycle: {
          hourly: hourlyToman,
          daily: Math.round(hourlyToman * 24),
          weekly: Math.round(hourlyToman * 168),
          monthly: monthlyToman
        },
        available: true
      };
    })
    .sort((a,b) => (a.family.localeCompare(b.family) || a.monthly_toman - b.monthly_toman || a.id.localeCompare(b.id)));
}

function normalizeStaticHetznerPlans(config = {}) {
  return (config.flavors || []).map(f => ({
    id: String(f.hetzner_type || f.id).toLowerCase(),
    hetzner_type: String(f.hetzner_type || f.id).toLowerCase(),
    server_type: String(f.hetzner_type || f.id).toLowerCase(),
    label: f.label || String(f.id), family: hetznerFamily(f.hetzner_type || f.id),
    cores: Number(f.cores || f.cpu || 0), memory: Number(f.memory || f.ram || 0), disk: Number(f.disk || 0),
    amount_hourly: Number(f.amount_hourly || f.price || 0), amount_monthly: Number(f.amount_monthly || f.monthly_toman || 0),
    price: Number(f.price || f.amount_hourly || 0), monthly_toman: Number(f.monthly_toman || f.amount_monthly || 0), available: f.available !== false
  }));
}

async function getHetznerSellablePlans(config = {}) {
  const now = Date.now();
  let plans = null;

  if (serverTypeCache.plans && serverTypeCache.expires > now) {
    plans = serverTypeCache.plans;
  } else {
    try {
      const livePlans = normalizeHetznerServerTypes(
        await listHetznerServerTypes(config),
        config
      );

      if (livePlans.length) {
        serverTypeCache = {
          plans: livePlans,
          expires: now + SERVER_TYPE_CACHE_MS
        };
        plans = livePlans;
      }
    } catch (error) {
      console.warn(
        '[hetzner] using static plan fallback:',
        error.message
      );
    }
  }

  if (!plans) {
    plans = normalizeStaticHetznerPlans(config);
  }

  const filtered = filterConfiguredServerTypes(plans, config);

  if (filtered.length) return filtered;

  if (plans.length) {
    console.warn(
      '[hetzner] all plans were filtered by allow/disable/unavailable rules',
      {
        location: config.HETZNER_LOCATION,
        available_before_filter: plans.length
      }
    );
    return [];
  }

  throw new Error('HETZNER_PLAN_CATALOG_UNAVAILABLE');
}

async function getHetznerServer(config, serverId) {
  const data = await hetznerRequest(config, 'GET', `/servers/${serverId}`);
  return data.server;
}

async function powerOffHetznerServer(config, serverId) {
  const data = await hetznerRequest(config, 'POST', `/servers/${serverId}/actions/poweroff`, {});
  return data.action;
}

async function powerOnHetznerServer(config, serverId) {
  const data = await hetznerRequest(config, 'POST', `/servers/${serverId}/actions/poweron`, {});
  return data.action;
}

async function changeHetznerServerType(config, serverId, serverType, upgradeDisk = false) {
  const data = await hetznerRequest(config, 'POST', `/servers/${serverId}/actions/change_type`, {
    server_type: String(serverType).toLowerCase(),
    upgrade_disk: !!upgradeDisk
  });
  return data.action;
}

async function waitHetznerAction(config, actionId, timeoutMs = 300000) {
  if (!actionId) return null;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const data = await hetznerRequest(config, 'GET', `/actions/${actionId}`);
    const action = data.action;
    if (action?.status === 'success') return action;
    if (action?.status === 'error') throw new Error(`Hetzner action ${actionId} failed: ${action.error?.message || 'unknown error'}`);
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error(`Hetzner action ${actionId} timed out`);
}

function client(tokenOrCfg) {
  const token = typeof tokenOrCfg === 'string'
    ? tokenOrCfg
    : (getHetznerApiToken(tokenOrCfg));
  return axios.create({
    baseURL: BASE,
    timeout: 15000,
    headers: { Authorization: `Bearer ${token}`},
  });
}

// همگام با امضای openstack-api (برای سازگاری با کد شما):
async function getToken() { return null; } // لازم نیست

async function listFlavors(dcConfig) {
  return getHetznerSellablePlans(dcConfig);
}


async function listImages(dcConfig, /*token*/ _t, options = {}) {
  try {
    const token = getHetznerApiToken(dcConfig);

    if (!token) {
      console.warn('[hetzner] listImages: missing token');
      return (dcConfig.images || []).map(image => ({
        id: String(image.id ?? image.name ?? image.label ?? image),
        label: image.label || image.name || String(image.id ?? image),
        name: image.name || String(image.id ?? image),
        architecture: image.architecture || null
      }));
    }

    const params = {
      type: 'system',
      status: 'available',
      per_page: 200
    };

    if (options?.architecture) {
      params.architecture = String(options.architecture).toLowerCase();
    }

    const http = client(token);
    const { data } = await http.get('/images', { params });
    const images = Array.isArray(data.images) ? data.images : [];
    const byKey = new Map();

    for (const image of images) {
      if (image?.deprecated || image?.deprecation) continue;

      const key = [
        image.name || image.id,
        image.architecture || ''
      ].join(':').toLowerCase();

      const previous = byKey.get(key);

      if (
        !previous ||
        new Date(image.created || 0) > new Date(previous.created || 0)
      ) {
        byKey.set(key, image);
      }
    }

    const mapped = [...byKey.values()].map(image => ({
      id: String(image.id),
      label: image.description || image.name || String(image.id),
      name: image.name || String(image.id),
      architecture: image.architecture || null,
      deprecated: Boolean(image.deprecated || image.deprecation)
    }));

    const fixed = (dcConfig.images || []).map(image => ({
      id: String(image.id ?? image.name ?? image.label ?? image),
      label: image.label || image.name || String(image.id ?? image),
      name: image.name || String(image.id ?? image),
      architecture: image.architecture || null
    }));

    const unique = new Map();

    for (const image of [...fixed, ...mapped]) {
      const key = `${image.name || image.id}:${image.architecture || ''}`;
      unique.set(key, image);
    }

    return [...unique.values()].sort((a, b) =>
      String(a.label).localeCompare(String(b.label))
    );
  } catch (error) {
    console.error(
      '[hetzner] listImages error:',
      error.response?.status,
      error.response?.data || error.message
    );

    return (dcConfig.images || []).map(image => ({
      id: String(image.id ?? image.name ?? image.label ?? image),
      label: image.label || image.name || String(image.id ?? image),
      name: image.name || String(image.id ?? image),
      architecture: image.architecture || null
    }));
  }
}

async function createOrGetSshKey({ token, name, publicKey }) {
  if (!publicKey) {
    throw new Error('[hetzner] createOrGetSshKey: publicKey is required');
  }
  const c = client(token);
  try {
    const r = await c.post('/ssh_keys', { name, public_key: publicKey });
    return r.data.ssh_key;
  } catch (e) {
    if (e.response && e.response.status === 409) {
      const list = await c.get('/ssh_keys');
      const found = (list.data.ssh_keys || []).find(k => k.public_key.trim() === publicKey.trim());
      if (found) return found;
    }
    // لاگ بدنهٔ خطای 422/… برای دیباگ
    console.error('[hetzner] createOrGetSshKey error:', e.response?.status, e.response?.data || e.message);
    throw e;
  }
}


async function deleteSshKey({ token, id }) {
  const c = client(token);
  await c.delete(`/ssh_keys/${id}`);
}




// جایگزین کامل createKeyPair موجود
async function createKeyPair(dcConfig, /*token*/ _t, keyName) {
  // 1) public key را از env یا کانفیگ دیتاسنتر بگیر
  const publicKey =
    process.env.HETZNER_SSH_PUBLIC_KEY?.trim() ||
    dcConfig?.ssh_public_key?.trim();

  if (!publicKey) {
    // بدون public key نمی‌توان در Hetzner کاری کرد
    // خروجی سازگار با OpenStack بده ولی private_key نداریم
    return {
      key_name: keyName,
      key_id: null,
      private_key: null,
    };
  }

  // 2) در Hetzner اگر همین public_key موجود باشد، 409 می‌دهد.
  //    پس از تابع createOrGetSshKey استفاده می‌کنیم.
  const token = dcConfig?.token || dcConfig?.HETZNER_API_TOKEN || dcConfig?.HETZNER_TOKEN || process.env.HETZNER_API_TOKEN || process.env.HETZNER_TOKEN || process.env.HCLOUD_TOKEN;
  const sshKey = await createOrGetSshKey({
    token,
    name: keyName.slice(0, 63),
    publicKey,
  });

  return {
    key_name: sshKey.name,
    key_id: sshKey.id,     // مهم: این را بعداً موقع ساخت سرور استفاده می‌کنیم
    private_key: null,     // Hetzner private تولید نمی‌کند؛ کلید باید از قبل دست شما باشد
  };
}
async function deleteKeyPair(dcConfig, /*token*/ _t, keyNameOrId) {
  try {
    const http = client(dcConfig);
    // اگر ID داریم:
    if (String(Number(keyNameOrId)) === keyNameOrId) {
      await http.delete(`/ssh_keys/${keyNameOrId}`);
      return;
    }
    // اگر اسم داریم → پیدا کن:
    const { data } = await http.get('/ssh_keys', { params: { name: keyNameOrId } });
    const key = (data.ssh_keys || []).find(k => k.name === keyNameOrId);
    if (key) await http.delete(`/ssh_keys/${key.id}`);
  } catch (_) {}
}



function getHetznerFallbackLocations(dcConfig = {}, preferredLocation = null) {
  const first = preferredLocation || dcConfig.HETZNER_LOCATION || process.env.HETZNER_LOCATION || 'nbg1';
  const raw = dcConfig.HETZNER_LOCATION_FALLBACKS || process.env.HETZNER_LOCATION_FALLBACKS || first;
  const list = String(raw).split(',').map(x => x.trim()).filter(Boolean);
  const out = [];
  for (const loc of [first, ...list]) {
    if (loc && !out.includes(loc)) out.push(loc);
  }
  return out.length ? out : [first];
}

function isHetznerPlacementUnavailableError(error) {
  const status = Number(
    error?.response?.status ||
    error?.status ||
    error?.statusCode ||
    0
  );
  const code = String(
    error?.response?.data?.error?.code ||
    error?.data?.error?.code ||
    error?.code ||
    ''
  ).toLowerCase();
  const message = String(
    error?.response?.data?.error?.message ||
    error?.data?.error?.message ||
    error?.message ||
    ''
  ).toLowerCase();

  const capacityCodes = new Set([
    'resource_unavailable',
    'unavailable',
    'service_error',
    'unsupported_error'
  ]);

  return (
    [412, 422, 503].includes(status) &&
    (
      capacityCodes.has(code) ||
      message.includes('resource unavailable') ||
      message.includes('resource_unavailable') ||
      message.includes('placement') ||
      message.includes('capacity') ||
      message.includes('temporarily unavailable')
    )
  );
}

function slugifyAscii(s = '') {
  return String(s)
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '-')     // حذف یونیکد (مثل آلمان)
    .replace(/[^A-Za-z0-9._-]+/g, '-') // امن برای Hetzner
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63) || 'user';
}

// امضا سازگار با index.js: (dcConfig, _t, opts)
async function createServer(dcConfig, _t, opts) {
  const {
    name,
    serverType,
    image,
    location,
    key_id,
    userLabel,
    user_data
  } = opts || {};

  const token = getHetznerApiToken(dcConfig);

  if (!token) {
    throw new Error('[hetzner] createServer: missing token');
  }

  if (!serverType) {
    throw new Error('[hetzner] createServer: serverType is required');
  }

  if (!image) {
    throw new Error('[hetzner] createServer: image is required');
  }

  const preferredLocation =
    location ||
    dcConfig?.HETZNER_LOCATION ||
    process.env.HETZNER_LOCATION ||
    'nbg1';
  const http = client(token);
  const passwordOnly = Boolean(dcConfig?.HETZNER_PASSWORD_ONLY);
  const sshKeys =
    !passwordOnly && key_id
      ? [Number(key_id)]
      : undefined;

  const payload = {
    name: slugifyAscii(name || `srv-${Date.now()}`),
    server_type: String(serverType).toLowerCase(),
    image,
    location: preferredLocation,
    ssh_keys: sshKeys,
    user_data: user_data || undefined,
    labels: userLabel
      ? { user: String(userLabel) }
      : undefined
  };

  let lastPlacementError = null;

  for (const candidate of getHetznerFallbackLocations(
    dcConfig,
    preferredLocation
  )) {
    const attemptPayload = {
      ...payload,
      location: candidate
    };

    console.log('[HETZNER_CREATE_ATTEMPT]', {
      location: candidate,
      server_type: payload.server_type,
      image
    });

    try {
      const response = await http.post(
        '/servers',
        attemptPayload
      );
      const data = response.data || {};
      const server = data.server || {};

      server.action = data.action || null;
      server.root_password = data.root_password || null;

      return server;
    } catch (error) {
      console.error('[HETZNER_CREATE_FAILED]', {
        location: candidate,
        server_type: payload.server_type,
        status: error.response?.status,
        code: error.response?.data?.error?.code,
        message:
          error.response?.data?.error?.message ||
          error.message
      });

      if (!isHetznerPlacementUnavailableError(error)) {
        throw error;
      }

      markServerTypeUnavailable(
        candidate,
        payload.server_type
      );
      lastPlacementError = error;
    }
  }

  const placementError = new Error(
    'ظرفیت این پلن در لوکیشن انتخاب‌شده موقتاً موجود نیست. پلن دیگری را انتخاب کنید.'
  );
  placementError.code = 'HETZNER_PLACEMENT_UNAVAILABLE';
  placementError.cause = lastPlacementError;
  throw placementError;
}

function normalizeServer(server = {}) {
  const ipv4 = server?.public_net?.ipv4 || null;
  const publicIp = ipv4?.ip || null;
  const location =
    server?.location?.name ||
    server?.location ||
    null;

  return {
    id: String(server.id),
    name: server.name,
    status: server.status,
    server_type:
      server.server_type?.name ||
      server.server_type?.id ||
      null,
    image: {
      id: server.image?.id || null,
      name:
        server.image?.name ||
        String(server.image?.id || ''),
      architecture: server.image?.architecture || null
    },
    location,
    primary_ipv4_id: ipv4?.id || null,
    public_ip: publicIp,
    public_net: server.public_net || null,
    metadata: {
      user: server.labels?.user,
      type: server.labels?.type
    },
    addresses: publicIp
      ? {
          public: [
            {
              version: 4,
              addr: publicIp
            }
          ]
        }
      : {}
  };
}

async function listServers(dcConfig /*, token */) {
  const http = client(dcConfig);
  const { data } = await http.get('/servers', {
    params: { per_page: 200 }
  });

  return (data.servers || []).map(normalizeServer);
}

async function getServer(dcConfig, /*token*/ _t, serverId) {
  const http = client(dcConfig);
  const { data } = await http.get(`/servers/${serverId}`);
  return normalizeServer(data.server);
}

async function deleteServer(dcConfig, /*token*/ _t, serverId) {
  const http = client(dcConfig);
  const response = await http.delete(`/servers/${serverId}`);
  return response.data?.action || null;
}

async function suspendServer(dcConfig, /*token*/ _t, serverId) {
  const http = client(dcConfig);
  const { data } = await http.post(
    `/servers/${serverId}/actions/poweroff`,
    {}
  );
  return data?.action || null;
}

async function resumeServer(dcConfig, /*token*/ _t, serverId) {
  const http = client(dcConfig);
  const { data } = await http.post(
    `/servers/${serverId}/actions/poweron`,
    {}
  );
  return data?.action || null;
}

async function startServer(dcConfig, token, serverId) {
  return resumeServer(dcConfig, token, serverId);
}

async function rebuildServer(
  dcConfig,
  /*token*/ _t,
  serverId,
  imageId
) {
  const http = client(dcConfig);
  const { data } = await http.post(
    `/servers/${serverId}/actions/rebuild`,
    { image: imageId }
  );

  return {
    action: data?.action || null,
    root_password: data?.root_password || null
  };
}

async function createPrimaryIpv4(dcConfig, location) {
  const data = await hetznerRequest(
    dcConfig,
    'POST',
    '/primary_ips',
    {
      type: 'ipv4',
      location: String(location),
      auto_delete: false
    }
  );

  return data.primary_ip;
}

async function assignPrimaryIp(
  dcConfig,
  primaryIpId,
  serverId
) {
  const data = await hetznerRequest(
    dcConfig,
    'POST',
    `/primary_ips/${primaryIpId}/actions/assign`,
    {
      assignee_id: Number(serverId),
      assignee_type: 'server'
    }
  );

  return data.action;
}

async function unassignPrimaryIp(dcConfig, primaryIpId) {
  const data = await hetznerRequest(
    dcConfig,
    'POST',
    `/primary_ips/${primaryIpId}/actions/unassign`,
    {}
  );

  return data.action;
}

async function deletePrimaryIp(dcConfig, primaryIpId) {
  return hetznerRequest(
    dcConfig,
    'DELETE',
    `/primary_ips/${primaryIpId}`
  );
}

async function resetServerPassword(
  dcConfig,
  /*token*/ _t,
  serverId
) {
  const http = client(dcConfig);
  const { data } = await http.post(
    `/servers/${serverId}/actions/reset_password`,
    {}
  );

  const newPassword =
    data?.root_password ||
    data?.action?.root_password ||
    null;

  console.log('[hetzner] reset_password response', {
    server_id: String(serverId),
    action_id: data?.action?.id || null,
    has_root_password: Boolean(newPassword)
  });

  return newPassword;
}

module.exports = {
  getHetznerApiToken,
  hetznerRequest,
  getHetznerFallbackLocations,
  isHetznerPlacementUnavailableError,
  markServerTypeUnavailable,
  isServerTypeTemporarilyUnavailable,
  filterConfiguredServerTypes,
  listHetznerServerTypes,
  normalizeHetznerServerTypes,
  getHetznerSellablePlans,
  getHetznerServer,
  powerOffHetznerServer,
  powerOnHetznerServer,
  changeHetznerServerType,
  waitHetznerAction,
  getToken,
  listFlavors,
  listImages,
  createKeyPair,
  deleteKeyPair,
  createServer,
  listServers,
  getServer,
  deleteServer,
  suspendServer,
  resumeServer,
  startServer,
  rebuildServer,
  createPrimaryIpv4,
  assignPrimaryIp,
  unassignPrimaryIp,
  deletePrimaryIp,
  resetServerPassword,
  createOrGetSshKey,
  deleteSshKey,
};
