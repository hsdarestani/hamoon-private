'use strict';

function replaceOnce(source, needle, replacement, label) {
  if (!source.includes(needle)) {
    throw new Error(`[LOYALTY_BOOTSTRAP] Missing patch anchor: ${label}`);
  }
  return source.replace(needle, replacement);
}

function applyLoyaltyClubPatches(coreSource) {
  let source = String(coreSource || '');

  source = replaceOnce(
    source,
    "const token = process.env.TELEGRAM_BOT_TOKEN;",
    "const loyaltyClub = require('./services/loyalty-club');\n\nconst token = process.env.TELEGRAM_BOT_TOKEN;",
    'loyalty import'
  );

  source = replaceOnce(
    source,
    "            ['👛 کیف پول'],\n            ['⚙️ مدیریت سرورها'],",
    "            ['👛 کیف پول', '🏆 باشگاه هامون'],\n            ['⚙️ مدیریت سرورها'],",
    'main menu'
  );

  source = replaceOnce(
    source,
    "case '👛 کیف پول': {",
    `case '🏆 باشگاه هامون': {
  try {
    const summary = await loyaltyClub.getSummary(effectiveUserId);
    return sendMessage(effectiveChatId, loyaltyClub.renderSummary(summary), {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔄 بروزرسانی', callback_data: makeShortCb(effectiveUserId, { action: 'LOYALTY_REFRESH' }) }
        ]]
      }
    });
  } catch (error) {
    console.error('[LOYALTY_CLUB] summary failed:', error.message || error);
    return sendMessage(effectiveChatId, '❌ اطلاعات باشگاه فعلاً در دسترس نیست. لطفاً کمی بعد دوباره امتحان کنید.');
  }
}

case '👛 کیف پول': {`,
    'club message handler'
  );

  source = replaceOnce(
    source,
    " if (payload) {\n    switch (payload.action) {",
    ` if (payload) {
    switch (payload.action) {
      case 'LOYALTY_REFRESH': {
        try {
          const summary = await loyaltyClub.getSummary(effectiveUserId);
          const options = {
            chat_id: effectiveChatId,
            message_id: q.message.message_id,
            reply_markup: {
              inline_keyboard: [[
                { text: '🔄 بروزرسانی', callback_data: makeShortCb(effectiveUserId, { action: 'LOYALTY_REFRESH' }) }
              ]]
            }
          };
          return bot.editMessageText(loyaltyClub.renderSummary(summary), options).catch(() =>
            sendMessage(effectiveChatId, loyaltyClub.renderSummary(summary), { reply_markup: options.reply_markup })
          );
        } catch (error) {
          console.error('[LOYALTY_CLUB] refresh failed:', error.message || error);
          return sendMessage(effectiveChatId, '❌ بروزرسانی باشگاه انجام نشد.');
        }
      }`,
    'club callback handler'
  );

  return source;
}

module.exports = { applyLoyaltyClubPatches };
