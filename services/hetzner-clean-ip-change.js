'use strict';

const net = require('net');
const base = require('./hetzner-change-ip');
const lifecycle = require('./hetzner-lifecycle');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function qualityGlobalReady(quality) {
  const selected = Number(quality?.global?.selected || 0);
  const success = Number(quality?.global?.success || 0);
  const configuredRatio = Math.min(1, Math.max(0.5, Number(process.env.HETZNER_IP_QUALITY_GLOBAL_MIN_RATIO || 0.67)));
  const required = Number(quality?.global?.required || Math.max(1, Math.ceil(selected * configuredRatio)));
  return selected > 0 && success >= required;
}

function tcpProbeOnce(ip, port, timeoutMs) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: ip, port });
    let settled = false;
    const finish = (ok, reason) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, reason });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true, 'connected'));
    socket.once('timeout', () => finish(false, 'timeout'));
    socket.once('error', error => finish(false, error?.code || error?.message || 'error'));
  });
}

async function probeSshReachability(ip, options = {}) {
  const attempts = clampInt(options.attempts ?? process.env.HETZNER_CHANGE_IP_SSH_PROBE_ATTEMPTS, 6, 1, 12);
  const timeoutMs = clampInt(options.timeoutMs ?? process.env.HETZNER_CHANGE_IP_SSH_PROBE_TIMEOUT_MS, 8000, 1000, 15000);
  const settleMs = clampInt(options.settleMs ?? process.env.HETZNER_CHANGE_IP_SSH_SETTLE_MS, 6000, 0, 30000);
  const retryDelayMs = clampInt(options.retryDelayMs ?? process.env.HETZNER_CHANGE_IP_SSH_RETRY_DELAY_MS, 5000, 500, 15000);
  const port = clampInt(options.port ?? process.env.HETZNER_CHANGE_IP_SSH_PORT, 22, 1, 65535);
  let last = null;

  if (settleMs > 0) await sleep(settleMs);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await tcpProbeOnce(ip, port, timeoutMs);
    if (last.ok) return { ...last, attempts: attempt, port };
    if (attempt < attempts) await sleep(retryDelayMs);
  }
  return { ...(last || { ok: false, reason: 'unknown' }), attempts, port };
}

async function probeIranQuality(ip) {
  // A Primary IPv4 swap includes a power cycle. Give the guest network a short
  // fixed settle window before asking external probes.
  const settleMs = clampInt(process.env.HETZNER_CHANGE_IP_QUALITY_SETTLE_MS, 6000, 0, 30000);
  if (settleMs > 0) await sleep(settleMs);

  const probeAttempts = clampInt(process.env.HETZNER_CHANGE_IP_QUALITY_PROBE_ATTEMPTS, 1, 1, 3);
  const polls = clampInt(process.env.HETZNER_CHANGE_IP_QUALITY_POLLS, 15, 6, 24);
  const pollDelayMs = clampInt(process.env.HETZNER_CHANGE_IP_QUALITY_POLL_DELAY_MS, 1500, 750, 4000);
  let last = null;
  for (let attempt = 1; attempt <= probeAttempts; attempt += 1) {
    last = await lifecycle.checkIpQuality(ip, { polls, pollDelayMs });
    if (last?.ok || last?.definitive) return last;
    if (attempt < probeAttempts) await sleep(2500);
  }
  return last;
}

