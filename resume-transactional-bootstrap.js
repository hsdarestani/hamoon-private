'use strict';

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0) throw new Error(`RESUME_TRANSACTIONAL_PATCH_MISSING:${label}`);
  if (source.indexOf(needle, first + needle.length) >= 0) throw new Error(`RESUME_TRANSACTIONAL_PATCH_DUPLICATE:${label}`);
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

function applyResumeTransactionalPatches(source) {
  let out = String(source || '');

  const settlementImport = "const { settleServerRenewalAtomic, settleHetznerTrafficOverage } = require('./billing-settlement');";
  const recoveryImport = "const { rollbackServerRenewalAtomic } = require('./billing-settlement-recovery');";
  if (!out.includes(recoveryImport)) {
    if (!out.includes(settlementImport)) throw new Error('RESUME_TRANSACTIONAL_SETTLEMENT_IMPORT_MISSING');
    out = out.replace(settlementImport, `${settlementImport}\n${recoveryImport}`);
  }

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
    return '⏳ عملیات قبلی روی سرور در Hetzner هنوز تمام نشده است. سیستم چند بار تلاش کرد و وضعیت واقعی سرور را هم بررسی کرد؛ لطفاً کمی بعد دوباره امتحان کنید.';
  }
  if (info.status === 401 || info.status === 403) {
    return '❌ ارتباط حساب ارائه‌دهنده نیاز به بررسی پشتیبانی دارد. هیچ مبلغی بابت روشن‌کردن ناموفق از دست نمی‌رود.';
  }
  if (info.status === 404) {
    return '❌ این سرور در سمت ارائه‌دهنده پیدا نشد. لطفاً با پشتیبانی تماس بگیرید.';
  }
  if (info.status === 429) {
    return '⏳ ارائه‌دهنده موقتاً تعداد درخواست‌ها را محدود کرده است. لطفاً کمی بعد دوباره تلاش کنید.';
  }
  if ((info.status && info.status >= 500) || ['econnreset','etimedout','econnaborted'].includes(info.code)) {
    return '⏳ ارتباط با ارائه‌دهنده موقتاً ناموفق بود. اگر تمدید همین تلاش کسر شده باشد، مبلغ خودکار به کیف پول برمی‌گردد.';
  }
  if (error?.code === 'RESUME_REFUND_FAILED') {
    return '❌ روشن‌کردن سرور انجام نشد و بازگردانی خودکار مبلغ نیاز به بررسی پشتیبانی دارد.';
  }
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
    out = out.replace(anchor, helper + anchor);
  }

  if (!out.includes('let renewalSettlementEventKey = null;')) {
    out = replaceOnce(
      out,
      `  let charged = 0;\n  if (renewal.cycleDue) {`,
      `  let charged = 0;\n  let renewalSettlementEventKey = null;\n  if (renewal.cycleDue) {`,
      'settlement-event-key-declaration'
    );
  }

  const chargedNeedle = `    charged = settlement.status === 'charged' ? Number(settlement.charged || renewal.cycleAmount) : 0;`;
  if (!out.includes('renewalSettlementEventKey = settlement.status')) {
    out = replaceOnce(
      out,
      chargedNeedle,
      `${chargedNeedle}\n    renewalSettlementEventKey = settlement.status === 'charged' ? settlement.eventKey : null;`,
      'settlement-event-key-capture'
    );
  }

  if (!out.includes('PROVIDER_POWER_ON_NOT_CONFIRMED')) {
    const oldBlock = `  try {
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
    const newBlock = `  let providerError = null;
  try {
    await openstackApi.resumeServer(dcConfig, null, serverId);
  } catch (error) {
    providerError = error;
  }

  // Hetzner power actions are asynchronous. A 423/timeout can mean that a
  // previous power-on is still completing, so verify provider state before
  // declaring failure or compensating a just-settled renewal.
  const providerConfirmedRunning = await confirmProviderServerRunning(
    dcConfig,
    serverId,
    providerError ? 10 : 12,
    2000
  );

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
    throw providerError || Object.assign(
      new Error('PROVIDER_POWER_ON_NOT_CONFIRMED'),
      { code: 'PROVIDER_POWER_ON_NOT_CONFIRMED' }
    );
  }

  // Atomic settlement already advances the billing boundary when charged.
  // For a not-due/already-settled resume, only restore lifecycle state now.
  if (!charged) await updatePurchaseStatus(serverId, 'active');
  await updatePurchaseSuspendReason(serverId, null).catch(() => {});
