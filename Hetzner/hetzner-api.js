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
const serverTypeCache = new Map();

function roundPrice(value) {
  const roundTo = Math.max(1, Number(process.env.HETZNER_PRICE_ROUND_TO || 1000));
  return Math.max(roundTo, Math.ceil(Number(value || 0) / roundTo) * roundTo);
}

function normalizeLocation(value) {
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

function hasConfiguredLocationPrice(serverType, config = {}) {
  const locations = configuredPriceLocations(config);
  if (!locations.length) return true;
  const prices = Array.isArray(serverType?.prices) ? serverType.prices : [];
  return prices.some(p =>
    (p?.price_hourly || p?.price_monthly) &&
    locations.includes(normalizeLocation(p?.location))
  );
}

function hasConfiguredLocationAvailability(serverType, config = {}) {
  const wantedLocations = configuredPriceLocations(config);
  if (!wantedLocations.length) return true;

  const perLocation = Array.isArray(serverType?.locations) ? serverType.locations : [];
  if (!perLocation.length) {
    // Backward compatibility for API responses without per-location metadata.
    return hasConfiguredLocationPrice(serverType, config);
  }

  return wantedLocations.some(location => {
    const entry = perLocation.find(item =>
      normalizeLocation(item?.name || item?.location) === location
    );
    if (!entry || entry.available === false) return false;

    const unavailableAfter = Date.parse(entry?.deprecation?.unavailable_after || '');
    if (Number.isFinite(unavailableAfter) && unavailableAfter <= Date.now()) return false;
    return true;
  });
}

function firstPrice(serverType, config = {}) {
  const prices = Array.isArray(serverType?.prices) ? serverType.prices : [];
  const usable = prices.filter(p => p?.price_hourly || p?.price_monthly);
  const locations = configuredPriceLocations(config);
  for (const location of locations) {
    const match = usable.find(p => normalizeLocation(p?.location) === location);
    if (match) return match;
  }
  // A location-scoped catalog must never borrow the price of a different region.
  if (locations.length) return {};
  return usable[0] || prices[0] || {};
}

function hetznerPlanCacheKey(config = {}) {
  return [
    String(config.key || config.name || 'hetzner').trim().toLowerCase(),
    ...configuredPriceLocations(config),
  ].join('|');
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
  return (serverTypes || [])
    .filter(st => st && st.name && !st.deprecated && (st.deprecation == null) && hasConfiguredLocationAvailability(st, config) && hasConfiguredLocationPrice(st, config))
    .map(st => {
      const price = firstPrice(st, config);
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
        price: hourlyToman, monthly_toman: monthlyToman, available: true
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
  const cacheKey = hetznerPlanCacheKey(config);
  const cached = serverTypeCache.get(cacheKey);
  if (cached?.plans && cached.expires > now) return cached.plans;

  const locationScoped = configuredPriceLocations(config).length > 0;
  try {
    const plans = normalizeHetznerServerTypes(await listHetznerServerTypes(config), config);
    if (plans.length) {
      serverTypeCache.set(cacheKey, { plans, expires: now + SERVER_TYPE_CACHE_MS });
      return plans;
    }
    if (locationScoped) {
      serverTypeCache.set(cacheKey, { plans: [], expires: now + Math.min(SERVER_TYPE_CACHE_MS, 60 * 1000) });
      return [];
    }
  } catch (e) {
    if (locationScoped) {
      const err = new Error('HETZNER_LOCATION_CATALOG_UNAVAILABLE');
      err.code = 'HETZNER_LOCATION_CATALOG_UNAVAILABLE';
      err.cause = e;
      console.warn('[hetzner] location catalog unavailable; refusing unsafe static fallback:', e.message);
      throw err;
    }
    console.warn('[hetzner] using static plan fallback:', e.message);
  }
  const fallback = normalizeStaticHetznerPlans(config);
  if (fallback.length) return fallback;
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



async function listImages(dcConfig) {
  try {
    const token = dcConfig?.token || dcConfig?.HETZNER_API_TOKEN || dcConfig?.HETZNER_TOKEN || process.env.HETZNER_API_TOKEN || process.env.HETZNER_TOKEN || process.env.HCLOUD_TOKEN;
    if (!token) {
      console.warn('[hetzner] listImages: Missing token');
      return (dcConfig.images || []).map(i => ({ id: String(i.id), label: i.label, name: i.id }));
    }

    const http = client(token);

    // فقط ایمیج‌های سیستم، آماده استفاده، و x86 (اگر ARM نمی‌خوای)
    const { data } = await http.get('/images', {
      params: {
        type: 'system',
        status: 'available',
        architecture: 'x86',     // اگر ARM لازم داری، این خط را بردار یا مقدارش را 'arm' کن
        per_page: 200
      }
    });

    const imgs = Array.isArray(data.images) ? data.images : [];

    // گروه‌بندی بر اساس name (برای هر نام، جدیدترینِ غیرdeprecated را نگه داریم)
    const byName = new Map();
    for (const img of imgs) {
      const key = (img.name || String(img.id)).toLowerCase().trim();
      const old = byName.get(key);

      // اولویت: غیر deprecated > قدیمی
      const isBetter =
        !old ||
        // اگر قدیمی deprecated بوده و این یکی نیست
        (!!old.deprecated && !img.deprecated) ||
        // یا تاریخ ساخت جدیدتر
        (new Date(img.created) > new Date(old.created));

      if (isBetter) byName.set(key, img);
    }

    // تبدیل به فرم عمومی پروژه (id/label/name) و sort بر اساس label
    const mapped = [...byName.values()].map(img => ({
      id: String(img.id),
      label: img.description || img.name || String(img.id),
      name: img.name || String(img.id),
    }));

    // ایمیج‌های ثابت config هم اضافه (مثلاً اگر چیز سفارشی داشتی)
    const fixed = (dcConfig.images || []).map(i => ({
      id: String(i.id ?? i.name ?? i.label ?? i),
      label: i.label || i.name || String(i.id ?? i),
      name: i.name || String(i.id ?? i),
    }));

    // ادغام یکتا بر پایه id (یا name اگر ترجیح میدی)
    const uniq = {};
    [...fixed, ...mapped].forEach(x => { uniq[x.name || x.id] = x; });

    const out = Object.values(uniq).sort((a, b) => a.label.localeCompare(b.label));
    if (!out.length) console.warn('[hetzner] listImages: Result is empty after dedup.');
    return out;

  } catch (e) {
    console.error('[hetzner] listImages error:', e.response?.status, e.response?.data || e.message);
    return (dcConfig.images || []).map(i => ({
      id: String(i.id ?? i.name ?? i.label ?? i),
      label: i.label || i.name || String(i.id ?? i),
      name: i.name || String(i.id ?? i),
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

function isHetznerPlacementUnavailableError(err) {
  const responseStatus = err?.response?.status || err?.status || err?.statusCode;
  const message = String(err?.response?.data?.error?.message || err?.message || '');
  const code = String(err?.response?.data?.error?.code || err?.code || '');
  const dataText = (() => { try { return JSON.stringify(err?.response?.data || {}); } catch { return ''; } })();
  const status = Number(responseStatus) || (/HTTP\s+412/i.test(message) ? 412 : 0) || (/status code\s+412/i.test(message) ? 412 : 0);
  return Number(status) === 412 && (
    code.includes('resource_unavailable') ||
    message.toLowerCase().includes('placement') ||
    message.toLowerCase().includes('resource_unavailable') ||
    dataText.toLowerCase().includes('placement') ||
    dataText.toLowerCase().includes('resource_unavailable') ||
    message.includes('HTTP 412')
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
    key_id,     // از index.js می‌آد (خروجی createKeyPair)
    userLabel,
user_data     
  } = opts || {};

  const token = dcConfig?.token || dcConfig?.HETZNER_API_TOKEN || dcConfig?.HETZNER_TOKEN || process.env.HETZNER_API_TOKEN || process.env.HETZNER_TOKEN || process.env.HCLOUD_TOKEN;
  if (!token) throw new Error('[hetzner] createServer: missing token');
  if (!serverType) throw new Error('[hetzner] createServer: serverType is required (e.g. "cx22")');
  if (!image)      throw new Error('[hetzner] createServer: image is required (e.g. "ubuntu-22.04" or numeric ID)');
  const loc = location || dcConfig?.HETZNER_LOCATION || process.env.HETZNER_LOCATION || 'nbg1';
  const c = client(token);


  const passwordOnly = !!(dcConfig?.HETZNER_PASSWORD_ONLY);

  // اگر key_id داری و passwordOnly نیست، کلید را بفرست
  let sshKeys = undefined;
  if (!passwordOnly && key_id) {
    sshKeys = [ Number(key_id) ];
  }
  // اگر passwordOnly=true باشد، ssh_keys عمداً خالی می‌ماند تا لاگین پسوردی کار کند

  const payload = {
    name: (name || `srv-${Date.now()}`).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 63),
    server_type: serverType,
    image,
    location: loc,
    ssh_keys: sshKeys,               // ممکن است undefined باشد → حذف می‌شود
    user_data: user_data || undefined, // ✅ cloud-init (اختیاری)
    labels: userLabel ? { user: String(userLabel) } : undefined,
  };


let lastPlacementError = null;
for (const locCandidate of getHetznerFallbackLocations(dcConfig, loc)) {
  const attemptPayload = { ...payload, location: locCandidate };
  console.log('[HETZNER_CREATE_ATTEMPT]', { location: locCandidate, server_type: serverType, image });
  try {
    const r = await c.post('/servers', attemptPayload);
    const data = r.data || {};
    const server = data.server || {};
    server.action = data.action || null;
    server.root_password = data.root_password || null;
    return server;
  } catch (e) {
    console.error('🚨 [Hetzner createServer error]', e.response?.status, e.response?.data || e.message);
    if (!isHetznerPlacementUnavailableError(e)) throw e;
    lastPlacementError = e;
  }
}
const placementError = new Error('ظرفیت این پلن در لوکیشن انتخاب‌شده موقتاً در دسترس نیست. لطفاً پلن دیگری انتخاب کنید یا بعداً دوباره تلاش کنید.');
placementError.code = 'HETZNER_PLACEMENT_UNAVAILABLE';
placementError.cause = lastPlacementError;
throw placementError;


  // نکته: اگر ssh_keys خالی باشد و ایمیج اجازه بده، Hetzner root_password تولید می‌کند
//  const r = await c.post('/servers', payload);
  //return r.data.server;
}


async function listServers(dcConfig /*, token */) {
  const http = client(dcConfig);
  const { data } = await http.get('/servers');
  return (data.servers || []).map(s => ({
    id: String(s.id),
    name: s.name,
    status: s.status,
    server_type: s.server_type?.name || s.server_type?.id || null,
    image: { name: s.image?.name || String(s.image?.id || '') },
    metadata: {
      user: s.labels?.user,
      type: s.labels?.type,
    },
    addresses: s.public_net?.ipv4?.ip ? { public: [{ version: 4, addr: s.public_net.ipv4.ip }] } : {},
  }));
}

async function getServer(dcConfig, /*token*/ _t, serverId) {
  const http = client(dcConfig);
  const { data } = await http.get(`/servers/${serverId}`);
  const s = data.server;
  return {
    id: String(s.id),
    name: s.name,
    status: s.status,
    server_type: s.server_type?.name || s.server_type?.id || null,
    image: { name: s.image?.name || String(s.image?.id || '') },
    metadata: {
      user: s.labels?.user,
      type: s.labels?.type,
    },
    addresses: s.public_net?.ipv4?.ip ? { public: [{ version: 4, addr: s.public_net.ipv4.ip }] } : {},
  };
}

async function deleteServer(dcConfig, /*token*/ _t, serverId) {
  const http = client(dcConfig);
  await http.delete(`/servers/${serverId}`);
}

async function suspendServer(dcConfig, /*token*/ _t, serverId) {
  const http = client(dcConfig);
  await http.post(`/servers/${serverId}/actions/poweroff`);
}

async function resumeServer(dcConfig, /*token*/ _t, serverId) {
  const http = client(dcConfig);
  await http.post(`/servers/${serverId}/actions/poweron`);
}

async function rebuildServer(dcConfig, /*token*/ _t, serverId, imageId) {
  const http = client(dcConfig);
  const { data } = await http.post(`/servers/${serverId}/actions/rebuild`, { image: imageId });
  return {
    action: data?.action || null,
    root_password: data?.root_password || null,
  };
}

async function startServer(dcConfig, token, serverId) {
  return resumeServer(dcConfig, token, serverId);
}

async function createPrimaryIpv4(dcConfig, location) {
  const data = await hetznerRequest(dcConfig, 'POST', '/primary_ips', { type: 'ipv4', datacenter: location, assignee_type: 'server', auto_delete: false });
  return data.primary_ip;
}
async function assignPrimaryIp(dcConfig, primaryIpId, serverId) {
  const data = await hetznerRequest(dcConfig, 'POST', `/primary_ips/${primaryIpId}/actions/assign`, { assignee_id: Number(serverId), assignee_type: 'server' });
  return data.action;
}
async function unassignPrimaryIp(dcConfig, primaryIpId) {
  const data = await hetznerRequest(dcConfig, 'POST', `/primary_ips/${primaryIpId}/actions/unassign`, {});
  return data.action;
}
async function deletePrimaryIp(dcConfig, primaryIpId) {
  return hetznerRequest(dcConfig, 'DELETE', `/primary_ips/${primaryIpId}`);
}

async function resetServerPassword(dcConfig, /*token*/ _t, serverId) {
  const http = client(dcConfig);
  console.log('[hetzner] reset_password call for server', serverId);
  const { data } = await http.post(`/servers/${serverId}/actions/reset_password`);

  // ✅ در Hetzner، root_password در level اصلی response است (نه داخل action)
  const newPass = data?.root_password || data?.action?.root_password || null;

  console.log('[hetzner] reset_password response:', {
    keys: Object.keys(data || {}),
    actionKeys: Object.keys(data?.action || {}),
    hasRootPassword: !!newPass
  });


  return newPass;
}


module.exports = {
  getHetznerApiToken,
  hetznerRequest,
  getHetznerFallbackLocations,
  isHetznerPlacementUnavailableError,
  listHetznerServerTypes,
  normalizeHetznerServerTypes,
  firstPrice,
  hetznerPlanCacheKey,
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
