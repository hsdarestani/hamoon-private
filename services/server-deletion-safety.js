'use strict';

const axios = require('axios');
const { isHetznerConfig, isOpenStackConfig, providerName } = require('../provider-detector');

const RECONCILE_MARK = Symbol.for('hamoon.serverDeletionSafetyReconcileInstalled');
const reconcileInFlight = new Set();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function errorStatus(error) {
  const status = Number(error?.response?.status ?? error?.status ?? error?.statusCode);
  return Number.isFinite(status) ? status : null;
}

function errorCode(error) {
  return String(
    error?.code ||
    error?.response?.data?.error?.code ||
    error?.response?.data?.code ||
    ''
  ).trim().toLowerCase();
}

function isDefiniteNotFound(error) {
  if (errorStatus(error) === 404) return true;
  const message = String(
    error?.response?.data?.error?.message ||
    error?.response?.data?.message ||
    error?.message ||
    ''
  ).toLowerCase();
  const code = errorCode(error);
  return /not[_ -]?found|does not exist|no server with|no volume with|resource .* missing/.test(`${code} ${message}`);
}

function safeMessage(error) {
  return String(error?.code || error?.message || errorStatus(error) || 'unknown').slice(0, 180);
}

function uniqueStrings(values) {
  return Array.from(new Set((values || []).map(v => String(v || '').trim()).filter(Boolean)));
}

function attachedVolumeIds(server) {
  const attached =
    server?.['os-extended-volumes:volumes_attached'] ||
    server?.os_extended_volumes_volumes_attached ||
    server?.volumes_attached ||
    [];
  return uniqueStrings(attached.map(v => v?.id || v?.volume_id || v));
}

function normalizeVolumeBaseUrl(raw, projectId) {
  let value = String(raw || '').trim().replace(/\/+$/, '');
  if (!value) return '';
  value = value
    .replace(/%\(project_id\)s/g, String(projectId || ''))
    .replace(/\{project_id\}/g, String(projectId || ''))
    .replace(/\$\{project_id\}/g, String(projectId || ''));
  if (/\/v3$/i.test(value) && projectId) value += `/${projectId}`;
  return value;
}

function openStackVolumeBaseUrl(dc = {}) {
  const explicit =
    dc.OS_VOLUME_URL ||
    dc.CINDER_URL ||
    dc.OS_CINDER_URL ||
    dc.VOLUME_URL ||
    dc.volume_url;
  if (explicit) return normalizeVolumeBaseUrl(explicit, dc.OS_PROJECT_ID);

  const auth = String(dc.OS_AUTH_URL || '').trim();
  if (!auth || !dc.OS_PROJECT_ID) return '';
  try {
    const u = new URL(auth);
    u.port = String(dc.OS_VOLUME_PORT || 8776);
    u.pathname = '';
    u.search = '';
    u.hash = '';
    return `${u.origin}/v3/${dc.OS_PROJECT_ID}`;
  } catch (_) {
    return '';
  }
}

async function getOpenStackVolume(dc, token, volumeId, request = axios) {
  const base = openStackVolumeBaseUrl(dc);
  if (!base) {
    const error = new Error('OPENSTACK_VOLUME_ENDPOINT_UNAVAILABLE');
    error.code = 'OPENSTACK_VOLUME_ENDPOINT_UNAVAILABLE';
    throw error;
  }
  const response = await request.get(`${base}/volumes/${encodeURIComponent(String(volumeId))}`, {
    headers: { 'X-Auth-Token': token },
    timeout: 20000
  });
  return response?.data?.volume || null;
}

async function deleteOpenStackVolume(dc, token, volumeId, request = axios) {
  const base = openStackVolumeBaseUrl(dc);
  if (!base) {
    const error = new Error('OPENSTACK_VOLUME_ENDPOINT_UNAVAILABLE');
    error.code = 'OPENSTACK_VOLUME_ENDPOINT_UNAVAILABLE';
    throw error;
  }
  await request.delete(`${base}/volumes/${encodeURIComponent(String(volumeId))}`, {
    headers: { 'X-Auth-Token': token },
    timeout: 20000
  });
  return true;
}

function isBootableVolume(volume) {
  if (!volume) return false;
  if (volume.bootable === true) return true;
  return String(volume.bootable || '').trim().toLowerCase() === 'true';
}

