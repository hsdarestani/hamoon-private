// cloud-api.js
const openstack = require('./openstack-api');
const hetzner   = require('./Hetzner/hetzner-api');
const afracloud = require('./Afracloud/afracloud-api');

function pick(dcConfig) {
  if (dcConfig.provider === 'hetzner') return hetzner;
  if (dcConfig.provider === 'afracloud') return afracloud;
  return openstack;
}

const safeNoopCreateKeyPair = async (_dc, _tok, _name, _publicKey) => ({ id: null, name: _name || null });

module.exports = {
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

};

