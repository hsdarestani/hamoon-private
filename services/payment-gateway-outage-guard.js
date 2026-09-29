'use strict';

const { postToZibal } = require('./zibal-gateway');

const GATEWAY = 'zibal';
const INVALID_HEALTHCHECK_MERCHANT = '__hamoon_zibal_healthcheck_invalid__';
let memoryCache = null;

function intEnv(name, fallback, min, max) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function asDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function mysqlDate(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function sanitizeError(error) {
  const value = String(
    error?.code ||
    error?.response?.data?.message ||
    error?.response?.status ||
    error?.message ||
    error ||
    'unknown'
  );
  return value.replace(/[\r\n\t]+/g, ' ').slice(0, 500);
}

async function ensureSchema(pool) {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS payment_gateway_health (" +
    "gateway VARCHAR(32) NOT NULL PRIMARY KEY," +
    "status VARCHAR(24) NOT NULL DEFAULT 'unknown'," +
    "outage_started_at DATETIME NULL," +
    "recovered_at DATETIME NULL," +
    "grace_until DATETIME NULL," +
    "last_checked_at DATETIME NULL," +
    "last_error VARCHAR(500) NULL," +
    "updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
  );
}

async function loadState(pool) {
  const [rows] = await pool.execute(
    'SELECT gateway,status,outage_started_at,recovered_at,grace_until,last_checked_at,last_error FROM payment_gateway_health WHERE gateway=? LIMIT 1',
    [GATEWAY]
  );
  return rows[0] || null;
}

function toProtection(row, now = new Date()) {
  const nowMs = now.getTime();
  const status = String(row?.status || 'unknown').toLowerCase();
  const graceUntil = asDate(row?.grace_until);
  const outageStartedAt = asDate(row?.outage_started_at);
  const recoveredAt = asDate(row?.recovered_at);
  const inOutage = status === 'outage';
  const inRecoveryGrace = status === 'healthy' && graceUntil && graceUntil.getTime() > nowMs;

  return {
    protected: Boolean(inOutage || inRecoveryGrace),
    mode: inOutage ? 'outage' : (inRecoveryGrace ? 'recovery_grace' : 'healthy'),
    status,
    outageStartedAt,
    recoveredAt,
    graceUntil,
    lastCheckedAt: asDate(row?.last_checked_at),
    lastError: row?.last_error || null
  };
}

async function persistState(pool, state) {
  await pool.execute(
    "INSERT INTO payment_gateway_health " +
    "(gateway,status,outage_started_at,recovered_at,grace_until,last_checked_at,last_error) " +
    "VALUES (?,?,?,?,?,?,?) " +
    "ON DUPLICATE KEY UPDATE " +
    "status=VALUES(status),outage_started_at=VALUES(outage_started_at)," +
    "recovered_at=VALUES(recovered_at),grace_until=VALUES(grace_until)," +
    "last_checked_at=VALUES(last_checked_at),last_error=VALUES(last_error)",
    [
      GATEWAY,
      state.status,
      state.outageStartedAt ? mysqlDate(state.outageStartedAt) : null,
      state.recoveredAt ? mysqlDate(state.recoveredAt) : null,
      state.graceUntil ? mysqlDate(state.graceUntil) : null,
      mysqlDate(state.lastCheckedAt),
      state.lastError || null
    ]
  );
}

async function probeZibal(axios) {
  const response = await postToZibal(
    axios,
    '/v1/request',
    {
      merchant: INVALID_HEALTHCHECK_MERCHANT,
      amount: 10000,
      callbackUrl: 'https://pay.hamooncloud.ir/zibal/callback'
    },
    {
      timeoutMs: intEnv('ZIBAL_BILLING_GUARD_PROBE_TIMEOUT_MS', 8000, 2000, 20000),
      maxAttempts: 2
    }
  );

  return {
    ok: true,
    gatewayIp: response?.zibalGatewayIp || null,
    result: response?.data?.result ?? null
  };
}

async function getZibalBillingProtection({ pool, axios, force = false, now = new Date() }) {
  if (!pool) throw new Error('ZIBAL_BILLING_GUARD_POOL_REQUIRED');
  if (!axios) throw new Error('ZIBAL_BILLING_GUARD_AXIOS_REQUIRED');

  const nowMs = now.getTime();
  const memoryTtlMs = intEnv('ZIBAL_BILLING_GUARD_CACHE_MS', 60000, 5000, 300000);

  if (!force && memoryCache && nowMs - memoryCache.checkedAtMs < memoryTtlMs) {
    return memoryCache.value;
  }

  await ensureSchema(pool);
  const existing = await loadState(pool);

  const existingCheckedAt = asDate(existing?.last_checked_at);
  if (
    !force &&
    existingCheckedAt &&
    nowMs - existingCheckedAt.getTime() >= 0 &&
    nowMs - existingCheckedAt.getTime() < memoryTtlMs
  ) {
    const value = toProtection(existing, now);
    memoryCache = { checkedAtMs: nowMs, value };
    return value;
  }

  let probeError = null;
  try {
    await probeZibal(axios);
  } catch (error) {
    probeError = error;
  }

  if (probeError) {
    const outageStartedAt =
      String(existing?.status || '').toLowerCase() === 'outage'
        ? (asDate(existing?.outage_started_at) || now)
        : now;

    const next = {
      status: 'outage',
      outageStartedAt,
      recoveredAt: null,
      graceUntil: null,
      lastCheckedAt: now,
      lastError: sanitizeError(probeError)
    };

    await persistState(pool, next);
    const value = toProtection(next, now);
    memoryCache = { checkedAtMs: nowMs, value };
    return value;
  }

  const graceMinutes = intEnv('ZIBAL_RECOVERY_BILLING_GRACE_MINUTES', 360, 15, 1440);
  const wasOutage = String(existing?.status || '').toLowerCase() === 'outage';
  const existingGraceUntil = asDate(existing?.grace_until);
  let graceUntil = existingGraceUntil && existingGraceUntil.getTime() > nowMs
    ? existingGraceUntil
    : null;
  let recoveredAt = asDate(existing?.recovered_at);

  if (wasOutage) {
    recoveredAt = now;
    graceUntil = new Date(nowMs + graceMinutes * 60 * 1000);
  }

  const next = {
    status: 'healthy',
    outageStartedAt: null,
    recoveredAt,
    graceUntil,
    lastCheckedAt: now,
    lastError: null
  };

  await persistState(pool, next);
  const value = toProtection(next, now);
  memoryCache = { checkedAtMs: nowMs, value };
  return value;
}

function invalidateZibalBillingProtectionCache() {
  memoryCache = null;
}

module.exports = {
  ensureSchema,
  probeZibal,
  getZibalBillingProtection,
  invalidateZibalBillingProtectionCache
};
