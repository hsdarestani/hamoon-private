'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { applyProviderVisibilityPatches } = require('./provider-visibility-bootstrap');
const { applyHetznerPendingDeliveryRecoveryPatches } = require('./hetzner-pending-delivery-recovery-bootstrap');
const { applyPatches: applyFeaturePatches } = require('./hetzner-console-bootstrap');
const { applyHetznerTrafficPatches } = require('./hetzner-traffic-bootstrap');
const { applyHetznerChangeIpPatches } = require('./hetzner-change-ip-bootstrap');
const { applyBillingCyclePatches } = require('./billing-cycle-bootstrap');
const { applyBillingRenewalGuardPatches } = require('./billing-renewal-guard-bootstrap');
const { applyBillingSettlementPatches } = require('./billing-settlement-bootstrap');
const { applyResellerBillingGracePatches } = require('./reseller-billing-grace-bootstrap');
const { applyRebuildPatches } = require('./rebuild-bootstrap');
const { applyHetznerPurchaseArchitecturePatches } = require('./hetzner-purchase-architecture-bootstrap');
const { applyHetznerManagementScopePatch } = require('./hetzner-management-scope-bootstrap');
const { applyZibalRefererPatches } = require('./zibal-referer-bootstrap');
const { applyHetznerUpgradeSafetyPatches } = require('./hetzner-upgrade-safety-bootstrap');
const { applyLoyaltyClubPatches } = require('./loyalty-club-bootstrap');
const { applyLoyaltyHistoryPatches } = require('./loyalty-history-bootstrap');
const { applyPurchaseConfirmationSafetyPatches } = require('./purchase-confirmation-safety-bootstrap');
const { installStrictCheckHostFetch } = require('./services/check-host-strict-fetch');
const { installSafeLifecycleModule } = require('./services/hetzner-lifecycle-safe-bootstrap');
const { installHetznerReconcilePolicy } = require('./services/hetzner-reconcile-policy');

const DELIVERED_STATUS_REPAIR_MARK = Symbol.for('hamoon.deliveredStatusRepairInstalled');

function applyRuntimeSafetyDefaults() {
  const datacenters = require('./datacenters');
  if (datacenters && Object.prototype.hasOwnProperty.call(datacenters, 'afracloud')) {
    delete datacenters.afracloud;
  }

  const forced = {
    HETZNER_IP_QUALITY_REQUIRED: 'true',
    HETZNER_IP_QUALITY_INCONCLUSIVE_FAIL_OPEN_MS: String(10 * 365 * 24 * 60 * 60 * 1000),
    HETZNER_IP_QUALITY_INCONCLUSIVE_ROTATE_PROBES: '2',
    HETZNER_MAX_IP_QUALITY_ROTATIONS: '20',
    HETZNER_IP_QUALITY_IR_NODES: '6',
    HETZNER_IP_QUALITY_IR_MIN_SUCCESS: '4',
    HETZNER_IP_QUALITY_GLOBAL_NODES: '6',
    HETZNER_IP_QUALITY_GLOBAL_MIN_RATIO: '0.67',
    HETZNER_CHANGE_IP_REJECTED_COOLDOWN_MS: '0',
    HETZNER_EUR_TO_TOMAN: '250000',
    LOYALTY_SILVER_CASHBACK: '2',
    LOYALTY_GOLD_CASHBACK: '4',
    LOYALTY_BLACK_CASHBACK: '6'
  };
  for (const [key, value] of Object.entries(forced)) process.env[key] = value;

  const defaults = {
    HETZNER_CHANGE_IP_UNIQUE_ATTEMPTS: '20',
    HETZNER_CHANGE_IP_CLEAN_ATTEMPTS: '20',
    HETZNER_CHANGE_IP_INCONCLUSIVE_CANDIDATES: '4',
    HETZNER_CHANGE_IP_QUALITY_PROBE_ATTEMPTS: '3',
    HETZNER_CHANGE_IP_RECENT_REUSE_COOLDOWN_MS: String(30 * 60 * 1000),
    HETZNER_PROVISIONING_CLEAN_ATTEMPTS: '8',
    HETZNER_PROVISIONING_SSH_VERIFY_TIMEOUT_MS: '90000',
    HETZNER_PENDING_RECOVERY_READY_TIMEOUT_MS: '90000'
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (process.env[key] == null || process.env[key] === '') process.env[key] = value;
  }
}