async function verifyCleanCandidate(ip, args = {}) {
  // Quality-first remains the fast path: when the global quorum can already see
  // the address but Iran cannot, the IP is definitively dirty and we reject it
  // without burning time on SSH. When *global and Iran are both dead* directly
  // after the Hetzner power-cycle, however, that is a guest/network-readiness
  // signal, not evidence that the IP is filtered in Iran. Wait briefly for the
  // guest, then re-run the quality probe before deciding.
  const qualityProbe = typeof args.qualityProbe === 'function' ? args.qualityProbe : probeIranQuality;
  const customSshProbe = typeof args.sshProbe === 'function' ? args.sshProbe : null;
  let quality = await qualityProbe(ip);
  let ssh = null;

  if (!quality?.ok && qualityGlobalReady(quality)) {
    return {
      ok: false,
      definitive: Boolean(quality?.definitive),
      rangeRejected: true,
      reason: quality?.reason || 'quality_inconclusive',
      ssh: null,
      quality
    };
  }

  if (!quality?.ok) {
    ssh = customSshProbe
      ? await customSshProbe(ip)
      : await probeSshReachability(ip, {
          settleMs: 0,
          attempts: clampInt(process.env.HETZNER_CHANGE_IP_READINESS_SSH_ATTEMPTS, 5, 1, 8),
          timeoutMs: clampInt(process.env.HETZNER_CHANGE_IP_READINESS_SSH_TIMEOUT_MS, 4000, 1000, 10000),
          retryDelayMs: clampInt(process.env.HETZNER_CHANGE_IP_READINESS_SSH_RETRY_DELAY_MS, 3000, 500, 10000)
        });

    if (!ssh?.ok) {
      return {
        ok: false,
        definitive: false,
        reason: 'network_not_ready',
        ssh,
        quality
      };
    }

    const rechecks = clampInt(args.readinessRechecks ?? process.env.HETZNER_CHANGE_IP_READINESS_RECHECKS, 2, 1, 3);
    const recheckDelayMs = clampInt(args.readinessRecheckDelayMs ?? process.env.HETZNER_CHANGE_IP_READINESS_RECHECK_DELAY_MS, 2500, 500, 10000);
    for (let i = 0; i < rechecks; i += 1) {
      if (recheckDelayMs > 0) await sleep(recheckDelayMs);
      quality = await qualityProbe(ip);
      if (quality?.ok || qualityGlobalReady(quality)) break;
    }

    if (!quality?.ok) {
      const globallyReady = qualityGlobalReady(quality);
      return {
        ok: false,
        definitive: Boolean(quality?.definitive && globallyReady),
        rangeRejected: globallyReady,
        reason: globallyReady
          ? (quality?.reason || 'failed_threshold')
          : 'quality_after_network_inconclusive',
        ssh,
        quality
      };
    }
  }

  if (!ssh) {
    ssh = customSshProbe
      ? await customSshProbe(ip)
      : await probeSshReachability(ip, { settleMs: 0 });
  }
  if (!ssh?.ok) {
    return {
      ok: false,
      definitive: true,
      reason: 'ssh_unreachable',
      ssh,
      quality
    };
  }

  return {
    ok: true,
    definitive: true,
    reason: 'ok',
    ssh,
    quality
  };
}

