'use strict';

const net = require('net');
const { spawn } = require('child_process');
const path = require('path');
const cloud = require('../cloud-api');
const hetznerApi = require('../Hetzner/hetzner-api');
const lifecycle = require('./hetzner-lifecycle');
const additionalIps = require('./hetzner-additional-ips');
const changeIp = require('./hetzner-change-ip');
const networkOps = require('./hetzner-network-operation-lock');

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

async function waitForCandidateTcp(ip, timeoutMs = 7000) {
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 7000);
  while (Date.now() < deadline) {
    const ok = await new Promise(resolve => {
      const socket = net.createConnection({ host: ip, port: 22 });
      let done = false;
      const finish = value => {
        if (done) return;
        done = true;
        try { socket.destroy(); } catch (_) {}
        resolve(value);
      };
      socket.setTimeout(1200, () => finish(false));
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
    });
    if (ok) return true;
    await sleep(450);
  }
  return false;
}

function alternateHomeLocations(location) {
  const current = String(location || '').toLowerCase();
  const eu = ['nbg1', 'fsn1', 'hel1'];
  if (!eu.includes(current)) return [current].filter(Boolean);
  return [current, ...eu.filter(x => x !== current)];
}

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
    const effectiveTimeout = Math.max(1500, Number(timeoutMs) || 30000);
    const helper = path.join(__dirname, '..', 'scripts', 'ssh-exec-helper.js');
    const child = spawn(process.execPath, [helper], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HAMOON_SSH_HELPER: '1' }
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { child.stdin.end(); } catch (_) {}
      if (error) reject(error);
      else resolve(value);
    };

    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      finish(Object.assign(new Error('SSH_TIMEOUT'), {
        code: 'SSH_TIMEOUT',
        helper_message: 'parent_hard_timeout'
      }));
    }, effectiveTimeout + 2500);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += String(chunk);
      if (stdout.length > 8192) stdout = stdout.slice(-8192);
    });
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });

    child.on('error', error => {
      finish(Object.assign(new Error('SSH_HELPER_FAILED'), {
        code: 'SSH_HELPER_FAILED',
        cause: error
      }));
    });

    child.on('close', code => {
      let result = null;
      try {
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        result = JSON.parse(lines[lines.length - 1] || '{}');
      } catch (_) {}

      if (Number(code) === 0 && result?.ok) return finish(null, true);

      const resultCode = String(result?.code || '');
      const errorCode = resultCode.startsWith('SSH_')
        ? resultCode
        : (Number(code) === 124 ? 'SSH_TIMEOUT' : 'SSH_CONNECTION_FAILED');

      finish(Object.assign(new Error(errorCode), {
        code: errorCode,
        helper_exit: Number(code),
        helper_message: String(result?.message || stderr || '').slice(0, 300)
      }));
    });

    child.stdin.end(JSON.stringify({
      host: String(host || ''),
      password: String(password || ''),
      command: String(cmd || ''),
      timeoutMs: effectiveTimeout
    }));
  });
}

function globalReady(q) {
  const selected = Number(q?.global?.selected || 0);
  const success = Number(q?.global?.success || 0);
  const ratio = Math.min(1, Math.max(0.5, Number(process.env.HETZNER_IP_QUALITY_GLOBAL_MIN_RATIO || 0.67)));
  const required = Number(q?.global?.required || Math.max(1, Math.ceil(selected * ratio)));
  return selected > 0 && success >= required;
}

function regionAllFailed(region) {
  const selected = Number(region?.selected || 0);
  const completed = Number(region?.completed || 0);
  const success = Number(region?.success || 0);
  return selected > 0 && completed >= selected && success === 0;
}

function iranStillPending(q) {
  const selected = Number(q?.iran?.selected || 0);
  const completed = Number(q?.iran?.completed || 0);
  const required = Number(q?.iran?.required || 0);
  const success = Number(q?.iran?.success || 0);
  return selected > 0 && completed < selected && success < Math.max(1, required);
}

