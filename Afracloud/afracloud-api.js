
const axios = require('axios');
const { buildRootPasswordCloudInit } = require('../services/cloud-init');
const { AFRA_CLOUD_PLANS, MONTHLY_HOURS } = require('./afracloud-prices');

function client(config) {
  return axios.create({
    baseURL: config.API_BASE_URL || 'https://panel.afracloud.net',
    timeout: 30000,
    headers: {
      apikey: config.API_KEY,
      secretkey: config.SECRET_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });
}

async function getToken(config) {
  if (!config.API_KEY || !config.SECRET_KEY) {
    throw new Error('AFRACLOUD_API_KEY / AFRACLOUD_SECRET_KEY is missing');
  }
  return 'afracloud-header-auth';
}

function normalizePlanName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '');
}

function toMemoryGb(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 256 ? n / 1024 : n;
}

function flavorCpu(f) {
  return Number(f.numberOfCores || f.cpu || f.cores || 0);
}

function flavorMemoryGb(f) {
  return toMemoryGb(f.memory || f.memoryGb || f.ram || 0);
}

async function listFlavors(config) {
  const r = await client(config).get('/restapi/compute/computeOfferingList', {
    params: { zoneUuid: config.ZONE_UUID },
  });

  const apiFlavors = r.data.listComputeOfferingResponse || [];
  const allowlist = config.allowedFlavorNames || config.afraAllowedFlavorNames;
  const allowedNames = Array.isArray(allowlist) && allowlist.length
    ? new Set(allowlist.map(normalizePlanName))
    : null;
  const planByName = new Map(AFRA_CLOUD_PLANS.map(plan => [normalizePlanName(plan.name), plan]));
  const usedPlanNames = new Set();
  const results = [];

  for (const f of apiFlavors) {
    const normalizedName = normalizePlanName(f.name || f.displayText);
    let plan = planByName.get(normalizedName);

    if (!plan) {
      const cpu = flavorCpu(f);
      const memoryGb = flavorMemoryGb(f);
      plan = AFRA_CLOUD_PLANS.find(p => p.cpu === cpu && Math.abs(p.memoryGb - memoryGb) < 0.01);
    }

    if (!plan) continue;
    const planName = normalizePlanName(plan.name);
    if (usedPlanNames.has(planName)) continue;
    if (allowedNames && !allowedNames.has(planName)) continue;

    usedPlanNames.add(planName);
    results.push({
      id: f.uuid,
      name: plan.name,
      label: `${plan.name} — ${plan.cpu} CPU / ${plan.memoryGb}GB RAM`,
      price: plan.monthlyPrice / MONTHLY_HOURS,
      monthly_price: plan.monthlyPrice,
      monthlyPrice: plan.monthlyPrice,
      pricesByCycle: { monthly: plan.monthlyPrice },
      disk: 0,
      cores: plan.cpu,
      memory: plan.memoryGb,
      raw: f,
    });
  }

  return results;
}



async function listImages(config) {
  if (config.images && config.images.length > 0) {
    return config.images.map(img => ({
      id: img.id,
      name: img.name,
      label: img.name,
    }));
  }

  const r = await client(config).get('/restapi/template/templateList', {
    params: { zoneUuid: config.ZONE_UUID },
  });

  return (r.data.listTemplateResponse || [])
    .filter(img => img.format === 'OVA')
    .filter(img => {
      const n = String(img.name || '').toLowerCase();
      return (
        n.includes('ubuntu 24') ||
        n.includes('ubuntu 22') ||
        n.includes('debian gnu/linux-12') ||
        n.includes('debian 11')
      );
    })
    .map(img => ({
      id: img.uuid,
      name: img.name,
      label: img.name,
    }));
}

async function listServers(config) {
  const r = await client(config).get('/restapi/instance/instanceList', {
    params: { zoneUuid: config.ZONE_UUID },
  });

  return (r.data.listInstanceResponse || []).map(vm => ({
    id: vm.uuid,
    uuid: vm.uuid,
    name: vm.name || vm.displayName,
    status: vm.status || vm.state,
    state: vm.state,
    addresses: vm.instancePrivateIp ? { private: [{ addr: vm.instancePrivateIp }] } : {},
    flavor: { id: vm.computeOfferingUuid },
    image: { id: vm.templateUuid },
    metadata: {},
    raw: vm,
  }));
}