async function captureBootVolumeIds({
  dc,
  token,
  server,
  purchase,
  testServer,
  getVolume = getOpenStackVolume
}) {
  if (!isOpenStackConfig(dc)) return [];

  const attached = attachedVolumeIds(server);
  const bootIds = [];

  for (const volumeId of attached) {
    try {
      const volume = await getVolume(dc, token, volumeId);
      if (isBootableVolume(volume)) bootIds.push(volumeId);
    } catch (error) {
      if (isDefiniteNotFound(error)) continue;
      const wrapped = new Error(`VOLUME_PREFLIGHT_FAILED:${safeMessage(error)}`);
      wrapped.code = 'VOLUME_PREFLIGHT_FAILED';
      wrapped.cause = error;
      throw wrapped;
    }
  }

  const persisted = String(purchase?.boot_volume_id || testServer?.boot_volume_id || '').trim();
  const serverId = String(server?.id || purchase?.server_id || testServer?.server_id || '').trim();
  if (persisted && persisted !== serverId) bootIds.push(persisted);

  const unique = uniqueStrings(bootIds);
  const requiresBootVolume = String(purchase?.boot_method || '').toLowerCase() === 'volume' || Boolean(testServer?.boot_volume_id);
  if (requiresBootVolume && server && unique.length === 0) {
    const error = new Error('BOOT_VOLUME_PREFLIGHT_UNVERIFIED');
    error.code = 'BOOT_VOLUME_PREFLIGHT_UNVERIFIED';
    throw error;
  }
  return unique;
}

async function waitForServerDeletion({
  cloud,
  dc,
  token,
  serverId,
  timeoutMs = Number(process.env.SERVER_DELETE_VERIFY_TIMEOUT_MS || 60000),
  pollMs = Number(process.env.SERVER_DELETE_VERIFY_POLL_MS || 1500),
  sleeper = sleep
}) {
  const deadline = Date.now() + Math.max(5000, Number(timeoutMs) || 60000);
  let last = null;

  while (Date.now() < deadline) {
    try {
      await cloud.getServer(dc, token, String(serverId));
      last = 'exists';
    } catch (error) {
      if (isDefiniteNotFound(error)) return { confirmed: true };
      last = error;
    }
    await sleeper(Math.max(250, Number(pollMs) || 1500));
  }

  const error = new Error('SERVER_DELETE_NOT_CONFIRMED');
  error.code = 'SERVER_DELETE_NOT_CONFIRMED';
  error.last = last;
  throw error;
}

async function waitForVolumeDeletion({
  dc,
  token,
  volumeId,
  timeoutMs = Number(process.env.SERVER_VOLUME_DELETE_VERIFY_TIMEOUT_MS || 60000),
  pollMs = Number(process.env.SERVER_VOLUME_DELETE_VERIFY_POLL_MS || 1500),
  getVolume = getOpenStackVolume,
  sleeper = sleep
}) {
  const deadline = Date.now() + Math.max(5000, Number(timeoutMs) || 60000);
  let last = null;

  while (Date.now() < deadline) {
    try {
      await getVolume(dc, token, String(volumeId));
      last = 'exists';
    } catch (error) {
      if (isDefiniteNotFound(error)) return { confirmed: true };
      last = error;
    }
    await sleeper(Math.max(250, Number(pollMs) || 1500));
  }

  const error = new Error(`BOOT_VOLUME_DELETE_NOT_CONFIRMED:${volumeId}`);
  error.code = 'BOOT_VOLUME_DELETE_NOT_CONFIRMED';
  error.volumeId = String(volumeId);
  error.last = last;
  throw error;
}

async function ensureBootVolumesDeleted({
  dc,
  token,
  volumeIds,
  getVolume = getOpenStackVolume,
  deleteVolume = deleteOpenStackVolume,
  sleeper = sleep
}) {
  if (!isOpenStackConfig(dc)) return [];
  const ids = uniqueStrings(volumeIds);
  const confirmed = [];

  for (const volumeId of ids) {
    let volume = null;
    try {
      volume = await getVolume(dc, token, volumeId);
    } catch (error) {
      if (isDefiniteNotFound(error)) {
        confirmed.push(volumeId);
        continue;
      }
      throw error;
    }

    // Nova normally removes delete_on_termination boot volumes by itself. Give
    // it a short grace period before issuing an explicit Cinder delete.
    const autoDeadline = Date.now() + 10000;
    while (volume && Date.now() < autoDeadline) {
      await sleeper(1000);
      try {
        volume = await getVolume(dc, token, volumeId);
      } catch (error) {
        if (isDefiniteNotFound(error)) {
          volume = null;
          break;
        }
        throw error;
      }
    }
    if (!volume) {
      confirmed.push(volumeId);
      continue;
    }

    const detachDeadline = Date.now() + 30000;
    let deletedRequestAccepted = false;
    while (Date.now() < detachDeadline) {
      try {
        await deleteVolume(dc, token, volumeId);
        deletedRequestAccepted = true;
        break;
      } catch (error) {
        if (isDefiniteNotFound(error)) {
          deletedRequestAccepted = true;
          break;
        }
        if (errorStatus(error) === 409) {
          await sleeper(1500);
          continue;
        }
        throw error;
      }
    }
    if (!deletedRequestAccepted) {
      const error = new Error(`BOOT_VOLUME_DELETE_REQUEST_BLOCKED:${volumeId}`);
      error.code = 'BOOT_VOLUME_DELETE_REQUEST_BLOCKED';
      error.volumeId = volumeId;
      throw error;
    }

    await waitForVolumeDeletion({ dc, token, volumeId, getVolume, sleeper });
    confirmed.push(volumeId);
  }

  return confirmed;
}

