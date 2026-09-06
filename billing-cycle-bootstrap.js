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

    // Prefer the same sellable catalog used by normal purchases. Hetzner's
    // monthly cap must come from amount_monthly rather than hourly * 720.
    let pricingDc = dcConfig;
    try {
      const liveFlavors = await openstackApi.listFlavors(dcConfig);
      if (Array.isArray(liveFlavors) && liveFlavors.length) {
        pricingDc = { ...dcConfig, flavors: liveFlavors };
      }
    } catch (pricingError) {
      console.warn('[BILLING_CYCLE_LIVE_PRICE_FALLBACK]', {
        server_id: serverId,
        datacenter: purchase.datacenter,
        message: pricingError?.message || String(pricingError)
      });
    }

    const purchaseFlavorId = String(purchase.flavor_id || '').trim().toLowerCase();
    let selectedFlavor = (Array.isArray(pricingDc?.flavors) ? pricingDc.flavors : []).find((flavor) => {
      const ids = [flavor?.id, flavor?.hetzner_type, flavor?.server_type]
        .filter(Boolean)
        .map((value) => String(value).trim().toLowerCase());
      return ids.includes(purchaseFlavorId);
    });

    // Existing Hetzner servers can legitimately use a server type that is no
    // longer returned by the *sellable* catalog for that location. Billing an
    // existing server must not depend on whether the plan can be newly ordered
    // today. If Hetzner confirms that the running server still has the same
    // type stored in our purchase record, recover its location-specific raw
    // hourly/monthly prices directly from /server_types.
    if (!selectedFlavor && openstackApi.isHetznerConfig(dcConfig)) {
      try {
        const providerServer = await openstackApi.getServer(dcConfig, null, serverId);
        const providerFlavorId = String(
          providerServer?.server_type?.name ||
          providerServer?.server_type ||
          providerServer?.type ||
          ''
        ).trim().toLowerCase();

        if (providerFlavorId && providerFlavorId === purchaseFlavorId) {
          const rawTypes = await openstackApi.listHetznerServerTypes(dcConfig);
          const rawType = (Array.isArray(rawTypes) ? rawTypes : []).find((serverType) =>
            String(serverType?.name || '').trim().toLowerCase() === providerFlavorId
          );

          if (rawType) {
            const preferredLocation = String(dcConfig?.HETZNER_LOCATION || dcConfig?.location || '').trim().toLowerCase();
            const fallbackLocations = String(dcConfig?.HETZNER_LOCATION_FALLBACKS || '')
              .split(',')
              .map((value) => String(value || '').trim().toLowerCase())
              .filter(Boolean);
            const priceLocations = [...new Set([preferredLocation, ...fallbackLocations].filter(Boolean))];
            const rawPrices = Array.isArray(rawType?.prices) ? rawType.prices : [];
            let rawPrice = null;

            for (const location of priceLocations) {
              rawPrice = rawPrices.find((price) =>
                String(price?.location || '').trim().toLowerCase() === location &&
                (price?.price_hourly || price?.price_monthly)
              ) || null;
              if (rawPrice) break;
            }
            if (!rawPrice && !priceLocations.length) {
              rawPrice = rawPrices.find((price) => price?.price_hourly || price?.price_monthly) || null;
            }

            const hourlyEur = Number(rawPrice?.price_hourly?.gross || rawPrice?.price_hourly?.net || 0);
            const monthlyEur = Number(rawPrice?.price_monthly?.gross || rawPrice?.price_monthly?.net || 0);

            if (hourlyEur > 0 && monthlyEur > 0) {
              const eurToToman = Number(process.env.HETZNER_EUR_TO_TOMAN || process.env.EUR_TO_TOMAN || 70000);
              const baseMultiplier = Number(process.env.HETZNER_PRICE_MULTIPLIER || 1);
              const hourlyMultiplier = Number(process.env.HETZNER_HOURLY_PRICE_MULTIPLIER || baseMultiplier);
              const monthlyMultiplier = Number(process.env.HETZNER_MONTHLY_PRICE_MULTIPLIER || baseMultiplier);
              const minHourly = Number(process.env.HETZNER_MIN_HOURLY_TOMAN || 1);
              const minMonthly = Number(process.env.HETZNER_MIN_MONTHLY_TOMAN || 1);
              const roundTo = Math.max(1, Number(process.env.HETZNER_PRICE_ROUND_TO || 1000));
              const roundProviderPrice = (value) => Math.max(roundTo, Math.ceil(Number(value || 0) / roundTo) * roundTo);
              const hourlyToman = roundProviderPrice(Math.max(minHourly, hourlyEur * eurToToman * hourlyMultiplier));
              const monthlyToman = roundProviderPrice(Math.max(minMonthly, monthlyEur * eurToToman * monthlyMultiplier));

              selectedFlavor = {
                id: providerFlavorId,
                hetzner_type: providerFlavorId,
                server_type: providerFlavorId,
                amount_hourly: hourlyToman,
                amount_monthly: monthlyToman,
                hourly_price_toman: hourlyToman,
                monthly_price_toman: monthlyToman,
                price: hourlyToman,
                monthly_toman: monthlyToman,
                __existingHetznerBillingRecovery: true
              };
              pricingDc = {
                ...pricingDc,
                flavors: [selectedFlavor, ...(Array.isArray(pricingDc?.flavors) ? pricingDc.flavors : [])]
              };

              console.log('[BILLING_CYCLE_EXISTING_HETZNER_PLAN_RECOVERED]', {
                server_id: serverId,
                datacenter: purchase.datacenter,
                flavor_id: providerFlavorId,
                location: rawPrice?.location || preferredLocation || null,
                hourly_amount: hourlyToman,
                monthly_amount: monthlyToman
              });
            }
          }
        }
      } catch (recoveryError) {
        console.warn('[BILLING_CYCLE_EXISTING_HETZNER_PLAN_RECOVERY_FAILED]', {
          server_id: serverId,
          datacenter: purchase.datacenter,
          flavor_id: purchaseFlavorId,
          message: recoveryError?.message || String(recoveryError)
        });
      }
    }

    if (!selectedFlavor) {
      throw Object.assign(new Error('BILLING_FLAVOR_NOT_FOUND'), { code: 'BILLING_FLAVOR_NOT_FOUND' });
    }

    const currentCycleAmount = Number(normalizeStoredCycleAmount(purchase, pricingDc) || 0);
    if (!(currentCycleAmount > 0)) {
      throw Object.assign(new Error('INVALID_BILLING_AMOUNT'), { code: 'INVALID_BILLING_AMOUNT' });
    }

    // For a recovered non-sellable Hetzner plan, protect grandfathered/legacy
    // records: only use today's raw provider price when it is reasonably close
    // to the amount already stored for the current cycle.
    if (selectedFlavor.__existingHetznerBillingRecovery) {
      const providerCurrentPrice = Number(getFlavorCyclePrice(selectedFlavor, currentCycle) || 0);
      const allowedDrift = Math.max(2000, currentCycleAmount * 0.25);
      if (!(providerCurrentPrice > 0) || Math.abs(providerCurrentPrice - currentCycleAmount) > allowedDrift) {
        console.warn('[BILLING_CYCLE_RECOVERED_PRICE_MISMATCH]', {
          server_id: serverId,
          datacenter: purchase.datacenter,
          flavor_id: purchaseFlavorId,
          stored_amount: currentCycleAmount,
          provider_amount: providerCurrentPrice,
          allowed_drift: allowedDrift
        });
        throw Object.assign(new Error('BILLING_RECOVERED_PRICE_MISMATCH'), { code: 'BILLING_RECOVERED_PRICE_MISMATCH' });
      }
    }

    const catalogTargetPrice = Number(getFlavorCyclePrice(selectedFlavor, newCycle) || 0);
    if (!(catalogTargetPrice > 0)) {
      throw Object.assign(new Error('INVALID_TARGET_BILLING_AMOUNT'), { code: 'INVALID_TARGET_BILLING_AMOUNT' });
    }

    const now = new Date();
    const lastBilledDate = new Date(purchase.last_billed_at || purchase.created_at || now);
    const elapsedHours = Math.max(0, (now - lastBilledDate) / 3600000);
    const hourlyPrice = currentCycleAmount / currentCycleHours;
    const unusedHours = Math.max(0, currentCycleHours - elapsedHours);
    const creditForUnusedTime = unusedHours * hourlyPrice;
    const newCyclePrice = Math.max(1, Math.round(catalogTargetPrice));
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

    const pricingErrorCodes = new Set([
      'INVALID_BILLING_AMOUNT',
      'INVALID_TARGET_BILLING_AMOUNT',
      'BILLING_FLAVOR_NOT_FOUND',
      'BILLING_RECOVERED_PRICE_MISMATCH'
    ]);
    const safeMessage = pricingErrorCodes.has(error?.code)
      ? '❌ قیمت دوره این سرور به‌صورت معتبر پیدا نشد و برای جلوگیری از محاسبه اشتباه تغییری انجام نشد. لطفاً با پشتیبانی تماس بگیرید.'
      : '❌ تغییر دوره پرداخت انجام نشد. لطفاً دوباره تلاش کنید و اگر مشکل ادامه داشت با پشتیبانی تماس بگیرید.';

    return editOrSendMessage(chatId, messageId, safeMessage);
  }
}

`;

  out = out.slice(0, start) + replacement + out.slice(end);
  return out;
}

module.exports = { applyBillingCyclePatches };
