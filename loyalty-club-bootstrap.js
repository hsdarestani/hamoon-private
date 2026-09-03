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
    "const loyaltyClub = require('./services/loyalty-club');\nconst LOYALTY_PUBLIC_URL = process.env.LOYALTY_PUBLIC_URL || 'https://pay.hamooncloud.ir/club';\n\nconst token = process.env.TELEGRAM_BOT_TOKEN;",
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
        inline_keyboard: [
          [{ text: '🔄 بروزرسانی', callback_data: makeShortCb(effectiveUserId, { action: 'LOYALTY_REFRESH' }) }],
          [{ text: 'ℹ️ قوانین و نحوه کار', url: LOYALTY_PUBLIC_URL }]
        ]
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
              inline_keyboard: [
                [{ text: '🔄 بروزرسانی', callback_data: makeShortCb(effectiveUserId, { action: 'LOYALTY_REFRESH' }) }],
                [{ text: 'ℹ️ قوانین و نحوه کار', url: LOYALTY_PUBLIC_URL }]
              ]
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

  source = replaceOnce(
    source,
    `    const finalPrice = getFlavorCyclePrice(selectedFlavor, selectedCycle);\n    state[userId].finalPrice = finalPrice;\n\n    const messageText =`,
    `    const finalPrice = getFlavorCyclePrice(selectedFlavor, selectedCycle);
    state[userId].finalPrice = finalPrice;
    const loyaltyPreview = await loyaltyClub.getRedemptionPreview(userId, finalPrice).catch(() => ({
      creditUsable: 0,
      walletCharge: finalPrice,
      maxPercent: 30
    }));
    const loyaltyPaymentLines = Number(loyaltyPreview.creditUsable || 0) > 0
      ? \`🎁 اعتبار باشگاه: -\${escapeMarkdownV2(formatToman(loyaltyPreview.creditUsable))} تومان\\n\` +
        \`💳 پرداخت از کیف پول: \${escapeMarkdownV2(formatToman(loyaltyPreview.walletCharge))} تومان\\n\` +
        \`ℹ️ اعتبار باشگاه به‌صورت خودکار و تا \${escapeMarkdownV2(String(loyaltyPreview.maxPercent))}٪ این خرید استفاده می‌شود.\\n\`
      : '';

    const messageText =`,
    'purchase confirmation loyalty preview'
  );

  source = replaceOnce(
    source,
    "      `🔹 هزینه دوره: ${escapeMarkdownV2(formatToman(finalPrice))} تومان\\n`;",
    "      `🔹 هزینه دوره: ${escapeMarkdownV2(formatToman(finalPrice))} تومان\\n` +\n      loyaltyPaymentLines;",
    'purchase confirmation payment lines'
  );

  source = replaceOnce(
    source,
    `  let srv = null;\n  let purchaseRecorded = false;\n  let effectiveDc = dcConfig || state[userId]?.selectedDatacenterConfig;`,
    `  let srv = null;
  let purchaseRecorded = false;
  let loyaltyCreditUsed = 0;
  let loyaltyWalletCharge = 0;
  let loyaltyWalletDebited = false;
  let loyaltyRedemptionApplied = false;
  let loyaltyAwardResult = null;
  let effectiveDc = dcConfig || state[userId]?.selectedDatacenterConfig;`,
    'purchase loyalty state'
  );

  source = replaceOnce(
    source,
    `    const balance = await getUserWallet(userId);\n    if (balance < finalPrice) {\n      return sendMessage(chatId, \`❌ موجودی شما برای خرید این سرور کافی نیست. حداقل موجودی مورد نیاز: \${formatToman(finalPrice)} تومان\\n💰 لطفاً از منوی «افزایش اعتبار» کیف پول خود را شارژ کنید.\`, mainMenu);\n    }`,
    `    const loyaltyCheckoutPreview = await loyaltyClub.getRedemptionPreview(userId, finalPrice).catch(() => ({
      creditUsable: 0,
      walletCharge: finalPrice,
      maxPercent: 30
    }));
    const expectedWalletCharge = Math.max(0, Number(loyaltyCheckoutPreview.walletCharge ?? finalPrice));
    const balance = await getUserWallet(userId);
    if (balance < expectedWalletCharge) {
      const creditHint = Number(loyaltyCheckoutPreview.creditUsable || 0) > 0
        ? \`\\n🎁 \${formatToman(loyaltyCheckoutPreview.creditUsable)} تومان از اعتبار باشگاه در این خرید قابل استفاده است.\`
        : '';
      return sendMessage(chatId, \`❌ موجودی کیف پول برای این خرید کافی نیست. مبلغ مورد نیاز از کیف پول: \${formatToman(expectedWalletCharge)} تومان\${creditHint}\\n💰 لطفاً از منوی «افزایش اعتبار» کیف پول خود را شارژ کنید.\`, mainMenu);
    }`,
    'purchase balance check with loyalty credit'
  );

  source = replaceOnce(
    source,
    `    await debitUser(userId, finalPrice);\n    const initialStatus = (isHetzner || isTebyan) ? 'provisioning' : 'active';`,
    `    let redemption = null;
    try {
      redemption = await loyaltyClub.consumeCredit({
        telegramId: userId,
        referenceId: srv.id,
        grossAmountToman: finalPrice
      });
      loyaltyCreditUsed = Math.max(0, Number(redemption?.creditUsed || 0));
      loyaltyWalletCharge = Math.max(0, finalPrice - loyaltyCreditUsed);
      loyaltyRedemptionApplied = loyaltyCreditUsed > 0;
    } catch (loyaltyError) {
      console.error('[LOYALTY] credit redemption failed; falling back to full wallet charge:', loyaltyError.message || loyaltyError);
      loyaltyCreditUsed = 0;
      loyaltyWalletCharge = finalPrice;
      loyaltyRedemptionApplied = false;
      const fullBalance = await getUserWallet(userId);
      if (fullBalance < finalPrice) {
        throw new Error('اعتبار باشگاه موقتاً قابل استفاده نیست و موجودی کیف پول برای مبلغ کامل خرید کافی نیست. لطفاً دوباره تلاش کنید.');
      }
    }

    const debitOk = loyaltyWalletCharge > 0 ? await debitUser(userId, loyaltyWalletCharge) : true;
    if (!debitOk) {
      if (loyaltyRedemptionApplied) {
        await loyaltyClub.refundRedemption({ telegramId: userId, referenceId: srv.id }).catch(() => {});
        loyaltyRedemptionApplied = false;
      }
      throw new Error('موجودی کیف پول برای تکمیل خرید کافی نیست.');
    }
    loyaltyWalletDebited = loyaltyWalletCharge > 0;

    const initialStatus = (isHetzner || isTebyan) ? 'provisioning' : 'active';`,
    'loyalty credit consumption before debit'
  );

  source = replaceOnce(
    source,
    `    await recordWalletLog(userId, -finalPrice, \`خرید سرور \${serverName} (\${effectiveDc.name})\`, 'purchase');\n    purchaseRecorded = true;`,
    `    if (loyaltyWalletCharge > 0) {
      const loyaltyPart = loyaltyCreditUsed > 0 ? \` + \${formatToman(loyaltyCreditUsed)} تومان اعتبار باشگاه\` : '';
      await recordWalletLog(userId, -loyaltyWalletCharge, \`خرید سرور \${serverName} (\${effectiveDc.name})\${loyaltyPart}\`, 'purchase');
    }
    purchaseRecorded = true;

    loyaltyAwardResult = await loyaltyClub.recordEligibleSpend({
      telegramId: userId,
      eventKey: \`purchase:\${srv.id}\`,
      eventType: 'purchase',
      referenceId: srv.id,
      amountToman: loyaltyWalletCharge,
      grossAmountToman: finalPrice,
      occurredAt: new Date(),
      metadata: {
        datacenter: effectiveDc.key,
        server_name: serverName,
        loyalty_credit_used: loyaltyCreditUsed
      }
    }).catch((loyaltyError) => {
      console.error('[LOYALTY] purchase earning failed without blocking delivery:', loyaltyError.message || loyaltyError);
      return null;
    });`,
    'purchase earning hook'
  );

  source = replaceOnce(
    source,
    `    ].join('\\n');\n    if (isHetzner) msgHtml += '\\n✅ دسترسی SSH و تست IP از ایران/چند نقطه خارجی تأیید شد.';`,
    `    ].join('\\n');
    if (loyaltyCreditUsed > 0) {
      msgHtml += '\\n🎁 اعتبار باشگاه استفاده‌شده: ' + htmlEscape(formatToman(loyaltyCreditUsed)) + ' تومان';
      msgHtml += '\\n💳 پرداخت از کیف پول: ' + htmlEscape(formatToman(loyaltyWalletCharge)) + ' تومان';
    }
    if (loyaltyAwardResult?.awarded) {
      msgHtml += '\\n⭐ <b>+' + htmlEscape(Number(loyaltyAwardResult.xpDelta || 0).toLocaleString('fa-IR')) + ' XP</b> از باشگاه هامون';
      if (Number(loyaltyAwardResult.rewardDelta || 0) > 0) {
        msgHtml += '\\n🎁 <b>+' + htmlEscape(formatToman(loyaltyAwardResult.rewardDelta)) + ' تومان</b> اعتبار باشگاه';
      }
    }
    if (isHetzner) msgHtml += '\\n✅ دسترسی SSH و تست IP از ایران/چند نقطه خارجی تأیید شد.';`,
    'purchase success loyalty details'
  );

  source = replaceOnce(
    source,
    "      await updatePurchaseStatus(server_id, billedStatus, billableFromCreationGb, newLastBilledAt);",
    `      if (instanceCost > 0) {
        await loyaltyClub.recordEligibleSpend({
          telegramId: userId,
          eventKey: \`renewal:\${server_id}:\${new Date(newLastBilledAt).toISOString()}\`,
          eventType: 'renewal',
          referenceId: server_id,
          amountToman: instanceCost,
          grossAmountToman: instanceCost,
          occurredAt: newLastBilledAt,
          metadata: { datacenter: purchase.datacenter, server_name }
        }).catch((loyaltyError) => {
          console.error('[LOYALTY] renewal earning failed without blocking billing:', {
            userId,
            serverId: server_id,
            message: loyaltyError.message || loyaltyError
          });
        });
      }
      await updatePurchaseStatus(server_id, billedStatus, billableFromCreationGb, newLastBilledAt);`,
    'renewal earning hook'
  );

  return source;
}

module.exports = { applyLoyaltyClubPatches };