'use strict';

function replaceOnce(source, needle, replacement, label) {
  const count = String(source || '').split(needle).length - 1;
  if (count !== 1) {
    throw new Error(`[LOYALTY_HISTORY_BOOTSTRAP] ${label} expected 1 match, found ${count}`);
  }
  return source.replace(needle, replacement);
}

function applyLoyaltyHistoryPatches(coreSource) {
  let source = String(coreSource || '');

  source = replaceOnce(
    source,
    "    const loyaltyCheckoutPreview = await loyaltyClub.getRedemptionPreview(userId, finalPrice).catch(() => ({",
    `    await loyaltyClub.syncHistory(userId).catch((loyaltyError) => {
      console.error('[LOYALTY] history sync before purchase failed:', loyaltyError.message || loyaltyError);
    });
    const loyaltyCheckoutPreview = await loyaltyClub.getRedemptionPreview(userId, finalPrice).catch(() => ({`,
    'purchase history sync'
  );

  source = replaceOnce(
    source,
    "      if (instanceCost > 0) {\n        await loyaltyClub.recordEligibleSpend({",
    `      if (instanceCost > 0) {
        await loyaltyClub.syncHistory(userId).catch((loyaltyError) => {
          console.error('[LOYALTY] history sync before renewal failed:', loyaltyError.message || loyaltyError);
        });
        await loyaltyClub.recordEligibleSpend({`,
    'renewal history sync'
  );

  return source;
}

module.exports = { applyLoyaltyHistoryPatches };