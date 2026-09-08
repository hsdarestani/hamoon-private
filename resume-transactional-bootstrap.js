'use strict';

function applyResumeTransactionalPatches(source) {
  let out = String(source || '');

  if (!out.includes('function resumeProviderErrorInfo(error)')) {
    const anchor = 'async function resumePurchaseWithBillingGuard(userId, purchase, dcConfig) {';
    if (!out.includes(anchor)) throw new Error('RESUME_TRANSACTIONAL_FUNCTION_MARKER_MISSING');
    const helper = `function resumeProviderErrorInfo(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  const code = String(
    error?.code || error?.data?.error?.code || error?.response?.data?.error?.code || ''
  ).trim().toLowerCase();
  return { status: Number.isFinite(status) ? status : null, code };
}

function resumeProviderErrorMessage(error) {
  const info = resumeProviderErrorInfo(error);
  if (error?.code === 'OPERATION_IN_PROGRESS' || info.status === 423 || info.code === 'locked') {
    return '⏳ عملیات قبلی روی سرور در Hetzner هنوز تمام نشده است. سیستم چند بار تلاش کرد؛ لطفاً کمی بعد دوباره امتحان کنید.';
  }
  if (info.status === 401 || info.status === 403) {
    return '❌ ارتباط حساب ارائه‌دهنده نیاز به بررسی پشتیبانی دارد. هیچ مبلغ اضافه‌ای بابت تلاش ناموفق کسر نمی‌شود.';
  }
  if (info.status === 404) {
    return '❌ این سرور در سمت ارائه‌دهنده پیدا نشد. لطفاً با پشتیبانی تماس بگیرید.';
  }
  if (info.status === 429) {
    return '⏳ ارائه‌دهنده موقتاً تعداد درخواست‌ها را محدود کرده است. لطفاً کمی بعد دوباره تلاش کنید.';
  }
  if ((info.status && info.status >= 500) || ['econnreset','etimedout','econnaborted'].includes(info.code)) {
    return '⏳ ارتباط با ارائه‌دهنده موقتاً ناموفق بود. مبلغ تمدید در صورت روشن‌نشدن سرور خودکار به کیف پول برمی‌گردد.';
  }
  if (error?.code === 'RESUME_REFUND_FAILED') {
    return '❌ روشن‌کردن سرور انجام نشد و بازگردانی خودکار مبلغ نیاز به بررسی پشتیبانی دارد.';
  }
  return '❌ روشن‌کردن سرور در سمت ارائه‌دهنده انجام نشد. در صورت ناموفق بودن روشن‌شدن، مبلغ تمدید خودکار به کیف پول برمی‌گردد.';
}

`;
    out = out.replace(anchor, helper + anchor);
  }

  if (!out.includes('PROVIDER_POWER_ON_NOT_CONFIRMED')) {
    const oldBlock = `    charged = renewal.cycleAmount;
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
`;
    const newBlock = `    charged = renewal.cycleAmount;
    await recordWalletLog(userId, -charged, 'تمدید و فعال‌سازی مجدد سرور ' + (purchase.server_name || serverId), 'billing');
  }

  let providerConfirmedRunning = false;
  let providerError = null;
  try {
    await openstackApi.resumeServer(dcConfig, null, serverId);
  } catch (error) {
    providerError = error;
  }

  // Power actions are asynchronous. A timeout/423 can still mean that a prior
  // power-on was accepted, so reconcile provider state before refunding.
  const verifyAttempts = providerError ? 8 : 12;
  for (let attempt = 0; attempt < verifyAttempts; attempt += 1) {
    try {
      const providerServer = await openstackApi.getServer(dcConfig, null, serverId);
      const providerStatus = String(providerServer?.status || '').toLowerCase();
      if (providerStatus === 'running' || providerStatus === 'active') {
        providerConfirmedRunning = true;
        break;
      }
    } catch (_) {}
    if (attempt + 1 < verifyAttempts) await new Promise(resolve => setTimeout(resolve, 2000));
  }

  if (!providerConfirmedRunning) {
    if (charged > 0) {
      try {
        await creditUser(userId, charged);
        await recordWalletLog(
          userId,
          charged,
          'بازگشت خودکار هزینه تمدید ناموفق سرور ' + (purchase.server_name || serverId),
          'billing_refund'
        );
        charged = 0;
      } catch (refundError) {
        await updatePurchaseStatus(serverId, 'suspended').catch(() => {});
        await updatePurchaseSuspendReason(serverId, 'resume_refund_failed').catch(() => {});
        const wrapped = new Error('RESUME_REFUND_FAILED');
        wrapped.code = 'RESUME_REFUND_FAILED';
        wrapped.cause = refundError;
        throw wrapped;
      }
    }
    await updatePurchaseStatus(serverId, 'suspended').catch(() => {});
    await updatePurchaseSuspendReason(serverId, 'resume_failed').catch(() => {});
    throw providerError || Object.assign(new Error('PROVIDER_POWER_ON_NOT_CONFIRMED'), { code: 'PROVIDER_POWER_ON_NOT_CONFIRMED' });
  }

  // Commit the new billing boundary only after the provider confirms running.
  if (charged > 0) {
    await updatePurchaseStatus(serverId, 'active', purchase.last_billed_traffic_gb, new Date());
  } else {
    await updatePurchaseStatus(serverId, 'active');
  }
  await updatePurchaseSuspendReason(serverId, null).catch(() => {});
`;
    if (!out.includes(oldBlock)) throw new Error('RESUME_TRANSACTIONAL_BLOCK_MARKER_MISSING');
    out = out.replace(oldBlock, newBlock);
  }

  if (!out.includes('status: providerInfo.status')) {
    const oldBulk = `        console.error('[START_MY_SERVERS] failed:', { userId, server_id: purchase.server_id, dcKey, error: error.message });
        results.push({ name: purchase.server_name || purchase.server_id, ok: false, message: 'روشن‌کردن سرور با خطای ارائه‌دهنده مواجه شد. لطفاً کمی بعد دوباره تلاش کنید.' });`;
    const newBulk = `        const providerInfo = resumeProviderErrorInfo(error);
        console.error('[START_MY_SERVERS] failed:', {
          userId,
          server_id: purchase.server_id,
          dcKey,
          status: providerInfo.status,
          code: providerInfo.code,
          error: error.message
        });
        results.push({ name: purchase.server_name || purchase.server_id, ok: false, message: resumeProviderErrorMessage(error) });`;
    if (!out.includes(oldBulk)) throw new Error('RESUME_TRANSACTIONAL_BULK_CATCH_MARKER_MISSING');
    out = out.replace(oldBulk, newBulk);
  }

  if (!out.includes('return sendMessage(effectiveChatId, resumeProviderErrorMessage(error));')) {
    const oldSingle = `    console.error('[RESUME_BILLING_GUARD_FAILED]', { user: effectiveUserId, server_id: payload.serverId, message: error.message });
    return sendMessage(effectiveChatId, '❌ روشن‌کردن سرور انجام نشد. لطفاً کمی بعد دوباره تلاش کنید یا با پشتیبانی تماس بگیرید.');`;
    const newSingle = `    const providerInfo = resumeProviderErrorInfo(error);
    console.error('[RESUME_BILLING_GUARD_FAILED]', {
      user: effectiveUserId,
      server_id: payload.serverId,
      status: providerInfo.status,
      code: providerInfo.code,
      message: error.message
    });
    return sendMessage(effectiveChatId, resumeProviderErrorMessage(error));`;
    if (!out.includes(oldSingle)) throw new Error('RESUME_TRANSACTIONAL_SINGLE_CATCH_MARKER_MISSING');
    out = out.replace(oldSingle, newSingle);
  }

  const required = [
    'function resumeProviderErrorInfo(error)',
    'PROVIDER_POWER_ON_NOT_CONFIRMED',
    'billing_refund',
    'resumeProviderErrorMessage(error)',
    'status: providerInfo.status'
  ];
  for (const marker of required) {
    if (!out.includes(marker)) throw new Error('RESUME_TRANSACTIONAL_PATCH_FAILED:' + marker);
  }
  return out;
}

module.exports = { applyResumeTransactionalPatches };