async function ensureSchema(db) {
  await db.pool.execute(`
    CREATE TABLE IF NOT EXISTS server_deletion_jobs (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      telegram_id VARCHAR(64) NOT NULL,
      server_id VARCHAR(128) NOT NULL,
      datacenter VARCHAR(64) NOT NULL,
      provider VARCHAR(32) NOT NULL,
      boot_volume_ids LONGTEXT NULL,
      requires_storage_verification TINYINT(1) NOT NULL DEFAULT 0,
      provider_delete_confirmed_at DATETIME NULL,
      storage_delete_confirmed_at DATETIME NULL,
      completed_at DATETIME NULL,
      last_error VARCHAR(255) NULL,
      requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_server_deletion_job (server_id, datacenter),
      KEY idx_server_deletion_pending (completed_at, requested_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

function parseVolumeIds(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return uniqueStrings(raw);
  try {
    const parsed = JSON.parse(String(raw));
    return uniqueStrings(Array.isArray(parsed) ? parsed : []);
  } catch (_) {
    return [];
  }
}

async function getDeletionJob(db, serverId, datacenter) {
  await ensureSchema(db);
  const [rows] = await db.pool.execute(
    'SELECT * FROM server_deletion_jobs WHERE server_id = ? AND datacenter = ? LIMIT 1',
    [String(serverId), String(datacenter)]
  );
  return rows[0] || null;
}

async function upsertDeletionJob(db, {
  telegramId,
  serverId,
  datacenter,
  provider,
  bootVolumeIds = [],
  requiresStorageVerification = false
}) {
  await ensureSchema(db);
  const serialized = JSON.stringify(uniqueStrings(bootVolumeIds));
  await db.pool.execute(
    `INSERT INTO server_deletion_jobs
      (telegram_id, server_id, datacenter, provider, boot_volume_ids, requires_storage_verification)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       telegram_id = VALUES(telegram_id),
       provider = VALUES(provider),
       boot_volume_ids = IF(VALUES(boot_volume_ids) <> '[]', VALUES(boot_volume_ids), boot_volume_ids),
       requires_storage_verification = GREATEST(requires_storage_verification, VALUES(requires_storage_verification)),
       last_error = NULL,
       updated_at = NOW()`,
    [
      String(telegramId),
      String(serverId),
      String(datacenter),
      String(provider || 'unknown'),
      serialized,
      requiresStorageVerification ? 1 : 0
    ]
  );
}

async function updateDeletionJob(db, serverId, datacenter, updates = {}) {
  await ensureSchema(db);
  const fields = [];
  const params = [];

  if (updates.providerConfirmed) fields.push('provider_delete_confirmed_at = COALESCE(provider_delete_confirmed_at, NOW())');
  if (updates.storageConfirmed) fields.push('storage_delete_confirmed_at = COALESCE(storage_delete_confirmed_at, NOW())');
  if (updates.completed) fields.push('completed_at = COALESCE(completed_at, NOW())');
  if (Object.prototype.hasOwnProperty.call(updates, 'lastError')) {
    fields.push('last_error = ?');
    params.push(updates.lastError ? String(updates.lastError).slice(0, 255) : null);
  }
  if (Array.isArray(updates.bootVolumeIds) && updates.bootVolumeIds.length) {
    fields.push('boot_volume_ids = ?');
    params.push(JSON.stringify(uniqueStrings(updates.bootVolumeIds)));
  }
  if (!fields.length) return false;

  params.push(String(serverId), String(datacenter));
  const [result] = await db.pool.execute(
    `UPDATE server_deletion_jobs SET ${fields.join(', ')}, updated_at = NOW()
     WHERE server_id = ? AND datacenter = ?`,
    params
  );
  return result.affectedRows > 0;
}

function requiresStorageVerificationFor(purchase, testServer, bootVolumeIds) {
  if (bootVolumeIds?.length) return true;
  return String(purchase?.boot_method || '').toLowerCase() === 'volume' || Boolean(testServer?.boot_volume_id);
}

async function secureDeleteServerResources({
  db,
  cloud,
  dc,
  token,
  telegramId,
  serverId,
  purchase = null,
  testServer = null
}) {
  const datacenter = String(dc?.key || purchase?.datacenter || testServer?.datacenter || '');
  if (!datacenter) {
    const error = new Error('DELETE_DATACENTER_REQUIRED');
    error.code = 'DELETE_DATACENTER_REQUIRED';
    throw error;
  }

  const existingJob = purchase ? await getDeletionJob(db, serverId, datacenter) : null;
  let providerServer = null;
  let providerMissing = false;

  try {
    providerServer = await cloud.getServer(dc, token, String(serverId));
  } catch (error) {
    if (!isDefiniteNotFound(error)) throw error;
    providerMissing = true;
  }

  let bootVolumeIds = parseVolumeIds(existingJob?.boot_volume_ids);
  if (!providerMissing) {
    const captured = await captureBootVolumeIds({
      dc,
      token,
      server: providerServer,
      purchase,
      testServer
    });
    bootVolumeIds = uniqueStrings([...bootVolumeIds, ...captured]);
  } else {
    const persisted = String(purchase?.boot_volume_id || testServer?.boot_volume_id || '').trim();
    if (persisted && persisted !== String(serverId)) bootVolumeIds = uniqueStrings([...bootVolumeIds, persisted]);
  }

  const requiresStorageVerification =
    Boolean(existingJob?.requires_storage_verification) ||
    requiresStorageVerificationFor(purchase, testServer, bootVolumeIds);

  if (providerMissing && isOpenStackConfig(dc) && requiresStorageVerification && bootVolumeIds.length === 0) {
    const error = new Error('BOOT_VOLUME_ID_UNAVAILABLE_AFTER_PROVIDER_DELETE');
    error.code = 'BOOT_VOLUME_ID_UNAVAILABLE_AFTER_PROVIDER_DELETE';
    throw error;
  }

  if (purchase) {
    await db.markDeletionPending(String(telegramId), String(serverId), datacenter);
    await upsertDeletionJob(db, {
      telegramId,
      serverId,
      datacenter,
      provider: providerName(dc),
      bootVolumeIds,
      requiresStorageVerification
    });
  }

  if (!providerMissing) {
    try {
      await cloud.deleteServer(dc, token, String(serverId));
    } catch (error) {
      if (!isDefiniteNotFound(error)) {
        if (purchase) await updateDeletionJob(db, serverId, datacenter, { lastError: safeMessage(error) }).catch(() => false);
        throw error;
      }
    }
  }

  try {
    await waitForServerDeletion({ cloud, dc, token, serverId });
    if (purchase) await updateDeletionJob(db, serverId, datacenter, { providerConfirmed: true, lastError: null });
  } catch (error) {
    if (purchase) await updateDeletionJob(db, serverId, datacenter, { lastError: safeMessage(error) }).catch(() => false);
    throw error;
  }

  if (isOpenStackConfig(dc) && bootVolumeIds.length) {
    try {
      await ensureBootVolumesDeleted({ dc, token, volumeIds: bootVolumeIds });
      if (purchase) await updateDeletionJob(db, serverId, datacenter, { storageConfirmed: true, lastError: null });
    } catch (error) {
      if (purchase) await updateDeletionJob(db, serverId, datacenter, { lastError: safeMessage(error) }).catch(() => false);
      throw error;
    }
  } else if (purchase) {
    await updateDeletionJob(db, serverId, datacenter, { storageConfirmed: true, lastError: null });
  }

  return {
    providerDeleteConfirmed: true,
    storageDeleteConfirmed: true,
    providerAlreadyMissing: providerMissing,
    bootVolumeIds
  };
}

async function purgeStoredCredentials({ db, cloud, dc, token, telegramId, serverId }) {
  const kp = await db.getKeyPair?.(String(serverId)).catch(() => null);
  if (!isHetznerConfig(dc) && kp?.key_name) {
    await cloud.deleteKeyPair(dc, token, kp.key_name).catch(error => {
      if (!isDefiniteNotFound(error)) {
        console.warn('[SERVER_DELETION_KEY_PROVIDER_CLEANUP_FAILED]', {
          server_id: String(serverId),
          error: safeMessage(error)
        });
      }
    });
  }
  await db.deleteKeyPairFromDb?.(String(serverId)).catch(() => false);
  await db.pool.execute(
    'DELETE FROM server_secrets WHERE server_id = ? AND telegram_id = ?',
    [String(serverId), String(telegramId)]
  ).catch(error => {
    console.warn('[SERVER_DELETION_SECRET_CLEANUP_FAILED]', {
      server_id: String(serverId),
      error: safeMessage(error)
    });
  });
}

async function finalizePurchasedDeletion({ db, telegramId, serverId, datacenter }) {
  const refund = await require('../server-deletion-refund').refundUnusedServerCycle({
    db,
    telegramId,
    serverId,
    datacenter
  });
  await db.markDeleted(String(telegramId), String(serverId), String(datacenter));
  await updateDeletionJob(db, serverId, datacenter, { completed: true, lastError: null }).catch(() => false);
  return refund;
}

function resolveDatacenter(datacenters, key) {
  const raw = String(key || '');
  return datacenters?.[raw] || datacenters?.[raw.split('__')[0]] || null;
}

async function reconcileOnePending({ db, cloud, datacenters, purchase }) {
  const key = `${purchase.datacenter}:${purchase.server_id}`;
  if (reconcileInFlight.has(key)) return { skipped: 'in_flight' };
  reconcileInFlight.add(key);

  try {
    const dc = resolveDatacenter(datacenters, purchase.datacenter);
    if (!dc) throw Object.assign(new Error('DATACENTER_CONFIG_MISSING'), { code: 'DATACENTER_CONFIG_MISSING' });
    const token = await cloud.getToken(dc);
    await secureDeleteServerResources({
      db,
      cloud,
      dc,
      token,
      telegramId: purchase.telegram_id,
      serverId: purchase.server_id,
      purchase
    });
    await purgeStoredCredentials({
      db,
      cloud,
      dc,
      token,
      telegramId: purchase.telegram_id,
      serverId: purchase.server_id
    });
    const refund = await finalizePurchasedDeletion({
      db,
      telegramId: purchase.telegram_id,
      serverId: purchase.server_id,
      datacenter: purchase.datacenter
    });
    console.log('[SERVER_DELETION_RECONCILED]', {
      server_id: String(purchase.server_id),
      datacenter: String(purchase.datacenter),
      refund: Number(refund?.refunded || 0)
    });
    return { ok: true, serverId: String(purchase.server_id) };
  } catch (error) {
    await updateDeletionJob(db, purchase.server_id, purchase.datacenter, { lastError: safeMessage(error) }).catch(() => false);
    console.error('[SERVER_DELETION_RECONCILE_FAILED]', {
      server_id: String(purchase.server_id),
      datacenter: String(purchase.datacenter),
      error: safeMessage(error)
    });
    return { ok: false, serverId: String(purchase.server_id), error: safeMessage(error) };
  } finally {
    reconcileInFlight.delete(key);
  }
}

async function reconcileDeletionPending({ db, cloud, datacenters, limit = 25 } = {}) {
  db = db || require('../db');
  cloud = cloud || require('../cloud-api');
  datacenters = datacenters || require('../datacenters');
  await ensureSchema(db);

  const rows = await db.listDeletionPending();
  const selected = rows.slice(0, Math.max(1, Math.min(100, Number(limit) || 25)));
  const results = [];
  for (const purchase of selected) {
    results.push(await reconcileOnePending({ db, cloud, datacenters, purchase }));
  }
  return results;
}

function scheduleDeletionPendingReconcile(options = {}) {
  const globalObj = globalThis;
  if (globalObj[RECONCILE_MARK]) return false;
  globalObj[RECONCILE_MARK] = true;

  const run = () => reconcileDeletionPending(options).catch(error => {
    console.error('[SERVER_DELETION_RECONCILE_LOOP_FAILED]', safeMessage(error));
  });

  const first = setTimeout(run, 5000);
  first.unref?.();
  const everyMs = Math.max(60000, Number(process.env.SERVER_DELETE_RECONCILE_INTERVAL_MS || 300000));
  const timer = setInterval(run, everyMs);
  timer.unref?.();
  return true;
}

module.exports = {
  isDefiniteNotFound,
  attachedVolumeIds,
  openStackVolumeBaseUrl,
  captureBootVolumeIds,
  waitForServerDeletion,
  waitForVolumeDeletion,
  ensureBootVolumesDeleted,
  ensureSchema,
  getDeletionJob,
  upsertDeletionJob,
  updateDeletionJob,
  secureDeleteServerResources,
  purgeStoredCredentials,
  finalizePurchasedDeletion,
  reconcileDeletionPending,
  scheduleDeletionPendingReconcile
};
