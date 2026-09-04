'use strict';

function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`[purchase-confirmation-safety-bootstrap] ${label}: expected 1 match, found ${count}`);
  }
  return source.replace(before, after);
}

function applyPurchaseConfirmationSafetyPatches(coreSource) {
  let source = String(coreSource || '');

  const unsafeLoyaltyLine = "      ? `🎁 اعتبار باشگاه: -${escapeMarkdownV2(formatToman(loyaltyPreview.creditUsable))} تومان\\n` +";
  const safeLoyaltyLine = "      ? `🎁 اعتبار باشگاه: ${escapeMarkdownV2('-' + formatToman(loyaltyPreview.creditUsable))} تومان\\n` +";
  source = replaceOnce(
    source,
    unsafeLoyaltyLine,
    safeLoyaltyLine,
    'escape negative loyalty credit in MarkdownV2 confirmation'
  );

  const helperBefore = [
    'async function editOrSendMessage(chatId, messageId, text, options = {}) {',
    '  if (messageId) {',
    '    try {',
    '      return await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });',
    '    } catch (e) {',
    "      console.warn('[Telegram] editMessageText failed, falling back to sendMessage:', e.message);",
    '    }',
    '  }',
    '  return sendMessage(chatId, text, options);',
    '}'
  ].join('\n');

  const helperAfter = [
    '// HAMOON_MARKDOWNV2_PLAIN_FALLBACK_V1',
    'function markdownV2ToPlainText(text) {',
    "  const formatting = '*_~`';",
    "  let output = '';",
    '  let escaped = false;',
    "  for (const ch of String(text || '')) {",
    '    if (escaped) {',
    '      output += ch;',
    '      escaped = false;',
    '      continue;',
    '    }',
    "    if (ch === '\\\\') {",
    '      escaped = true;',
    '      continue;',
    '    }',
    '    if (formatting.includes(ch)) continue;',
    '    output += ch;',
    '  }',
    "  if (escaped) output += '\\\\';",
    '  return output;',
    '}',
    '',
    'async function editOrSendMessage(chatId, messageId, text, options = {}) {',
    '  let editError = null;',
    '  if (messageId) {',
    '    try {',
    '      return await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });',
    '    } catch (e) {',
    '      editError = e;',
    "      console.warn('[Telegram] editMessageText failed, falling back to sendMessage:', e.message);",
    '    }',
    '  }',
    '  const sent = await sendMessage(chatId, text, options);',
    '  if (sent) return sent;',
    "  const markdownV2ParseError = options?.parse_mode === 'MarkdownV2' && editError &&",
    "    /can't parse entities|reserved and must be escaped/i.test(String(editError.message || editError));",
    '  if (markdownV2ParseError) {',
    '    const safeOptions = { ...options };',
    '    delete safeOptions.parse_mode;',
    "    console.warn('[Telegram] MarkdownV2 parse failed; retrying as plain text');",
    '    return sendMessage(chatId, markdownV2ToPlainText(text), safeOptions);',
    '  }',
    '  return sent;',
    '}'
  ].join('\n');

  source = replaceOnce(
    source,
    helperBefore,
    helperAfter,
    'plain-text fallback for invalid MarkdownV2'
  );

  return source;
}

module.exports = { applyPurchaseConfirmationSafetyPatches };
