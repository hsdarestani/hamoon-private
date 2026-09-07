'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

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
  if (count !== 1) {
    throw new Error(`[hetzner-change-ip] patch "${label}" expected exactly 1 match, found ${count}`);
  }
  return source.replace(needle, replacement);
}

function replaceInSection(source, startMarker, endMarker, needle, replacement, label) {
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error(`[hetzner-change-ip] section start not found for "${label}"`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end === -1) throw new Error(`[hetzner-change-ip] section end not found for "${label}"`);
  const section = source.slice(start, end);
  const patched = replaceOnce(section, needle, replacement, label);
  return source.slice(0, start) + patched + source.slice(end);
}

function applyHetznerChangeIpPatches(originalSource) {
  let source = String(originalSource);

  const handlers = [
    "async function handleHetznerChangeIpAsk(chatId, userId, serverId, dcConfig) {",
    "  if (!isHetznerDc(dcConfig)) return sendMessage(chatId, '❌ تغییر IP فقط برای سرورهای Hetzner فعال است.');",
    "  const purchase = await getPurchaseForUserServer(userId, serverId, dcConfig.key).catch(() => null);",
    "  if (!purchase || String(purchase.telegram_id) !== String(userId)) return sendMessage(chatId, '❌ این سرور برای حساب شما پیدا نشد.');",
    "  const status = String(purchase.status || '').toLowerCase();",
    "  const allowed = new Set(['active', 'running', 'suspended', 'stopped', 'shutoff']);",
    "  if (!allowed.has(status)) return sendMessage(chatId, '❌ در وضعیت فعلی سرور امکان تغییر IP وجود ندارد.');",
    "",
    "  const yes = makeShortCb(userId, { action: 'HETZNER_CHANGE_IP_CONFIRM', dcKey: dcConfig.key, serverId });",
    "  const no = makeShortCb(userId, { action: 'HETZNER_CHANGE_IP_CANCEL', dcKey: dcConfig.key, serverId });",
    "  return sendMessage(chatId,",
    "    '⚠️ با تغییر IP، سرور برای مدت کوتاهی خاموش و دوباره روشن می‌شود و IPv4 فعلی با یک IPv4 جدید جایگزین خواهد شد.\\n\\n' +",
    "    'ربات تلاش می‌کند IPای بدهد که قبلاً روی همین سرور استفاده نشده باشد. ادامه می‌دهید؟',",
    "    { reply_markup: { inline_keyboard: [",
    "      [{ text: '✅ بله، تغییر IP', callback_data: yes }],",
    "      [{ text: '❌ انصراف', callback_data: no }]",
    "    ] } }",
    "  );",
    "}",
    "",
    "async function handleHetznerChangeIpConfirm(chatId, userId, serverId, dcConfig) {",
    "  if (!isHetznerDc(dcConfig)) return sendMessage(chatId, '❌ تغییر IP فقط برای سرورهای Hetzner فعال است.');",
    "  await sendMessage(chatId, '⏳ در حال تغییر IP سرور... این عملیات ممکن است یکی دو دقیقه طول بکشد.');",
    "  try {",
    "    const dbModule = require('./db');",
    "    const { changeHetznerPublicIp } = require('./services/hetzner-change-ip');",
    "    const result = await changeHetznerPublicIp({",
    "      db: dbModule,",
    "      dc: dcConfig,",
    "      telegramId: userId,",
    "      serverId,",
    "      datacenter: dcConfig.key",
    "    });",
    "    await sendMessage(chatId, '✅ IP سرور با موفقیت تغییر کرد.\\nIP قبلی: ' + result.oldIp + '\\nIP جدید: ' + result.newIp);",
    "    return handleServerManagement(chatId, userId, serverId, dcConfig);",
    "  } catch (error) {",
    "    console.error('[HETZNER_CHANGE_IP]', {",
    "      user_id: userId,",
    "      server_id: String(serverId),",
    "      datacenter: dcConfig.key,",
    "      code: error?.code || null,",
    "      message: error?.message || String(error)",
    "    });",
    "    const { userMessageForError } = require('./services/hetzner-change-ip');",
    "    return sendMessage(chatId, '❌ ' + userMessageForError(error));",
    "  }",
    "}",
    "",
    "async function handleHetznerChangeIpCancel(chatId, userId, serverId, dcConfig) {",
    "  await sendMessage(chatId, '↩️ تغییر IP لغو شد.');",
    "  return handleServerManagement(chatId, userId, serverId, dcConfig);",
    "}",
    ""
  ].join('\n');

  source = replaceOnce(
    source,
    'async function handleHetznerUpgradeMenu(chatId, userId, serverId, dcConfig) {',
    handlers + 'async function handleHetznerUpgradeMenu(chatId, userId, serverId, dcConfig) {',
    'add change IP handlers'
  );

  source = replaceOnce(
    source,
    `      case 'HCONSOLE': {`,
    `      case 'HETZNER_CHANGE_IP_ASK': {\n        const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey] || baseDatacenters[payload.dcKey];\n        if (!dc) return sendMessage(effectiveChatId, '❌ دیتاسنتر نامعتبر.');\n        return handleHetznerChangeIpAsk(effectiveChatId, effectiveUserId, payload.serverId, dc);\n      }\n\n      case 'HETZNER_CHANGE_IP_CONFIRM': {\n        const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey] || baseDatacenters[payload.dcKey];\n        if (!dc) return sendMessage(effectiveChatId, '❌ دیتاسنتر نامعتبر.');\n        return handleHetznerChangeIpConfirm(effectiveChatId, effectiveUserId, payload.serverId, dc);\n      }\n\n      case 'HETZNER_CHANGE_IP_CANCEL': {\n        const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey] || baseDatacenters[payload.dcKey];\n        if (!dc) return sendMessage(effectiveChatId, '❌ دیتاسنتر نامعتبر.');\n        return handleHetznerChangeIpCancel(effectiveChatId, effectiveUserId, payload.serverId, dc);\n      }\n\n      case 'HCONSOLE': {`,
    'add change IP callbacks'
  );

  const trafficBlock = `    if (isHetznerDc(dcConfig) && purchase && String(purchase.telegram_id) === String(userId)) {\n      keyboard.push([\n        { text: '📊 مصرف ترافیک', callback_data: short('HETZNER_TRAFFIC', { range: 'current' }) },\n        { text: '➕ خرید ترافیک', callback_data: short('HETZNER_TRAFFIC_BUY') }\n      ]);\n    }`;
  const trafficAndIp = `${trafficBlock}\n    if (isHetznerDc(dcConfig) && purchase && String(purchase.telegram_id) === String(userId) && ['active', 'running', 'suspended', 'stopped', 'shutoff'].includes(String(purchase.status || '').toLowerCase())) {\n      keyboard.push([{ text: '🔄 تغییر IP', callback_data: short('HETZNER_CHANGE_IP_ASK') }]);\n    }`;

  source = replaceInSection(
    source,
    'async function handleServerManagement(chatId, userId, serverId, dcConfig) {',
    'async function getProjectTrafficSummary(chatId, userId, dcConfig, projectId) {',
    trafficBlock,
    trafficAndIp,
    'add change IP button after traffic'
  );

  return source;
}

function run() {
  const corePath = path.join(__dirname, 'index-core.js');
  const source = applyHetznerChangeIpPatches(fs.readFileSync(corePath, 'utf8'));
  const child = new Module(corePath, module.parent);
  child.filename = corePath;
  child.paths = Module._nodeModulePaths(path.dirname(corePath));
  require.cache[corePath] = child;
  child._compile(source, corePath);
  return child.exports;
}

module.exports = { applyHetznerChangeIpPatches, run };
