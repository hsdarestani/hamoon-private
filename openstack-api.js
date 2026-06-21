// openstack-api.js - Centralized OpenStack API functions for multiple datacenters

const axios = require('axios');
const prices = require('./prices');
const http = require('http');
const https = require('https');

const axiosClient = axios.create({
  timeout: 20000,
  httpAgent: new http.Agent({ keepAlive: true, maxSockets: 50 }),
  httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 50 }),
  // جلوگیری از قطع شدن روی پاسخ‌های بزرگ:
  maxContentLength: Infinity,
  maxBodyLength: Infinity,
});


const noKeepAliveAgent = new http.Agent({ keepAlive: false, maxSockets: 10 });


async function getWithRetry(url, opts, retries = 2) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      // ✅ حتما از axiosClient استفاده کن تا timeout/agent درست اعمال شود
      return await axiosClient.get(url, opts);
    } catch (e) {
      last = e;
      const m = (e.message || '').toLowerCase();
      const retryable =
        m.includes('aborted') ||
        m.includes('timeout') ||
        m.includes('stream has been aborted') ||
        e.code === 'ECONNRESET' ||
        e.code === 'ETIMEDOUT' ||
        e.code === 'EPIPE';

      if (!retryable || i === retries) throw e;
      await new Promise(r => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw last;
}
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;

  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const cur = idx++;
      if (cur >= items.length) break;
      results[cur] = await fn(items[cur], cur);
    }
  });

  await Promise.all(workers);
  return results;
}



async function getToken(config) {
    const body = {
        auth: {
            identity: {
                methods: ['password'],
                password: { user: { name: config.OS_USERNAME, domain: { name: config.OS_USER_DOMAIN_NAME }, password: config.OS_PASSWORD } }
            },
            scope: {
                project: { id: config.OS_PROJECT_ID, domain: { id: config.OS_PROJECT_DOMAIN_ID } }
            }
        }
    };
    try {
        const r = await axios.post(`${config.OS_AUTH_URL}/v3/auth/tokens`, body, { headers: { 'Content-Type': 'application/json' } });
        return r.headers['x-subject-token'];
    } catch (error) {
        console.error(`Error fetching OpenStack token for ${config.name}:`, error.message);
        if (error.response && error.response.data) console.error('OpenStack API Error Details (Token):', JSON.stringify(error.response.data, null, 2));
        throw error;
    }
}

const computeUrl = (config) => `${config.OS_AUTH_URL.replace(/:5000$|:50000$/, ':8774')}/v2.1`;

// --- Create Snapshot (Volume-aware + Logging) ---
async function createSnapshot(config, tok, serverId, snapshotName, ownerUserId) {
  const baseUrl = `${config.OS_AUTH_URL.replace(/:5000$|:50000$/, ':8774')}`;
  const computeBase = `${baseUrl}/v2.1`;
  const url = `${computeBase}/servers/${serverId}/action`;

  // ✅ مالک تلگرام را در متادیتا ثبت می‌کنیم
  const body = {
    createImage: {
      name: snapshotName,
      metadata: {
        type: "snapshot",
        owner_telegram_id: String(ownerUserId)
      }
    }
  };

  try {
    const res = await axios.post(url, body, {
      headers: { 'X-Auth-Token': tok, 'Content-Type': 'application/json' }
    });

    console.log(`✅ [${config.name}] Snapshot '${snapshotName}' requested (server: ${serverId})`);
    console.log('Response status:', res.status, res.statusText);

    // (اختیاری) چند ثانیه صبر کن و وجودش در Glance را چک کن
    await new Promise(r => setTimeout(r, 5000));
    try {
      const snaps = await listSnapshots(config, tok, ownerUserId);
      const found = snaps.find(s => s.name === snapshotName);
      if (found) {
        console.log(`📸 Snapshot '${snapshotName}' visible in Glance (${found.status})`);
      } else {
        console.warn(`⚠️ Snapshot '${snapshotName}' not yet visible in Glance`);
      }
    } catch (err) {
      console.warn('⚠️ Could not verify snapshot visibility:', err.message);
    }

    return true;
  } catch (error) {
    console.error(`❌ [${config.name}] Error creating snapshot for server ${serverId}:`, error.message);
    if (error.response) {
      console.error('🧾 Response:', JSON.stringify(error.response.data, null, 2));
      console.error('📋 Status:', error.response.status);
    }
    return false;
  }
}



