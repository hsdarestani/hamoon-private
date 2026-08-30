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

  // Hetzner can report the server running with the new Primary IPv4 before the guest
  // network stack/sshd has fully settled after the power cycle. Give it a short grace period.
  if (settleMs > 0) await sleep(settleMs);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await tcpProbeOnce(ip, port, timeoutMs);
    if (last.ok) return { ...last, attempts: attempt, port };
    if (attempt < attempts) await sleep(retryDelayMs);
  }
  return { ...(last || { ok: false, reason: 'unknown' }), attempts, port };
}

async function probeIranQuality(ip) {
  const probeAttempts = clampInt(process.env.HETZNER_CHANGE_IP_QUALITY_PROBE_ATTEMPTS, 3, 1, 6);
  let last = null;
  for (let attempt = 1; attempt <= probeAttempts; attempt += 1) {
    last = await lifecycle.checkIpQuality(ip);
    if (last?.ok || last?.definitive) return last;
    if (attempt < probeAttempts) await sleep(1800);
  }
  return last;
}

async function verifyCleanCandidate(ip, args = {}) {
  const sshProbe = typeof args.sshProbe === 'function' ? args.sshProbe : probeSshReachability;
  const ssh = await sshProbe(ip);
  if (!ssh?.ok) {
    return {
      ok: false,
      definitive: true,
      reason: 'ssh_unreachable',
      ssh,
      quality: null
    };
  }

  const qualityProbe = typeof args.qualityProbe === 'function' ? args.qualityProbe : probeIranQuality;
  const quality = await qualityProbe(ip);
  return {
    ok: Boolean(quality?.ok),
    definitive: Boolean(quality?.definitive),
    reason: quality?.ok ? 'ok' : (quality?.reason || 'quality_inconclusive'),
    ssh,
    quality
  };
}

async function changeHetznerPublicIp(args) {
  const maxAttempts = clampInt(process.env.HETZNER_CHANGE_IP_CLEAN_ATTEMPTS, 20, 1, 30);
  let firstOldIp = null;
  let lastCandidateIp = null;
  let lastVerification = null;

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
          const unavailable = new Error('IP_QUALITY_CHECK_UNAVAILABLE');
          unavailable.code = 'IP_QUALITY_CHECK_UNAVAILABLE';
          unavailable.currentIp = error.oldIp || firstOldIp || null;
          unavailable.candidateIp = error.candidateIp || null;
          unavailable.verification = verification;
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
  throw error;
}

function userMessageForError(error) {
  const code = String(error?.code || error?.message || '');
  if (code === 'IP_QUALITY_CHECK_UNAVAILABLE') {
    const suffix = error?.currentIp ? `\nIP قبلی حفظ شد: ${error.currentIp}` : '';
    return `سرویس بررسی دسترسی از ایران فعلاً نتیجه قطعی نداد. برای جلوگیری از قطعی، IP جدید اعمال نشد و ربات به IP قبلی برگشت.${suffix}`;
  }
  if (code === 'NO_CLEAN_IPV4_AVAILABLE') {
    const suffix = error?.currentIp ? `\nIP قبلی حفظ شد: ${error.currentIp}` : '';
    return `چندین IP جدید بررسی شد اما هیچ‌کدام هم‌زمان SSH و معیار دسترسی از ایران را پاس نکردند. هیچ IP تأییدنشده‌ای روی سرور نهایی نشد.${suffix}`;
  }
  if (code === 'IP_CHANGE_ROLLBACK_FAILED') {
    return 'IP جدید تأیید نشد و بازگردانی خودکار کامل نشد. برای جلوگیری از تغییر بیشتر، عملیات متوقف شد؛ لطفاً با پشتیبانی تماس بگیرید.';
  }
  return base.userMessageForError(error);
}

module.exports = {
  ...base,
  probeSshReachability,
  probeIranQuality,
  verifyCleanCandidate,
  changeHetznerPublicIp,
  userMessageForError
};
