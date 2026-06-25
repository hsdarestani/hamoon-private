'use strict';

const BILLABLE_PURCHASE_STATUSES = new Set(['active']);
const NON_BILLABLE_PURCHASE_STATUSES = new Set([
  'provisioning', 'building', 'pending_ip', 'pending_ssh', 'provisioning_failed',
  'deletion_pending', 'deleted', 'provider_missing', 'manual_review', 'cancelled'
]);

function isBillablePurchaseStatus(status) {
  return BILLABLE_PURCHASE_STATUSES.has(String(status || '').toLowerCase());
}

function isNonBillablePurchaseStatus(status) {
  return NON_BILLABLE_PURCHASE_STATUSES.has(String(status || '').toLowerCase());
}

module.exports = { BILLABLE_PURCHASE_STATUSES, NON_BILLABLE_PURCHASE_STATUSES, isBillablePurchaseStatus, isNonBillablePurchaseStatus };
