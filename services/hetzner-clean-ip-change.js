'use strict';

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

async function changeHetznerPublicIp(args) {
  const maxAttempts = clampInt(process.env.HETZNER_CHANGE_IP_CLEAN_ATTEMPTS, 20, 1, 30);
  let firstOldIp = null;
  let lastResult = null;
  let lastQuality = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await base.changeHetznerPublicIp(args);
    if (!firstOldIp) firstOldIp = result.oldIp;
    lastResult = result;

    const quality = await probeIranQuality(result.newIp);
    lastQuality = quality;

    if (quality?.ok) {
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
        quality: lifecycle.qualitySummary(quality)
      });
      return {
        ...result,
        oldIp: firstOldIp,
        attempts: attempt,
        quality
      };
    }

    await base.rememberIp(args.db, {
      telegramId: args.telegramId,
      datacenter: args.datacenter,
      serverId: args.serverId,
      ip: result.newIp,
      event: quality?.definitive ? 'clean_ip_rejected' : 'clean_ip_unverified'
    }).catch(() => {});

    console.warn('[HETZNER_CHANGE_IP_CLEAN_REJECTED]', {
      server_id: String(args.serverId),
      attempt,
      ip: result.newIp,
      definitive: Boolean(quality?.definitive),
      quality: lifecycle.qualitySummary(quality)
    });

    // If the external probe itself is unavailable/inconclusive after retries,
    // do not burn through the whole Hetzner pool blindly. Stop and report that
    // the IP was changed but could not be verified as clean.
    if (!quality?.definitive) {
      const error = new Error('IP_QUALITY_CHECK_UNAVAILABLE');
      error.code = 'IP_QUALITY_CHECK_UNAVAILABLE';
      error.currentIp = result.newIp;
      error.quality = quality;
      throw error;
    }
  }

  const error = new Error('NO_CLEAN_IPV4_AVAILABLE');
  error.code = 'NO_CLEAN_IPV4_AVAILABLE';
  error.currentIp = lastResult?.newIp || null;
  error.quality = lastQuality;
  throw error;
}

function userMessageForError(error) {
  const code = String(error?.code || error?.message || '');
  if (code === 'IP_QUALITY_CHECK_UNAVAILABLE') {
    const suffix = error?.currentIp ? `\nIP فعلی: ${error.currentIp}` : '';
    return `IP تغییر کرد، اما سرویس بررسی دسترسی از ایران فعلاً نتیجه قطعی نداد؛ ربات این IP را به عنوان «تمیز» تأیید نکرد.${suffix}`;
  }
  if (code === 'NO_CLEAN_IPV4_AVAILABLE') {
    const suffix = error?.currentIp ? `\nآخرین IP: ${error.currentIp}` : '';
    return `چندین IP جدید بررسی شد اما هیچ‌کدام معیار دسترسی از ایران را پاس نکردند. ربات IP تأییدنشده را سالم اعلام نمی‌کند.${suffix}`;
  }
  return base.userMessageForError(error);
}

module.exports = {
  ...base,
  probeIranQuality,
  changeHetznerPublicIp,
  userMessageForError
};
