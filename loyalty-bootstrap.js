'use strict';

const PATCH_MARKER = "const loyaltyClub = require('./loyalty-club');";

function replaceRequired(source, anchor, replacement, label) {
  if (!source.includes(anchor)) {
    throw new Error(`[LOYALTY_BOOTSTRAP] Missing ${label} anchor; refusing partial patch`);
  }
  return source.replace(anchor, replacement);
}

function applyLoyaltyPatches(coreSource) {
  let source = String(coreSource || '');
  if (source.includes(PATCH_MARKER)) return source;

  source = replaceRequired(
    source,
    "} = require('./db');",
    `} = require('./db');\n${PATCH_MARKER}`,
    'database import'
  );

  source = replaceRequired(
    source,
    "            ['⚡ روشن‌کردن سرورها'],\n            ['📞 پشتیبانی']",
    "            ['⚡ روشن‌کردن سرورها'],\n            ['🏆 باشگاه هامون'],\n            ['📞 پشتیبانی']",
    'main menu'
  );

  source = replaceRequired(
    source,
    "case '👛 کیف پول': {",
    `case '🏆 باشگاه هامون': {\n  try {\n    const dashboard = await loyaltyClub.getDashboard(effectiveUserId);\n    await sendMessage(effectiveChatId, dashboard.text, { parse_mode: 'HTML' });\n  } catch (error) {\n    console.error('[LOYALTY] Dashboard failed:', error);\n    await sendMessage(effectiveChatId, '❌ دریافت اطلاعات باشگاه موقتاً با خطا مواجه شد. لطفاً دوباره تلاش کنید.');\n  }\n  break;\n}\n\ncase '👛 کیف پول': {`,
    'club message handler'
  );

  source = replaceRequired(
    source,
    "    await recordWalletLog(userId, -finalPrice, `خرید سرور ${serverName} (${effectiveDc.name})`, 'purchase');\n    purchaseRecorded = true;",
    `    await loyaltyClub.recordPurchaseReward({\n      telegramId: userId,\n      referenceId: srv.id,\n      amountToman: finalPrice,\n      datacenter: effectiveDc.key,\n      serverName\n    }).catch((error) => {\n      console.error('[LOYALTY] Purchase reward failed without blocking purchase:', { userId, serverId: srv.id, message: error.message });\n    });\n    await recordWalletLog(userId, -finalPrice, \`خرید سرور \${serverName} (\${effectiveDc.name})\`, 'purchase');\n    purchaseRecorded = true;`,
    'purchase reward hook'
  );

  return source;
}

module.exports = { applyLoyaltyPatches };
