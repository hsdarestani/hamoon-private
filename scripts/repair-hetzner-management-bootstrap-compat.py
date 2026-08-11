#!/usr/bin/env python3
from pathlib import Path

p = Path('index-core.js')
s = p.read_text()

old = """    const hetznerDeliveryPending = isHetznerDc(dcConfig) && isHetznerUndeliveredPurchase(purchase);\n    let ip = hetznerDeliveryPending ? 'در حال بررسی' : (extractServerIp(srv) || '–');"""
new = """    let ip = extractServerIp(srv) || '–';\n    const hetznerDeliveryPending = isHetznerDc(dcConfig) && isHetznerUndeliveredPurchase(purchase);\n    if (hetznerDeliveryPending) ip = 'در حال بررسی';"""
if old in s:
    s = s.replace(old, new, 1)
elif new not in s:
    raise SystemExit('management IP compatibility marker not found')

note = """    if (hetznerDeliveryPending) {\n      messageText += '⏳ تحویل: در حال بررسی روشن بودن، SSH و دسترسی IP از ایران و نقاط خارجی\\n';\n    }\n"""
if note in s:
    s = s.replace(note, '', 1)

purchase_block = """    if (purchase) {\n      messageText += Number(purchase.auto_renew ?? 1) === 1\n        ? '🔁 تمدید خودکار: روشن\\n'\n        : '⏸ تمدید خودکار: خاموش\\n';\n    }\n\n    const keyboard = [];"""
replacement = """    if (purchase) {\n      messageText += Number(purchase.auto_renew ?? 1) === 1\n        ? '🔁 تمدید خودکار: روشن\\n'\n        : '⏸ تمدید خودکار: خاموش\\n';\n    }\n    if (hetznerDeliveryPending) {\n      messageText += '⏳ تحویل: در حال بررسی روشن بودن، SSH و دسترسی IP از ایران و نقاط خارجی\\n';\n    }\n\n    const keyboard = [];"""
if replacement not in s:
    if purchase_block not in s:
        raise SystemExit('management note compatibility marker not found')
    s = s.replace(purchase_block, replacement, 1)

old_keyboard = """    const keyboard = [];\n    const short = (action, extra = {}) => makeShortCb(userId, { action, dcKey: dcConfig.key, serverId: srv.id, ...extra });\n\n    if (hetznerDeliveryPending) {\n      if (hasCapability(dcConfig, 'deleteServer')) {\n        keyboard.push([{ text: '❌ حذف سرور', callback_data: makeShortCb(userId, { action: 'ASK_DELETE', dcKey: dcConfig.key, serverId: srv.id }) }]);\n      }\n      keyboard.push([{ text: '🔙 بازگشت', callback_data: 'CANCEL' }]);\n      await sendMessage(chatId, messageText, {\n        parse_mode: 'MarkdownV2',\n        reply_markup: { inline_keyboard: keyboard }\n      });\n      console.log('[handleServerManagement] pending Hetzner delivery redacted', { user: userId, dc: dcConfig.key, server_id: srv.id, status: purchase?.status });\n      return;\n    }\n\n    if (isProjectDC"""
new_keyboard = """    const keyboard = [];\n    if (hetznerDeliveryPending) {\n      if (hasCapability(dcConfig, 'deleteServer')) {\n        keyboard.push([{ text: '❌ حذف سرور', callback_data: makeShortCb(userId, { action: 'ASK_DELETE', dcKey: dcConfig.key, serverId: srv.id }) }]);\n      }\n      keyboard.push([{ text: '🔙 بازگشت', callback_data: 'CANCEL' }]);\n      await sendMessage(chatId, messageText, {\n        parse_mode: 'MarkdownV2',\n        reply_markup: { inline_keyboard: keyboard }\n      });\n      console.log('[handleServerManagement] pending Hetzner delivery redacted', { user: userId, dc: dcConfig.key, server_id: srv.id, status: purchase?.status });\n      return;\n    }\n\n    const short = (action, extra = {}) => makeShortCb(userId, { action, dcKey: dcConfig.key, serverId: srv.id, ...extra });\n\n    if (isProjectDC"""
if old_keyboard in s:
    s = s.replace(old_keyboard, new_keyboard, 1)
elif new_keyboard not in s:
    raise SystemExit('management keyboard compatibility marker not found')

p.write_text(s)
print('repair-hetzner-management-bootstrap-compat: patched')
