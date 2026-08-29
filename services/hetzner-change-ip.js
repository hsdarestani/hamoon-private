'use strict';

const net = require('net');
const cloud = require('../cloud-api');
const hetznerApi = require('../Hetzner/hetzner-api');

const VALID_STATUSES = new Set([
  'active', 'running', 'suspended', 'stopped', 'shutoff',
  // Internal delivery recovery uses the same transactional swap primitive. The
  // user-facing UI still decides whether a manual Change-IP button is shown.
  'provisioning', 'pending_ip', 'pending_ssh', 'pending_ip_quality', 'manual_review'
]);
const locks = new Set();
const REJECTED_HISTORY_EVENTS = new Set([
  'duplicate_candidate_rejected',
  'candidate_verification_rejected',
  'candidate_verification_inconclusive',
  'clean_ip_rejected',
  'clean_ip_unverified',
  'clean_ip_rejected_rolled_back',
  'clean_ip_unverified_rolled_back',
  'provisioning_quality_rejected'
]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeIpv4(value) {
  const ip = String(value || '').trim();
  return net.isIP(ip) === 4 ? ip : null;
}

function currentIpv4(server) {
  return normalizeIpv4(server?.public_net?.ipv4?.ip || server?.public_ip || server?.ip);
}

function primaryIpv4Id(server) {
  const id = server?.public_net?.ipv4?.id ?? server?.primary_ipv4_id ?? null;
  return id == null ? null : String(id);
}

function serverLocation(server, dc = {}) {
  return String(
    server?.datacenter?.location?.name ||
    server?.location?.name ||
    server?.location ||
    dc?.HETZNER_LOCATION ||
    dc?.location ||
    ''
  ).trim().toLowerCase();
}

function positiveMs(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

async function ensureHistoryTable(db) {
  if (!db?.pool?.query) throw Object.assign(new Error('DB_POOL_UNAVAILABLE'), { code: 'DB_POOL_UNAVAILABLE' });
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS server_ip_history (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      telegram_id VARCHAR(255) NULL,
      datacenter VARCHAR(64) NOT NULL,
      server_id VARCHAR(128) NOT NULL,
      ip_address VARCHAR(45) NOT NULL,
      first_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      seen_count INT UNSIGNED NOT NULL DEFAULT 1,
      last_event VARCHAR(64) NOT NULL DEFAULT 'observed',
      PRIMARY KEY (id),
      UNIQUE KEY uq_server_ip_history (datacenter, server_id, ip_address),
      KEY idx_server_ip_history_owner (telegram_id, datacenter, server_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function rememberIp(db, { telegramId, datacenter, serverId, ip, event }) {
  const normalized = normalizeIpv4(ip);
  if (!normalized) return false;
  await ensureHistoryTable(db);
  await db.pool.query(
    `INSERT INTO server_ip_history
      (telegram_id, datacenter, server_id, ip_address, last_event)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       telegram_id = COALESCE(VALUES(telegram_id), telegram_id),
       last_seen_at = CURRENT_TIMESTAMP(3),
       seen_count = seen_count + 1,
       last_event = VALUES(last_event)`,
    [String(telegramId), String(datacenter), String(serverId), normalized, String(event || 'observed').slice(0, 64)]
  );
  return true;
}

/**
 * Return IPs that should be avoided for the next allocation attempt.
 *
 * Previous behaviour blacklisted every IP ever seen by a server forever. Hetzner
 * legitimately recycles Primary IPv4 addresses from a finite pool, so after a few
 * rotations a server could become permanently unable to change IP and would emit
 * NO_UNUSED_PRIMARY_IPV4_AVAILABLE for days.
 *
 * We now block:
 *   - the currently assigned/persisted IP unconditionally;
 *   - any IP seen very recently (default 30 minutes), to avoid immediate bouncing;
 *   - known rejected/bad candidates for a longer cooldown (default 7 days).
 * Older healthy historical IPs may be reused, which keeps the pool usable without
 * immediately recycling a just-rejected address.
 */
async function usedIps(db, { datacenter, serverId, now = Date.now() }) {
  await ensureHistoryTable(db);
  const used = new Set();
  const recentCooldownMs = positiveMs(
    process.env.HETZNER_CHANGE_IP_RECENT_REUSE_COOLDOWN_MS,
    30 * 60 * 1000
  );
  const rejectedCooldownMs = positiveMs(
    process.env.HETZNER_CHANGE_IP_REJECTED_COOLDOWN_MS,
    7 * 24 * 60 * 60 * 1000
  );

  const [historyRows] = await db.pool.query(
    `SELECT ip_address, last_seen_at, last_event
       FROM server_ip_history
      WHERE datacenter = ? AND server_id = ?`,
    [String(datacenter), String(serverId)]
  );
  const [purchaseRows] = await db.pool.query(
    `SELECT DISTINCT public_ip AS ip_address FROM purchases
     WHERE datacenter = ? AND server_id = ?
       AND public_ip IS NOT NULL AND TRIM(public_ip) <> ''`,
    [String(datacenter), String(serverId)]
  );

  for (const row of purchaseRows || []) {
    const ip = normalizeIpv4(row?.ip_address);
    if (ip) used.add(ip);
  }

  const nowMs = Number(now instanceof Date ? now.getTime() : now) || Date.now();
  for (const row of historyRows || []) {
    const ip = normalizeIpv4(row?.ip_address);
    if (!ip || used.has(ip)) continue;
    const seenMs = new Date(row?.last_seen_at || 0).getTime();
    const ageMs = Number.isFinite(seenMs) && seenMs > 0 ? Math.max(0, nowMs - seenMs) : Infinity;
    const event = String(row?.last_event || '');
    const recent = ageMs <= recentCooldownMs;
    const rejectedRecently = REJECTED_HISTORY_EVENTS.has(event) && ageMs <= rejectedCooldownMs;
    if (recent || rejectedRecently) used.add(ip);
  }

  return used;
}

async function waitAction(dc, action) {
  const id = action?.id ?? action?.action?.id ?? null;
  if (!id) return null;
  return cloud.waitHetznerAction(dc, id, Number(process.env.HETZNER_CHANGE_IP_ACTION_TIMEOUT_MS || 180000));
}

async function deletePrimaryIpWithRetry(dc, primaryIpId, attempts = 4) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await cloud.deletePrimaryIp(dc, null, primaryIpId);
      return true;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(attempt * 1200);
    }
  }
  throw lastError || new Error('PRIMARY_IP_DELETE_FAILED');
}

async function reserveUniquePrimaryIpv4(db, { dc, telegramId, datacenter, serverId, location, oldIp }) {
  const maxAttempts = Math.max(1, Math.min(20, Number(process.env.HETZNER_CHANGE_IP_UNIQUE_ATTEMPTS || 8)));
  const used = await usedIps(db, { datacenter, serverId });
  if (oldIp) {
    used.add(oldIp);
    await rememberIp(db, { telegramId, datacenter, serverId, ip: oldIp, event: 'current_before_change' });
  }

  let duplicateCandidates = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let candidate;
    try {
      candidate = await cloud.createPrimaryIpv4(dc, null, location);
    } catch (cause) {
      if (duplicateCandidates > 0) {
        const error = new Error('NO_UNUSED_PRIMARY_IPV4_AVAILABLE');
        error.code = 'NO_UNUSED_PRIMARY_IPV4_AVAILABLE';
        error.cause = cause;
        error.duplicateCandidates = duplicateCandidates;
        throw error;
      }
      throw cause;
    }

    const candidateId = candidate?.id == null ? null : String(candidate.id);
    const candidateIp = normalizeIpv4(candidate?.ip);
    if (!candidateId || !candidateIp) {
      if (candidateId) await deletePrimaryIpWithRetry(dc, candidateId).catch(() => {});
      throw Object.assign(new Error('INVALID_PRIMARY_IPV4_CANDIDATE'), { code: 'INVALID_PRIMARY_IPV4_CANDIDATE' });
    }

    if (!used.has(candidateIp)) {
      await rememberIp(db, { telegramId, datacenter, serverId, ip: candidateIp, event: 'reserved_unique_candidate' });
      console.log('[HETZNER_CHANGE_IP_UNIQUE_CANDIDATE]', { server_id: String(serverId), attempt, ip: candidateIp });
      return { ...candidate, id: candidateId, ip: candidateIp };
    }

    duplicateCandidates += 1;
    used.add(candidateIp);
    await rememberIp(db, { telegramId, datacenter, serverId, ip: candidateIp, event: 'duplicate_candidate_rejected' });
    console.warn('[HETZNER_CHANGE_IP_CANDIDATE_REJECTED]', {
      server_id: String(serverId),
      attempt,
      ip: candidateIp,
      reason: 'cooldown_or_current_ip'
    });
    await deletePrimaryIpWithRetry(dc, candidateId);
  }

  const error = new Error('NO_UNUSED_PRIMARY_IPV4_AVAILABLE');
  error.code = 'NO_UNUSED_PRIMARY_IPV4_AVAILABLE';
  error.duplicateCandidates = duplicateCandidates;
  throw error;
}

async function waitForNewIp(dc, serverId, expectedIp, timeoutMs = Number(process.env.HETZNER_CHANGE_IP_READY_TIMEOUT_MS || 120000)) {
  const started = Date.now();
  let lastServer = null;
  while (Date.now() - started < timeoutMs) {
    lastServer = await hetznerApi.getHetznerServer(dc, serverId);
    const ip = currentIpv4(lastServer);
    if (String(lastServer?.status || '').toLowerCase() === 'running' && ip === expectedIp) {
      return { server: lastServer, ip };
    }
    await sleep(2500);
  }
  const error = new Error('NEW_IP_NOT_READY');
  error.code = 'NEW_IP_NOT_READY';
  error.server = lastServer;
  throw error;
}

async function rollbackSwap(dc, { serverId, oldPrimaryId, newPrimaryId, oldIp }) {
  try {
    const raw = await hetznerApi.getHetznerServer(dc, serverId).catch(() => null);
    if (String(raw?.status || '').toLowerCase() === 'running') {
      await waitAction(dc, await cloud.powerOffHetznerServer(dc, serverId));
    }
    if (newPrimaryId) {
      await waitAction(dc, await cloud.unassignPrimaryIp(dc, null, newPrimaryId)).catch(() => {});
    }
    if (oldPrimaryId) {
      await waitAction(dc, await cloud.assignPrimaryIp(dc, null, oldPrimaryId, serverId));
    }
    await waitAction(dc, await cloud.powerOnHetznerServer(dc, serverId));
    if (oldIp) await waitForNewIp(dc, serverId, oldIp);
    if (newPrimaryId) await deletePrimaryIpWithRetry(dc, newPrimaryId).catch(() => {});
    return true;
  } catch (rollbackError) {
    console.error('[HETZNER_CHANGE_IP_ROLLBACK_FAILED]', {
      server_id: String(serverId),
      message: rollbackError?.message || String(rollbackError)
    });
    return false;
  }
}

async function changeHetznerPublicIp({ db, dc, telegramId, serverId, datacenter, verifyCandidate = null }) {
  const lockKey = `${datacenter}:${serverId}`;
  if (locks.has(lockKey)) throw Object.assign(new Error('OPERATION_IN_PROGRESS'), { code: 'OPERATION_IN_PROGRESS' });
  locks.add(lockKey);

  let oldPrimaryId = null;
  let newPrimary = null;
  let oldIp = null;
  let rollbackDone = false;
  try {
    const purchase = await db.getPurchaseForOwner(telegramId, serverId, datacenter);
    if (!purchase) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
    const status = String(purchase.status || '').toLowerCase();
    if (!VALID_STATUSES.has(status)) throw Object.assign(new Error('INVALID_SERVER_STATE'), { code: 'INVALID_SERVER_STATE' });

    const server = await hetznerApi.getHetznerServer(dc, serverId);
    oldPrimaryId = primaryIpv4Id(server);
    oldIp = currentIpv4(server);
    const location = serverLocation(server, dc);
    if (!oldPrimaryId || !oldIp || !location) {
      throw Object.assign(new Error('PRIMARY_IPV4_NOT_FOUND'), { code: 'PRIMARY_IPV4_NOT_FOUND' });
    }

    newPrimary = await reserveUniquePrimaryIpv4(db, {
      dc, telegramId, datacenter, serverId, location, oldIp
    });

    await waitAction(dc, await cloud.powerOffHetznerServer(dc, serverId));
    await waitAction(dc, await cloud.unassignPrimaryIp(dc, null, oldPrimaryId));
    await waitAction(dc, await cloud.assignPrimaryIp(dc, null, newPrimary.id, serverId));
    await waitAction(dc, await cloud.powerOnHetznerServer(dc, serverId));

    const ready = await waitForNewIp(dc, serverId, newPrimary.ip);
    let verification = null;
    if (typeof verifyCandidate === 'function') {
      try {
        verification = await verifyCandidate({
          ip: ready.ip,
          server: ready.server,
          oldIp,
          serverId: String(serverId),
          datacenter: String(datacenter)
        });
      } catch (verifyError) {
        verification = {
          ok: false,
          definitive: false,
          reason: `verifier_error:${verifyError?.code || verifyError?.message || 'unknown'}`
        };
      }

      if (!verification?.ok) {
        await rememberIp(db, {
          telegramId, datacenter, serverId, ip: ready.ip,
          event: verification?.definitive ? 'candidate_verification_rejected' : 'candidate_verification_inconclusive'
        }).catch(() => {});

        rollbackDone = await rollbackSwap(dc, {
          serverId,
          oldPrimaryId,
          newPrimaryId: newPrimary.id,
          oldIp
        });
        if (rollbackDone) {
          await db.updatePublicIp(telegramId, serverId, datacenter, oldIp).catch(() => {});
        }

        const error = new Error(rollbackDone ? 'CANDIDATE_REJECTED' : 'CANDIDATE_REJECTED_ROLLBACK_FAILED');
        error.code = rollbackDone ? 'CANDIDATE_REJECTED' : 'CANDIDATE_REJECTED_ROLLBACK_FAILED';
        error.candidateIp = ready.ip;
        error.oldIp = oldIp;
        error.verification = verification;
        error.rollbackDone = rollbackDone;
        throw error;
      }
    }

    try {
      await deletePrimaryIpWithRetry(dc, oldPrimaryId);
    } catch (cleanupError) {
      rollbackDone = await rollbackSwap(dc, {
        serverId,
        oldPrimaryId,
        newPrimaryId: newPrimary.id,
        oldIp
      });
      if (rollbackDone) await db.updatePublicIp(telegramId, serverId, datacenter, oldIp).catch(() => {});
      const error = new Error('OLD_PRIMARY_IP_CLEANUP_FAILED');
      error.code = 'OLD_PRIMARY_IP_CLEANUP_FAILED';
      error.cause = cleanupError;
      error.rollbackDone = rollbackDone;
      throw error;
    }

    await db.updatePublicIp(telegramId, serverId, datacenter, ready.ip);
    await rememberIp(db, { telegramId, datacenter, serverId, ip: ready.ip, event: 'change_completed' });
    console.log('[HETZNER_CHANGE_IP_SUCCESS]', { server_id: String(serverId), old_ip: oldIp, new_ip: ready.ip });
    return { oldIp, newIp: ready.ip, verification };
  } catch (error) {
    if (!rollbackDone && !error?.rollbackDone && newPrimary?.id && oldPrimaryId && error?.code !== 'OLD_PRIMARY_IP_CLEANUP_FAILED') {
      rollbackDone = await rollbackSwap(dc, {
        serverId,
        oldPrimaryId,
        newPrimaryId: newPrimary.id,
        oldIp
      });
      if (rollbackDone && oldIp) await db.updatePublicIp(telegramId, serverId, datacenter, oldIp).catch(() => {});
    } else if (newPrimary?.id && !oldPrimaryId) {
      await deletePrimaryIpWithRetry(dc, newPrimary.id).catch(() => {});
    }
    throw error;
  } finally {
    locks.delete(lockKey);
  }
}

function userMessageForError(error) {
  const code = String(error?.code || error?.message || '');
  if (code === 'NO_UNUSED_PRIMARY_IPV4_AVAILABLE') {
    return 'Hetzner در این تلاش IP قابل استفاده‌ای خارج از cooldown برنگرداند. IP فعلی سرور بدون تغییر حفظ شد؛ لطفاً چند دقیقه بعد دوباره تلاش کنید.';
  }
  if (code === 'OPERATION_IN_PROGRESS') return 'یک عملیات دیگر روی این سرور در حال انجام است. چند لحظه بعد دوباره تلاش کنید.';
  if (code === 'INVALID_SERVER_STATE') return 'در وضعیت فعلی سرور امکان تغییر IP وجود ندارد.';
  if (code === 'PRIMARY_IPV4_NOT_FOUND') return 'اطلاعات IPv4 اصلی سرور از Hetzner دریافت نشد. لطفاً با پشتیبانی تماس بگیرید.';
  if (code === 'CANDIDATE_REJECTED') return 'IP جدید معیارهای سلامت را پاس نکرد و ربات به‌صورت خودکار IP قبلی را برگرداند.';
  if (code === 'CANDIDATE_REJECTED_ROLLBACK_FAILED') return 'IP جدید تأیید نشد و بازگردانی خودکار کامل نشد. لطفاً با پشتیبانی تماس بگیرید.';
  if (code === 'OLD_PRIMARY_IP_CLEANUP_FAILED') return 'تغییر IP کامل نشد و برای جلوگیری از هزینه یا قطعی، عملیات برگشت داده شد. لطفاً دوباره تلاش کنید.';
  if (code === 'NOT_FOUND') return 'این سرور برای حساب شما پیدا نشد.';
  return 'تغییر IP انجام نشد. IP قبلی تا حد امکان حفظ شده است؛ لطفاً کمی بعد دوباره تلاش کنید.';
}

module.exports = {
  normalizeIpv4,
  ensureHistoryTable,
  rememberIp,
  usedIps,
  reserveUniquePrimaryIpv4,
  waitForNewIp,
  rollbackSwap,
  changeHetznerPublicIp,
  userMessageForError,
};