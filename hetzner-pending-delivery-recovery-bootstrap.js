'use strict';

function countOccurrences(source, needle) {
  let count = 0;
  let from = 0;
  while (true) {
    const idx = source.indexOf(needle, from);
    if (idx === -1) return count;
    count += 1;
    from = idx + needle.length;
  }
}

function replaceOnce(source, needle, replacement, label) {
  const count = countOccurrences(source, needle);
  if (count !== 1) throw new Error(`[hetzner-pending-recovery] ${label}: expected 1 match, found ${count}`);
  return source.replace(needle, replacement);
}

function applyHetznerPendingDeliveryRecoveryPatches(originalSource) {
  let source = String(originalSource);

  const handler = `const hetznerDeliveryRetryLocks = new Set();\n\nasync function handleHetznerDeliveryRetry(chatId, userId, serverId, dcConfig) {\n  const lockKey = String(dcConfig?.key || 'hetzner') + ':' + String(serverId);\n  if (hetznerDeliveryRetryLocks.has(lockKey)) {\n    return sendMessage(chatId, '⏳ بررسی این سرور در حال انجام است. چند لحظه صبر کنید.');\n  }\n  hetznerDeliveryRetryLocks.add(lockKey);\n\n  try {\n    if (!isHetznerDc(dcConfig)) return sendMessage(chatId, '❌ این عملیات فقط برای Hetzner است.');\n    const purchase = await getPurchaseForUserServer(userId, serverId, dcConfig.key).catch(() => null)\n      || await getPurchaseByServerId(serverId).catch(() => null);\n    if (!purchase || String(purchase.telegram_id) !== String(userId) || String(purchase.datacenter) !== String(dcConfig.key)) {\n      return sendMessage(chatId, '❌ این سرور برای حساب شما پیدا نشد.');\n    }\n    if (!isHetznerUndeliveredPurchase(purchase)) return handleServerManagement(chatId, userId, serverId, dcConfig);\n\n    await sendMessage(chatId, '🔎 وضعیت واقعی سرور، SSH و دسترسی IP در حال بررسی است...');\n    const tok = await openstackApi.getToken(dcConfig);\n    let providerServer;\n    try {\n      providerServer = await openstackApi.getServer(dcConfig, tok, serverId);\n    } catch (error) {\n      if (Number(error?.status || error?.statusCode || error?.response?.status) === 404) {\n        await require('./db').updateScopedStatus(userId, serverId, dcConfig.key, 'provider_missing').catch(() => {});\n        return sendMessage(chatId, '❌ سرور در Hetzner پیدا نشد. پشتیبانی باید وضعیت خرید را بررسی کند.');\n      }\n      throw error;\n    }\n\n    const liveState = String(providerServer?.status || providerServer?.state || '').toLowerCase();\n    if (['off', 'stopped', 'shutoff', 'suspended'].some(x => liveState.includes(x)) && hasCapability(dcConfig, 'resumeServer')) {\n      await openstackApi.resumeServer(dcConfig, tok, serverId);\n      await new Promise(resolve => setTimeout(resolve, 3000));\n    }\n\n    const db = require('./db');\n    const recordQuality = async readiness => {\n      if (readiness?.quality && db.updateIpQualityResult) {\n        await db.updateIpQualityResult(\n          userId, serverId, dcConfig.key,\n          hetznerLifecycle.qualitySummary(readiness.quality), false\n        ).catch(() => {});\n      }\n    };\n    const deliverIfReady = async readiness => {\n      if (!readiness?.ready) return false;\n      if (dcConfig.HETZNER_PASSWORD_ONLY) {\n        const storedPassword = await getServerSecret(serverId, 'root_password').catch(() => null);\n        if (!storedPassword) {\n          await db.updateScopedStatus(userId, serverId, dcConfig.key, 'manual_review').catch(() => {});\n          await sendMessage(chatId, '⚠️ خود سرور آماده است اما رمز اولیه امن آن پیدا نشد؛ برای جلوگیری از تحویل ناقص، وضعیت به بررسی دستی رفت.');\n          return false;\n        }\n      }\n      await db.markDelivered(userId, serverId, dcConfig.key, readiness.ip).catch(() => false);\n      await sendMessage(chatId, '✅ سرور آماده شد و تحویل آن دوباره فعال شد.');\n      return true;\n    };\n\n    let readiness = await hetznerLifecycle.waitForReadiness(dcConfig, serverId, {\n      timeoutMs: Number(process.env.HETZNER_PENDING_RECOVERY_READY_TIMEOUT_MS || 60000)\n    });\n    await recordQuality(readiness);\n    if (await deliverIfReady(readiness)) return handleServerManagement(chatId, userId, serverId, dcConfig);\n\n    if (readiness.status === 'pending_ip_quality' && readiness.quality?.definitive) {\n      try {\n        await hetznerLifecycle.rotateProvisioningIp({\n          dc: dcConfig,\n          serverId,\n          db,\n          telegramId: userId,\n          datacenter: dcConfig.key\n        });\n        readiness = await hetznerLifecycle.waitForReadiness(dcConfig, serverId, {\n          timeoutMs: Number(process.env.HETZNER_PENDING_RECOVERY_READY_TIMEOUT_MS || 90000)\n        });\n        await recordQuality(readiness);\n        if (await deliverIfReady(readiness)) return handleServerManagement(chatId, userId, serverId, dcConfig);\n      } catch (rotationError) {\n        console.warn('[HETZNER_PENDING_RECOVERY_ROTATE]', {\n          server_id: String(serverId),\n          code: rotationError?.code || null,\n          message: rotationError?.message || String(rotationError)\n        });\n      }\n    }\n\n    await db.updateScopedStatus(userId, serverId, dcConfig.key, readiness.status || 'pending_ssh').catch(() => {});\n    await sendMessage(\n      chatId,\n      readiness.status === 'pending_ip_quality'\n        ? '⏳ سرور روشن است اما IP هنوز معیار دسترسی امن از ایران را پاس نکرده. IP قبلی تا تأیید candidate مناسب حفظ می‌شود و بررسی خودکار ادامه دارد.'\n        : '⏳ سرور هنوز کاملاً آماده نیست. وضعیت بدون حذف یا Rebuild حفظ شد و بررسی خودکار ادامه دارد.'\n    );\n    return handleServerManagement(chatId, userId, serverId, dcConfig);\n  } catch (error) {\n    console.error('[HETZNER_PENDING_RECOVERY_FAILED]', {\n      user_id: String(userId),\n      server_id: String(serverId),\n      dc: dcConfig?.key || null,\n      code: error?.code || null,\n      message: error?.message || String(error)\n    });\n    return sendMessage(chatId, '❌ بازیابی خودکار کامل نشد. هیچ Rebuild یا حذف دیسکی انجام نشد؛ لطفاً پشتیبانی بررسی کند.');\n  } finally {\n    hetznerDeliveryRetryLocks.delete(lockKey);\n  }\n}\n\n`;

  source = replaceOnce(
    source,
    'async function handleServerManagement(chatId, userId, serverId, dcConfig) {',
    handler + 'async function handleServerManagement(chatId, userId, serverId, dcConfig) {',
    'insert pending recovery handler'
  );

  source = replaceOnce(
    source,
    "    const osLabel = purchase?.os_label || srv.image?.name || 'N/A';",
    "    const storedOsLabel = String(purchase?.os_label || '').trim();\n    const osLabel = (storedOsLabel && !/^\\d+$/.test(storedOsLabel))\n      ? storedOsLabel\n      : (srv.image?.description || srv.image?.name || storedOsLabel || 'N/A');",
    'prefer provider OS label over raw numeric image id'
  );

  source = replaceOnce(
    source,
    `    if (hetznerDeliveryPending) {\n      if (hasCapability(dcConfig, 'deleteServer')) {`,
    `    if (hetznerDeliveryPending) {\n      keyboard.push([{ text: '🔄 بررسی و بازیابی', callback_data: makeShortCb(userId, { action: 'HDELIVERY_RETRY', dcKey: dcConfig.key, serverId: srv.id }) }]);\n      if (hasCapability(dcConfig, 'deleteServer')) {`,
    'add recovery button for pending delivery'
  );

  source = replaceOnce(
    source,
    `      case 'ASK_DELETE': {`,
    `      case 'HDELIVERY_RETRY': {\n        const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];\n        if (!dc) return sendMessage(effectiveChatId, '❌ دیتاسنتر نامعتبر.');\n        return handleHetznerDeliveryRetry(effectiveChatId, effectiveUserId, payload.serverId, dc);\n      }\n\n      case 'ASK_DELETE': {`,
    'add recovery callback'
  );

  if (!source.includes("action: 'HDELIVERY_RETRY'") || !source.includes('[HETZNER_PENDING_RECOVERY_FAILED]')) {
    throw new Error('HETZNER_PENDING_RECOVERY_PATCH_FAILED');
  }
  return source;
}

module.exports = { applyHetznerPendingDeliveryRecoveryPatches };
