'use strict';

const INSTALL_MARK = Symbol.for('hamoon.serverDeletionConsistencyInstalled');

function safeErrorCode(error) {
  return String(
    error?.code ||
    error?.response?.status ||
    error?.status ||
    error?.message ||
    'unknown'
  ).slice(0, 160);
}

function installServerDeletionConsistency() {
  const db = require('./db');
  const deletionRefund = require('./server-deletion-refund');

  if (db[INSTALL_MARK]) return false;

  // Provider deletion is the irreversible operation. Once it has succeeded (or
  // returned 404), bookkeeping such as a prorated refund must never prevent the
  // purchase row from reaching status=deleted. Keep refund failures visible in
  // logs, but let the existing deletion handler continue to DB cleanup.
  if (typeof deletionRefund.refundUnusedServerCycle === 'function') {
    const originalRefundUnusedServerCycle = deletionRefund.refundUnusedServerCycle.bind(deletionRefund);
    deletionRefund.refundUnusedServerCycle = async function refundUnusedServerCycleNonBlocking(args) {
      try {
        return await originalRefundUnusedServerCycle(args);
      } catch (error) {
        console.error('[SERVER_DELETION_REFUND_FAILED_NON_BLOCKING]', {
          telegram_id: String(args?.telegramId || ''),
          server_id: String(args?.serverId || ''),
          datacenter: String(args?.datacenter || ''),
          error: safeErrorCode(error)
        });
        return {
          status: 'refund_failed_non_blocking',
          refunded: 0,
          refundError: safeErrorCode(error)
        };
      }
    };
  }

  // Key material is secondary cleanup. A stale/missing key row must not turn a
  // successfully deleted VM into a ghost active purchase.
  if (typeof db.deleteKeyPairFromDb === 'function') {
    const originalDeleteKeyPairFromDb = db.deleteKeyPairFromDb.bind(db);
    db.deleteKeyPairFromDb = async function deleteKeyPairFromDbNonBlocking(serverId) {
      try {
        return await originalDeleteKeyPairFromDb(serverId);
      } catch (error) {
        console.error('[SERVER_DELETION_KEY_DB_CLEANUP_FAILED_NON_BLOCKING]', {
          server_id: String(serverId || ''),
          error: safeErrorCode(error)
        });
        return false;
      }
    };
  }

  db[INSTALL_MARK] = true;
  return true;
}

module.exports = {
  installServerDeletionConsistency
};