async function quality(ip, check = lifecycle.checkIpQuality) {
  const fastPolls = clamp(process.env.HETZNER_ADDITIONAL_IP_FAST_POLLS, 4, 2, 8);
  const fastDelay = clamp(process.env.HETZNER_ADDITIONAL_IP_FAST_POLL_DELAY_MS, 650, 350, 1500);
  const fullPolls = clamp(process.env.HETZNER_ADDITIONAL_IP_QUALITY_POLLS, 7, 4, 14);
  const fullDelay = clamp(process.env.HETZNER_ADDITIONAL_IP_QUALITY_POLL_DELAY_MS, 800, 500, 1800);

  let fast = await check(ip, {
    iranCount: 3,
    iranMin: 2,
    globalCount: 3,
    globalRatio: 0.67,
    polls: fastPolls,
    pollDelayMs: fastDelay
  });

  // A brand-new Floating IP can need a moment before every route/probe sees it.
  // If the first tiny sample is completely dark or incomplete, retry that same
  // IP once instead of deleting it and paying the provider/API cost of another candidate.
  if (!fast?.ok && (regionAllFailed(fast?.iran) && regionAllFailed(fast?.global) || !fast?.definitive)) {
    await sleep(1200);
    fast = await check(ip, {
      iranCount: 3,
      iranMin: 2,
      globalCount: 3,
      globalRatio: 0.67,
      polls: fastPolls,
      pollDelayMs: fastDelay
    });
  }

  // Clearly dead on both sides: reject cheaply without a 12-node confirmation.
  if (!fast?.ok && regionAllFailed(fast?.iran) && regionAllFailed(fast?.global)) {
    return { ...fast, phase: 'fast_reject' };
  }

  // If the global side is definitively dead, the address is not deliverable.
  if (!fast?.ok && fast?.definitive && regionAllFailed(fast?.global)) {
    return { ...fast, phase: 'fast_reject' };
  }

  // Any promising or inconclusive candidate gets one full confirmation.
  let full = await check(ip, {
    iranCount: 6,
    iranMin: 3,
    globalCount: 6,
    globalRatio: 0.67,
    polls: fullPolls,
    pollDelayMs: fullDelay
  });
  if (full?.ok) return { ...full, phase: 'full_confirm' };

  // Important: when the outside world is good but Iran nodes simply have not
  // answered yet, keep the same candidate briefly and recheck it. This avoids
  // throwing away a potentially clean IP merely because the Iran probe was slow.
  if (!full?.definitive && globalReady(full) && iranStillPending(full)) {
    await sleep(1800);
    full = await check(ip, {
      iranCount: 6,
      iranMin: 3,
      globalCount: 6,
      globalRatio: 0.67,
      polls: fullPolls,
      pollDelayMs: fullDelay
    });
  }

  return { ...full, phase: 'full_confirm' };
}

async function serverFor(dc, serverId, request) {
  if (request) {
    const data = await request(dc, 'GET', `/servers/${encodeURIComponent(serverId)}`);
    return data?.server || null;
  }
  return hetznerApi.getHetznerServer(dc, serverId);
}

