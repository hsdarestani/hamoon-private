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

function hetznerHttpStatus(err) {
  const status = Number(err?.status ?? err?.statusCode ?? err?.response?.status);
  return Number.isFinite(status) ? status : null;
}

function hetznerErrorCode(err) {
  return String(
    err?.code ||
    err?.data?.error?.code ||
    err?.response?.data?.error?.code ||
    ''
  ).trim().toLowerCase();
}

function isHetznerLockedError(err) {
  return hetznerHttpStatus(err) === 423 || hetznerErrorCode(err) === 'locked';
}

function hetznerLockedRetryDelays() {
  const parsed = String(process.env.HETZNER_LOCKED_RETRY_MS || '2000,4000,8000')
    .split(',')
    .map(v => Number(v.trim()))
    .filter(v => Number.isFinite(v) && v >= 0)
    .map(v => Math.min(v, 30000));
  return parsed.length ? parsed : [2000, 4000, 8000];
}

function operationInProgressError(cause) {
  const err = new Error('OPERATION_IN_PROGRESS');
  err.code = 'OPERATION_IN_PROGRESS';
  err.status = 423;
  err.cause = cause;
  if (cause?.response) err.response = cause.response;
  return err;
}

async function retryHetznerLockedOperation(dc, operation, fn, options = {}) {
  if (!isHetznerConfig(dc)) return fn();

  const delays = Array.isArray(options.delays) ? options.delays : hetznerLockedRetryDelays();
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!isHetznerLockedError(err)) throw err;
      if (attempt >= delays.length) throw operationInProgressError(err);

      const delayMs = Math.max(0, Number(delays[attempt]) || 0);
      console.warn('[HETZNER_LOCKED_RETRY]', {
        operation,
        attempt: attempt + 1,
        delay_ms: delayMs,
        status: hetznerHttpStatus(err) || 423
      });
      if (delayMs > 0) await sleep(delayMs);
    }
  }
}

function callWithHetznerLockedRetry(dc, operation, fn) {
  return isHetznerConfig(dc) ? retryHetznerLockedOperation(dc, operation, fn) : fn();
}

function callProviderMethod(dc, method, args, unsupportedMessage) {
  const provider = pick(dc);
  return provider[method]
    ? provider[method](dc, ...args)
    : Promise.reject(new Error(unsupportedMessage));
}

// Production lifecycle uses the generic cloud-api convention (dc, token, ...args).
// Hetzner's Primary-IP helpers historically used (dc, ...args) directly.
// Accept both forms so a null token placeholder can never shift the real arguments.
function stripLegacyTokenPlaceholder(args = []) {
  const out = Array.from(args);
  if (out.length > 1 && (out[0] === null || out[0] === undefined)) out.shift();
  return out;
}

function primaryIpLocationName(value, dc = {}) {
  const raw =
    value?.name ||
    value?.location?.name ||
    value?.location ||
    value ||
    dc?.HETZNER_LOCATION ||
    dc?.location ||
    process.env.HETZNER_LOCATION ||
    'nbg1';
  return String(raw).trim().toLowerCase();
}

// Hetzner changed unassigned Primary IPs on 2026-08-01 from
// assignee_type="server", assignee_id=null to assignee_type="unassigned".
// Production lifecycle still expects the legacy shape before the swap.
// Preserve the provider value separately while presenting the compatible shape internally.
function normalizePrimaryIpForLegacyLifecycle(primaryIp) {
  if (!primaryIp || typeof primaryIp !== 'object') return primaryIp;
  if (primaryIp.assignee_id == null && String(primaryIp.assignee_type || '').toLowerCase() === 'unassigned') {
    return {
      ...primaryIp,
      provider_assignee_type: 'unassigned',
      assignee_type: 'server'
    };
  }
  return primaryIp;
}

async function createHetznerPrimaryIpv4(dc, args) {
  const [locationArg] = stripLegacyTokenPlaceholder(args);
  const location = primaryIpLocationName(locationArg, dc);
  // Hetzner removed "datacenter" from Primary-IP create requests on 2026-07-01.
  // "assignee_type" is optional for an unassigned Primary IP.
  const data = await hetzner.hetznerRequest(dc, 'POST', '/primary_ips', {
    type: 'ipv4',
    location,
    auto_delete: false
  });
  return normalizePrimaryIpForLegacyLifecycle(data?.primary_ip);
}

async function assignHetznerPrimaryIp(dc, args) {
  const [primaryIpId, serverId] = stripLegacyTokenPlaceholder(args);
  const data = await hetzner.hetznerRequest(
    dc,
    'POST',
    `/primary_ips/${primaryIpId}/actions/assign`,
    { assignee_id: Number(serverId), assignee_type: 'server' }
  );
  return data?.action;
}

async function unassignHetznerPrimaryIp(dc, args) {
  const [primaryIpId] = stripLegacyTokenPlaceholder(args);
  const data = await hetzner.hetznerRequest(dc, 'POST', `/primary_ips/${primaryIpId}/actions/unassign`, {});
  return data?.action;
}

async function deleteHetznerPrimaryIp(dc, args) {
  const [primaryIpId] = stripLegacyTokenPlaceholder(args);
  return hetzner.hetznerRequest(dc, 'DELETE', `/primary_ips/${primaryIpId}`);
}

