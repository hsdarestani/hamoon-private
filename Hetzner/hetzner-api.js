const path = require('path');
require('dotenv').config({
  path: path.join(__dirname, '..', '.env')
});
const axios  = require('axios');

const BASE = 'https://api.hetzner.cloud/v1';

function client(tokenOrCfg) {
  const token = typeof tokenOrCfg === 'string'
    ? tokenOrCfg
    : (tokenOrCfg?.token || process.env.HETZNER_API_TOKEN);
  return axios.create({
    baseURL: BASE,
    timeout: 15000,
    headers: { Authorization: `Bearer ${token}`},
  });
}

// همگام با امضای openstack-api (برای سازگاری با کد شما):
async function getToken() { return null; } // لازم نیست

async function listFlavors(dcConfig) {
  // ما قبلاً از datacenters.js → dcConfig.flavors استفاده می‌کنیم
  return dcConfig.flavors || [];
}



async function listImages(dcConfig) {
  try {
    const token = dcConfig?.token || process.env.HETZNER_API_TOKEN;
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
  const token = dcConfig?.token || process.env.HETZNER_API_TOKEN;
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

  const token = dcConfig?.token || process.env.HETZNER_API_TOKEN;
  if (!token) throw new Error('[hetzner] createServer: missing token');
  if (!serverType) throw new Error('[hetzner] createServer: serverType is required (e.g. "cx22")');
  if (!image)      throw new Error('[hetzner] createServer: image is required (e.g. "ubuntu-22.04" or numeric ID)');
  const loc = location || dcConfig?.HETZNER_LOCATION || 'nbg1';
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


try {
  const r = await c.post('/servers', payload);
  return r.data.server;
} catch (e) {
  console.error('🚨 [Hetzner createServer error]', e.response?.status, e.response?.data || e.message);
  throw e;
}


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
  await http.post(`/servers/${serverId}/actions/rebuild`, { image: imageId });
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

  if (process.env.DEBUG_PASSWORDS === '1') {
    console.log('[hetzner] root_password =', newPass);
  }

  return newPass;
}


module.exports = {
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
  rebuildServer,
  resetServerPassword,
  createOrGetSshKey,
  deleteSshKey,
};
