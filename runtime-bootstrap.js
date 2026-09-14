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
const { applyBillingRenewalTickPatches } = require('./billing-renewal-tick-bootstrap');
const { applyResumeTransactionalPatches } = require('./resume-transactional-bootstrap');
const { applyResellerBillingGracePatches } = require('./reseller-billing-grace-bootstrap');
const { applyRebuildPatches } = require('./rebuild-bootstrap');
const { applyHetznerPurchaseArchitecturePatches } = require('./hetzner-purchase-architecture-bootstrap');
const { applyHetznerManagementScopePatch } = require('./hetzner-management-scope-bootstrap');
const { applyZibalRefererPatches } = require('./zibal-referer-bootstrap');
const { applyHetznerUpgradeSafetyPatches } = require('./hetzner-upgrade-safety-bootstrap');
const { applyLoyaltyClubPatches } = require('./loyalty-club-bootstrap');
const { applyLoyaltyHistoryPatches } = require('./loyalty-history-bootstrap');
const { applyPurchaseConfirmationSafetyPatches } = require('./purchase-confirmation-safety-bootstrap');
const { applyAdminUnlimitedFreeTestPatches } = require('./admin-free-test-bootstrap');
const { installStrictCheckHostFetch } = require('./services/check-host-strict-fetch');
const { installSafeLifecycleModule } = require('./services/hetzner-lifecycle-safe-bootstrap');
const { installFastLocationFallbackModule } = require('./services/hetzner-location-fallback-fast-bootstrap');

// Reconcile policy imports the location-fallback module at module load time. Install
// the accelerated version first so every reconcile cycle uses the same temporary
// FSN VM while searching multiple clean IPv4 candidates.
installFastLocationFallbackModule();
const { installHetznerReconcilePolicy } = require('./services/hetzner-reconcile-policy');

const DELIVERED_STATUS_REPAIR_MARK = Symbol.for('hamoon.deliveredStatusRepairInstalled');

function applyRuntimeSafetyDefaults() {
  const datacenters = require('./datacenters');
  if (datacenters && Object.prototype.hasOwnProperty.call(datacenters, 'afracloud')) {
    delete datacenters.afracloud;
  }

  // HAMOON_IR_QUALITY_QUORUM_V1
  const forced = {
    HETZNER_IP_QUALITY_REQUIRED: 'true',
    // Production delivery is fail-closed for Iran reachability. Keep the legacy
    // lifecycle fail-open horizon effectively disabled, and rotate inconclusive
    // IPs quickly instead of releasing credentials for an unverified address.
    HETZNER_IP_QUALITY_INCONCLUSIVE_FAIL_OPEN_MS: String(10 * 365 * 24 * 60 * 60 * 1000),
    HETZNER_IP_QUALITY_INCONCLUSIVE_ROTATE_PROBES: '2',
    HETZNER_MAX_IP_QUALITY_ROTATIONS: '20',
    HETZNER_IP_QUALITY_IR_NODES: '6',
    // Check-Host currently exposes four Iran nodes in normal operation. Requiring
    // all four makes one slow/offline probe strand otherwise healthy Hetzner IPs
    // as "inconclusive" forever. Keep the strict per-node ICMP+TCP/22 check, but
    // use a 3-of-4 quorum so a single probe outage cannot block delivery/change-IP.
    HETZNER_IP_QUALITY_IR_MIN_SUCCESS: '3',
    HETZNER_IP_QUALITY_GLOBAL_NODES: '6',
    HETZNER_IP_QUALITY_GLOBAL_MIN_RATIO: '0.67',
    HETZNER_CHANGE_IP_REJECTED_COOLDOWN_MS: '0',
    // Manual Change-IP runs against an already-delivered server and therefore must
    // never rebuild/move the VM across locations. Keep the operation bounded: try
    // only a few verified candidates, then preserve the previous IP and return a
    // clear failure instead of spinning through the pool for tens of minutes.
    HETZNER_CHANGE_IP_CLEAN_ATTEMPTS: '4',
    HETZNER_CHANGE_IP_INCONCLUSIVE_CANDIDATES: '2',
    HETZNER_TRAFFIC_EUR_TO_TOMAN: '250000',
    LOYALTY_SILVER_CASHBACK: '2',
    LOYALTY_GOLD_CASHBACK: '4',
    LOYALTY_BLACK_CASHBACK: '6'
  };
  for (const [key, value] of Object.entries(forced)) process.env[key] = value;

  const defaults = {
    HETZNER_CHANGE_IP_UNIQUE_ATTEMPTS: '20',
    // One longer Check-Host request is more reliable than repeatedly restarting
    // short probes before Iranian TCP nodes have returned.
    HETZNER_CHANGE_IP_QUALITY_PROBE_ATTEMPTS: '1',
    HETZNER_CHANGE_IP_QUALITY_POLLS: '15',
    HETZNER_CHANGE_IP_QUALITY_POLL_DELAY_MS: '1500',
    HETZNER_CHANGE_IP_QUALITY_SETTLE_MS: '6000',
    HETZNER_CHANGE_IP_RECENT_REUSE_COOLDOWN_MS: String(30 * 60 * 1000),
    HETZNER_PROVISIONING_CLEAN_ATTEMPTS: '8',
    HETZNER_PROVISIONING_QUALITY_SETTLE_MS: '6000',
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
  const baseline = applyPurchaseConfirmationSafetyPatches(
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
  const patched = applyBillingRenewalTickPatches(applyResumeTransactionalPatches(baseline));
  return applyAdminUnlimitedFreeTestPatches(patched);
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
  installFastLocationFallbackModule,
  run
};