async function createVerifiedAdditionalIpv4Unlocked(opts) {
  const {
    dc, serverId, telegramId, description, maxIps, request,
    db = require('../db'), getSecret, execSsh = sshExec,
    checkQuality, maxAttempts, maxDurationMs, onProgress
  } = opts;
  const startedAt = Date.now();
  const durationMs = clamp(
    maxDurationMs ?? process.env.HETZNER_ADDITIONAL_IP_MAX_DURATION_MS,
    300000,
    60000,
    600000
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
    const cleanupDeadlineAt = Date.now() + 20000;
    const cleanupRequest = request || ((providerDc, method, path, body) =>
      hetznerApi.hetznerRequest(providerDc, method, path, body, {
        deadlineAt: cleanupDeadlineAt,
        timeoutMs: 8000
      })
    );
    await additionalIps.deleteAdditionalIp({
      dc,
      serverId,
      floatingIpId: created.ip.id,
      request: cleanupRequest,
      unassignTimeoutMs: Math.max(3000, Math.min(8000, cleanupDeadlineAt - Date.now())),
      pollDelayMs: 800
    });
    return true;
  };
  const cleanupCandidateBestEffort = async created => {
    try {
      return await cleanupCandidate(created);
    } catch (cleanupError) {
      console.warn('[HETZNER_ADDITIONAL_IP_CLEANUP_DEFERRED]', {
        server_id: String(serverId),
        floating_ip_id: String(created?.ip?.id || ''),
        code: cleanupError?.code || null,
        message: String(cleanupError?.message || cleanupError).slice(0, 160)
      });
      return false;
    }
  };

  let server;
  try {
    server = await serverFor(dc, serverId, providerRequest);
  } catch (error) {
    if (error?.code === 'HETZNER_API_DEADLINE_EXCEEDED') throw deadlineError();
    throw error;
  }
  let host = primaryIp(server);
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

  // Do not create or bill a new Floating IP until the VM is actually ready
  // for authenticated SSH. A Primary-IP change can report "running" several
  // minutes before DHCP/network/sshd inside the guest is fully usable.
  // Refresh provider state on every round so we never keep probing a stale
  // Primary IPv4 after a recent Change-IP operation.
  let sshHost = null;
  let lastSshError = null;
  let probeRound = 0;
  const sshReadyWindowMs = clamp(
    process.env.HETZNER_ADDITIONAL_IP_SSH_READY_WINDOW_MS,
    210000,
    30000,
    300000
  );
  const sshReadyDeadline = Math.min(deadline, Date.now() + sshReadyWindowMs);

  while (!sshHost && Date.now() < sshReadyDeadline && remaining() > 0) {
    probeRound += 1;

    try {
      const latestServer = await serverFor(dc, serverId, providerRequest);
      if (latestServer?.id) {
        server = latestServer;
        host = primaryIp(latestServer) || host;
      }
    } catch (error) {
      if (error?.code === 'HETZNER_API_DEADLINE_EXCEEDED') throw deadlineError();
    }

    const existingAdditional = await additionalIps.listAdditionalIps({
      dc,
      serverId,
      request: providerRequest
    }).catch(() => []);

    const sshHosts = [...new Set([
      host,
      ...existingAdditional.map(item => ipv4(item?.ip)).filter(Boolean)
    ].filter(Boolean))];

    if (probeRound === 1 || probeRound % 4 === 0) {
      await progress({
        stage: 'ssh_wait',
        round: probeRound,
        primary_ip: host,
        candidate_count: sshHosts.length,
        remaining_ms: Math.max(0, sshReadyDeadline - Date.now())
      });
    }

    for (const candidateHost of sshHosts) {
      const readinessRemaining = Math.max(0, sshReadyDeadline - Date.now());
      const probeTimeoutMs = Math.min(7000, remaining(), readinessRemaining);
      if (probeTimeoutMs < 1500) break;

      try {
        await withTimeout(
          execSsh({
            host: candidateHost,
            password,
            command: command('true\n'),
            timeoutMs: probeTimeoutMs
          }),
          probeTimeoutMs + 750,
          () => Object.assign(new Error('SSH_TIMEOUT'), { code: 'SSH_TIMEOUT' })
        );
        sshHost = candidateHost;
        console.log('[HETZNER_ADDITIONAL_IP_SSH_ROUTE_SELECTED]', {
          server_id: String(serverId),
          host: candidateHost,
          primary_ip: host,
          fallback: candidateHost !== host,
          candidate_count: sshHosts.length,
          round: probeRound
        });
        break;
      } catch (error) {
        lastSshError = error;
        console.warn('[HETZNER_ADDITIONAL_IP_SSH_ROUTE_FAILED]', {
          server_id: String(serverId),
          host: candidateHost,
          primary_ip: host,
          fallback: candidateHost !== host,
          code: error?.code || null,
          round: probeRound
        });

        // Authentication errors are not boot-readiness races. Retrying them for
        // minutes only delays the useful error shown to the customer.
        if (error?.code === 'SSH_AUTH_FAILED') break;
      }
    }

    if (lastSshError?.code === 'SSH_AUTH_FAILED') break;
    if (!sshHost && Date.now() < sshReadyDeadline && remaining() > 3500) {
      await sleep(3000);
    }
  }

  if (!sshHost) {
    const cause = lastSshError || Object.assign(new Error('SSH_CONNECTION_FAILED'), { code: 'SSH_CONNECTION_FAILED' });
    throw Object.assign(new Error('ADDITIONAL_IP_QUALITY_VERIFY_UNAVAILABLE'), {
      code: 'ADDITIONAL_IP_QUALITY_VERIFY_UNAVAILABLE',
      cause,
      waited_ms: Math.min(sshReadyWindowMs, Date.now() - startedAt)
    });
  }

  const attempts = clamp(maxAttempts ?? process.env.HETZNER_ADDITIONAL_IP_CLEAN_ATTEMPTS, 6, 1, 10);
  const blocked = await changeIp.recentBadRanges(db, { location }).catch(() => new Set());
  const homeLocations = alternateHomeLocations(location);
  const seenIps = new Set();
  const seenRanges = new Set();
  const maxProviderDraws = Math.max(attempts, attempts * 4);
  let providerDraws = 0;
  let last = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (remaining() <= 0) throw deadlineError();
    providerDraws += 1;
    if (providerDraws > maxProviderDraws) break;

    let created = null;
    let bound = false;
    try {
      const candidateHomeLocation = homeLocations[(attempt - 1) % homeLocations.length] || location;
      created = await additionalIps.addAdditionalIpv4({
        dc,
        serverId,
        description,
        maxIps,
        request: providerRequest,
        homeLocation: candidateHomeLocation !== location ? candidateHomeLocation : undefined
      });
      const actionId = created?.action?.id ?? created?.action?.action?.id;
      const createdServerId = String(created?.ip?.server_id || '');
      console.log('[HETZNER_ADDITIONAL_IP_CREATED]', {
        user_id: String(telegramId || ''),
        server_id: String(serverId),
        floating_ip_id: String(created?.ip?.id || ''),
        provider_server_id: createdServerId || null,
        action_id: actionId == null ? null : String(actionId),
        home_location: created?.ip?.home_location || candidateHomeLocation || null,
        attempt
      });

      // Hetzner often returns the Floating IP already assigned to the requested
      // server even while an action object is present. Waiting on that action
      // used to strand the Telegram flow despite the IP already existing.
      // Only wait when the response does not yet show the expected assignment.
      if (actionId && createdServerId !== String(serverId)) {
        if (remaining() <= 0) throw deadlineError();
        try {
          await cloud.waitHetznerAction(
            dc,
            actionId,
            Math.max(5000, Math.min(30000, remaining()))
          );
        } catch (error) {
          if (error?.code === 'HETZNER_ACTION_TIMEOUT' || error?.code === 'HETZNER_API_DEADLINE_EXCEEDED') {
            throw deadlineError();
          }
          throw error;
        }
      }

      const ip = ipv4(created?.ip?.ip);
      if (!ip) throw Object.assign(new Error('FLOATING_IP_CREATE_FAILED'), { code: 'FLOATING_IP_CREATE_FAILED' });
      const range = changeIp.ipv4Range24(ip);
      const duplicateInRequest = seenIps.has(ip) || Boolean(range && seenRanges.has(range));
      const knownBadRange = Boolean(range && blocked.has(range));
      if (duplicateInRequest || knownBadRange) {
        console.warn('[HETZNER_ADDITIONAL_IP_CANDIDATE_SKIPPED]', {
          server_id: String(serverId),
          attempt,
          provider_draw: providerDraws,
          ip,
          range: range || null,
          reason: duplicateInRequest ? 'duplicate_in_request' : 'known_bad_range'
        });
        await cleanupCandidateBestEffort(created);
        attempt -= 1;
        continue;
      }

      seenIps.add(ip);
      if (range) seenRanges.add(range);

      if (remaining() <= 0) throw deadlineError();
      await progress({ stage: 'attempt_start', attempt, attempts, ip, remaining_ms: remaining() });
      await progress({ stage: 'os_config', attempt, attempts, ip, remaining_ms: remaining() });
      console.log('[HETZNER_ADDITIONAL_IP_BIND_START]', {
        server_id: String(serverId),
        floating_ip_id: String(created.ip.id),
        ip,
        attempt
      });
      let bindError = null;
      for (let bindAttempt = 1; bindAttempt <= 2; bindAttempt += 1) {
        const bindTimeoutMs = Math.max(5000, Math.min(15000, remaining()));
        try {
          await withTimeout(
            execSsh({
              host: sshHost,
              password,
              command: command(bindScript(ip)),
              timeoutMs: bindTimeoutMs
            }),
            bindTimeoutMs + 1000,
            () => Object.assign(new Error('SSH_TIMEOUT'), { code: 'SSH_TIMEOUT' })
          );
          bindError = null;
          break;
        } catch (error) {
          bindError = error;
          console.warn('[HETZNER_ADDITIONAL_IP_BIND_RETRY]', {
            server_id: String(serverId),
            floating_ip_id: String(created.ip.id),
            ip,
            attempt,
            bind_attempt: bindAttempt,
            code: error?.code || null
          });
          if (bindAttempt < 2 && remaining() > 1500) await sleep(1500);
        }
      }
      if (bindError) throw bindError;
      bound = true;
      console.log('[HETZNER_ADDITIONAL_IP_BIND_SUCCESS]', {
        server_id: String(serverId),
        floating_ip_id: String(created.ip.id),
        ip,
        attempt
      });

      // Wait only for cheap TCP readiness before spending Check-Host probes.
      // This prevents immediate 0/6 + 0/6 results while Hetzner's Floating-IP
      // route is still propagating after assignment.
      const routeReady = await waitForCandidateTcp(
        ip,
        Math.max(1500, Math.min(6500, remaining()))
      );
      console.log('[HETZNER_ADDITIONAL_IP_ROUTE_READY]', {
        server_id: String(serverId),
        ip,
        attempt,
        ready: routeReady
      });

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
      const qualitySummary = lifecycle.qualitySummary(last);
      console.warn('[HETZNER_ADDITIONAL_IP_QUALITY_REJECTED]', {
        server_id: String(serverId), attempt, ip, location,
        definitive: Boolean(last?.definitive),
        reason: last?.reason || 'unknown',
        quality: qualitySummary,
        iran: last?.iran || null,
        global: last?.global || null
      });
      await progress({
        stage: 'candidate_rejected',
        attempt,
        attempts,
        ip,
        reason: last?.reason || 'unknown',
        quality_summary: qualitySummary,
        iran: last?.iran || null,
        global: last?.global || null,
        remaining_ms: remaining()
      });

      await withTimeout(
        execSsh({ host: sshHost, password, command: command(unbindScript(ip)), timeoutMs: 10000 }),
        11000,
        () => Object.assign(new Error('SSH_TIMEOUT'), { code: 'SSH_TIMEOUT' })
      ).catch(() => {});
      bound = false;
      await cleanupCandidateBestEffort(created);
    } catch (error) {
      if (created?.ip?.id) {
        if (bound && created?.ip?.ip) {
          await withTimeout(
            execSsh({
              host: sshHost, password, command: command(unbindScript(created.ip.ip)), timeoutMs: 10000
            }),
            11000,
            () => Object.assign(new Error('SSH_TIMEOUT'), { code: 'SSH_TIMEOUT' })
          ).catch(() => {});
        }
        await cleanupCandidateBestEffort(created);
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

async function createVerifiedAdditionalIpv4(opts) {
  const lock = networkOps.acquire({
    dc: opts?.dc,
    datacenter: opts?.datacenter,
    serverId: opts?.serverId,
    operation: 'add_ip'
  });
  try {
    return await createVerifiedAdditionalIpv4Unlocked(opts);
  } finally {
    networkOps.release(lock);
  }
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
