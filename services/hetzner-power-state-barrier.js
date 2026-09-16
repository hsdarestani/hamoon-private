'use strict';

const INSTALL_MARK = Symbol.for('hamoon.hetznerPowerStateBarrierInstalled');
const pendingActions = new Map();

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function actionId(action) {
  const id = action?.id ?? action?.action?.id ?? null;
  return id == null ? null : String(id);
}

async function waitForState(cloud, dc, serverId, wanted, timeoutMs = 60000) {
  const started = Date.now();
  let lastStatus = null;
  while (Date.now() - started < timeoutMs) {
    const server = await cloud.getServer(dc, null, serverId);
    lastStatus = String(server?.status || server?.state || '').trim().toLowerCase();
    if (wanted.has(lastStatus)) return server;
    await sleep(750);
  }
  const error = new Error(`HETZNER_POWER_STATE_TIMEOUT:${lastStatus || 'unknown'}`);
  error.code = 'HETZNER_POWER_STATE_TIMEOUT';
  error.serverId = String(serverId);
  error.lastStatus = lastStatus;
  throw error;
}

function installHetznerPowerStateBarrier() {
  const cloud = require('../cloud-api');
  if (cloud[INSTALL_MARK]) return false;

  const originalPowerOff = cloud.powerOffHetznerServer.bind(cloud);
  const originalPowerOn = cloud.powerOnHetznerServer.bind(cloud);
  const originalWait = cloud.waitHetznerAction.bind(cloud);

  cloud.powerOffHetznerServer = async function powerOffWithStateTracking(dc, serverId, ...rest) {
    const action = await originalPowerOff(dc, serverId, ...rest);
    const id = actionId(action);
    if (id) pendingActions.set(id, { dc, serverId: String(serverId), wanted: new Set(['off']) });
    return action;
  };

  cloud.powerOnHetznerServer = async function powerOnWithStateTracking(dc, serverId, ...rest) {
    const action = await originalPowerOn(dc, serverId, ...rest);
    const id = actionId(action);
    if (id) pendingActions.set(id, { dc, serverId: String(serverId), wanted: new Set(['running']) });
    return action;
  };

  cloud.waitHetznerAction = async function waitHetznerActionWithStateBarrier(dc, id, timeoutMs, ...rest) {
    const result = await originalWait(dc, id, timeoutMs, ...rest);
    const key = id == null ? null : String(id);
    const pending = key ? pendingActions.get(key) : null;
    if (!pending) return result;

    try {
      await waitForState(cloud, pending.dc || dc, pending.serverId, pending.wanted, Math.min(Number(timeoutMs || 60000), 90000));
      console.log('[HETZNER_POWER_STATE_BARRIER_OK]', {
        action_id: key,
        server_id: pending.serverId,
        state: [...pending.wanted].join('|')
      });
    } finally {
      pendingActions.delete(key);
    }
    return result;
  };

  cloud[INSTALL_MARK] = true;
  return true;
}

module.exports = { installHetznerPowerStateBarrier, waitForState };
