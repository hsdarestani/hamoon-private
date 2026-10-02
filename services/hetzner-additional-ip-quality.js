'use strict';

const net = require('net');
const { Client } = require('ssh2');
const cloud = require('../cloud-api');
const hetznerApi = require('../Hetzner/hetzner-api');
const lifecycle = require('./hetzner-lifecycle');
const additionalIps = require('./hetzner-additional-ips');
const changeIp = require('./hetzner-change-ip');

const clamp = (v, d, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : d;
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function withTimeout(promise, timeoutMs, errorFactory) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(errorFactory()), Math.max(1, timeoutMs));
    Promise.resolve(promise).then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
}
const ipv4 = value => net.isIP(String(value || '').trim()) === 4 ? String(value).trim() : null;

function primaryIp(server) {
  return ipv4(server?.public_net?.ipv4?.ip || server?.public_ip || server?.ip);
}
function locationOf(server, dc = {}) {
  return String(server?.datacenter?.location?.name || server?.location?.name || server?.location ||
    dc?.HETZNER_LOCATION || dc?.location || '').trim().toLowerCase();
}
function command(script) {
  return `printf '%s' '${Buffer.from(script).toString('base64')}' | base64 -d | /bin/sh`;
}
function bindScript(ip) {
  return `set -eu
IFACE="$(ip -4 route show default | awk 'NR==1 {print $5}')"
test -n "$IFACE"
ip -4 addr show dev "$IFACE" | grep -Fq "inet ${ip}/32" || ip addr add "${ip}/32" dev "$IFACE"
`;
}
function unbindScript(ip) {
  return `set +e
IFACE="$(ip -4 route show default | awk 'NR==1 {print $5}')"
[ -z "$IFACE" ] || ip addr del "${ip}/32" dev "$IFACE" >/dev/null 2>&1 || true
`;
}

function sshExec({ host, password, command: cmd, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let done = false;
    const finish = error => {
      if (done) return;
      done = true;
      try { conn.end(); } catch (_) {}
      error ? reject(error) : resolve(true);
    };
    conn.on('ready', () => conn.exec(cmd, (error, stream) => {
      if (error) return finish(Object.assign(new Error('SSH_COMMAND_FAILED'), { code: 'SSH_COMMAND_FAILED' }));
      stream.on('error', () => finish(Object.assign(new Error('SSH_COMMAND_FAILED'), { code: 'SSH_COMMAND_FAILED' })));
      stream.on('close', code => finish(Number(code) === 0 ? null :
        Object.assign(new Error('SSH_COMMAND_FAILED'), { code: 'SSH_COMMAND_FAILED' })));
    }));
    conn.on('error', error => {
      const msg = String(error?.message || '').toLowerCase();
      const code = msg.includes('auth') ? 'SSH_AUTH_FAILED' :
        (msg.includes('timeout') ? 'SSH_TIMEOUT' : 'SSH_CONNECTION_FAILED');
      finish(Object.assign(new Error(code), { code }));
    });
    conn.connect({ host, username: 'root', password, readyTimeout: timeoutMs, tryKeyboard: false });
  });
}

function globalReady(q) {
  const selected = Number(q?.global?.selected || 0);
  const success = Number(q?.global?.success || 0);
  const ratio = Math.min(1, Math.max(0.5, Number(process.env.HETZNER_IP_QUALITY_GLOBAL_MIN_RATIO || 0.67)));
  const required = Number(q?.global?.required || Math.max(1, Math.ceil(selected * ratio)));
  return selected > 0 && success >= required;
}

async function quality(ip, check = lifecycle.checkIpQuality) {
  const tries = clamp(process.env.HETZNER_ADDITIONAL_IP_QUALITY_RECHECKS, 2, 1, 4);
  const polls = clamp(process.env.HETZNER_ADDITIONAL_IP_QUALITY_POLLS, 15, 6, 24);
  const delay = clamp(process.env.HETZNER_ADDITIONAL_IP_QUALITY_POLL_DELAY_MS, 1500, 750, 4000);
  let last = null;
  for (let i = 0; i < tries; i += 1) {
    last = await check(ip, { polls, pollDelayMs: delay });
    if (last?.ok || (last?.definitive && globalReady(last))) return last;
    if (i + 1 < tries) await sleep(2500);
  }
  return last;
}

async function serverFor(dc, serverId, request) {
  if (request) {
    const data = await request(dc, 'GET', `/servers/${encodeURIComponent(serverId)}`);
    return data?.server || null;
  }
  return hetznerApi.getHetznerServer(dc, serverId);
}

