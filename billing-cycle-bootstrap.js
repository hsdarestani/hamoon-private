'use strict';

function applyBillingCyclePatches(source) {
  let out = String(source || '');

  if (!out.includes('changePurchaseCycleAtomic,')) {
    const importNeedle = '    updatePurchaseCycle,\n    updateUserShahkar,';
    const importReplacement = '    updatePurchaseCycle,\n    changePurchaseCycleAtomic,\n    updateUserShahkar,';
    if (!out.includes(importNeedle)) {
      throw new Error('billing-cycle-bootstrap: database import marker not found');
    }
    out = out.replace(importNeedle, importReplacement);
  }

  const startMarker = 'async function handleChangeCycleConfirm(';
  const endMarker = 'async function handleSnapshotAsk(';
  const start = out.indexOf(startMarker);
  const end = out.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('billing-cycle-bootstrap: change-cycle handler markers not found');
  }

  const replacement = `async function handleChangeCycleConfirm(chatId, userId, serverId, dcConfig, newCycle, messageId) {
  await bot.editMessageText('⏳ در حال محاسبه و تغییر دوره پرداخت...', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] }
  }).catch(() => {});

  try {
    const purchase = await getPurchaseByServerId(serverId);

    if (!purchase || String(purchase.telegram_id) !== String(userId)) {
      return editOrSendMessage(chatId, messageId, '❌ اطلاعات خرید این سرور برای حساب شما یافت نشد.');
    }

    const allowedCycles = getAllowedCycles(dcConfig);
    if (!allowedCycles.includes(newCycle)) {
      return editOrSendMessage(chatId, messageId, '❌ دوره پرداخت انتخاب‌شده برای این دیتاسنتر مجاز نیست.');
    }

    const currentCycle = String(purchase.duration || '');
    if (currentCycle === String(newCycle)) {
      return editOrSendMessage(chatId, messageId, 'ℹ️ این سرور همین حالا روی همین دوره پرداخت قرار دارد.');
    }

    const currentCycleHours = HOURS_IN_CYCLE[currentCycle];
    const targetCycleHours = HOURS_IN_CYCLE[newCycle];
    if (!currentCycleHours || !targetCycleHours) {
      return editOrSendMessage(chatId, messageId, '❌ دوره پرداخت فعلی یا انتخاب‌شده نامعتبر است.');
    }

    const currentCycleAmount = Number(normalizeStoredCycleAmount(purchase, dcConfig) || 0);
    if (!(currentCycleAmount > 0)) {
      throw Object.assign(new Error('INVALID_BILLING_AMOUNT'), { code: 'INVALID_BILLING_AMOUNT' });
    }

    const now = new Date();
    const lastBilledDate = new Date(purchase.last_billed_at || purchase.created_at || now);
    const elapsedHours = Math.max(0, (now - lastBilledDate) / 3600000);
    const hourlyPrice = currentCycleAmount / currentCycleHours;
    const unusedHours = Math.max(0, currentCycleHours - elapsedHours);
    const creditForUnusedTime = unusedHours * hourlyPrice;
    const newCyclePrice = Math.max(1, Math.round(hourlyPrice * targetCycleHours));
    const difference = Math.round(newCyclePrice - creditForUnusedTime);

    let result;
    try {
      result = await changePurchaseCycleAtomic({
        telegramId: userId,
        serverId,
        datacenter: purchase.datacenter,
        expectedCurrentCycle: currentCycle,
        newCycle,
        newAmount: newCyclePrice,
        walletDifference: difference,
        serverName: purchase.server_name
      });
    } catch (error) {
      if (error?.code === 'INSUFFICIENT_WALLET') {
        const wallet = Number(await getUserWallet(userId).catch(() => 0) || 0);
        const required = Math.max(0, difference - wallet);
        return editOrSendMessage(
          chatId,
          messageId,
          '❌ موجودی کافی نیست. برای تغییر دوره به ' + getCycleLabel(newCycle) +
          ' حداقل ' + formatToman(Math.ceil(required)) + ' تومان دیگر کیف پول خود را شارژ کنید.'
        );
      }
      if (error?.code === 'PURCHASE_CYCLE_CHANGED' || error?.code === 'PURCHASE_CYCLE_CONCURRENT_UPDATE') {
        return editOrSendMessage(chatId, messageId, '⚠️ دوره پرداخت هم‌زمان تغییر کرده است. لطفاً صفحه مدیریت سرور را دوباره باز کنید.');
      }
      throw error;
    }

    const settlementText = difference > 0
      ? 'مابه‌التفاوت کسرشده: ' + formatToman(difference) + ' تومان'
      : difference < 0
        ? 'اعتبار برگشتی: ' + formatToman(Math.abs(difference)) + ' تومان'
        : 'مابه‌التفاوت: 0 تومان';

    console.log('[BILLING_CYCLE_CHANGE_SUCCESS]', {
      server_id: serverId,
      user_id: String(userId),
      from: currentCycle,
      to: String(newCycle),
      amount: newCyclePrice,
      difference,
      balance: result.newWallet
    });

    const successLines = [
      '✅ دوره پرداخت سرور «' + String(purchase.server_name || serverId) + '» با موفقیت از ' +
        getCycleLabel(currentCycle) + ' به ' + getCycleLabel(newCycle) + ' تغییر کرد.',
      settlementText,
      'موجودی جدید: ' + formatToman(result.newWallet) + ' تومان'
    ];

    return editOrSendMessage(
      chatId,
      messageId,
      successLines.join(String.fromCharCode(10))
    );
  } catch (error) {
    console.error('[BILLING_CYCLE_CHANGE_FAILED]', {
      server_id: serverId,
      user_id: String(userId),
      code: error?.code || null,
      message: error?.message || String(error)
    });

    const safeMessage = error?.code === 'INVALID_BILLING_AMOUNT'
      ? '❌ مبلغ دوره فعلی این سرور معتبر نیست و برای جلوگیری از محاسبه اشتباه تغییری انجام نشد. لطفاً با پشتیبانی تماس بگیرید.'
      : '❌ تغییر دوره پرداخت انجام نشد. لطفاً دوباره تلاش کنید و اگر مشکل ادامه داشت با پشتیبانی تماس بگیرید.';

    return editOrSendMessage(chatId, messageId, safeMessage);
  }
}

`;

  out = out.slice(0, start) + replacement + out.slice(end);
  return out;
}

module.exports = { applyBillingCyclePatches };