module.exports = {
  pick,
  isHetznerConfig,
  isAfraCloudConfig,
  isOpenStackConfig,
  isHetznerLockedError,
  retryHetznerLockedOperation,
  stripLegacyTokenPlaceholder,
  primaryIpLocationName,
  normalizePrimaryIpForLegacyLifecycle,
  getToken:              (dc, ...a) => pick(dc).getToken(dc, ...a),
  listFlavors:           (dc, ...a) => pick(dc).listFlavors(dc, ...a),
  listImages:            (dc, ...a) => pick(dc).listImages(dc, ...a),
  createServer:          (dc, ...a) => pick(dc).createServer(dc, ...a),
  getServer:             (dc, ...a) => pick(dc).getServer(dc, ...a),
  listServers:           (dc, ...a) => pick(dc).listServers(dc, ...a),
  deleteServer:          (dc, ...a) => pick(dc).deleteServer(dc, ...a),
  rebuildServer:         (dc, ...a) => pick(dc).rebuildServer ? pick(dc).rebuildServer(dc, ...a) : Promise.reject(new Error('rebuild not supported')),
  resetServerPassword:   (dc, ...a) => pick(dc).resetServerPassword ? pick(dc).resetServerPassword(dc, ...a) : Promise.reject(new Error('reset password not supported')),
  suspendServer:         (dc, ...a) => {
    const provider = pick(dc);
    const call = () => provider.suspendServer ? provider.suspendServer(dc, ...a) : Promise.reject(new Error('suspend not supported'));
    return callWithHetznerLockedRetry(dc, 'suspend', call);
  },
  resumeServer:          (dc, ...a) => {
    const provider = pick(dc);
    const call = () => provider.resumeServer ? provider.resumeServer(dc, ...a) : Promise.reject(new Error('resume not supported'));
    return callWithHetznerLockedRetry(dc, 'resume', call);
  },
  startServer:           (dc, ...a) => {
    const provider = pick(dc);
    const call = () => provider.startServer
      ? provider.startServer(dc, ...a)
      : (provider.resumeServer ? provider.resumeServer(dc, ...a) : Promise.reject(new Error('start/resume not supported')));
    return callWithHetznerLockedRetry(dc, 'start', call);
  },
  createSnapshot: (dc, ...a) => pick(dc).createSnapshot ? pick(dc).createSnapshot(dc, ...a) : Promise.reject(new Error('snapshot not supported')),
  listSnapshots: (dc, ...a) => pick(dc).listSnapshots ? pick(dc).listSnapshots(dc, ...a) : Promise.reject(new Error('listSnapshots not supported')),

  createServerFromSnapshot: (dc, ...a) =>
    pick(dc).createServerFromSnapshot
      ? pick(dc).createServerFromSnapshot(dc, ...a)
      : Promise.reject(new Error('createServerFromSnapshot not supported')),

  createKeyPair:         (dc, ...a) => (pick(dc).createKeyPair ? pick(dc).createKeyPair(dc, ...a) : safeNoopCreateKeyPair(dc, ...a)),
  deleteKeyPair:         (dc, ...a) => pick(dc).deleteKeyPair ? pick(dc).deleteKeyPair(dc, ...a) : Promise.reject(new Error('deleteKeyPair not supported')),
  getServerDetails:      (dc, ...a) => pick(dc).getServerDetails ? pick(dc).getServerDetails(dc, ...a) : Promise.reject(new Error('getServerDetails not supported')),
  ensureSshSecurityGroup:(dc, ...a) => pick(dc).ensureSshSecurityGroup ? pick(dc).ensureSshSecurityGroup(dc, ...a) : Promise.resolve('default'),
  listHetznerServerTypes: (dc, ...a) => pick(dc).listHetznerServerTypes ? pick(dc).listHetznerServerTypes(dc, ...a) : Promise.reject(new Error('Hetzner server types not supported')),
  changeHetznerServerType: (dc, ...a) => pick(dc).changeHetznerServerType ? pick(dc).changeHetznerServerType(dc, ...a) : Promise.reject(new Error('Hetzner change_type not supported')),
  waitHetznerAction: (dc, ...a) => pick(dc).waitHetznerAction ? pick(dc).waitHetznerAction(dc, ...a) : Promise.reject(new Error('Hetzner actions not supported')),
  powerOffHetznerServer: (dc, ...a) => {
    const provider = pick(dc);
    const call = () => provider.powerOffHetznerServer ? provider.powerOffHetznerServer(dc, ...a) : Promise.reject(new Error('Hetzner poweroff not supported'));
    return callWithHetznerLockedRetry(dc, 'poweroff', call);
  },
  powerOnHetznerServer: (dc, ...a) => {
    const provider = pick(dc);
    const call = () => provider.powerOnHetznerServer ? provider.powerOnHetznerServer(dc, ...a) : Promise.reject(new Error('Hetzner poweron not supported'));
    return callWithHetznerLockedRetry(dc, 'poweron', call);
  },

  createPrimaryIpv4: (dc, ...a) =>
    isHetznerConfig(dc)
      ? createHetznerPrimaryIpv4(dc, a)
      : callProviderMethod(dc, 'createPrimaryIpv4', a, 'createPrimaryIpv4 not supported'),
  assignPrimaryIp: (dc, ...a) =>
    isHetznerConfig(dc)
      ? assignHetznerPrimaryIp(dc, a)
      : callProviderMethod(dc, 'assignPrimaryIp', a, 'assignPrimaryIp not supported'),
  unassignPrimaryIp: (dc, ...a) =>
    isHetznerConfig(dc)
      ? unassignHetznerPrimaryIp(dc, a)
      : callProviderMethod(dc, 'unassignPrimaryIp', a, 'unassignPrimaryIp not supported'),
  deletePrimaryIp: (dc, ...a) =>
    isHetznerConfig(dc)
      ? deleteHetznerPrimaryIp(dc, a)
      : callProviderMethod(dc, 'deletePrimaryIp', a, 'deletePrimaryIp not supported'),
};