async function listFlavors(config) {
    if (!config.flavors || config.flavors.length === 0) throw new Error(`No flavors defined for datacenter ${config.name}`);
    return config.flavors.map(f => {
        const cpu = parseInt(f.name.match(/(\d+)\s*Core/i)?.[1] || '0');
        const ram = parseInt(f.name.match(/(\d+)\s*GB\s*RAM/i)?.[1] || '0');
        const disk = parseInt(f.name.match(/(\d+)\s*GB\s*SSD/i)?.[1] || '0');
        const hourlyPrice = f.monthly_price * (prices.hourlyFactorFromMonthly || (1 / 720));
        return { id: f.id, label: `${cpu} Core, ${ram}GB RAM, ${disk}GB SSD`, price: Math.round(hourlyPrice), disk: disk };
    });
}

async function listImages(config, tok) {
    if (!config.images || config.images.length === 0) throw new Error(`No images defined for datacenter ${config.name}`);
    return config.images.map(img => ({ id: img.id, label: img.name }));
}

async function createKeyPair(config, tok, keyName) {
    const body = { keypair: { name: keyName } };
    try {
        const r = await axios.post(`${computeUrl(config)}/os-keypairs`, body, { headers: { 'X-Auth-Token': tok, 'Content-Type': 'application/json' } });
        return r.data.keypair;
    } catch (error) {
        console.error(`Error creating key pair for ${config.name}:`, error.message);
        if (error.response && error.response.data) {
            console.error('OpenStack API Error Details (KeyPair):', JSON.stringify(error.response.data, null, 2));
        }
        throw error;
    }
}

async function deleteKeyPair(config, tok, keyName) {
    await axios.delete(`${computeUrl(config)}/os-keypairs/${keyName}`, { headers: { 'X-Auth-Token': tok } });
}



async function createServer(config, tok, name, flavorRef, imageRef, keyName, meta, diskSize, bootMethod, isSnapshot = false) {
  try {
    const networkId = config.OS_NETWORK_ID;
    const serverDetails = {
      name,
      flavorRef,
      networks: [{ uuid: networkId }],
      metadata: meta,
      key_name: keyName || null,
    };

    if (isSnapshot) {
      // ✅ اسنپ‌شات Glance مثل image است
      serverDetails.block_device_mapping_v2 = [{
        boot_index: 0,
        uuid: imageRef,
        source_type: 'image',          // ← قبلاً snapshot بود؛ اصلاح شد
        destination_type: 'volume',
        volume_size: diskSize || 20,
        delete_on_termination: true
      }];
    } else if (bootMethod === 'volume') {
      serverDetails.block_device_mapping_v2 = [{
        boot_index: 0,
        uuid: imageRef,
        source_type: 'image',
        destination_type: 'volume',
        volume_size: diskSize || 20,
        delete_on_termination: true
      }];
    } else {
      serverDetails.imageRef = imageRef;
    }

    console.log("🟡 [DEBUG] Final server body:", JSON.stringify({ server: serverDetails }, null, 2));

    const r = await axios.post(`${computeUrl(config)}/servers`, { server: serverDetails }, {
      headers: { 'X-Auth-Token': tok, 'Content-Type': 'application/json' }
    });

    return r.data.server;
  } catch (error) {
    console.error("❌ Error in createServer:", error.response?.data || error.message);
    throw error;
  }
}






async function rebuildServer(config, tok, serverId, imageRef) {
    const body = {
        rebuild: {
            imageRef: imageRef
        }
    };
    try {
        await axios.post(`${computeUrl(config)}/servers/${serverId}/action`, body, {
            headers: { 'X-Auth-Token': tok, 'Content-Type': 'application/json' }
        });
        return true;
    } catch (error) {
        console.error(`Error rebuilding server ${serverId} in ${config.name}:`, error.message);
        if (error.response && error.response.data) {
            console.error('OpenStack API Error Details (Rebuild):', JSON.stringify(error.response.data, null, 2));
        }
        throw error;
    }
}