async function changeHetznerPublicIp(args) {
  // Manual Change-IP operates on an already-delivered VM. Unlike initial
  // provisioning, it cannot safely rebuild the customer's machine in another
  // Hetzner location just to obtain a different address. Bound the number of
  // full candidate rounds so the request cannot spin for tens of minutes.
  const maxAttempts = clampInt(process.env.HETZNER_CHANGE_IP_CLEAN_ATTEMPTS, 4, 1, 8);
  const maxInconclusiveCandidates = clampInt(
    process.env.HETZNER_CHANGE_IP_INCONCLUSIVE_CANDIDATES,
    2,
    1,
    4
  );
  let firstOldIp = null;
  let lastCandidateIp = null;
  let lastVerification = null;
  let inconclusiveCandidates = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await base.changeHetznerPublicIp({
        ...args,
        verifyCandidate: typeof args.verifyCandidate === 'function'
          ? args.verifyCandidate
          : async ({ ip }) => verifyCleanCandidate(ip, args)
      });
      if (!firstOldIp) firstOldIp = result.oldIp;
      const verification = result.verification || null;
      await base.rememberIp(args.db, {
        telegramId: args.telegramId,
        datacenter: args.datacenter,
        serverId: args.serverId,
        ip: result.newIp,
        event: 'clean_ip_verified'
      }).catch(() => {});
      console.log('[HETZNER_CHANGE_IP_CLEAN_SUCCESS]', {
        server_id: String(args.serverId),
        attempt,
        ip: result.newIp,
        quality: lifecycle.qualitySummary(verification?.quality || verification)
      });
      return {
        ...result,
        oldIp: firstOldIp || result.oldIp,
        attempts: attempt,
        quality: verification?.quality || verification,
        ssh: verification?.ssh || null
      };
    } catch (error) {
      if (!firstOldIp && error?.oldIp) firstOldIp = error.oldIp;
      lastCandidateIp = error?.candidateIp || lastCandidateIp;
      lastVerification = error?.verification || lastVerification;

      if (error?.code === 'CANDIDATE_REJECTED') {
        const verification = error.verification || {};
        await base.rememberIp(args.db, {
          telegramId: args.telegramId,
          datacenter: args.datacenter,
          serverId: args.serverId,
          ip: error.candidateIp,
          event: verification?.definitive ? 'clean_ip_rejected_rolled_back' : 'clean_ip_unverified_rolled_back'
        }).catch(() => {});

        console.warn('[HETZNER_CHANGE_IP_CLEAN_REJECTED_ROLLED_BACK]', {
          server_id: String(args.serverId),
          attempt,
          candidate_ip: error.candidateIp,
          restored_ip: error.oldIp,
          definitive: Boolean(verification?.definitive),
          reason: verification?.reason || 'unknown',
          quality: lifecycle.qualitySummary(verification?.quality || verification)
        });

        if (!verification?.definitive) {
          inconclusiveCandidates += 1;
          if (attempt < maxAttempts && inconclusiveCandidates < maxInconclusiveCandidates) {
            console.warn('[HETZNER_CHANGE_IP_INCONCLUSIVE_RETRY]', {
              server_id: String(args.serverId),
              attempt,
              inconclusive_candidates: inconclusiveCandidates,
              max_inconclusive_candidates: maxInconclusiveCandidates,
              candidate_ip: error.candidateIp || null,
              restored_ip: error.oldIp || firstOldIp || null
            });
            await sleep(1200);
            continue;
          }

          const unavailable = new Error('IP_QUALITY_CHECK_UNAVAILABLE');
          unavailable.code = 'IP_QUALITY_CHECK_UNAVAILABLE';
          unavailable.currentIp = error.oldIp || firstOldIp || null;
          unavailable.candidateIp = error.candidateIp || null;
          unavailable.verification = verification;
          unavailable.inconclusiveCandidates = inconclusiveCandidates;
          throw unavailable;
        }
        continue;
      }

      if (error?.code === 'CANDIDATE_REJECTED_ROLLBACK_FAILED') {
        const rollbackError = new Error('IP_CHANGE_ROLLBACK_FAILED');
        rollbackError.code = 'IP_CHANGE_ROLLBACK_FAILED';
        rollbackError.currentIp = error.oldIp || firstOldIp || null;
        rollbackError.candidateIp = error.candidateIp || null;
        rollbackError.verification = error.verification || null;
        throw rollbackError;
      }

      throw error;
    }
  }

  const error = new Error('NO_CLEAN_IPV4_AVAILABLE');
  error.code = 'NO_CLEAN_IPV4_AVAILABLE';
  error.currentIp = firstOldIp || null;
  error.lastCandidateIp = lastCandidateIp;
  error.verification = lastVerification;
  error.attempts = maxAttempts;
  throw error;
}

function userMessageForError(error) {
  const code = String(error?.code || error?.message || '');
  if (code === 'IP_QUALITY_CHECK_UNAVAILABLE') {
    const suffix = error?.currentIp ? `\nIP قبلی حفظ شد: ${error.currentIp}` : '';
    return `چند IP جدید بررسی شد اما سرویس بررسی دسترسی از ایران هنوز نتیجه قطعی نداد. برای جلوگیری از قطعی، هیچ IP تأییدنشده‌ای اعمال نشد و ربات به IP قبلی برگشت.${suffix}`;
  }
  if (code === 'NO_CLEAN_IPV4_AVAILABLE') {
    const suffix = error?.currentIp ? `\nIP قبلی حفظ شد: ${error.currentIp}` : '';
    return `چند IP جدید بررسی شد اما فعلاً هیچ IP سالمی در لوکیشن فعلی پیدا نشد. عملیات متوقف شد و هیچ IP تأییدنشده‌ای روی سرور نهایی نشد.${suffix}`;
  }
  if (code === 'IP_CHANGE_ROLLBACK_FAILED') {
    return 'IP جدید تأیید نشد و بازگردانی خودکار کامل نشد. برای جلوگیری از تغییر بیشتر، عملیات متوقف شد؛ لطفاً با پشتیبانی تماس بگیرید.';
  }
  return base.userMessageForError(error);
}

module.exports = {
  ...base,
  qualityGlobalReady,
  probeSshReachability,
  probeIranQuality,
  verifyCleanCandidate,
  changeHetznerPublicIp,
  userMessageForError
};