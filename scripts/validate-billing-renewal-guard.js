#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { applyPatches } = require('../runtime-bootstrap');

const corePath = path.join(__dirname, '..', 'index-core.js');
const source = fs.readFileSync(corePath, 'utf8');
const composed = applyPatches(source);

const required = [
  'function getPurchaseRenewalInfo(',
  'async function resumePurchaseWithBillingGuard(',
  'تا قبل از پایان دوره فعلی، صرفاً کم بودن کیف پول باعث قطع سرور نمی‌شود.',
  "[RESUME_BILLING_GUARD_FAILED]",
  '💳 هزینه تمدید:',
  'هزینه دوره جدید کسر شد و سرور مجدداً فعال شد',
  'چون دوره فعلی هنوز تمام نشده بود، بابت تمدید مبلغی کسر نشد',
];

for (const marker of required) {
  assert(composed.includes(marker), `missing billing renewal guard marker: ${marker}`);
}

assert(!composed.includes('`active server (wallet-based)`'), 'legacy generic Hetzner low-wallet alert must be removed');
assert(composed.includes("const cycleDue = hoursSinceLastBill >= cycleHours;"), 'hourly billing cycle boundary must remain intact');
assert(composed.includes("if (cycleDue && autoRenewEnabled)"), 'auto-renew billing condition must remain intact');

new vm.Script(composed, { filename: 'index-core.composed.js' });
console.log('validate-billing-renewal-guard: ok');
