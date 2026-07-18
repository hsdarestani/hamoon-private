'use strict';

function normalizeNovaMetadataValues(object) {
  if (!object || typeof object !== 'object') return object;

  const metadata =
    object?.server?.metadata ||
    object?.metadata;

  if (!metadata || typeof metadata !== 'object') {
    return object;
  }

  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) {
      delete metadata[key];
    } else if (typeof value !== 'string') {
      metadata[key] = String(value);
    }
  }

  return object;
}

const openstack = require('./openstack-api');
const hetzner = require('./Hetzner/hetzner-api');
const afracloud = require('./Afracloud/afracloud-api');
const {
  providerName,
  isHetznerConfig,
  isAfraCloudConfig,
  isOpenStackConfig
} = require('./provider-detector');

function pick(dcConfig = {}) {
  const provider = providerName(dcConfig);

  if (provider === 'hetzner') return hetzner;
  if (provider === 'afracloud') return afracloud;
  return openstack;
}

function unsupported(message) {
  return Promise.reject(new Error(message));
}

const safeNoopCreateKeyPair = async (
  _dc,
  _token,
  name
) => ({
  id: null,
  name: name || null
});

module.exports = {
  pick,
  providerName,
  isHetznerConfig,
  isAfraCloudConfig,
  isOpenStackConfig,
  normalizeNovaMetadataValues,

  getToken: (dc, ...args) =>
    pick(dc).getToken(dc, ...args),

  listFlavors: (dc, ...args) =>
    pick(dc).listFlavors(dc, ...args),

  listImages: (dc, ...args) =>
    pick(dc).listImages(dc, ...args),

  createServer: (dc, ...args) =>
    pick(dc).createServer(dc, ...args),

  getServer: (dc, ...args) =>
    pick(dc).getServer(dc, ...args),

  listServers: (dc, ...args) =>
    pick(dc).listServers(dc, ...args),

  deleteServer: (dc, ...args) =>
    pick(dc).deleteServer(dc, ...args),

  rebuildServer: (dc, ...args) =>
    pick(dc).rebuildServer
      ? pick(dc).rebuildServer(dc, ...args)
      : unsupported('rebuild not supported'),

  resetServerPassword: (dc, ...args) =>
    pick(dc).resetServerPassword
      ? pick(dc).resetServerPassword(dc, ...args)
      : unsupported('reset password not supported'),

  suspendServer: (dc, ...args) =>
    pick(dc).suspendServer
      ? pick(dc).suspendServer(dc, ...args)
      : unsupported('suspend not supported'),

  resumeServer: (dc, ...args) =>
    pick(dc).resumeServer
      ? pick(dc).resumeServer(dc, ...args)
      : unsupported('resume not supported'),

  startServer: (dc, ...args) =>
    pick(dc).startServer
      ? pick(dc).startServer(dc, ...args)
      : (
          pick(dc).resumeServer
            ? pick(dc).resumeServer(dc, ...args)
            : unsupported('start/resume not supported')
        ),

  createSnapshot: (dc, ...args) =>
    pick(dc).createSnapshot
      ? pick(dc).createSnapshot(dc, ...args)
      : unsupported('snapshot not supported'),

  listSnapshots: (dc, ...args) =>
    pick(dc).listSnapshots
      ? pick(dc).listSnapshots(dc, ...args)
      : unsupported('listSnapshots not supported'),

  createServerFromSnapshot: (dc, ...args) =>
    pick(dc).createServerFromSnapshot
      ? pick(dc).createServerFromSnapshot(dc, ...args)
      : unsupported('createServerFromSnapshot not supported'),

  createKeyPair: (dc, ...args) =>
    pick(dc).createKeyPair
      ? pick(dc).createKeyPair(dc, ...args)
      : safeNoopCreateKeyPair(dc, ...args),

  deleteKeyPair: (dc, ...args) =>
    pick(dc).deleteKeyPair
      ? pick(dc).deleteKeyPair(dc, ...args)
      : unsupported('deleteKeyPair not supported'),

  getServerDetails: (dc, ...args) =>
    pick(dc).getServerDetails
      ? pick(dc).getServerDetails(dc, ...args)
      : unsupported('getServerDetails not supported'),

  ensureSshSecurityGroup: (dc, ...args) =>
    pick(dc).ensureSshSecurityGroup
      ? pick(dc).ensureSshSecurityGroup(dc, ...args)
      : Promise.resolve('default'),

  listHetznerServerTypes: (dc, ...args) =>
    pick(dc).listHetznerServerTypes
      ? pick(dc).listHetznerServerTypes(dc, ...args)
      : unsupported('Hetzner server types not supported'),

  changeHetznerServerType: (dc, ...args) =>
    pick(dc).changeHetznerServerType
      ? pick(dc).changeHetznerServerType(dc, ...args)
      : unsupported('Hetzner change_type not supported'),

  waitHetznerAction: (dc, ...args) =>
    pick(dc).waitHetznerAction
      ? pick(dc).waitHetznerAction(dc, ...args)
      : unsupported('Hetzner actions not supported'),

  powerOffHetznerServer: (dc, ...args) =>
    pick(dc).powerOffHetznerServer
      ? pick(dc).powerOffHetznerServer(dc, ...args)
      : unsupported('Hetzner poweroff not supported'),

  powerOnHetznerServer: (dc, ...args) =>
    pick(dc).powerOnHetznerServer
      ? pick(dc).powerOnHetznerServer(dc, ...args)
      : unsupported('Hetzner poweron not supported'),

  createPrimaryIpv4: (dc, ...args) =>
    pick(dc).createPrimaryIpv4
      ? pick(dc).createPrimaryIpv4(dc, ...args)
      : unsupported('Primary IPv4 creation not supported'),

  assignPrimaryIp: (dc, ...args) =>
    pick(dc).assignPrimaryIp
      ? pick(dc).assignPrimaryIp(dc, ...args)
      : unsupported('Primary IP assignment not supported'),

  unassignPrimaryIp: (dc, ...args) =>
    pick(dc).unassignPrimaryIp
      ? pick(dc).unassignPrimaryIp(dc, ...args)
      : unsupported('Primary IP unassignment not supported'),

  deletePrimaryIp: (dc, ...args) =>
    pick(dc).deletePrimaryIp
      ? pick(dc).deletePrimaryIp(dc, ...args)
      : unsupported('Primary IP deletion not supported')
};
