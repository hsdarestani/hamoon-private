'use strict';

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) {
    throw new Error(`[rebuild-bootstrap] Patch target not found: ${label}`);
  }
  return source.replace(before, after);
}

function applyRebuildPatches(coreSource) {
  let source = String(coreSource);

  source = replaceOnce(
    source,
    "      case 'REBUILD_ASK': {\n        const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];\n        if (!requireCapabilityOrReply(effectiveChatId, dc, 'rebuild')) return;\n        return handleRebuildAsk(effectiveChatId, effectiveUserId, payload.serverId, dc, q.message.message_id);\n      }",
    "      case 'REBUILD_ASK': {\n        const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];\n        if (!requireCapabilityOrReply(effectiveChatId, dc, 'rebuild')) return;\n        return handleRebuildAsk(effectiveChatId, effectiveUserId, payload.serverId, dc, q.message.message_id);\n      }\n\n      case 'REBUILD_IMG': {\n        if (payload.rebuildStarted) {\n          return bot.sendMessage(effectiveChatId, '⏳ بازسازی این سرور قبلاً شروع شده و در حال انجام است.');\n        }\n        for (const rebuildPayload of Object.values(state[effectiveUserId]?.cb || {})) {\n          if (\n            rebuildPayload?.action === 'REBUILD_IMG' &&\n            String(rebuildPayload.serverId) === String(payload.serverId) &&\n            String(rebuildPayload.dcKey) === String(payload.dcKey)\n          ) {\n            rebuildPayload.rebuildStarted = true;\n          }\n        }\n        const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];\n        if (!requireCapabilityOrReply(effectiveChatId, dc, 'rebuild')) return;\n        return handleRebuildConfirm(\n          effectiveChatId,\n          effectiveUserId,\n          payload.serverId,\n          payload.imageId,\n          dc,\n          q.message.message_id\n        );\n      }",
    'short callback REBUILD_IMG handler'
  );

  source = replaceOnce(
    source,
    "  const images = await openstackApi.listImages(dcConfig, null);\n  const serverType = state[userId]?.selectedFlavor?.id || '';\n  const compatible = hetznerLifecycle.filterCompatibleImages(images, serverType);\n  state[userId] = { ...(state[userId] || {}), rebuildInfo: { serverId, dcConfig } };\n  const keyboard = compatible.slice(0, 20).map(img => [{ text: img.label || img.name || String(img.id), callback_data: `rebuild:IMG:${img.id}` }]);",
    "  const dcKey = dcConfig?.key || dcConfig?.__baseKey;\n  const purchase = await getPurchaseForUserServer(userId, serverId, dcKey).catch(() => null);\n  let serverType = purchase?.flavor_id || state[userId]?.selectedFlavor?.id || '';\n  if (isHetznerDc(dcConfig) && !serverType) {\n    const providerServer = await openstackApi.getServer(dcConfig, null, serverId).catch(() => null);\n    serverType = providerServer?.server_type?.name || providerServer?.server_type || '';\n  }\n  let images = [];\n  try {\n    images = isHetznerDc(dcConfig)\n      ? await require('./hetzner-purchase-images').listCompatibleImages(dcConfig, serverType)\n      : await openstackApi.listImages(dcConfig, null);\n  } catch (e) {\n    console.warn('[REBUILD_IMAGE_CATALOG_FAILED]', { server_id: serverId, datacenter: dcKey, server_type: serverType || null, code: e?.code || e?.message });\n    return bot.sendMessage(chatId, '❌ دریافت لیست سیستم‌عامل‌های سازگار ممکن نشد. لطفاً چند لحظه بعد دوباره تلاش کنید.');\n  }\n  const compatible = isHetznerDc(dcConfig) ? images : hetznerLifecycle.filterCompatibleImages(images, serverType);\n  if (!compatible.length) {\n    console.warn('[REBUILD_IMAGE_CATALOG_EMPTY]', { server_id: serverId, datacenter: dcKey, server_type: serverType || null });\n    return bot.sendMessage(chatId, '❌ در حال حاضر سیستم‌عامل سازگاری برای این پلن پیدا نشد. لطفاً با پشتیبانی تماس بگیرید.');\n  }\n  state[userId] = { ...(state[userId] || {}), rebuildInfo: { serverId, dcConfig } };\n  const keyboard = compatible.slice(0, 20).map(img => [{\n    text: img.label || img.name || String(img.id),\n    callback_data: makeShortCb(userId, { action: 'REBUILD_IMG', dcKey, serverId, imageId: img.id })\n  }]);",
    'rebuild image buttons'
  );

  source = replaceOnce(
    source,
    'async function handleRebuildConfirm(chatId, userId, serverId, imageId, dcConfig) {\n  try {',
    "async function handleRebuildConfirm(chatId, userId, serverId, imageId, dcConfig, messageId) {\n  if (messageId) {\n    await bot.editMessageReplyMarkup(\n      { inline_keyboard: [] },\n      { chat_id: chatId, message_id: messageId }\n    ).catch(() => null);\n  }\n  await bot.sendMessage(chatId, '⏳ بازسازی شروع شد. سرور در حال نصب سیستم‌عامل و آماده‌سازی SSH است...').catch(() => null);\n  try {",
    'rebuild one-shot UI'
  );

  source = replaceOnce(
    source,
    '    await bot.sendMessage(chatId, `✅ بازسازی تکمیل شد و SSH در دسترس است.${passNote}`);',
    "    if (!result.ok) {\n      return bot.sendMessage(chatId, '⏳ بازسازی توسط ارائه‌دهنده انجام شده، اما SSH هنوز آماده نیست. پس از آماده‌شدن سرور وضعیت نهایی اعلام می‌شود.');\n    }\n    const passwordBlock = result.root_password\n      ? `\\n\\n🔐 رمز root جدید:\\n<code>${htmlEscape(result.root_password)}</code>\\n⚠️ این رمز را در جای امن نگه دارید.`\n      : '';\n    await bot.sendMessage(\n      chatId,\n      `✅ بازسازی تکمیل شد و SSH در دسترس است.${passwordBlock}`,\n      { parse_mode: 'HTML' }\n    );",
    'rebuild completion semantics'
  );

  source = replaceOnce(
    source,
    "  } catch (e) {\n    console.warn('[HETZNER_REBUILD_FAILED]', { server_id: serverId, code: e.code || e.message });\n    await bot.sendMessage(chatId, hetznerLifecycle.safeProviderMessage(e));\n  }\n}",
    "  } catch (e) {\n    console.warn('[HETZNER_REBUILD_FAILED]', { server_id: serverId, code: e.code || e.message });\n    if (e?.code === 'OPERATION_IN_PROGRESS' || e?.message === 'OPERATION_IN_PROGRESS') {\n      return bot.sendMessage(chatId, '⏳ بازسازی این سرور در حال انجام است. پس از تکمیل، نتیجه اعلام می‌شود.');\n    }\n    await bot.sendMessage(chatId, hetznerLifecycle.safeProviderMessage(e));\n  }\n}",
    'rebuild duplicate lock message'
  );

  return source;
}

module.exports = { applyRebuildPatches };