function installCleanIpChangeModule() {
  const legacyPath = require.resolve('./services/hetzner-change-ip');
  const cleanModule = require('./services/hetzner-clean-ip-change');
  if (require.cache[legacyPath]) require.cache[legacyPath].exports = cleanModule;
}

// markDelivered intentionally returns true only for the first delivery. A rebuild or
// later lifecycle check can put an already-delivered row back into a pending state.
// The old DB helper then refuses to touch it because delivered_at is already set,
// leaving a healthy server stuck in pending_ip_quality forever. Preserve the
// first-delivery return value (so credentials are never re-sent) but repair the
// stale status whenever a fresh readiness check says the server is deliverable.
function installDeliveredStatusRepair() {
  const db = require('./db');
  if (db[DELIVERED_STATUS_REPAIR_MARK]) return false;
  if (typeof db.markDelivered !== 'function') throw new Error('DB_MARK_DELIVERED_UNAVAILABLE');

  const originalMarkDelivered = db.markDelivered.bind(db);
  db.markDelivered = async function markDeliveredWithStatusRepair(
    telegramId,
    serverId,
    datacenter,
    publicIp
  ) {
    const newlyDelivered = await originalMarkDelivered(
      telegramId,
      serverId,
      datacenter,
      publicIp
    );
    if (newlyDelivered) return true;

    const purchase = await db.getPurchaseForOwner?.(
      telegramId,
      serverId,
      datacenter
    ).catch(() => null);

    if (!purchase?.delivered_at) return false;
    if (String(purchase.status || '').toLowerCase() === 'active') return false;

    if (publicIp && typeof db.updatePublicIp === 'function') {
      await db.updatePublicIp(telegramId, serverId, datacenter, publicIp).catch(() => false);
    }
    const repaired = await db.updateScopedStatus?.(
      telegramId,
      serverId,
      datacenter,
      'active'
    );

    if (repaired) {
      console.log('[HETZNER_DELIVERED_STATUS_REPAIRED]', {
        server_id: String(serverId),
        datacenter: String(datacenter),
        previous_status: String(purchase.status || 'unknown')
      });
    }
    return false;
  };

  db[DELIVERED_STATUS_REPAIR_MARK] = true;
  return true;
}

function applyPatches(coreSource) {
  return applyPurchaseConfirmationSafetyPatches(
    applyLoyaltyHistoryPatches(
      applyLoyaltyClubPatches(
        applyResellerBillingGracePatches(
          applyBillingSettlementPatches(
            applyBillingRenewalGuardPatches(
              applyHetznerManagementScopePatch(
                applyHetznerPurchaseArchitecturePatches(
                  applyRebuildPatches(
                    applyBillingCyclePatches(
                      applyHetznerChangeIpPatches(
                        applyHetznerTrafficPatches(
                          applyFeaturePatches(
                            applyHetznerPendingDeliveryRecoveryPatches(
                              applyProviderVisibilityPatches(
                                applyHetznerUpgradeSafetyPatches(
                                  applyZibalRefererPatches(coreSource)
                                )
                              )
                            )
                          )
                        )
                      )
                    )
                  )
                )
              )
            )
          )
        )
      )
    )
  );
}

function run() {
  applyRuntimeSafetyDefaults();
  installStrictCheckHostFetch();
  installSafeLifecycleModule();
  installHetznerReconcilePolicy();
  installCleanIpChangeModule();
  installDeliveredStatusRepair();
  const corePath = path.join(__dirname, 'index-core.js');
  const source = applyPatches(fs.readFileSync(corePath, 'utf8'));
  const child = new Module(corePath, module.parent);
  child.filename = corePath;
  child.paths = Module._nodeModulePaths(path.dirname(corePath));
  require.cache[corePath] = child;
  child._compile(source, corePath);
  return child.exports;
}

module.exports = {
  applyPatches,
  applyRuntimeSafetyDefaults,
  installCleanIpChangeModule,
  installDeliveredStatusRepair,
  installSafeLifecycleModule,
  run
};
