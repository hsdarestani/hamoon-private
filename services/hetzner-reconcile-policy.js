'use strict';

const {
  shouldRelocateToFsn,
  relocatePendingPurchase
} = require('./hetzner-location-fallback');

const INSTALL_MARK = Symbol.for('hamoon.hetznerReconcilePolicyInstalled');
const inconclusiveCounts = new Map();
let reconcileRunning = false;

function clearServer(serverId) {
  const prefix = `${serverId}:`;
  for (const key of inconclusiveCounts.keys()) {
    if (key.startsWith(prefix)) inconclusiveCounts.delete(key);
  }
}

function shouldCountInconclusive(result) {
  return Boolean(
    result &&
    result.status === 'pending_ip_quality' &&
    result.ip &&
    result.quality &&
    result.quality.checked === true &&
    result.quality.definitive === false &&
    result.quality.reason === 'insufficient_results'
  );
}

function installHetznerReconcilePolicy() {
  const lifecycle = require('./hetzner-lifecycle');
  if (lifecycle[INSTALL_MARK]) return false;

  const original = lifecycle.reconcileProvisioning.bind(lifecycle);
  lifecycle.reconcileProvisioning = async function reconcileWithBoundedInconclusive(options = {}) {
    // node-cron can start the next minute while the previous quality/rotation cycle
    // is still running. Never let two cycles mutate the same pending Hetzner server.
    if (reconcileRunning) return [];
    reconcileRunning = true;

    try {
      const results = await original(options);
      const db = options.db;
      const resolveDatacenter = options.resolveDatacenter;
      const maxIpRotations = Number(
        options.maxIpRotations ?? process.env.HETZNER_MAX_IP_QUALITY_ROTATIONS ?? 20
      );
      const threshold = Math.max(
        2,
        Number(process.env.HETZNER_IP_QUALITY_INCONCLUSIVE_ROTATE_PROBES || 2)
      );
      const locationFallbackEnabled = process.env.HETZNER_GERMANY_LOCATION_FALLBACK_ENABLED !== 'false';
      const locationFallbackThreshold = Math.max(
        1,
        Number(process.env.HETZNER_GERMANY_LOCATION_FALLBACK_AFTER_ATTEMPTS || 2)
      );

      const output = [];
      for (const result of results || []) {
        if (!result?.server_id) {
          output.push(result);
          continue;
        }

        // Once a still-undelivered Germany/NBG purchase has burned through a few
        // dirty candidates, stop cycling inside the same NBG pool. Build a fresh
        // FSN VM, validate SSH + Iran/global reachability, atomically switch the
        // purchase to it and let the existing delivery notifier send credentials.
        if (locationFallbackEnabled && result.ready !== true && db?.getPurchaseForOwner) {
          const purchase = await db.getPurchaseForOwner(
            result.telegram_id,
            result.server_id,
            result.datacenter
          ).catch(() => null);

          if (shouldRelocateToFsn({
            result,
            purchase,
            threshold: locationFallbackThreshold
          })) {
            const dc = resolveDatacenter?.(result.datacenter, purchase || result);
            if (dc) {
              try {
                const relocated = await relocatePendingPurchase({
                  db,
                  dc,
                  lifecycle,
                  purchase,
                  targetLocation: process.env.HETZNER_GERMANY_LOCATION_FALLBACK_TARGET || 'fsn1',
                  maxCandidates: Number(process.env.HETZNER_FSN_LOCATION_FALLBACK_CANDIDATES || 3),
                  timeoutMs: Number(process.env.HETZNER_LOCATION_FALLBACK_READY_TIMEOUT_MS || 150000)
                });

                if (!relocated?.skipped) {
                  clearServer(result.server_id);
                  if (relocated?.server_id) clearServer(relocated.server_id);
                  output.push({ ...result, ...relocated });
                  continue;
                }
              } catch (error) {
                console.warn('[HETZNER_LOCATION_FALLBACK_FAILED]', {
                  server_id: String(result.server_id),
                  user_id: String(result.telegram_id || ''),
                  code: error?.code || null,
                  message: String(error?.message || error).slice(0, 120)
                });
                output.push({
                  ...result,
                  ready: false,
                  reason: 'location_fallback_failed',
                  error: String(error?.message || error).slice(0, 120)
                });
                continue;
              }
            }
          }
        }

        if (result.ready || result.ip_rotated || result.status !== 'pending_ip_quality') {
          clearServer(result.server_id);
          output.push(result);
          continue;
        }

        if (!shouldCountInconclusive(result)) {
          output.push(result);
          continue;
        }

        const key = `${result.server_id}:${result.ip}`;
        const count = (inconclusiveCounts.get(key) || 0) + 1;
        inconclusiveCounts.set(key, count);

        if (count < threshold) {
          output.push({ ...result, inconclusive_probe_count: count });
          continue;
        }

        try {
          const purchase = await db?.getPurchaseForOwner?.(
            result.telegram_id,
            result.server_id,
            result.datacenter
          );
          const attempts = Number(purchase?.ip_quality_attempts || 0);

          if (attempts >= maxIpRotations) {
            await db?.updateScopedStatus?.(
              result.telegram_id,
              result.server_id,
              result.datacenter,
              'manual_review'
            );
            clearServer(result.server_id);
            output.push({
              ...result,
              status: 'manual_review',
              ready: false,
              reason: 'ip_quality_exhausted'
            });
            continue;
          }

          const dc = resolveDatacenter?.(result.datacenter, purchase || result);
          if (!dc) {
            output.push({ ...result, reason: 'missing_datacenter' });
            continue;
          }

          await db?.updateIpQualityResult?.(
            result.telegram_id,
            result.server_id,
            result.datacenter,
            lifecycle.qualitySummary(result.quality),
            true
          );

          const rotated = await lifecycle.rotateProvisioningIp({
            dc,
            serverId: result.server_id,
            db,
            telegramId: result.telegram_id,
            datacenter: result.datacenter
          });

          await db?.updatePublicIp?.(
            result.telegram_id,
            result.server_id,
            result.datacenter,
            rotated.newIp
          );
          await db?.updateScopedStatus?.(
            result.telegram_id,
            result.server_id,
            result.datacenter,
            'pending_ssh'
          );

          clearServer(result.server_id);
          output.push({
            ...result,
            status: 'pending_ssh',
            ready: false,
            ip: rotated.newIp,
            ip_rotated: true,
            reason: 'repeated_inconclusive_rotated'
          });
        } catch (error) {
          output.push({
            ...result,
            reason: 'inconclusive_rotation_failed',
            error: String(error?.message || error).slice(0, 120)
          });
        }
      }

      return output;
    } finally {
      reconcileRunning = false;
    }
  };

  lifecycle[INSTALL_MARK] = true;
  return true;
}

module.exports = {
  installHetznerReconcilePolicy,
  shouldCountInconclusive,
  clearServer
};
