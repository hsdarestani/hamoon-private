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
    "      case 'REBUILD_ASK': {\n        const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];\n        if (!requireCapabilityOrReply(effectiveChatId, dc, 'rebuild')) return;\n        return handleRebuildAsk(effectiveChatId, effectiveUserId, payload.serverId, dc, q.message.message_id);\n      }\n\n      case 'REBUILD_IMG': {\n        const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];\n        if (!requireCapabilityOrReply(effectiveChatId, dc, 'rebuild')) return;\n        return handleRebuildConfirm(\n          effectiveChatId,\n          effectiveUserId,\n          payload.serverId,\n          payload.imageId,\n          dc,\n          q.message.message_id\n        );\n      }",
    'short callback REBUILD_IMG handler'
  );

  source = replaceOnce(
    source,
    "  const serverType = state[userId]?.selectedFlavor?.id || '';\n  const compatible = hetznerLifecycle.filterCompatibleImages(images, serverType);\n  state[userId] = { ...(state[userId] || {}), rebuildInfo: { serverId, dcConfig } };\n  const keyboard = compatible.slice(0, 20).map(img => [{ text: img.label || img.name || String(img.id), callback_data: `rebuild:IMG:${img.id}` }]);",
    "  const dcKey = dcConfig?.key || dcConfig?.__baseKey;\n  const purchase = await getPurchaseForUserServer(userId, serverId, dcKey).catch(() => null);\n  const serverType = purchase?.flavor_id || state[userId]?.selectedFlavor?.id || '';\n  const compatible = hetznerLifecycle.filterCompatibleImages(images, serverType);\n  state[userId] = { ...(state[userId] || {}), rebuildInfo: { serverId, dcConfig } };\n  const keyboard = compatible.slice(0, 20).map(img => [{\n    text: img.label || img.name || String(img.id),\n    callback_data: makeShortCb(userId, { action: 'REBUILD_IMG', dcKey, serverId, imageId: img.id })\n  }]);",
    'rebuild image buttons'
  );

  return source;
}

module.exports = { applyRebuildPatches };
