'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { applyPatches } = require('../runtime-bootstrap');
const { applyResellerBillingGracePatches } = require('../reseller-billing-grace-bootstrap');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const core = fs.readFileSync(path.join(__dirname, '..', 'index-core.js'), 'utf8');
let patched = applyPatches(core);
if (!patched.includes('BILLING_GRACE_RESELLER_IDS')) {
  patched = applyResellerBillingGracePatches(patched);
}

assert(patched.includes("process.env.BILLING_GRACE_RESELLER_IDS || '8977002450'"), 'protected reseller default is missing');
assert(patched.includes('billingGraceOverdraft'), 'grace overdraft billing path is missing');
assert(patched.includes('debitBillingGraceWallet(userId, totalCost)'), 'negative-balance charge is missing');
assert(patched.includes("suspend_reason === 'insufficient_balance'"), 'previous billing suspension recovery is missing');
assert(patched.includes('sendBillingGraceAlertsIfNeeded(allPurchases)'), 'hourly grace alert hook is missing');
assert(patched.includes("'billing_grace_alert'"), 'grace alert dedupe log is missing');
assert(patched.includes("updatePurchaseSuspendReason(server_id, 'insufficient_balance')"), 'normal insufficient-balance suspension was removed');
assert(patched.includes('BILLING_GRACE_ADMIN_ID || SUPPORT_ID'), 'admin notification fallback is missing');

new vm.Script(patched, { filename: 'index-core.billing-grace.patched.js' });
console.log('validate-reseller-billing-grace: ok');
