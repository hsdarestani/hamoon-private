'use strict';

function applyBillingRenewalGuardPatches(source) {
  let out = String(source || '');

  // 1) Do not warn every prepaid Hetzner customer merely because wallet < 100k.
  //    Hetzner has no traffic charge in this bot; warn only when renewal is close
  //    and the wallet cannot cover the actual next-cycle amount.
  const alertStart = '  // 🔔 هشدار کمبود موجودی برای کاربران عادی (بدون پروژه)';
  const alertEnd = '  // ✅ اضافه کردن کاربران پروژه‌محور (ممکنه خریدی نداشته باشن)';
  const alertStartPos = out.indexOf(alertStart);
  const alertEndPos = out.indexOf(alertEnd, alertStartPos + alertStart.length);
  if (alertStartPos < 0 || alertEndPos < 0 || alertEndPos <= alertStartPos) {
    throw new Error('BILLING_RENEWAL_GUARD_ALERT_MARKER_MISSING');
  }

  const alertReplacement = `  // 🔔 هشدار موجودی برای کاربران عادی (بدون پروژه)
  // Hetzner prepaid: هشدار فقط نزدیک موعد تمدید و بر اساس مبلغ واقعی دوره بعد.
  // Providerهای دارای صورتحساب ترافیک: هشدار قدیمی 100k برای ریسک مصرف ترافیک حفظ می‌شود.
  for (const [uid, meta] of usersWithPurchases) {
    const userId = String(uid);
    const projects = getUserProjects(userId) || [];
    if (projects.length > 0 || !meta.hasActive) continue;

    const effectiveDCs = getUserEffectiveDCs(userId) || {};
    const now = new Date();
    const upcoming = [];
    let hasTrafficBilledServer = false;

    for (const p of allPurchases) {
      if (String(p.telegram_id) !== userId || String(p.status || '').toLowerCase() !== 'active') continue;
      const dc = effectiveDCs[p.datacenter];
      if (!dc) continue;

      const providerText = String(dc.provider || dc.apiType || '').toLowerCase();
      const hetzner = providerText === 'hetzner' || String(dc.key || '').toLowerCase().startsWith('hetzner');
      if (!hetzner && dc.TRAFFIC_API_BASE_URL) hasTrafficBilledServer = true;

      if (Number(p.auto_renew ?? 1) !== 1) continue;
      const cycleHours = HOURS_IN_CYCLE[String(p.duration || '')];
      if (!cycleHours) continue;
      const base = new Date(p.last_billed_at || p.created_at || now);
      if (Number.isNaN(base.getTime())) continue;
      const dueAt = new Date(base.getTime() + cycleHours * 3600000);
      const hoursLeft = (dueAt - now) / 3600000;
      if (hoursLeft > 24) continue;
      const cycleAmount = Number(normalizeStoredCycleAmount(p, dc) || 0);
      if (!(cycleAmount > 0)) continue;
      upcoming.push({ purchase: p, dc, dueAt, hoursLeft, cycleAmount });
    }

    const balance = Number(await getUserWallet(userId).catch(() => 0) || 0);
    if (upcoming.length) {
      const required = Math.round(upcoming.reduce((sum, item) => sum + item.cycleAmount, 0));
      if (balance < required && !(await hasRecentLowBalanceAlert(userId, 24))) {
        const soonest = upcoming.slice().sort((a, b) => a.dueAt - b.dueAt)[0];
        const shortfall = Math.max(0, Math.ceil(required - balance));
        const when = soonest.hoursLeft <= 0
          ? 'موعد تمدید رسیده است'
          : (soonest.hoursLeft < 1
              ? 'کمتر از یک ساعت تا تمدید مانده است'
              : (soonest.hoursLeft < 24
                  ? Math.ceil(soonest.hoursLeft) + ' ساعت تا تمدید مانده است'
                  : 'حدود یک روز تا تمدید مانده است'));
        await recordWalletLog(
          userId,
          0,
          'هشدار موجودی تمدید؛ موردنیاز=' + required + '; موجودی=' + Math.floor(balance) + '; کسری=' + shortfall,
          'low_balance_alert'
        );
        await sendMessage(
          Number(userId),
          '⚠️ ' + when + '.\\n' +
          'هزینه تمدید پیش رو: ' + formatToman(required) + ' تومان\\n' +
          'موجودی کیف پول: ' + formatToman(Math.floor(balance)) + ' تومان\\n' +
          'برای تمدید خودکار حداقل ' + formatToman(shortfall) + ' تومان دیگر شارژ کنید.\\n' +
          'تا قبل از پایان دوره فعلی، صرفاً کم بودن کیف پول باعث قطع سرور نمی‌شود.'
        );
      }
      continue;
    }

    if (hasTrafficBilledServer && balance < DEFAULT_MIN_ALERT_TOMAN) {
      await sendLowBalanceAlertIfNeeded(
        userId,
        Number(userId),
        Math.max(0, Math.floor(balance)),
        'active traffic-billed server'
      );
    }
  }

`;
  out = out.slice(0, alertStartPos) + alertReplacement + out.slice(alertEndPos);

  // 2) Billing-aware resume. A Hetzner server that was suspended at renewal
  //    must not be powered back on with an arbitrary positive wallet and then
  //    be suspended again by the next hourly billing tick.
  const startFn = 'async function handleStartMySuspendedServers(chatId, userId) {';
  const endFn = 'const HETZNER_UPGRADE_ALLOWED_STATUSES = new Set(';
  const startFnPos = out.indexOf(startFn);
  const endFnPos = out.indexOf(endFn, startFnPos + startFn.length);
  if (startFnPos < 0 || endFnPos < 0 || endFnPos <= startFnPos) {
    throw new Error('BILLING_RENEWAL_GUARD_RESUME_MARKER_MISSING');
  }

  const resumeReplacement = `function getPurchaseRenewalInfo(purchase, dcConfig, now = new Date()) {
  const cycle = String(purchase?.duration || '');
  const cycleHours = HOURS_IN_CYCLE[cycle] || 0;
  const base = new Date(purchase?.last_billed_at || purchase?.created_at || now);
  const validBase = !Number.isNaN(base.getTime());
  const dueAt = cycleHours && validBase ? new Date(base.getTime() + cycleHours * 3600000) : null;
  const remainingMs = dueAt ? (dueAt - now) : null;
  const cycleAmount = Number(normalizeStoredCycleAmount(purchase, dcConfig) || 0);
  return {
    cycle,
    cycleHours,
    dueAt,
    remainingMs,
    cycleDue: dueAt ? remainingMs <= 0 : false,
    cycleAmount
  };
}

function formatPurchaseRenewalRemaining(info) {
  if (!info?.dueAt) return 'نامشخص';
  if (info.remainingMs <= 0) return 'پایان یافته / در انتظار تمدید';
  const totalMinutes = Math.max(0, Math.floor(info.remainingMs / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return days + ' روز و ' + hours + ' ساعت';
  if (hours > 0) return hours + ' ساعت و ' + minutes + ' دقیقه';
  return minutes + ' دقیقه';
}

async function resumePurchaseWithBillingGuard(userId, purchase, dcConfig) {
  if (!purchase) return { ok: false, message: '❌ اطلاعات خرید این سرور پیدا نشد.' };
  const serverId = purchase.server_id;
  const isHetznerPurchase = isHetznerDc(dcConfig);

  if (!isHetznerPurchase) {
    const wallet = Number(await getUserWallet(userId).catch(() => 0) || 0);
    if (wallet <= 0) {
      return { ok: false, message: 'کیف پول شما موجودی کافی ندارد. لطفاً ابتدا کیف پول را شارژ کنید.' };
    }
    const token = await openstackApi.getToken(dcConfig);
    await openstackApi.resumeServer(dcConfig, token, serverId);
    await updatePurchaseStatus(serverId, 'active');
    await updatePurchaseSuspendReason(serverId, null).catch(() => {});
    return { ok: true, charged: 0, message: '✅ دستور روشن کردن سرور ارسال شد.' };
  }

  const renewal = getPurchaseRenewalInfo(purchase, dcConfig);
  const autoRenewEnabled = Number(purchase.auto_renew ?? 1) === 1;

  if (renewal.cycleDue && !autoRenewEnabled) {
    return {
      ok: false,
      message: '⏸ دوره فعلی این سرور تمام شده و تمدید خودکار خاموش است. ابتدا از مدیریت سرور «فعال کردن تمدید خودکار» را بزنید.'
    };
  }

  let charged = 0;
  if (renewal.cycleDue) {
    if (!(renewal.cycleAmount > 0)) {
      return { ok: false, message: '❌ مبلغ تمدید این سرور معتبر نیست؛ برای جلوگیری از کسر اشتباه، سرور روشن نشد. با پشتیبانی تماس بگیرید.' };
    }
    const wallet = Number(await getUserWallet(userId).catch(() => 0) || 0);
    if (wallet < renewal.cycleAmount) {
      const missing = Math.ceil(renewal.cycleAmount - wallet);
      return {
        ok: false,
        message: '⚠️ دوره فعلی سرور تمام شده است.\\n' +
          'هزینه تمدید: ' + formatToman(Math.round(renewal.cycleAmount)) + ' تومان\\n' +
          'موجودی فعلی: ' + formatToman(Math.floor(wallet)) + ' تومان\\n' +
          'حداقل ' + formatToman(missing) + ' تومان دیگر شارژ کنید؛ سپس دوباره روشن‌کردن سرور را بزنید.'
      };
    }

    const debited = await debitUser(userId, renewal.cycleAmount);
    if (!debited) {
      return { ok: false, message: '⚠️ موجودی هم‌زمان تغییر کرد و هزینه تمدید قابل کسر نبود. موجودی را بررسی و دوباره تلاش کنید.' };
    }
    charged = renewal.cycleAmount;
    await recordWalletLog(userId, -charged, 'تمدید و فعال‌سازی مجدد سرور ' + (purchase.server_name || serverId), 'billing');
    await updatePurchaseStatus(serverId, 'active', purchase.last_billed_traffic_gb, new Date());
    await updatePurchaseSuspendReason(serverId, null).catch(() => {});
  }

  try {
    await openstackApi.resumeServer(dcConfig, null, serverId);
  } catch (error) {
    await updatePurchaseStatus(serverId, 'suspended').catch(() => {});
    await updatePurchaseSuspendReason(serverId, 'resume_failed').catch(() => {});
    throw error;
  }

  if (!charged) {
    await updatePurchaseStatus(serverId, 'active');
    await updatePurchaseSuspendReason(serverId, null).catch(() => {});
  }

  return {
    ok: true,
    charged,
    message: charged
      ? '✅ هزینه دوره جدید کسر شد و سرور مجدداً فعال شد. مبلغ کسرشده: ' + formatToman(Math.round(charged)) + ' تومان.'
      : '✅ سرور مجدداً فعال شد. چون دوره فعلی هنوز تمام نشده بود، بابت تمدید مبلغی کسر نشد.'
  };
}

async function handleStartMySuspendedServers(chatId, userId) {
  try {
    const userDCs = getUserEffectiveDCs(String(userId)) || {};
    const storedRestartable = await getUserRestartablePurchases(userId);
    const restartableById = new Map(
      (storedRestartable || []).map(purchase => [String(purchase.server_id), purchase])
    );

    // The provider can be off while the DB still says active (for example after
    // a provider-side shutdown). Reconcile only this user's Hetzner purchases
    // before deciding that there is nothing to start.
    const activePurchases = await getUserActivePurchases(userId);
    await Promise.all((activePurchases || []).map(async purchase => {
      const serverId = String(purchase.server_id || '');
      if (!serverId || restartableById.has(serverId)) return;
      const dcConfig = userDCs[String(purchase.datacenter || '').trim()];
      if (!dcConfig || !isHetznerDc(dcConfig)) return;
      try {
        const providerServer = await openstackApi.getServer(dcConfig, null, serverId);
        const providerStatus = String(providerServer?.status || providerServer?.state || '').toLowerCase();
        if (!['off', 'stopped', 'shutoff', 'suspended'].includes(providerStatus)) return;
        restartableById.set(serverId, purchase);
        await updatePurchaseStatus(serverId, 'suspended').catch(() => {});
        await updatePurchaseSuspendReason(serverId, 'provider_state_drift').catch(() => {});
        console.log('[START_MY_SERVERS] reconciled provider-off purchase', {
          userId,
          server_id: serverId,
          dcKey: purchase.datacenter,
          provider_status: providerStatus
        });
      } catch (error) {
        console.warn('[START_MY_SERVERS] provider state lookup failed', {
          userId,
          server_id: serverId,
          dcKey: purchase.datacenter,
          status: error?.status || error?.response?.status || null,
          message: error?.message || String(error)
        });
      }
    }));

    const purchases = [...restartableById.values()];
    if (purchases.length === 0) {
      return sendMessage(chatId, 'در حال حاضر سرور خاموش/معلق قابل روشن‌کردن برای حساب شما پیدا نشد.');
    }
    const results = [];
    await sendMessage(chatId, 'در حال بررسی وضعیت صورتحساب و روشن‌کردن ' + purchases.length + ' سرور...');

    for (const purchase of purchases) {
      const dcKey = String(purchase.datacenter || '').trim();
      const dcConfig = userDCs[dcKey];
      if (!dcConfig) {
        results.push({ name: purchase.server_name || purchase.server_id, ok: false, message: 'دیتاسنتر ' + dcKey + ' پیدا نشد.' });
        continue;
      }
      try {
        const result = await resumePurchaseWithBillingGuard(userId, purchase, dcConfig);
        results.push({ name: purchase.server_name || purchase.server_id, ...result });
      } catch (error) {
        console.error('[START_MY_SERVERS] failed:', { userId, server_id: purchase.server_id, dcKey, error: error.message });
        results.push({ name: purchase.server_name || purchase.server_id, ok: false, message: 'روشن‌کردن سرور با خطای ارائه‌دهنده مواجه شد. لطفاً کمی بعد دوباره تلاش کنید.' });
      }
    }

    const lines = [];
    for (const item of results) {
      lines.push((item.ok ? '✅ ' : '⚠️ ') + item.name + ': ' + item.message.replace(/^✅ |^⚠️ |^❌ /, ''));
    }
    return sendMessage(chatId, lines.join('\\n\\n'));
  } catch (error) {
    console.error('[START_MY_SERVERS] fatal:', error);
    return sendMessage(chatId, '❌ خطایی در بررسی صورتحساب/روشن‌کردن سرورها رخ داد. لطفاً چند دقیقه بعد دوباره تلاش کنید یا به پشتیبانی پیام دهید.');
  }
}

`;
  out = out.slice(0, startFnPos) + resumeReplacement + out.slice(endFnPos);

  // 3) The per-server Resume button must use the same billing guard.
  const resumeCase = `case 'RESUME': {
  const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];
  if (!requireCapabilityOrReply(effectiveChatId, dc, 'resumeServer')) return;
  const tok = await openstackApi.getToken(dc);
  await openstackApi.resumeServer(dc, tok, payload.serverId);
  await updatePurchaseStatus(payload.serverId, 'active').catch(() => {});
  await sendMessage(effectiveChatId, '✅ دستور روشن کردن سرور ارسال شد.');
  return handleServerManagement(effectiveChatId, effectiveUserId, payload.serverId, dc);
}`;
  const guardedResumeCase = `case 'RESUME': {
  const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];
  if (!requireCapabilityOrReply(effectiveChatId, dc, 'resumeServer')) return;
  const purchase = await getPurchaseForUserServer(effectiveUserId, payload.serverId, payload.dcKey).catch(() => null) || await getPurchaseByServerId(payload.serverId);
  if (!purchase || String(purchase.telegram_id) !== String(effectiveUserId)) return sendMessage(effectiveChatId, '❌ خرید مربوط به این سرور پیدا نشد.');
  try {
    const result = await resumePurchaseWithBillingGuard(effectiveUserId, purchase, dc);
    await sendMessage(effectiveChatId, result.message);
    if (!result.ok) return;
    return handleServerManagement(effectiveChatId, effectiveUserId, payload.serverId, dc);
  } catch (error) {
    console.error('[RESUME_BILLING_GUARD_FAILED]', { user: effectiveUserId, server_id: payload.serverId, message: error.message });
    return sendMessage(effectiveChatId, '❌ روشن‌کردن سرور انجام نشد. لطفاً کمی بعد دوباره تلاش کنید یا با پشتیبانی تماس بگیرید.');
  }
}`;
  if (!out.includes(resumeCase)) throw new Error('BILLING_RENEWAL_GUARD_RESUME_CASE_MARKER_MISSING');
  out = out.replace(resumeCase, guardedResumeCase);

  // 4) Show the prepaid-cycle facts in server management so customers know the
  //    exact cycle, renewal amount and remaining time instead of guessing.
  const managementMarker = `    if (purchase) {
      messageText += Number(purchase.auto_renew ?? 1) === 1
        ? '🔁 تمدید خودکار: روشن\\n'
        : '⏸ تمدید خودکار: خاموش\\n';
    }
    if (hetznerDeliveryPending) {`;
  const managementReplacement = `    if (purchase) {
      messageText += Number(purchase.auto_renew ?? 1) === 1
        ? '🔁 تمدید خودکار: روشن\\n'
        : '⏸ تمدید خودکار: خاموش\\n';
      const renewal = getPurchaseRenewalInfo(purchase, dcConfig);
      const dueText = renewal.dueAt
        ? renewal.dueAt.toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' })
        : 'نامشخص';
      messageText += '🗓 دوره پرداخت: ' + escapeMarkdownV2(getCycleLabel(purchase.duration || '')) + '\\n';
      messageText += '⏳ باقی‌مانده دوره: ' + escapeMarkdownV2(formatPurchaseRenewalRemaining(renewal)) + '\\n';
      messageText += '📅 موعد تمدید: ' + escapeMarkdownV2(dueText) + '\\n';
      if (renewal.cycleAmount > 0) messageText += '💳 هزینه تمدید: ' + escapeMarkdownV2(formatToman(Math.round(renewal.cycleAmount))) + ' تومان\\n';
    }

    const runtimeCoverage = await getServerRuntimeCoverage(userId);
    if (runtimeCoverage.activeCount > 0) {
      messageText +=
        '⏳ پوشش تقریبی کیف پول برای ' + escapeMarkdownV2(String(runtimeCoverage.activeCount)) +
        ' سرور روشن: ' + escapeMarkdownV2(formatRuntimeCoverageHours(runtimeCoverage.remainingHours)) + '\\n' +
        '🔥 هزینه مؤثر مجموع: ' + escapeMarkdownV2(formatToman(Math.round(runtimeCoverage.hourlyBurn))) + ' تومان/ساعت\\n';
    }

    if (hetznerDeliveryPending) {`;
  if (!out.includes(managementMarker)) throw new Error('BILLING_RENEWAL_GUARD_MANAGEMENT_MARKER_MISSING');
  out = out.replace(managementMarker, managementReplacement);

  const requiredMarkers = [
    'function getPurchaseRenewalInfo(',
    'async function resumePurchaseWithBillingGuard(',
    'تا قبل از پایان دوره فعلی، صرفاً کم بودن کیف پول باعث قطع سرور نمی‌شود.',
    "[RESUME_BILLING_GUARD_FAILED]",
    '💳 هزینه تمدید:'
  ];
  for (const marker of requiredMarkers) {
    if (!out.includes(marker)) throw new Error('BILLING_RENEWAL_GUARD_PATCH_FAILED:' + marker);
  }
  return out;
}

module.exports = { applyBillingRenewalGuardPatches };