`;
    out = replaceOnce(out, oldBlock, newBlock, 'manual-resume-confirmation');
  }

  if (!out.includes('[ATOMIC_RENEWAL_RESUME_ROLLED_BACK]')) {
    const oldAuto = `        if (status === 'suspended') {
          try {
            const tok = await openstackApi.getToken(dcConfig);
            await openstackApi.resumeServer(dcConfig, tok, server_id);
            await sendMessage(userId, '✅ سرور ' + escapeMarkdownV2(server_name) + ' مجددا فعال شد.');
          } catch (e) {
            console.warn('[Billing] resume failed after atomic renewal', { status: e.response?.status, server_id, datacenter: purchase.datacenter, message: e.message });
          }
        }`;
    const newAuto = `        if (status === 'suspended') {
          let resumeError = null;
          try {
            const tok = await openstackApi.getToken(dcConfig);
            await openstackApi.resumeServer(dcConfig, tok, server_id);
          } catch (e) {
            resumeError = e;
          }

          const running = await confirmProviderServerRunning(dcConfig, server_id, resumeError ? 10 : 12, 2000);
          if (!running) {
            try {
              const rollback = await rollbackServerRenewalAtomic({
                telegramId: userId,
                serverId: server_id,
                datacenter: purchase.datacenter,
                eventKey: renewalSettlement.eventKey,
                reason: 'resume_failed'
              });
              console.warn('[ATOMIC_RENEWAL_RESUME_ROLLED_BACK]', {
                server_id,
                datacenter: purchase.datacenter,
                refunded: rollback.refunded || 0,
                provider_status: resumeProviderErrorInfo(resumeError).status,
                provider_code: resumeProviderErrorInfo(resumeError).code
              });
              await sendMessage(
                userId,
                '⚠️ تمدید سرور ' + escapeMarkdownV2(server_name) + ' انجام شد اما روشن‌شدن در Hetzner تأیید نشد؛ مبلغ همین تمدید خودکار به کیف پول برگشت. لطفاً کمی بعد دوباره روشن‌کردن سرور را بزنید.'
              ).catch(() => {});
            } catch (rollbackError) {
              console.error('[ATOMIC_RENEWAL_RESUME_ROLLBACK_FAILED]', {
                server_id,
                datacenter: purchase.datacenter,
                message: rollbackError.message
              });
            }
            continue;
          }

          await updatePurchaseStatus(server_id, 'active').catch(() => {});
          await updatePurchaseSuspendReason(server_id, null).catch(() => {});
          await sendMessage(userId, '✅ سرور ' + escapeMarkdownV2(server_name) + ' مجددا فعال شد.');
        }`;
    out = replaceOnce(out, oldAuto, newAuto, 'automatic-renewal-resume-confirmation');
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
    out = replaceOnce(out, oldBulk, newBulk, 'bulk-error-message');
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
    out = replaceOnce(out, oldSingle, newSingle, 'single-error-message');
  }

  const required = [
    recoveryImport,
    'function resumeProviderErrorInfo(error)',
    'async function confirmProviderServerRunning(',
    'renewalSettlementEventKey',
    'PROVIDER_POWER_ON_NOT_CONFIRMED',
    'rollbackServerRenewalAtomic({',
    '[ATOMIC_RENEWAL_RESUME_ROLLED_BACK]',
    'resumeProviderErrorMessage(error)',
    'status: providerInfo.status'
  ];
  for (const marker of required) {
    if (!out.includes(marker)) throw new Error('RESUME_TRANSACTIONAL_PATCH_FAILED:' + marker);
  }
  return out;
}

module.exports = { applyResumeTransactionalPatches };
