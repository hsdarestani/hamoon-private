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
assert(handler.includes('openstackApi.listFlavors(dcConfig)'), 'cycle change does not load the live purchase catalog');
assert(handler.includes('getFlavorCyclePrice(selectedFlavor, newCycle)'), 'target cycle does not use the catalog cycle price');
assert(!handler.includes('Math.round(hourlyPrice * targetCycleHours)'), 'target price still extrapolates hourly price by cycle hours');

assert(handler.includes('openstackApi.isHetznerConfig(dcConfig)'), 'existing Hetzner plan recovery is not provider-scoped');
assert(handler.includes('openstackApi.getServer(dcConfig, null, serverId)'), 'existing Hetzner plan recovery does not verify the provider server type');
assert(handler.includes('openstackApi.listHetznerServerTypes(dcConfig)'), 'existing Hetzner plan recovery does not use the raw server type catalog');
assert(handler.includes('providerFlavorId === purchaseFlavorId'), 'existing Hetzner plan recovery does not require DB/provider flavor agreement');
assert(handler.includes('BILLING_CYCLE_EXISTING_HETZNER_PLAN_RECOVERED'), 'existing Hetzner plan recovery audit marker is missing');
assert(handler.includes('BILLING_CYCLE_RECOVERED_PRICE_MISMATCH'), 'recovered Hetzner pricing drift guard is missing');
assert(handler.includes('currentCycleAmount * 0.25'), 'recovered Hetzner pricing drift tolerance is missing');
assert(handler.includes('price_monthly?.gross'), 'recovered Hetzner monthly price does not come from provider raw pricing');
assert(handler.includes('price_hourly?.gross'), 'recovered Hetzner hourly price does not come from provider raw pricing');

new vm.Script(patched, { filename: 'index-core.patched.js' });
console.log('validate-billing-cycle-change: ok');
