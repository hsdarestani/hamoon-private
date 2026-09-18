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
    throw new Error(`[server-display-names] patch "${label}" expected exactly 1 match, found ${count}`);
  }
  return source.replace(needle, replacement);
}

function replaceInSection(source, startMarker, endMarker, needle, replacement, label) {
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error(`[server-display-names] section start not found for "${label}"`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end === -1) throw new Error(`[server-display-names] section end not found for "${label}"`);
  const section = source.slice(start, end);
  const patchedSection = replaceOnce(section, needle, replacement, label);
  return source.slice(0, start) + patchedSection + source.slice(end);
}

function applyPatches(originalSource) {
  let source = String(originalSource);

  source = replaceOnce(
    source,
    `} = require('./db');\n\n// Environment variables`,
    `} = require('./db');\n\nconst {\n    normalizeServerDisplayName,\n    getServerDisplayName,\n    getServerDisplayNameMap,\n    getServerDisplayNameFromMap,\n    setServerDisplayName,\n    clearServerDisplayName\n} = require('./server-display-names');\n\n// Environment variables`,
    'import server display name helpers'
  );

  source = replaceOnce(
    source,
    `    if (state[effectiveUserId]?.step === 'WAIT_SHAHKAR_NATIONAL_CODE') {\n        return handleShahkarNationalCodeMessage(effectiveChatId, effectiveUserId, text);\n    }\n\n    switch (text) {`,
    `    if (state[effectiveUserId]?.step === 'WAIT_SHAHKAR_NATIONAL_CODE') {\n        return handleShahkarNationalCodeMessage(effectiveChatId, effectiveUserId, text);\n    }\n\n    if (state[effectiveUserId]?.step === 'WAIT_SERVER_RENAME') {\n        return handleServerRenameMessage(effectiveChatId, effectiveUserId, text);\n    }\n\n    switch (text) {`,
    'route rename text input'
  );

  source = replaceOnce(
    source,
    `ensureUserState(effectiveUserId);\n\nconst serverManageKeyboard = userServers.map(s => {`,
    `ensureUserState(effectiveUserId);\nconst serverDisplayNames = await getServerDisplayNameMap(effectiveUserId);\n\nconst serverManageKeyboard = userServers.map(s => {`,
    'load aliases for regular server list'
  );

  source = replaceOnce(
    source,
    `{ text: \`${'${s.purchase?.server_name || s.name}'} (${'${userDCs[s.datacenter]?.name || s.datacenter}'})\`, callback_data: token }`,
    `{ text: \`${'${getServerDisplayNameFromMap(serverDisplayNames, s.datacenter, s.id) || s.purchase?.server_name || s.name}'} (${'${userDCs[s.datacenter]?.name || s.datacenter}'})\`, callback_data: token }`,
    'show aliases in regular server list'
  );

  source = replaceOnce(
    source,
    `      const keyboard = [\n        [{\n          text: "📊 مشاهده کل ترافیک پروژه",`,
    `      const serverDisplayNames = await getServerDisplayNameMap(effectiveUserId);\n      const keyboard = [\n        [{\n          text: "📊 مشاهده کل ترافیک پروژه",`,
    'load aliases for project server list'
  );

  source = replaceOnce(
    source,
    `          text: \`🖥 ${'${s.name}'}\`,`,
    `          text: \`🖥 ${'${getServerDisplayNameFromMap(serverDisplayNames, dc.key, s.id) || s.name}'}\`,`,
    'show aliases in project server list'
  );

  source = replaceOnce(
    source,
    `      case 'HU': {`,
    `      case 'RENAME_SERVER': {\n        const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];\n        if (!dc) return sendMessage(effectiveChatId, '❌ دیتاسنتر نامعتبر.');\n        const currentName = await getServerDisplayName(effectiveUserId, payload.serverId, dc.key).catch(() => null);\n        state[effectiveUserId] = {\n          ...(state[effectiveUserId] || {}),\n          step: 'WAIT_SERVER_RENAME',\n          renameServer: { serverId: payload.serverId, dcKey: dc.key }\n        };\n        return sendMessage(\n          effectiveChatId,\n          '🏷 نام نمایشی جدید سرور را بفرستید.\\n' +\n          (currentName ? \`نام فعلی: ${'${currentName}'}\\n\` : '') +\n          'مثال: سایت وستا، VPN آلمان، سرور مشتری ۳\\n' +\n          'حداکثر ۶۴ کاراکتر.\\n\\n' +\n          'برای برگشت به نام اصلی فقط «-» بفرستید؛ برای انصراف «لغو» را بفرستید.'\n        );\n      }\n      case 'CLEAR_SERVER_NAME': {\n        const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];\n        if (!dc) return sendMessage(effectiveChatId, '❌ دیتاسنتر نامعتبر.');\n        await clearServerDisplayName(effectiveUserId, payload.serverId, dc.key);\n        await sendMessage(effectiveChatId, '✅ نام نمایشی حذف شد و نام اصلی سرور نمایش داده می‌شود.');\n        return handleServerManagement(effectiveChatId, effectiveUserId, payload.serverId, dc);\n      }\n\n      case 'HU': {`,
    'handle rename callbacks'
  );

  const renameHandler = `async function handleServerRenameMessage(chatId, userId, text) {\n  const renameInfo = state[userId]?.renameServer;\n  if (!renameInfo?.serverId || !renameInfo?.dcKey) {\n    state[userId] = { ...(state[userId] || {}), step: 'READY', renameServer: null };\n    return sendMessage(chatId, '❌ درخواست تغییر نام منقضی شده است. دوباره از مدیریت سرور وارد شوید.');\n  }\n\n  const value = String(text || '').trim();\n  if (/^(لغو|انصراف|cancel)$/i.test(value)) {\n    state[userId] = { ...(state[userId] || {}), step: 'READY', renameServer: null };\n    return sendMessage(chatId, '↩️ تغییر نام لغو شد.');\n  }\n\n  const dcConfig = getUserEffectiveDCs(userId)[renameInfo.dcKey];\n  if (!dcConfig) {\n    state[userId] = { ...(state[userId] || {}), step: 'READY', renameServer: null };\n    return sendMessage(chatId, '❌ دیتاسنتر این سرور دیگر در دسترس نیست.');\n  }\n\n  try {\n    if (value === '-' || value === 'نام اصلی') {\n      await clearServerDisplayName(userId, renameInfo.serverId, renameInfo.dcKey);\n      state[userId] = { ...(state[userId] || {}), step: 'READY', renameServer: null };\n      await sendMessage(chatId, '✅ نام نمایشی حذف شد و نام اصلی سرور نمایش داده می‌شود.');\n      return handleServerManagement(chatId, userId, renameInfo.serverId, dcConfig);\n    }\n\n    const displayName = normalizeServerDisplayName(value);\n    if (!displayName) {\n      return sendMessage(chatId, '❌ نام نمی‌تواند خالی باشد. یک نام کوتاه و مشخص بفرستید.');\n    }\n\n    await setServerDisplayName(userId, renameInfo.serverId, renameInfo.dcKey, displayName);\n    state[userId] = { ...(state[userId] || {}), step: 'READY', renameServer: null };\n    await sendMessage(chatId, \`✅ نام نمایشی سرور به «${'${displayName}'}» تغییر کرد.\`);\n    return handleServerManagement(chatId, userId, renameInfo.serverId, dcConfig);\n  } catch (e) {\n    if (e?.code === 'DISPLAY_NAME_TOO_LONG') {\n      return sendMessage(chatId, '❌ نام خیلی طولانی است. حداکثر ۶۴ کاراکتر وارد کنید.');\n    }\n    console.error('[SERVER_RENAME]', { userId, serverId: renameInfo.serverId, dcKey: renameInfo.dcKey, message: e.message });\n    return sendMessage(chatId, '❌ تغییر نام ذخیره نشد. لطفاً دوباره تلاش کنید.');\n  }\n}\n\n`;

  source = replaceOnce(
    source,
    `async function handleServerManagement(chatId, userId, serverId, dcConfig) {`,
    renameHandler + `async function handleServerManagement(chatId, userId, serverId, dcConfig) {`,
    'add rename message handler'
  );

  source = replaceInSection(
    source,
    `async function handleServerManagement(chatId, userId, serverId, dcConfig) {`,
    `async function getProjectTrafficSummary(chatId, userId, dcConfig, projectId) {`,
    `      : await getPurchaseByServerId(serverId);\n\n    let ip = extractServerIp(srv) || '–';`,
    `      : await getPurchaseByServerId(serverId);\n\n    const customDisplayName = await getServerDisplayName(userId, srv.id, dcConfig.key).catch(() => null);\n    const technicalName = purchase?.server_name || srv.name || srv.id;\n    const shownName = customDisplayName || technicalName;\n    let ip = extractServerIp(srv) || '–';`,
    'resolve display name in management view'
  );

  source = replaceInSection(
    source,
    `async function handleServerManagement(chatId, userId, serverId, dcConfig) {`,
    `async function getProjectTrafficSummary(chatId, userId, dcConfig, projectId) {`,
    `      \`*مدیریت سرور: ${'${escapeMarkdownV2(srv.name || srv.id)}'}*\\n\` +`,
    `      \`*مدیریت سرور: ${'${escapeMarkdownV2(shownName)}'}*\\n\` +`,
    'show display name in management title'
  );

  source = replaceInSection(
    source,
    `async function handleServerManagement(chatId, userId, serverId, dcConfig) {`,
    `async function getProjectTrafficSummary(chatId, userId, dcConfig, projectId) {`,
    `      \`سیستم عامل: ${'${escapeMarkdownV2(osLabel)}'}\\n\`;\n\n    if (purchase) {`,
    `      \`سیستم عامل: ${'${escapeMarkdownV2(osLabel)}'}\\n\`;\n\n    if (customDisplayName && customDisplayName !== technicalName) {\n      messageText += \`نام اصلی: ${'${escapeMarkdownV2(technicalName)}'}\\n\`;\n    }\n\n    if (purchase) {`,
    'show technical name when alias exists'
  );

  source = replaceInSection(
    source,
    `async function handleServerManagement(chatId, userId, serverId, dcConfig) {`,
    `async function getProjectTrafficSummary(chatId, userId, dcConfig, projectId) {`,
    `    const short = (action, extra = {}) => makeShortCb(userId, { action, dcKey: dcConfig.key, serverId: srv.id, ...extra });\n\n    if (isProjectDC`,
    `    const short = (action, extra = {}) => makeShortCb(userId, { action, dcKey: dcConfig.key, serverId: srv.id, ...extra });\n\n    keyboard.push([{ text: customDisplayName ? '✏️ تغییر نام نمایشی' : '🏷️ نام‌گذاری سرور', callback_data: short('RENAME_SERVER') }]);\n    if (customDisplayName) {\n      keyboard.push([{ text: '🧹 بازگشت به نام اصلی', callback_data: short('CLEAR_SERVER_NAME') }]);\n    }\n\n    if (isProjectDC`,
    'add rename buttons to management view'
  );

  source = replaceInSection(
    source,
    `async function askForDeletionConfirmation(chatId, userId, serverId, dcConfig) {`,
    `async function handleServerDeletion(chatId, userId, serverId, dcConfig) {`,
    `    const serverName = purchase?.server_name || serverId;`,
    `    const customDisplayName = await getServerDisplayName(userId, serverId, dcConfig.key).catch(() => null);\n    const serverName = customDisplayName || purchase?.server_name || serverId;`,
    'show display name in delete confirmation'
  );

  source = replaceInSection(
    source,
    `async function handleServerDeletion(chatId, userId, serverId, dcConfig) {`,
    `async function getPrivateKey(chatId, serverId) {`,
    `        logServerEvent({ type: 'server_deleted', server_id: serverId, user_id: userId, datacenter: dcConfig.key });`,
    `        await clearServerDisplayName(userId, serverId, dcConfig.key).catch(() => {});\n        logServerEvent({ type: 'server_deleted', server_id: serverId, user_id: userId, datacenter: dcConfig.key });`,
    'clear display name after deletion'
  );

  return source;
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

module.exports = { applyPatches, run };