// --- NEW FUNCTION ---
async function resetServerPassword(config, tok, serverId, newPassword) {
    const body = {
        changePassword: {
            adminPass: newPassword
        }
    };
    try {
        await axios.post(`${computeUrl(config)}/servers/${serverId}/action`, body, {
            headers: { 'X-Auth-Token': tok, 'Content-Type': 'application/json' }
        });
        return true;
    } catch (error) {
        console.error(`Error resetting password for server ${serverId} in ${config.name}:`, error.message);
        if (error.response && error.response.data) {
            console.error('OpenStack API Error Details (ResetPassword):', JSON.stringify(error.response.data, null, 2));
        }
        throw error;
    }
}

async function getServer(config, tok, id) {
    const r = await axios.get(`${computeUrl(config)}/servers/${id}`, { headers: { 'X-Auth-Token': tok } });
    return r.data.server;
}

async function deleteServer(config, tok, id) {
    await axios.delete(`${computeUrl(config)}/servers/${id}`, { headers: { 'X-Auth-Token': tok } });
}


async function listServers(config, tok) {
  const base = `${computeUrl(config)}/servers`;
  const limit = 20;
  const maxPages = 50;

  let marker = null;
  let all = [];

  // 1) لیست سبک (فقط id,name,links) با pagination
  for (let page = 0; page < maxPages; page++) {
    const url = marker
      ? `${base}?limit=${limit}&marker=${marker}`
      : `${base}?limit=${limit}`;

    console.log(`[LIST-PAGE][${config.key}] page=${page + 1} url=${url}`);

    const r = await getWithRetry(url, {
      headers: { 'X-Auth-Token': tok, 'Accept': 'application/json' },
      timeout: 30000,
      httpAgent: noKeepAliveAgent,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      // ✅ برای جلوگیری از خطای stream aborted روی پاسخ‌های chunked
      decompress: true,
      transitional: { clarifyTimeoutError: true },
    }, 2);

    const batch = r.data?.servers || [];
    all = all.concat(batch);

    if (batch.length < limit) break;
    marker = batch[batch.length - 1].id;
  }

  console.log(`[LIST-PAGE][${config.key}] baseList=${all.length}`);

  // 2) گرفتن جزئیات هر سرور با concurrency کم
  const concurrency = 3;

  const detailed = await mapLimit(all, concurrency, async (s) => {
    const detailUrl = `${computeUrl(config)}/servers/${s.id}`;

    try {
      const d = await getWithRetry(detailUrl, {
        headers: { 'X-Auth-Token': tok, 'Accept': 'application/json' },
        timeout: 20000,
        httpAgent: noKeepAliveAgent,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        decompress: true,
        transitional: { clarifyTimeoutError: true },
      }, 1);

      return d.data?.server || s;
    } catch (e) {
      console.log(`[LIST-DETAIL][${config.key}] fail id=${s.id} code=${e.code || ''} msg=${e.message || ''}`);
      return s;
    } finally {
      // ✅ کمی فاصله بده تا API فشار نخورد
      await sleep(30);
    }
  });

  console.log(`[LIST-PAGE][${config.key}] detailed=${detailed.length}`);
  return detailed;
}


async function suspendServer(config, tok, serverId) {
    await axios.post(`${computeUrl(config)}/servers/${serverId}/action`, { suspend: null }, { headers: { 'X-Auth-Token': tok, 'Content-Type': 'application/json' } });
}

async function resumeServer(config, tok, serverId) {
    await axios.post(`${computeUrl(config)}/servers/${serverId}/action`, { resume: null }, { headers: { 'X-Auth-Token': tok, 'Content-Type': 'application/json' } });
}


