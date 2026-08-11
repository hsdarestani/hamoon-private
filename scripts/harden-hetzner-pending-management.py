#!/usr/bin/env python3
from pathlib import Path

p = Path('index-core.js')
s = p.read_text()

helper = r'''
const HETZNER_UNDELIVERED_PURCHASE_STATUSES = new Set([
  'provisioning',
  'pending_ip',
  'pending_ssh',
  'pending_ip_quality',
  'manual_review',
  'provisioning_failed'
]);

function isHetznerUndeliveredPurchase(purchase) {
  if (!purchase) return false;
  return HETZNER_UNDELIVERED_PURCHASE_STATUSES.has(String(purchase.status || '').toLowerCase());
}

async function blockUndeliveredHetznerAction(chatId, serverId, dcConfig) {
  if (!isHetznerDc(dcConfig)) return false;
  const purchase = await getPurchaseByServerId(serverId).catch(() => null);
  if (!isHetznerUndeliveredPurchase(purchase)) return false;
  await sendMessage(
    chatId,
    '⏳ این سرور هنوز تحویل نهایی نشده است و تا تأیید روشن بودن، SSH و دسترسی IP از ایران و نقاط خارجی، اطلاعات ورود یا عملیات حساس در دسترس نیست.'
  );
  return true;
}
'''

if 'const HETZNER_UNDELIVERED_PURCHASE_STATUSES' not in s:
    marker = "\nasync function handleGetStoredPassword(chatId, userId, serverId, dcConfig, messageId) {"
    if marker not in s:
        raise SystemExit('stored-password handler marker not found')
    s = s.replace(marker, '\n' + helper + marker, 1)

old = """async function handleGetStoredPassword(chatId, userId, serverId, dcConfig, messageId) {\n  if (!isAfraDc(dcConfig)) return handleResetPasswordConfirm(chatId, serverId, dcConfig, messageId);"""
new = """async function handleGetStoredPassword(chatId, userId, serverId, dcConfig, messageId) {\n  if (await blockUndeliveredHetznerAction(chatId, serverId, dcConfig)) return;\n  if (!isAfraDc(dcConfig)) return handleResetPasswordConfirm(chatId, serverId, dcConfig, messageId);"""
if old in s:
    s = s.replace(old, new, 1)
elif 'if (await blockUndeliveredHetznerAction(chatId, serverId, dcConfig)) return;\n  if (!isAfraDc(dcConfig))' not in s:
    raise SystemExit('stored-password guard insertion failed')

old = """async function handleResetPasswordAsk(chatId, userId, serverId, dcConfig) {\n  if (!requireCapabilityOrReply(chatId, dcConfig, 'resetPassword')) return;"""
new = """async function handleResetPasswordAsk(chatId, userId, serverId, dcConfig) {\n  if (!requireCapabilityOrReply(chatId, dcConfig, 'resetPassword')) return;\n  if (await blockUndeliveredHetznerAction(chatId, serverId, dcConfig)) return;"""
if old in s:
    s = s.replace(old, new, 1)
elif "handleResetPasswordAsk" in s and "blockUndeliveredHetznerAction(chatId, serverId, dcConfig)" not in s[s.index('async function handleResetPasswordAsk'):s.index('async function handleResetPasswordConfirm')]:
    raise SystemExit('reset ask guard insertion failed')

old = """async function handleResetPasswordConfirm(chatId, serverId, dcConfig, messageId) {\n  if (!requireCapabilityOrReply(chatId, dcConfig, 'resetPassword')) return;\n  try {"""
new = """async function handleResetPasswordConfirm(chatId, serverId, dcConfig, messageId) {\n  if (!requireCapabilityOrReply(chatId, dcConfig, 'resetPassword')) return;\n  if (await blockUndeliveredHetznerAction(chatId, serverId, dcConfig)) return;\n  try {"""
if old in s:
    s = s.replace(old, new, 1)
