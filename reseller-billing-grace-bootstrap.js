'use strict';

function countOccurrences(source, needle) {
  let count = 0;
  let from = 0;
  while (true) {
    const index = source.indexOf(needle, from);
    if (index < 0) return count;
    count += 1;
    from = index + needle.length;
  }
}

function replaceOnce(source, needle, replacement, label) {
  const count = countOccurrences(source, needle);
  if (count !== 1) {
    throw new Error(`[reseller-billing-grace] patch "${label}" expected exactly 1 match, found ${count}`);
  }
  return source.replace(needle, replacement);
}

function applyResellerBillingGracePatches(source) {
  let out = String(source || '');

  const helperMarker = 'async function runHourlyBilling() {';
  const helpers = `const BILLING_GRACE_RESELLER_IDS = new Set(
  String(process.env.BILLING_GRACE_RESELLER_IDS || '8977002450')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
);

function isBillingGraceReseller(userId) {
  return BILLING_GRACE_RESELLER_IDS.has(String(userId));
}

async function debitBillingGraceWallet(userId, amount) {
  const value = Number(amount);
  if (!(value > 0)) return true;
  const dbModule = require('./db');
  const [result] = await dbModule.pool.execute(
    'UPDATE users SET wallet = wallet - ? WHERE telegram_id = ?',
    [value, String(userId)]
  );
  return Number(result?.affectedRows || 0) === 1;
}

async function hasRecentBillingGraceAlert(userId, minutes = 55) {
  const logs = await getWalletLogs(userId, 100) || [];
  const since = Date.now() - Number(minutes || 55) * 60 * 1000;
  return logs.some(log =>
    String(log.type || '').toLowerCase() === 'billing_grace_alert' &&
    new Date(log.timestamp || 0).getTime() >= since
  );
}

async function sendBillingGraceAlertsIfNeeded(allPurchases = []) {
  for (const userId of BILLING_GRACE_RESELLER_IDS) {
    const protectedPurchases = (allPurchases || []).filter(purchase =>
      String(purchase?.telegram_id) === String(userId) &&
      hetznerLifecycle.isBillablePurchase(purchase)
    );
    if (!protectedPurchases.length) continue;

    const balance = Number(await getUserWallet(userId).catch(() => 0) || 0);
    if (balance > 0) continue;
    if (await hasRecentBillingGraceAlert(userId, 55)) continue;

    const balanceRounded = Math.floor(balance);
    const balanceText = Math.abs(balanceRounded).toLocaleString('fa-IR');
    const balanceLabel = balanceRounded < 0
      ? 'بدهی فعلی: ' + balanceText + ' تومان'
      : 'موجودی فعلی: ۰ تومان';

    const resellerMessage =
      '⚠️ موجودی کیف پول ریسلری شما ' + (balanceRounded < 0 ? 'منفی' : 'صفر') + ' است.\\n' +
      balanceLabel + '\\n' +
      'برای جلوگیری از قطعی مشتری‌ها، سرورها در مهلت پرداخت فعال مانده‌اند.\\n' +
      'لطفاً در اولین فرصت کیف پول را شارژ کنید. تا زمان مثبت شدن موجودی، این یادآوری هر ساعت ارسال می‌شود.';

    await sendMessage(Number(userId), resellerMessage).catch(error => {
      console.warn('[BILLING_GRACE] reseller notification failed', {
        user_id: String(userId),
        message: error?.message || String(error)
      });
    });

    const adminChatId = Number(process.env.BILLING_GRACE_ADMIN_ID || SUPPORT_ID || 0);
    if (adminChatId > 0 && String(adminChatId) !== String(userId)) {
      const adminMessage =
        '🚨 مهلت پرداخت ریسلر فعال است.\\n' +
        'Reseller: ' + String(userId) + '\\n' +
        'موجودی: ' + balanceRounded.toLocaleString('fa-IR') + ' تومان\\n' +
        'سرورهای تحت پوشش: ' + protectedPurchases.length + '\\n' +
        'سرورهای مشتری‌ها به‌علت کمبود موجودی suspend نشده‌اند. لطفاً وضعیت پرداخت را پیگیری کنید.';
      await sendMessage(adminChatId, adminMessage).catch(error => {
        console.warn('[BILLING_GRACE] admin notification failed', {
          admin_id: String(adminChatId),
          user_id: String(userId),
          message: error?.message || String(error)
        });
      });
    }

    await recordWalletLog(
      userId,
      0,
      'هشدار ساعتی مهلت پرداخت ریسلر؛ موجودی=' + balanceRounded,
      'billing_grace_alert'
    ).catch(error => {
      console.warn('[BILLING_GRACE] alert log failed', {
        user_id: String(userId),
        message: error?.message || String(error)
      });
    });
  }
}

${helperMarker}`;

  out = replaceOnce(out, helperMarker, helpers, 'add grace helpers');

  const billingNeedle = `    if (currentBalance >= totalCost) {
      await debitUser(userId, totalCost);
      await recordWalletLog(userId, -totalCost, \`کسر هزینه سرور \${server_name}\`, 'billing');`;
  const billingReplacement = `    const billingGraceOverdraft = isBillingGraceReseller(userId) && currentBalance < totalCost;
    if (currentBalance >= totalCost || billingGraceOverdraft) {
      if (billingGraceOverdraft) {
        const debitOk = await debitBillingGraceWallet(userId, totalCost);
        if (!debitOk) {
          throw Object.assign(new Error('BILLING_GRACE_WALLET_UPDATE_FAILED'), {
            code: 'BILLING_GRACE_WALLET_UPDATE_FAILED'
          });
        }
      } else {
        await debitUser(userId, totalCost);
      }
      await recordWalletLog(userId, -totalCost, \`کسر هزینه سرور \${server_name}\`, 'billing');`;

  out = replaceOnce(out, billingNeedle, billingReplacement, 'allow protected reseller overdraft');

  const statusNeedle = `      const newLastBilledAt = hoursSinceLastBill >= cycleHours ? now : lastBilledDate;
      await updatePurchaseStatus(server_id, 'active', billableFromCreationGb, newLastBilledAt);`;
  const statusReplacement = `      const newLastBilledAt = hoursSinceLastBill >= cycleHours ? now : lastBilledDate;
      let billedStatus = 'active';
      if (isBillingGraceReseller(userId) && status === 'suspended' && suspend_reason === 'insufficient_balance') {
        try {
          const tok = await openstackApi.getToken(dcConfig);
          await openstackApi.resumeServer(dcConfig, tok, server_id);
          await updatePurchaseSuspendReason(server_id, null).catch(() => {});
          console.log('[BILLING_GRACE] resumed previous low-balance suspension', {
            user_id: userId,
            server_id,
            datacenter: purchase.datacenter
          });
        } catch (resumeError) {
          billedStatus = 'suspended';
          console.warn('[BILLING_GRACE] resume previous low-balance suspension failed', {
            user_id: userId,
            server_id,
            datacenter: purchase.datacenter,
            message: resumeError?.message || String(resumeError)
          });
        }
      }
      await updatePurchaseStatus(server_id, billedStatus, billableFromCreationGb, newLastBilledAt);`;

  out = replaceOnce(out, statusNeedle, statusReplacement, 'resume prior insufficient-balance suspension');

  const endNeedle = `  console.log('--- Hourly billing process completed ---');
}`;
  const endReplacement = `  await sendBillingGraceAlertsIfNeeded(allPurchases);
  console.log('--- Hourly billing process completed ---');
}`;
  out = replaceOnce(out, endNeedle, endReplacement, 'send hourly grace notifications');

  return out;
}

module.exports = { applyResellerBillingGracePatches };
