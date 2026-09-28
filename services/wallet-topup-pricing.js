'use strict';

function normalizeTopupAmount(value) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) {
    const error = new Error('INVALID_WALLET_TOPUP_AMOUNT');
    error.code = 'INVALID_WALLET_TOPUP_AMOUNT';
    throw error;
  }
  return amount;
}

function walletTopupAmounts(originalAmountToman) {
  const walletCreditToman = normalizeTopupAmount(originalAmountToman);

  // Never use Math.ceil(amount * 1.1) here. Binary floating point can turn
  // exact decimal results such as 2,870,000 * 1.1 into 3,157,000.0000000005,
  // which Math.ceil incorrectly rounds up by one toman.
  const taxToman = Math.ceil(walletCreditToman / 10);
  const payableToman = walletCreditToman + taxToman;
  const payableRial = payableToman * 10;

  return {
    walletCreditToman,
    taxToman,
    payableToman,
    payableRial
  };
}

module.exports = {
  normalizeTopupAmount,
  walletTopupAmounts
};