async function getServer(config, _tok, id) {
  const r = await client(config).get('/restapi/instance/instanceList', {
    params: {
      zoneUuid: config.ZONE_UUID,
      vmUuid: id,
    },
  });

  const vm = (r.data.listInstanceResponse || [])[0];
  if (!vm) throw new Error('AfraCloud instance not found');

  return {
    id: vm.uuid,
    uuid: vm.uuid,
    name: vm.name || vm.displayName,
    status: vm.status || vm.state,
    state: vm.state,
    addresses: vm.instancePrivateIp ? { private: [{ addr: vm.instancePrivateIp }] } : {},
    flavor: { id: vm.computeOfferingUuid },
    image: { id: vm.templateUuid },
    metadata: {},
    raw: vm,
  };
}

async function getServerDetails(config, tok, id) {
  return getServer(config, tok, id);
}

async function createServer(config, _tok, name, flavorRef, imageRef, keyName, meta, diskSize) {
  const body = {
    name,
    zoneUuid: config.ZONE_UUID,
    networkUuid: config.NETWORK_UUID,
    computeOfferingUuid: flavorRef,
    templateUuid: imageRef,
  };

  const rootPassword = meta?.rootPassword || meta?.afraRootPassword || null;
  if (rootPassword && config.SET_ROOT_PASSWORD_WITH_CLOUD_INIT !== false) {
    const cloudInit = buildRootPasswordCloudInit(rootPassword);
    const payloadUserData = String(config.USERDATA_ENCODING || 'plain').toLowerCase() === 'base64'
      ? Buffer.from(cloudInit, 'utf8').toString('base64')
      : cloudInit;
    body[config.USERDATA_FIELD || 'userData'] = payloadUserData;
  }
  if (rootPassword && config.PASSWORD_FIELD) body[config.PASSWORD_FIELD] = rootPassword;

  if (keyName) body.sshKeyName = keyName;
  if (diskSize) body.rootDiskSize = Number(diskSize);
  if (config.STORAGE_OFFERING_UUID) body.storageOfferingUuid = config.STORAGE_OFFERING_UUID;

  const r = await client(config).post('/restapi/instance/createInstance', body);
  const vm = (r.data.listInstanceResponse || [])[0];

  if (!vm) throw new Error('AfraCloud createInstance returned empty response');

  return {
    id: vm.uuid,
    uuid: vm.uuid,
    name: vm.name || name,
    status: vm.status || vm.state,
    raw: vm,
  };
}

async function deleteServer(config, _tok, id) {
  await client(config).get('/restapi/instance/destroyInstance', {
    params: {
      uuid: id,
      expunge: true,
    },
  });
  return true;
}

async function suspendServer(config, _tok, id) {
  await client(config).get('/restapi/instance/stopInstance', {
    params: {
      uuid: id,
      forceStop: true,
    },
  });
  return true;
}

async function resumeServer(config, _tok, id) {
  await client(config).get('/restapi/instance/startInstance', {
    params: { uuid: id },
  });
  return true;
}

async function createKeyPair(config, _tok, keyName, publicKey) {
  const body = { name: keyName };
  if (publicKey) body.publicKey = publicKey;

  const r = await client(config).post('/restapi/sshkey/createSSHkey', body);
  const key = (r.data.listSSHKeyResponse || [])[0];

  return {
    id: key?.uuid || keyName,
    name: key?.name || keyName,
  };
}

async function deleteKeyPair(config, _tok, keyNameOrUuid) {
  await client(config).delete(`/restapi/sshkey/deleteSSHkey/${keyNameOrUuid}`);
  return true;
}


async function resetServerPassword(config, _tok, serverId) {
  const r = await client(config).get('/restapi/instance/instancePasswordList', {
    params: { uuid: serverId },
  });

  const item = (r.data.listInstancePasswordResponse || [])[0];
  return item?.password || null;
}

async function rebuildServer() {
  throw new Error('AfraCloud rebuild is not supported');
}

async function createSnapshot() {
  throw new Error('AfraCloud snapshot is not supported');
}

async function listSnapshots() {
  return [];
}

async function createServerFromSnapshot() {
  throw new Error('AfraCloud create from snapshot is not supported');
}

module.exports = {
  getToken,
  listFlavors,
  listImages,
  createServer,
  getServer,
  getServerDetails,
  listServers,
  deleteServer,
  suspendServer,
  resumeServer,
  createKeyPair,
  deleteKeyPair,
  resetServerPassword,
  rebuildServer,
  createSnapshot,
  listSnapshots,
  createServerFromSnapshot,
};