async function listSnapshots(config, tok, userId = null) {
  try {
    const glanceBase = config.OS_AUTH_URL.replace(/:5000$/, ':9292');
    const url = `${glanceBase}/v2/images?visibility=private`;

    console.log(`🟡 [DEBUG] Fetching snapshots from Glance for ${config.name} → ${url}`);
    const r = await axios.get(url, { headers: { 'X-Auth-Token': tok } });
    const all = r.data.images || [];

    // فقط مواردی که snapshot هستن
    let snapshots = all.filter(img =>
      (img.name && img.name.startsWith('snap-')) ||
      (img.image_type === 'snapshot') ||
      (img.name && img.name.includes('snap'))
    );

    // اگر userId داریم، بر اساس متادیتا فیلتر کنیم
    if (userId) {
      snapshots = snapshots.filter(s =>
        s.properties?.owner_telegram_id === String(userId) ||
        s.name?.includes(`snap-${userId}-`)
      );
    }

    const mapped = snapshots.map(s => ({
      id: s.id,
      name: s.name,
      label: `📸 Snapshot: ${s.name || s.id}`,
      status: s.status,
      created_at: s.created_at,
      size: s.size,
      visibility: s.visibility,
      owner: s.properties?.owner_telegram_id || 'unknown'
    }));

    console.log(`🟢 [DEBUG] Filtered ${mapped.length} snapshots for user ${userId} in ${config.name}`);
    mapped.forEach(s => console.log(`   → ${s.label} (${s.id}) [owner=${s.owner}]`));

    return mapped;
  } catch (error) {
    console.error(`❌ Error listing snapshots in ${config.name}:`, error.message);
    if (error.response && error.response.data) {
      console.error('OpenStack API Error Details (listSnapshots):', JSON.stringify(error.response.data, null, 2));
    }
    return [];
  }
}




// --- Create Server from Snapshot (Glance-aware) ---
async function createServerFromSnapshot(config, tok, name, flavorId, snapshotId, networkId) {
  const baseUrl = config.OS_AUTH_URL.replace(/:5000$|:50000$/, ':8774');
  const computeUrl = `${baseUrl}/v2.1/servers`;

  // در این سیستم، snapshotها در Glance ذخیره میشن (image service)
  // پس باید source_type رو "image" قرار بدیم، نه "snapshot"
  const body = {
    server: {
      name,
      flavorRef: flavorId,
      block_device_mapping_v2: [
        {
          source_type: "image",
          destination_type: "volume",
          uuid: snapshotId,              // ← همون ID که از Glance اومده
          boot_index: 0,
          delete_on_termination: true
        }
      ],
      networks: networkId ? [{ uuid: networkId }] : []
    }
  };

  try {
    const res = await axios.post(computeUrl, body, {
      headers: { 'X-Auth-Token': tok, 'Content-Type': 'application/json' }
    });

    console.log(`🚀 [${config.name}] Server creation from snapshot (Glance image) started (${res.data.server.id})`);
    return res.data.server;
  } catch (error) {
    console.error(`❌ Error creating server from snapshot in ${config.name}:`, error.message);
    if (error.response) {
      console.error("🧾 Response:", JSON.stringify(error.response.data, null, 2));
      console.error("📋 Status:", error.response.status);
    }
    throw new Error(error.response?.data?.badRequest?.message || error.message);
  }
}



// 📦 دریافت جزئیات سرور (نسخه دقیق با پشتیبانی از همه پورت‌ها)
async function getServerDetails(dcConfig, token, serverId) {
  const axios = require("axios");

  // تعیین پورت Compute بر اساس دیتاسنتر
  let port = 8774; // پیش‌فرض
  if (dcConfig.key === "respina") port = 50001;
  if (dcConfig.key === "tebyan") port = 8774;
  if (dcConfig.key === "tabriz") port = 8774;
  if (dcConfig.key === "tehran") port = 8774;

  // ساخت URL معتبر
  const baseUrl = dcConfig.OS_AUTH_URL.replace(/:\d+/, `:${port}`);
  const endpoint = `${baseUrl}/v2.1/${dcConfig.OS_PROJECT_ID}/servers/${serverId}`;

  try {
    const res = await axios.get(endpoint, {
      headers: {
        "X-Auth-Token": token,
        "Content-Type": "application/json",
      },
    });
    return res.data.server;
  } catch (err) {
    console.error(
      `[OpenStack] Failed to get details for server ${serverId}:`,
      err.response?.data || err.message
    );
    throw err;
  }
}

module.exports = {
    getToken, listFlavors, listImages, createKeyPair, deleteKeyPair,
    createServer, rebuildServer, getServer, deleteServer, listServers,
    suspendServer, resumeServer, resetServerPassword,createSnapshot,listSnapshots,createServerFromSnapshot ,getServerDetails
};

