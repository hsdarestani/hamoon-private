
const axios = require('axios');

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

async function listFlavors(config) {
  const r = await client(config).get('/restapi/compute/computeOfferingList', {
    params: { zoneUuid: config.ZONE_UUID },
  });

  return (r.data.listComputeOfferingResponse || []).map(f => ({
    id: f.uuid,
    name: f.name,
    label: f.displayText || f.name,
    price: 0,
    disk: 0,
    cores: Number(f.numberOfCores || 0),
    memory: Number(f.memory || 0),
  }));
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
  throw new Error('AfraCloud rebuild is not implemented in public API');
}

async function createSnapshot() {
  throw new Error('AfraCloud snapshot adapter not wired yet');
}

async function listSnapshots() {
  return [];
}

async function createServerFromSnapshot() {
  throw new Error('AfraCloud create from snapshot not wired yet');
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