async function createVerifiedAdditionalIpv4(opts) {
  const {
    dc, serverId, telegramId, description, maxIps, request,
    db = require('../db'), getSecret, execSsh = sshExec,
    checkQuality, maxAttempts, maxDurationMs, onProgress
  } = opts;
  const startedAt = Date.now();
  const durationMs = clamp(
    maxDurationMs ?? process.env.HETZNER_ADDITIONAL_IP_MAX_DURATION_MS,
    90000,
    30000,
    180000
  );
  const deadline = startedAt + durationMs;
  const providerRequest = request || ((providerDc, method, path, body) =>
    hetznerApi.hetznerRequest(providerDc, method, path, body, {
      deadlineAt: deadline,
      timeoutMs: 15000
    })
  );
  const progress = async payload => {
    if (typeof onProgress !== 'function') return;
    try { await onProgress(payload); } catch (_) {}
  };
  const remaining = () => Math.max(0, deadline - Date.now());
  const deadlineError = () => Object.assign(new Error('ADDITIONAL_IP_SEARCH_TIMEOUT'), {
    code: 'ADDITIONAL_IP_SEARCH_TIMEOUT',
    elapsed_ms: Date.now() - startedAt
  });
  const cleanupCandidate = async created => {
    if (!created?.ip?.id) return false;
    const cleanupDeadlineAt = Date.now() + 30000;
    const cleanupRequest = request || ((providerDc, method, path, body) =>
      hetznerApi.hetznerRequest(providerDc, method, path, body, {
        deadlineAt: cleanupDeadlineAt,
        timeoutMs: 10000
      })
    );
    await additionalIps.deleteAdditionalIp({
      dc,
      serverId,
      floatingIpId: created.ip.id,
      request: cleanupRequest,
      waitAction: async actionId => {
        const remainingCleanup = Math.max(0, cleanupDeadlineAt - Date.now());
        if (remainingCleanup <= 0) throw deadlineError();
        await cloud.waitHetznerAction(
          dc,
          actionId,
          Math.max(3000, Math.min(20000, remainingCleanup))
        );
      }
    });
    return true;
  };

  let server;
  try {
    server = await serverFor(dc, serverId, providerRequest);
  } catch (error) {
    if (error?.code === 'HETZNER_API_DEADLINE_EXCEEDED') throw deadlineError();
    throw error;
  }
  const host = primaryIp(server);
  const location = locationOf(server, dc);
  if (!server?.id || !host || !location) {
    throw Object.assign(new Error('ADDITIONAL_IP_QUALITY_VERIFY_UNAVAILABLE'), {
      code: 'ADDITIONAL_IP_QUALITY_VERIFY_UNAVAILABLE',
      cause: Object.assign(new Error('SERVER_METADATA_MISSING'), { code: 'SERVER_METADATA_MISSING' })
    });
  }
  const password = await (getSecret || (id => db.getServerSecret(id, 'root_password')))(serverId);
  if (!password) {
    throw Object.assign(new Error('ADDITIONAL_IP_QUALITY_VERIFY_UNAVAILABLE'), {
      code: 'ADDITIONAL_IP_QUALITY_VERIFY_UNAVAILABLE',
      cause: Object.assign(new Error('ROOT_PASSWORD_MISSING'), { code: 'ROOT_PASSWORD_MISSING' })
    });
  }

  const attempts = clamp(maxAttempts ?? process.env.HETZNER_ADDITIONAL_IP_CLEAN_ATTEMPTS, 8, 1, 12);
  const blocked = await changeIp.recentBadRanges(db, { location }).catch(() => new Set());
  let last = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (remaining() <= 0) throw deadlineError();
    await progress({ stage: 'attempt_start', attempt, attempts, remaining_ms: remaining() });

    let created = null;
    let bound = false;
    try {
      created = await additionalIps.addAdditionalIpv4({
        dc,
        serverId,
        description,
        maxIps,
        request: providerRequest
      });
      const actionId = created?.action?.id ?? created?.action?.action?.id;
      if (actionId) {
        if (remaining() <= 0) throw deadlineError();
        await cloud.waitHetznerAction(dc, actionId, Math.max(5000, Math.min(45000, remaining())));
      }

      const ip = ipv4(created?.ip?.ip);
      if (!ip) throw Object.assign(new Error('FLOATING_IP_CREATE_FAILED'), { code: 'FLOATING_IP_CREATE_FAILED' });
      const range = changeIp.ipv4Range24(ip);
      if (range && blocked.has(range)) {
        await cleanupCandidate(created);
        continue;
      }

      if (remaining() <= 0) throw deadlineError();
      await execSsh({
        host,
        password,
        command: command(bindScript(ip)),
        timeoutMs: Math.max(5000, Math.min(20000, remaining()))
      });
      bound = true;
      await progress({ stage: 'quality_check', attempt, attempts, ip, remaining_ms: remaining() });
      if (remaining() <= 0) throw deadlineError();
      last = await withTimeout(
        quality(ip, checkQuality),
        remaining(),
        deadlineError
      );

      if (last?.ok) {
        console.log('[HETZNER_ADDITIONAL_IP_CLEAN_SUCCESS]', {
          user_id: String(telegramId || ''), server_id: String(serverId),
          floating_ip_id: String(created.ip.id), attempt, ip, location,
          quality: lifecycle.qualitySummary(last)
        });
        await progress({ stage: 'success', attempt, attempts, ip, remaining_ms: remaining() });
        return { ...created, verified: true, attempts: attempt, quality: last };
      }

      if (last?.definitive && globalReady(last)) {
        await changeIp.rememberBadRange(db, {
          location, ip, reason: last?.reason || 'additional_ip_quality_failed'
        }).catch(() => {});
        if (range) blocked.add(range);
      }
      console.warn('[HETZNER_ADDITIONAL_IP_QUALITY_REJECTED]', {
        server_id: String(serverId), attempt, ip, location,
        definitive: Boolean(last?.definitive), reason: last?.reason || 'unknown'
      });
      await progress({
        stage: 'candidate_rejected',
        attempt,
        attempts,
        ip,
        reason: last?.reason || 'unknown',
        remaining_ms: remaining()
      });

      await execSsh({ host, password, command: command(unbindScript(ip)), timeoutMs: 15000 }).catch(() => {});
      bound = false;
      await cleanupCandidate(created);
    } catch (error) {
      if (created?.ip?.id) {
        if (bound && created?.ip?.ip) {
          await execSsh({
            host, password, command: command(unbindScript(created.ip.ip)), timeoutMs: 15000
          }).catch(() => {});
        }
        await cleanupCandidate(created).catch(cleanupError => {
          console.warn('[HETZNER_ADDITIONAL_IP_CLEANUP_FAILED]', {
            server_id: String(serverId),
            floating_ip_id: String(created.ip.id),
            code: cleanupError?.code || null,
            message: String(cleanupError?.message || cleanupError).slice(0, 160)
          });
        });
      }
      if (error?.code === 'ADDITIONAL_IP_SEARCH_TIMEOUT') throw error;
      if (error?.code === 'HETZNER_API_DEADLINE_EXCEEDED') throw deadlineError();
      if (String(error?.code || '').startsWith('SSH_')) {
        throw Object.assign(new Error('ADDITIONAL_IP_QUALITY_VERIFY_UNAVAILABLE'), {
          code: 'ADDITIONAL_IP_QUALITY_VERIFY_UNAVAILABLE',
          cause: error
        });
      }
      throw error;
    }
  }

  if (remaining() <= 0) throw deadlineError();
  throw Object.assign(new Error('NO_CLEAN_ADDITIONAL_IPV4_AVAILABLE'), {
    code: 'NO_CLEAN_ADDITIONAL_IPV4_AVAILABLE',
    attempts,
    quality: last
  });
}

async function deleteVerifiedAdditionalIp(opts) {
  const {
    dc, serverId, floatingIpId, request,
    db = require('../db'), getSecret, execSsh = sshExec
  } = opts;
  const call = request || ((...args) => hetznerApi.hetznerRequest(...args));
  try {
    const [floatingData, server] = await Promise.all([
      call(dc, 'GET', `/floating_ips/${encodeURIComponent(floatingIpId)}`),
      serverFor(dc, serverId, request)
    ]);
    const floating = floatingData?.floating_ip;
    const host = primaryIp(server);
    const password = host
      ? await (getSecret || (id => db.getServerSecret(id, 'root_password')))(serverId).catch(() => null)
      : null;
    if (floating?.ip && String(floating?.server?.id || '') === String(serverId) && host && password) {
      await execSsh({
        host, password, command: command(unbindScript(floating.ip)), timeoutMs: 30000
      }).catch(() => {});
    }
  } catch (_) {}

  return additionalIps.deleteAdditionalIp({ dc, serverId, floatingIpId, request });
}

module.exports = {
  globalReady,
  quality,
  createVerifiedAdditionalIpv4,
  deleteVerifiedAdditionalIp
};