elif "handleResetPasswordConfirm" in s and "blockUndeliveredHetznerAction(chatId, serverId, dcConfig)" not in s[s.index('async function handleResetPasswordConfirm'):s.index('async function handleChangeCycleConfirm')]:
    raise SystemExit('reset confirm guard insertion failed')

old = """    let ip = extractServerIp(srv) || '–';\n\n    const osLabel = purchase?.os_label || srv.image?.name || 'N/A';"""
new = """    const hetznerDeliveryPending = isHetznerDc(dcConfig) && isHetznerUndeliveredPurchase(purchase);\n    let ip = hetznerDeliveryPending ? 'در حال بررسی' : (extractServerIp(srv) || '–');\n\n    const osLabel = purchase?.os_label || srv.image?.name || 'N/A';"""
if old in s:
    s = s.replace(old, new, 1)
elif 'const hetznerDeliveryPending = isHetznerDc(dcConfig) && isHetznerUndeliveredPurchase(purchase);' not in s:
    raise SystemExit('management IP redaction insertion failed')

old = """    let messageText =\n      `*مدیریت سرور: ${escapeMarkdownV2(srv.name || srv.id)}*\\n` +\n      `دیتاسنتر: ${escapeMarkdownV2(dcConfig.name)}\\n` +\n      `IP: ${escapeMarkdownV2(ip)}\\n` +\n      `وضعیت: ${escapeMarkdownV2(srv.status || srv.state || 'N/A')}\\n` +\n      `سیستم عامل: ${escapeMarkdownV2(osLabel)}\\n`;"""
new = """    const displayStatus = hetznerDeliveryPending\n      ? (purchase?.status || 'provisioning')\n      : (srv.status || srv.state || 'N/A');\n    let messageText =\n      `*مدیریت سرور: ${escapeMarkdownV2(srv.name || srv.id)}*\\n` +\n      `دیتاسنتر: ${escapeMarkdownV2(dcConfig.name)}\\n` +\n      `IP: ${escapeMarkdownV2(ip)}\\n` +\n      `وضعیت: ${escapeMarkdownV2(displayStatus)}\\n` +\n      `سیستم عامل: ${escapeMarkdownV2(osLabel)}\\n`;\n    if (hetznerDeliveryPending) {\n      messageText += '⏳ تحویل: در حال بررسی روشن بودن، SSH و دسترسی IP از ایران و نقاط خارجی\\n';\n    }"""
if old in s:
    s = s.replace(old, new, 1)
elif 'const displayStatus = hetznerDeliveryPending' not in s:
    raise SystemExit('management status redaction insertion failed')

old = """    const keyboard = [];\n    const short = (action, extra = {}) => makeShortCb(userId, { action, dcKey: dcConfig.key, serverId: srv.id, ...extra });\n\n    if (isProjectDC"""
new = """    const keyboard = [];\n    const short = (action, extra = {}) => makeShortCb(userId, { action, dcKey: dcConfig.key, serverId: srv.id, ...extra });\n\n    if (hetznerDeliveryPending) {\n      if (hasCapability(dcConfig, 'deleteServer')) {\n        keyboard.push([{ text: '❌ حذف سرور', callback_data: makeShortCb(userId, { action: 'ASK_DELETE', dcKey: dcConfig.key, serverId: srv.id }) }]);\n      }\n      keyboard.push([{ text: '🔙 بازگشت', callback_data: 'CANCEL' }]);\n      await sendMessage(chatId, messageText, {\n        parse_mode: 'MarkdownV2',\n        reply_markup: { inline_keyboard: keyboard }\n      });\n      console.log('[handleServerManagement] pending Hetzner delivery redacted', { user: userId, dc: dcConfig.key, server_id: srv.id, status: purchase?.status });\n      return;\n    }\n\n    if (isProjectDC"""
if old in s:
    s = s.replace(old, new, 1)
elif "pending Hetzner delivery redacted" not in s:
    raise SystemExit('management sensitive-action guard insertion failed')

p.write_text(s)
print('harden-hetzner-pending-management: patched')
