// cloud-api.js
const openstack = require('./openstack-api');
const hetzner   = require('./Hetzner/hetzner-api');
const afracloud = require('./Afracloud/afracloud-api');
const { providerName, isHetznerConfig, isAfraCloudConfig, isOpenStackConfig } = require('./provider-detector');

function pick(dcConfig = {}) {
  const provider = providerName(dcConfig);
  if (provider === 'hetzner') return hetzner;
  if (provider === 'afracloud') return afracloud;
  return openstack;
}

const safeNoopCreateKeyPair = async (_dc, _tok, _name, _publicKey) => ({ id: null, name: _name || null });

module.exports = {
  pick,
  isHetznerConfig,
  isAfraCloudConfig,
  isOpenStackConfig,
  getToken:              (dc, ...a) => pick(dc).getToken(dc, ...a),
  listFlavors:           (dc, ...a) => pick(dc).listFlavors(dc, ...a),
  listImages:            (dc, ...a) => pick(dc).listImages(dc, ...a),
  createServer:          (dc, ...a) => pick(dc).createServer(dc, ...a),
  getServer:             (dc, ...a) => pick(dc).getServer(dc, ...a),
  listServers:           (dc, ...a) => pick(dc).listServers(dc, ...a),
  deleteServer:          (dc, ...a) => pick(dc).deleteServer(dc, ...a),
  rebuildServer:         (dc, ...a) => pick(dc).rebuildServer ? pick(dc).rebuildServer(dc, ...a) : Promise.reject(new Error('rebuild not supported')),
  resetServerPassword:   (dc, ...a) => pick(dc).resetServerPassword ? pick(dc).resetServerPassword(dc, ...a) : Promise.reject(new Error('reset password not supported')),
  suspendServer:         (dc, ...a) => pick(dc).suspendServer ? pick(dc).suspendServer(dc, ...a) : Promise.reject(new Error('suspend not supported')),
  resumeServer:          (dc, ...a) => pick(dc).resumeServer ? pick(dc).resumeServer(dc, ...a) : Promise.reject(new Error('resume not supported')),
  startServer:           (dc, ...a) => pick(dc).startServer ? pick(dc).startServer(dc, ...a) : (pick(dc).resumeServer ? pick(dc).resumeServer(dc, ...a) : Promise.reject(new Error('start/resume not supported'))),
  createSnapshot: (dc, ...a) => pick(dc).createSnapshot ? pick(dc).createSnapshot(dc, ...a) : Promise.reject(new Error('snapshot not supported')),
  listSnapshots: (dc, ...a) => pick(dc).listSnapshots ? pick(dc).listSnapshots(dc, ...a) : Promise.reject(new Error('listSnapshots not supported')),

createServerFromSnapshot: (dc, ...a) =>
  pick(dc).createServerFromSnapshot
    ? pick(dc).createServerFromSnapshot(dc, ...a)
    : Promise.reject(new Error('createServerFromSnapshot not supported')),

  // 👇 این خط مشکل شما را حل می‌کند:
  createKeyPair:         (dc, ...a) => (pick(dc).createKeyPair ? pick(dc).createKeyPair(dc, ...a) : safeNoopCreateKeyPair(dc, ...a)),
  deleteKeyPair:         (dc, ...a) => pick(dc).deleteKeyPair ? pick(dc).deleteKeyPair(dc, ...a) : Promise.reject(new Error('deleteKeyPair not supported')),
  getServerDetails:      (dc, ...a) => pick(dc).getServerDetails ? pick(dc).getServerDetails(dc, ...a) : Promise.reject(new Error('getServerDetails not supported')),
  ensureSshSecurityGroup:(dc, ...a) => pick(dc).ensureSshSecurityGroup ? pick(dc).ensureSshSecurityGroup(dc, ...a) : Promise.resolve('default'),
  listHetznerServerTypes: (dc, ...a) => pick(dc).listHetznerServerTypes ? pick(dc).listHetznerServerTypes(dc, ...a) : Promise.reject(new Error('Hetzner server types not supported')),
  changeHetznerServerType: (dc, ...a) => pick(dc).changeHetznerServerType ? pick(dc).changeHetznerServerType(dc, ...a) : Promise.reject(new Error('Hetzner change_type not supported')),
  waitHetznerAction: (dc, ...a) => pick(dc).waitHetznerAction ? pick(dc).waitHetznerAction(dc, ...a) : Promise.reject(new Error('Hetzner actions not supported')),
  powerOffHetznerServer: (dc, ...a) => pick(dc).powerOffHetznerServer ? pick(dc).powerOffHetznerServer(dc, ...a) : Promise.reject(new Error('Hetzner poweroff not supported')),
  powerOnHetznerServer: (dc, ...a) => pick(dc).powerOnHetznerServer ? pick(dc).powerOnHetznerServer(dc, ...a) : Promise.reject(new Error('Hetzner poweron not supported')),

};

