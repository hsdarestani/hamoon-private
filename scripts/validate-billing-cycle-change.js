'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { applyPatches } = require('../runtime-bootstrap');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const core = fs.readFileSync(path.join(__dirname, '..', 'index-core.js'), 'utf8');
const patched = applyPatches(core);
const start = patched.indexOf('async function handleChangeCycleConfirm(');
const end = patched.indexOf('async function handleSnapshotAsk(', start);
assert(start >= 0 && end > start, 'patched change-cycle handler not found');
const handler = patched.slice(start, end);

assert(patched.includes('changePurchaseCycleAtomic,'), 'atomic DB helper is not imported');
assert(handler.includes('changePurchaseCycleAtomic({'), 'cycle change is not atomic');
assert(handler.includes('newAmount: newCyclePrice'), 'new billing amount is not persisted');
assert(handler.includes("String(purchase.telegram_id) !== String(userId)"), 'ownership check is missing');
assert(!handler.includes('updatePurchaseCycle(serverId, newCycle)'), 'legacy partial cycle update is still active');
assert(!handler.includes("parse_mode: 'MarkdownV2'"), 'cycle result still depends on MarkdownV2 escaping');
assert(handler.includes('BILLING_CYCLE_CHANGE_SUCCESS'), 'success audit marker is missing');
assert(handler.includes('BILLING_CYCLE_CHANGE_FAILED'), 'failure audit marker is missing');

new vm.Script(patched, { filename: 'index-core.patched.js' });
console.log('validate-billing-cycle-change: ok');
