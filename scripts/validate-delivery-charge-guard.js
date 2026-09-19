'use strict';

const fs = require('fs');
const { applyPatches } = require('../runtime-bootstrap');

function must(haystack, needle, label) {
  if (!haystack.includes(needle)) throw new Error('DELIVERY_CHARGE_GUARD_MISSING:' + label);
}
function mustNot(haystack, needle, label) {
  if (haystack.includes(needle)) throw new Error('DELIVERY_CHARGE_GUARD_FORBIDDEN:' + label);
}

const db = fs.readFileSync('db.js', 'utf8');
const core = fs.readFileSync('index-core.js', 'utf8');
const customerApi = fs.readFileSync('customer-api.js', 'utf8');
const settlement = fs.readFileSync('billing-settlement.js', 'utf8');
const lifecycle = fs.readFileSync('services/hetzner-lifecycle.js', 'utf8');
const delivery = fs.readFileSync('delivery-charge.js', 'utf8');

must(delivery, 'pending_delivery_charges', 'reservation_table');
must(delivery, 'settlePendingOnDelivery', 'delivery_settlement');
must(delivery, "status='charged'", 'reservation_charge_transition');

must(db, 'reserveDeliveryCharge', 'db_reserve_export');
must(db, 'cancelDeliveryCharge', 'db_cancel_export');
must(db, 'deliveryCharge.settlePendingOnDelivery', 'mark_delivered_settlement');
must(db, 'deliveryCharge.pendingTotalForUser', 'wallet_reservation_protection');
must(db, 'SERVER_NOT_DELIVERED', 'cycle_change_predelivery_guard');

must(core, 'reserveDeliveryCharge({', 'telegram_reservation');
must(core, 'getPendingDeliveryChargeTotal(userId)', 'telegram_spendable_precheck');
must(core, "if (!isHetzner) {", 'telegram_non_hetzner_immediate_log');
must(core, "if (isHetzner) {\n      // Keep the customer's visible wallet untouched", 'telegram_deferred_branch');
must(core, "} else {\n      const debited = await debitUser(userId, finalPrice);", 'telegram_immediate_only_non_hetzner');

must(customerApi, 'db.reserveDeliveryCharge({', 'api_reservation');
must(customerApi, 'pending_delivery_reserved', 'api_spendable_precheck');
mustNot(customerApi, 'chargeApiInitialCycle({', 'api_immediate_initial_charge');

must(settlement, "return { status: 'undelivered_no_charge', charged: 0 };", 'atomic_renewal_predelivery_guard');
must(settlement, 'deliveryCharge.pendingTotalForUser', 'atomic_billing_reservation_protection');

must(lifecycle, 'if (isHetznerPurchase && !p.delivered_at) return false;', 'lifecycle_billable_delivery_gate');

const composed = applyPatches(core);
must(composed, 'reserveDeliveryCharge({', 'runtime_telegram_reservation');
must(composed, 'loyaltyWalletCharge', 'runtime_loyalty_deferred_charge');
must(composed, 'payment_deferred_until_delivery: isHetzner', 'runtime_loyalty_marker');
must(composed, "if (isHetzner) {\n      // Keep the customer's visible wallet untouched", 'runtime_deferred_branch');
must(composed, "} else {\n      const debited = loyaltyWalletCharge > 0 ? await debitUser(userId, loyaltyWalletCharge) : true;", 'runtime_immediate_only_non_hetzner');

console.log('validate-delivery-charge-guard: ok');
