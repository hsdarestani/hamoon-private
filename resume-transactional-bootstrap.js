'use strict';

function replaceRequired(source, needle, replacement, label) {
  const pos = source.indexOf(needle);
  if (pos < 0) throw new Error(`RESUME_TRANSACTIONAL_PATCH_MISSING:${label}`);
  return source.slice(0, pos) + replacement + source.slice(pos + needle.length);
}

function applyResumeTransactionalPatches(input) {
  let source = String(input || '');

  const settlementImport = "const { settleServerRenewalAtomic, settleHetznerTrafficOverage } = require('./billing-settlement');";
  const recoveryImport = "const { rollbackServerRenewalAtomic } = require('./billing-settlement-recovery');";
  if (!source.includes(recoveryImport)) {
    source = replaceRequired(source, settlementImport, `${settlementImport}\n${recoveryImport}`, 'settlement-import');
  }

  const resumeFn = 'async function resumePurchaseWithBillingGuard(userId, purchase, dcConfig) {';
  if (!source.includes('function resumeProviderErrorInfo(error)')) {
    const helpers = `function resumeProviderErrorInfo(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  const code = String(error?.code || error?.data?.error?.code || error?.response?.data?.error?.code || '').trim().toLowerCase();
  return { status: Number.isFinite(status) ? status : null, code };
}

function resumeProviderErrorMessage(error) {
  const info = resumeProviderErrorInfo(error);
  if (error?.code === 'OPERATION_IN_PROGRESS' || info.status === 423 || info.code === 'locked') {
    return '⏳ عملیات قبلی روی سرور در Hetzner هنوز تمام نشده است. سیستم چند بار تلاش کرد و وضعیت واقعی سرور را هم بررسی کرد؛ لطفاً کمی بعد دوباره امتحان کنید.';
  }
  if (info.status === 401 || info.status === 403) return '❌ ارتباط حساب ارائه‌دهنده نیاز به بررسی پشتیبانی دارد. هیچ مبلغی بابت روشن‌کردن ناموفق از دست نمی‌رود.';
  if (info.status === 404) return '❌ این سرور در سمت ارائه‌دهنده پیدا نشد. لطفاً با پشتیبانی تماس بگیرید.';
  if (info.status === 429) return '⏳ ارائه‌دهنده موقتاً تعداد درخواست‌ها را محدود کرده است. لطفاً کمی بعد دوباره تلاش کنید.';
  if ((info.status && info.status >= 500) || ['econnreset','etimedout','econnaborted'].includes(info.code)) {
    return '⏳ ارتباط با ارائه‌دهنده موقتاً ناموفق بود. اگر تمدید همین تلاش کسر شده باشد، مبلغ خودکار به کیف پول برمی‌گردد.';
  }
  if (error?.code === 'RESUME_REFUND_FAILED') return '❌ روشن‌کردن سرور انجام نشد و بازگردانی خودکار مبلغ نیاز به بررسی پشتیبانی دارد.';
  return '❌ روشن‌کردن سرور در سمت ارائه‌دهنده تأیید نشد. اگر تمدید همین تلاش کسر شده باشد، مبلغ خودکار به کیف پول برمی‌گردد.';
}

async function confirmProviderServerRunning(dcConfig, serverId, attempts = 10, delayMs = 2000) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const providerServer = await openstackApi.getServer(dcConfig, null, serverId);
      const providerStatus = String(providerServer?.status || '').toLowerCase();
      if (providerStatus === 'running' || providerStatus === 'active') return true;
    } catch (_) {}
    if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return false;
}

`;
    source = replaceRequired(source, resumeFn, helpers + resumeFn, 'resume-function');
  }

  if (!source.includes('let renewalSettlementEventKey = null;')) {
    source = replaceRequired(
      source,
      `  let charged = 0;\n  if (renewal.cycleDue) {`,
      `  let charged = 0;\n  let renewalSettlementEventKey = null;\n  if (renewal.cycleDue) {`,
      'event-key-declaration'
    );
  }

  if (!source.includes('renewalSettlementEventKey = settlement.status')) {
    const chargedLine = `    charged = settlement.status === 'charged' ? Number(settlement.charged || renewal.cycleAmount) : 0;`;
    source = replaceRequired(
      source,
      chargedLine,
      `${chargedLine}\n    renewalSettlementEventKey = settlement.status === 'charged' ? settlement.eventKey : null;`,
      'event-key-capture'
    );
  }

  if (!source.includes('PROVIDER_POWER_ON_NOT_CONFIRMED')) {
    const oldPowerBlock = `  try {
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
    const newPowerBlock = `  let providerError = null;
  try {
    await openstackApi.resumeServer(dcConfig, null, serverId);
  } catch (error) {
    providerError = error;
  }

  const providerConfirmedRunning = await confirmProviderServerRunning(dcConfig, serverId, providerError ? 10 : 12, 2000);
  if (!providerConfirmedRunning) {
    if (charged > 0 && renewalSettlementEventKey) {
      try {
        await rollbackServerRenewalAtomic({
          telegramId: userId,
          serverId,
          datacenter: purchase.datacenter || dcConfig.key,
          eventKey: renewalSettlementEventKey,
          reason: 'resume_failed'
        });
        charged = 0;
      } catch (refundError) {
        await updatePurchaseStatus(serverId, 'suspended').catch(() => {});
        await updatePurchaseSuspendReason(serverId, 'resume_refund_failed').catch(() => {});
        const wrapped = new Error('RESUME_REFUND_FAILED');
        wrapped.code = 'RESUME_REFUND_FAILED';
        wrapped.cause = refundError;
        throw wrapped;
      }
    } else {
      await updatePurchaseStatus(serverId, 'suspended').catch(() => {});
      await updatePurchaseSuspendReason(serverId, 'resume_failed').catch(() => {});
    }
    throw providerError || Object.assign(new Error('PROVIDER_POWER_ON_NOT_CONFIRMED'), { code: 'PROVIDER_POWER_ON_NOT_CONFIRMED' });
  }

  if (!charged) await updatePurchaseStatus(serverId, 'active');
  await updatePurchaseSuspendReason(serverId, null).catch(() => {});
`;
    source = replaceRequired(source, oldPowerBlock, newPowerBlock, 'provider-confirmation');
  }

  if (!source.includes('status: providerInfo.status')) {
    const oldBulk = `        console.error('[START_MY_SERVERS] failed:', { userId, server_id: purchase.server_id, dcKey, error: error.message });
        results.push({ name: purchase.server_name || purchase.server_id, ok: false, message: 'روشن‌کردن سرور با خطای ارائه‌دهنده مواجه شد. لطفاً کمی بعد دوباره تلاش کنید.' });`;
    const newBulk = `        const providerInfo = resumeProviderErrorInfo(error);
        console.error('[START_MY_SERVERS] failed:', { userId, server_id: purchase.server_id, dcKey, status: providerInfo.status, code: providerInfo.code, error: error.message });
        results.push({ name: purchase.server_name || purchase.server_id, ok: false, message: resumeProviderErrorMessage(error) });`;
    source = replaceRequired(source, oldBulk, newBulk, 'bulk-error');
  }

  if (!source.includes('return sendMessage(effectiveChatId, resumeProviderErrorMessage(error));')) {
    const oldSingle = `    console.error('[RESUME_BILLING_GUARD_FAILED]', { user: effectiveUserId, server_id: payload.serverId, message: error.message });
    return sendMessage(effectiveChatId, '❌ روشن‌کردن سرور انجام نشد. لطفاً کمی بعد دوباره تلاش کنید یا با پشتیبانی تماس بگیرید.');`;
    const newSingle = `    const providerInfo = resumeProviderErrorInfo(error);
    console.error('[RESUME_BILLING_GUARD_FAILED]', { user: effectiveUserId, server_id: payload.serverId, status: providerInfo.status, code: providerInfo.code, message: error.message });
    return sendMessage(effectiveChatId, resumeProviderErrorMessage(error));`;
    source = replaceRequired(source, oldSingle, newSingle, 'single-error');
  }

  for (const marker of [
    recoveryImport,
    'function resumeProviderErrorInfo(error)',
    'async function confirmProviderServerRunning(',
    'renewalSettlementEventKey',
    'PROVIDER_POWER_ON_NOT_CONFIRMED',
    'rollbackServerRenewalAtomic({',
    'resumeProviderErrorMessage(error)'
  ]) {
    if (!source.includes(marker)) throw new Error(`RESUME_TRANSACTIONAL_PATCH_FAILED:${marker}`);
  }
  return source;
}

module.exports = { applyResumeTransactionalPatches };
