'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { applyPatches: applyDisplayNamePatches } = require('./server-display-names-bootstrap');

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
    throw new Error(`[hetzner-console] patch "${label}" expected exactly 1 match, found ${count}`);
  }
  return source.replace(needle, replacement);
}

function replaceInSection(source, startMarker, endMarker, needle, replacement, label) {
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error(`[hetzner-console] section start not found for "${label}"`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end === -1) throw new Error(`[hetzner-console] section end not found for "${label}"`);
  const section = source.slice(start, end);
  const patched = replaceOnce(section, needle, replacement, label);
  return source.slice(0, start) + patched + source.slice(end);
}

function applyConsolePatches(sourceWithDisplayNames) {
  let source = String(sourceWithDisplayNames);

  const consoleHandler = `async function handleHetznerConsole(chatId, userId, serverId, dcConfig) {\n  if (!isHetznerDc(dcConfig)) {\n    return sendMessage(chatId, '❌ کنسول فقط برای سرورهای Hetzner فعال است.');\n  }\n\n  const purchase = await getPurchaseForUserServer(userId, serverId, dcConfig.key).catch(() => null)\n    || await getPurchaseByServerId(serverId).catch(() => null);\n\n  if (!purchase\n      || String(purchase.telegram_id) !== String(userId)\n      || String(purchase.datacenter) !== String(dcConfig.key)) {\n    return sendMessage(chatId, '❌ این سرور برای حساب شما پیدا نشد.');\n  }\n\n  try {\n    const hetznerApi = require('./Hetzner/hetzner-api');\n    const data = await hetznerApi.hetznerRequest(\n      dcConfig,\n      'POST',\n      \\`/servers/\\${encodeURIComponent(serverId)}/actions/request_console\\`,\n      {}\n    );\n\n    const wssUrl = String(data?.wss_url || '').trim();\n    const password = String(data?.password || '').trim();\n    if (!wssUrl || !password) throw new Error('HETZNER_CONSOLE_CREDENTIALS_MISSING');\n\n    const keyboard = [];\n    if (wssUrl.length <= 256) {\n      keyboard.push([{ text: '📋 کپی آدرس کنسول', copy_text: { text: wssUrl } }]);\n    }\n    if (password.length <= 256) {\n      keyboard.push([{ text: '📋 کپی رمز کنسول', copy_text: { text: password } }]);\n    }\n    keyboard.push([{\n      text: '🔄 ساخت لینک جدید',\n      callback_data: makeShortCb(userId, { action: 'HCONSOLE', dcKey: dcConfig.key, serverId })\n    }]);\n\n    const message =\n      '🖥 <b>کنسول Hetzner آماده است</b>\\n\\n' +\n      '<b>آدرس VNC over WebSocket:</b>\\n' +\n      \\`<code>\\${htmlEscape(wssUrl)}</code>\\n\\n\\` +\n      '<b>رمز کنسول:</b>\\n' +\n      \\`<code>\\${htmlEscape(password)}</code>\\n\\n\\` +\n      '⏱ این اطلاعات کوتاه‌عمر هستند. اگر اتصال را دیر شروع کردید، «ساخت لینک جدید» را بزنید.\\n' +\n      '🔒 این پیام تا حدود ۲ دقیقه دیگر خودکار حذف می‌شود.';\n\n    const sent = await sendMessage(chatId, message, {\n      parse_mode: 'HTML',\n      disable_web_page_preview: true,\n      reply_markup: { inline_keyboard: keyboard }\n    });\n\n    if (sent?.message_id) {\n      const timer = setTimeout(() => {\n        bot.deleteMessage(chatId, sent.message_id).catch(() => {});\n      }, 120000);\n      if (typeof timer.unref === 'function') timer.unref();\n    }\n\n    return sent;\n  } catch (e) {\n    console.error('[HETZNER_CONSOLE]', {\n      user_id: userId,\n      server_id: serverId,\n      status: e?.status || e?.response?.status || null,\n      code: e?.data?.error?.code || e?.response?.data?.error?.code || e?.code || null\n    });\n    return sendMessage(chatId, '❌ دریافت کنسول Hetzner انجام نشد. چند لحظه بعد دوباره تلاش کنید.');\n  }\n}\n\n`;

  source = replaceOnce(
    source,
    'async function handleHetznerUpgradeMenu(chatId, userId, serverId, dcConfig) {',
    consoleHandler + 'async function handleHetznerUpgradeMenu(chatId, userId, serverId, dcConfig) {',
    'add console handler'
  );

  source = replaceOnce(
    source,
    `      case 'HU': {`,
    `      case 'HCONSOLE': {\n        const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey] || baseDatacenters.hetzner;\n        if (!isHetznerDc(dc)) return sendMessage(effectiveChatId, '❌ کنسول فقط برای سرورهای Hetzner فعال است.');\n        return handleHetznerConsole(effectiveChatId, effectiveUserId, payload.serverId, dc);\n      }\n\n      case 'HU': {`,
    'add console callback'
  );

  source = replaceInSection(
    source,
    'async function handleServerManagement(chatId, userId, serverId, dcConfig) {',
    'async function getProjectTrafficSummary(chatId, userId, dcConfig, projectId) {',
    `    if (isHetznerDc(dcConfig) && purchase && String(purchase.telegram_id) === String(userId) && !HETZNER_UPGRADE_BLOCKED_STATUSES.has(String(purchase.status || '').toLowerCase())) {\n      keyboard.push([{ text: '⬆️ ارتقای سرور', callback_data: makeShortCb(userId, { action: 'HU', serverId: srv.id, dcKey: dcConfig.key }) }]);\n    }`,
    `    if (isHetznerDc(dcConfig) && purchase && String(purchase.telegram_id) === String(userId)) {\n      keyboard.push([{ text: '🖥 کنسول', callback_data: short('HCONSOLE') }]);\n    }\n    if (isHetznerDc(dcConfig) && purchase && String(purchase.telegram_id) === String(userId) && !HETZNER_UPGRADE_BLOCKED_STATUSES.has(String(purchase.status || '').toLowerCase())) {\n      keyboard.push([{ text: '⬆️ ارتقای سرور', callback_data: makeShortCb(userId, { action: 'HU', serverId: srv.id, dcKey: dcConfig.key }) }]);\n    }`,
    'add console button'
  );

  return source;
}

function applyPatches(coreSource) {
  return applyConsolePatches(applyDisplayNamePatches(coreSource));
}

function run() {
  const corePath = path.join(__dirname, 'index-core.js');
  const source = applyPatches(fs.readFileSync(corePath, 'utf8'));
  const child = new Module(corePath, module.parent);
  child.filename = corePath;
  child.paths = Module._nodeModulePaths(path.dirname(corePath));
  require.cache[corePath] = child;
  child._compile(source, corePath);
  return child.exports;
}

module.exports = { applyConsolePatches, applyPatches, run };
