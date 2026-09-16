'use strict';

const db = require('./db');
const cloud = require('./cloud-api');
const datacenters = require('./datacenters');

const inFlight = new Set();

function errorInfo(error) {
  return {
    status: Number(error?.response?.status ?? error?.status ?? error?.statusCode ?? 0) || null,
    code: String(
      error?.code ||
      error?.response?.data?.code ||
      error?.response?.data?.error?.code ||
      ''
    ).trim().toLowerCase(),
    message: String(
      error?.response?.data?.message ||
      error?.response?.data?.error?.message ||
      error?.message ||
      ''
    ).trim().toLowerCase()
  };
}

function isDefiniteNotFound(error) {
  const info = errorInfo(error);
  if (info.status === 404) return true;
  const haystack = `${info.code} ${info.message}`;
  return /\bnot[_ -]?found\b|does not exist|no server with|server .* missing|instance .* missing/.test(haystack);
}

function getDatacenterConfig(datacenterKey) {
  const raw = String(datacenterKey || '').trim();
  if (!raw) return null;
  if (datacenters[raw]) return datacenters[raw];
  const base = raw.split('__')[0];
  return datacenters[base] || null;
}

async function providerServerExists(purchase) {
  const dc = getDatacenterConfig(purchase?.datacenter);
  if (!dc) {
    const error = new Error(`DATACENTER_CONFIG_MISSING:${purchase?.datacenter || ''}`);
    error.code = 'DATACENTER_CONFIG_MISSING';
    throw error;
  }
  const token = await cloud.getToken(dc);
  await cloud.getServer(dc, token, String(purchase.server_id));
  return true;
}

async function reconcileStaleServersForUser(telegramId) {
  const userId = String(telegramId || '').trim();
  if (!userId) throw new Error('TELEGRAM_ID_REQUIRED');
  if (inFlight.has(userId)) return { userId, skipped: 'already_running' };

  inFlight.add(userId);
  const repairedPurchases = [];
  const repairedTests = [];
  const live = [];
  const inconclusive = [];

  try {
    const purchases = await db.getUserActivePurchases(userId);
    const tests = await db.getUserActiveTestServers(userId);

    for (const purchase of purchases) {
      try {
        await providerServerExists(purchase);
        live.push({
          type: 'purchase',
          serverId: String(purchase.server_id),
          datacenter: String(purchase.datacenter)
        });
      } catch (error) {
        if (!isDefiniteNotFound(error)) {
          const info = errorInfo(error);
          inconclusive.push({
            type: 'purchase',
            serverId: String(purchase.server_id),
            datacenter: String(purchase.datacenter),
            status: info.status,
            code: info.code || info.message.slice(0, 80)
          });
          continue;
        }

        const marked = await db.markDeleted(
          userId,
          String(purchase.server_id),
          String(purchase.datacenter)
        );
        if (marked) {
          await db.deleteKeyPairFromDb(String(purchase.server_id)).catch(() => false);
          repairedPurchases.push({
            serverId: String(purchase.server_id),
            datacenter: String(purchase.datacenter),
            previousStatus: String(purchase.status || 'unknown')
          });
        }
      }
    }

    for (const test of tests) {
      try {
        await providerServerExists(test);
        live.push({
          type: 'test',
          serverId: String(test.server_id),
          datacenter: String(test.datacenter)
        });
      } catch (error) {
        if (!isDefiniteNotFound(error)) {
          const info = errorInfo(error);
          inconclusive.push({
            type: 'test',
            serverId: String(test.server_id),
            datacenter: String(test.datacenter),
            status: info.status,
            code: info.code || info.message.slice(0, 80)
          });
          continue;
        }

        const [result] = await db.pool.execute(
          `DELETE FROM test_servers
           WHERE telegram_id = ? AND datacenter = ? AND server_id = ?`,
          [userId, String(test.datacenter), String(test.server_id)]
        );
        if (result.affectedRows > 0) {
          repairedTests.push({
            serverId: String(test.server_id),
            datacenter: String(test.datacenter)
          });
        }
      }
    }

    const result = {
      userId,
      repairedPurchases,
      repairedTests,
      liveCount: live.length,
      inconclusive
    };

    console.log('[provider-visibility][STALE_SERVER_RECONCILE]', JSON.stringify(result));
    return result;
  } finally {
    inFlight.delete(userId);
  }
}

function scheduleStaleServerReconcile(userIds, delayMs = 500) {
  const ids = Array.from(new Set((userIds || []).map(String).filter(Boolean)));
  if (!ids.length) return false;

  const timer = setTimeout(() => {
    Promise.allSettled(ids.map(reconcileStaleServersForUser)).then(results => {
      for (let i = 0; i < results.length; i += 1) {
        if (results[i].status === 'rejected') {
          console.error('[provider-visibility][STALE_SERVER_RECONCILE_FAILED]', {
            userId: ids[i],
            error: String(results[i].reason?.message || results[i].reason || 'unknown').slice(0, 180)
          });
        }
      }
    });
  }, Math.max(0, Number(delayMs) || 0));
  timer.unref?.();
  return true;
}

module.exports = {
  errorInfo,
  isDefiniteNotFound,
  getDatacenterConfig,
  reconcileStaleServersForUser,
  scheduleStaleServerReconcile
};
