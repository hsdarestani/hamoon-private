#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { walletTopupAmounts } = require('../services/wallet-topup-pricing');

const cases = [
  [2870000, 287000, 3157000, 31570000],
  [2210500, 221050, 2431550, 24315500],
  [100000, 10000, 110000, 1100000],
  [334300, 33430, 367730, 3677300],
  [1, 1, 2, 20]
];

for (const [credit, tax, payable, rial] of cases) {
  const got = walletTopupAmounts(credit);
  assert.deepStrictEqual(got, {
    walletCreditToman: credit,
    taxToman: tax,
    payableToman: payable,
    payableRial: rial
  });
}

assert.throws(() => walletTopupAmounts(-1), /INVALID_WALLET_TOPUP_AMOUNT/);
assert.throws(() => walletTopupAmounts(1.2), /INVALID_WALLET_TOPUP_AMOUNT/);

console.log('validate-wallet-topup-pricing: ok');
