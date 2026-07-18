'use strict';

const net = require('net');
const cloud = require('../cloud-api');
const { isHetznerConfig } = require('../provider-detector');

const HOURS_IN_CYCLE = Object.freeze({
  hourly: 1,
  daily: 24,
  weekly: 168,
  monthly: 720
});

const NON_BILLABLE_STATUSES = new Set([
  'deleted',
  'deletion_pending',
  'provider_missing',
  'provisioning',
  'pending_ip',
  'pending_ssh',
  'provisioning_failed',
  'manual_review',
  'upgrading',
  'rebuilding',
  'changing_ip'
]);

const BILLABLE_STATUSES = new Set([
  'active',
  'running',
  'suspended',
  'stopped',
  'shutoff'
]);

const VALID_OPERATION_STATUSES = new Set([
  'active',
  'running',
  'suspended',
  'stopped',
  'shutoff'
]);

const locks = new Set();

function statusOf(error) {
  return Number(
    error?.status ||
    error?.statusCode ||
    error?.response?.status ||
    0
  );
}

function providerCode(error) {
  return String(
    error?.code ||
    error?.data?.error?.code ||
    error?.response?.data?.error?.code ||
    ''
  );
}

function isNotFound(error) {
  return statusOf(error) === 404 || providerCode(error) === 'not_found';
}

function isBillablePurchase(purchase) {
  if (!purchase) return false;
  const status = String(purchase.status || '').trim().toLowerCase();
  if (NON_BILLABLE_STATUSES.has(status)) return false;
  return BILLABLE_STATUSES.has(status);
}

function cycleHours(cycle) {
  const hours = HOURS_IN_CYCLE[String(cycle || '').toLowerCase()];
  if (!hours) {
    const error = new Error('INVALID_BILLING_CYCLE');
    error.code = 'INVALID_BILLING_CYCLE';
    throw error;
  }
  return hours;
}

function getFlavorCyclePrice(plan, cycle) {
  const normalizedCycle = String(cycle || '').toLowerCase();
  const hours = cycleHours(normalizedCycle);
  const monthly = Number(
    plan?.amount_monthly ??
    plan?.monthly_toman ??
    plan?.monthly_price_toman ??
    plan?.monthly_price ??
    plan?.monthlyPrice ??
    0
  );
  const hourly = Number(
    plan?.amount_hourly ??
    plan?.hourly_price_toman ??
    plan?.price ??
    (monthly > 0 ? monthly / 720 : 0)
  );

  if (normalizedCycle === 'monthly') {
    return Math.round(monthly > 0 ? monthly : hourly * hours);
  }

  return Math.round(hourly * hours);
}

function getPurchaseCycleAmount(purchase) {
  if (!purchase) return 0;
  const amount = Number(purchase.amount || 0);
  const version = Number(purchase.billing_amount_version || 1);
  if (version >= 2) return amount;
  return amount * cycleHours(purchase.duration);
}

function calculateCycleChange({
  currentAmount,
  currentCycle,
  targetAmount,
  lastBilledAt,
  now = new Date()
}) {
  const totalHours = cycleHours(currentCycle);
  const start = new Date(lastBilledAt || now);
  const end = new Date(now);
  const elapsedHours = Math.max(0, (end - start) / 3600000);
  const unusedHours = Math.max(
    0,
    totalHours - Math.min(totalHours, elapsedHours)
  );
  const credit = Number(currentAmount || 0) / totalHours * unusedHours;
  const normalizedTarget = Number(targetAmount || 0);
  const difference = normalizedTarget - credit;

  return {
    elapsedHours,
    unusedHours,
    credit,
    targetAmount: normalizedTarget,
    difference
  };
}

function architectureForServerType(type) {
  return String(type || '').toLowerCase().startsWith('cax') ? 'arm' : 'x86';
}

function imageArch(image) {
  const explicit =
    image?.architecture ||
    image?.arch ||
    image?.labels?.architecture;

  if (explicit) return String(explicit).toLowerCase();

  const text = String(
    image?.name ||
    image?.id ||
    image?.description ||
    ''
  ).toLowerCase();

  return text.includes('arm') || text.includes('aarch64')
    ? 'arm'
    : 'x86';
}

function filterCompatibleImages(images, serverType) {
  const architecture = architectureForServerType(serverType);
  return (images || []).filter(image =>
    image &&
    !image.deprecated &&
    !image.deprecation &&
    imageArch(image).startsWith(architecture)
  );
}

function publicIpv4(server) {
  return (
    server?.public_net?.ipv4?.ip ||
    server?.public_ip ||
    server?.publicIp ||
    server?.addresses?.public?.find?.(
      address => Number(address?.version) === 4
    )?.addr ||
    null
  );
}

function withLock(key, operation) {
  if (locks.has(key)) {
    const error = new Error('OPERATION_IN_PROGRESS');
    error.code = 'OPERATION_IN_PROGRESS';
    throw error;
  }

  locks.add(key);

  return Promise.resolve()
    .then(operation)
    .finally(() => locks.delete(key));
}

function waitTcp22(ip, timeoutMs = 30000, dial = net.createConnection) {
  const started = Date.now();

  return new Promise(resolve => {
    const tryConnect = () => {
      if (Date.now() - started >= timeoutMs) {
        resolve(false);
        return;
      }

      let settled = false;
      const socket = dial({
        host: ip,
        port: 22,
        timeout: Math.min(2500, timeoutMs)
      });

      const finish = result => {
        if (settled) return;
        settled = true;
        socket.destroy();

        if (result) {
          resolve(true);
          return;
        }

        setTimeout(tryConnect, 1000);
      };

      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.once('timeout', () => finish(false));
    };

    tryConnect();
  });
}

async function waitForReadiness(
  dc,
  serverId,
  {
    waitActionId,
    timeoutMs = Number(process.env.HETZNER_READY_TIMEOUT_MS || 300000),
    waitTcp = waitTcp22
  } = {}
) {
  if (waitActionId) {
    await cloud.waitHetznerAction(dc, waitActionId, timeoutMs);
  }

  const started = Date.now();
  let server = null;
  let ip = null;

  while (Date.now() - started < timeoutMs) {
    server = await cloud.getServer(dc, null, serverId);
    ip = publicIpv4(server);
    const status = String(server?.status || '').toLowerCase();

    if (status === 'running' && ip) {
      const remaining = Math.max(1000, timeoutMs - (Date.now() - started));
      const reachable = await waitTcp(ip, Math.min(30000, remaining));
      if (reachable) {
        return {
          server,
          ip,
          status: 'active',
          ready: true
        };
      }
    }

    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  return {
    server,
    ip,
    status: ip ? 'pending_ssh' : 'pending_ip',
    ready: false
  };
}

function safeProviderMessage(error) {
  const code = providerCode(error);

  if (
    code === 'HETZNER_PLACEMENT_UNAVAILABLE' ||
    code === 'resource_unavailable'
  ) {
    return 'ظرفیت این پلن در لوکیشن انتخاب‌شده موقتاً موجود نیست. پلن دیگری را انتخاب کنید.';
  }

  if (code === 'HETZNER_INVALID_IMAGE_ARCH') {
    return 'سیستم‌عامل انتخاب‌شده با معماری این پلن سازگار نیست.';
  }

  if (code === 'OPERATION_IN_PROGRESS') {
    return 'یک عملیات دیگر روی این سرور در حال انجام است. پس از پایان آن دوباره تلاش کنید.';
  }

  if (code === 'INVALID_BILLING_CYCLE') {
    return 'دوره پرداخت انتخاب‌شده معتبر نیست.';
  }

  if (code === 'CHANGE_IP_FAILED') {
    return 'تغییر IP کامل نشد و سیستم برای بازگردانی IP قبلی تلاش کرد. لطفاً با پشتیبانی تماس بگیرید.';
  }

  return 'عملیات Hetzner با خطا روبه‌رو شد. کمی بعد دوباره تلاش کنید یا با پشتیبانی تماس بگیرید.';
}

async function deletePurchaseServer({
  db,
  dc,
  telegramId,
  serverId,
  datacenter
}) {
  if (!isHetznerConfig(dc)) {
    const error = new Error('NOT_HETZNER');
    error.code = 'NOT_HETZNER';
    throw error;
  }

  return withLock(
    `delete:${datacenter}:${serverId}`,
    async () => {
      const purchase =
        await db.getPurchaseForOwner?.(
          telegramId,
          serverId,
          datacenter
        ) ||
        await db.getPurchaseForUserServer?.(
          telegramId,
          serverId,
          datacenter
        );

      if (!purchase) {
        const error = new Error('NOT_FOUND');
        error.code = 'NOT_FOUND';
        throw error;
      }

      const previousStatus = purchase.status || 'active';
      const previousAutoRenew = Number(purchase.auto_renew ?? 1);

      await db.markDeletionPending?.(
        telegramId,
        serverId,
        datacenter
      );

      try {
        await cloud.deleteServer(dc, null, serverId);

        await db.markDeleted?.(
          telegramId,
          serverId,
          datacenter
        );

        return { status: 'deleted' };
      } catch (error) {
        if (isNotFound(error)) {
          await db.markDeleted?.(
            telegramId,
            serverId,
            datacenter
          );

          return { status: 'deleted' };
        }

        await db.restorePurchaseLifecycle?.(
          telegramId,
          serverId,
          datacenter,
          previousStatus,
          previousAutoRenew
        );

        error.safeMessage = safeProviderMessage(error);
        throw error;
      }
    }
  );
}

async function reconcileDeletionPending({
  db,
  resolveDatacenter
}) {
  const rows = await db.listDeletionPending?.();
  const results = [];

  for (const purchase of rows || []) {
    const dc = resolveDatacenter(
      purchase.datacenter,
      purchase
    );

    if (!dc || !isHetznerConfig(dc)) {
      results.push({
        server_id: purchase.server_id,
        status: 'missing_datacenter'
      });
      continue;
    }

    try {
      await cloud.deleteServer(
        dc,
        null,
        purchase.server_id
      );

      await db.markDeleted?.(
        purchase.telegram_id,
        purchase.server_id,
        purchase.datacenter
      );

      results.push({
        server_id: purchase.server_id,
        status: 'deleted'
      });
    } catch (error) {
      if (isNotFound(error)) {
        await db.markDeleted?.(
          purchase.telegram_id,
          purchase.server_id,
          purchase.datacenter
        );

        results.push({
          server_id: purchase.server_id,
          status: 'deleted'
        });
      } else {
        results.push({
          server_id: purchase.server_id,
          status: 'retry_failed',
          code: providerCode(error) || statusOf(error)
        });
      }
    }
  }

  return results;
}


async function reconcileProvisioning({
  db,
  resolveDatacenter,
  timeoutMs = 15000
}) {
  const rows = await db.listPendingProvisioning?.();
  const results = [];

  for (const purchase of rows || []) {
    const dc = resolveDatacenter(
      purchase.datacenter,
      purchase
    );

    if (!dc || !isHetznerConfig(dc)) {
      results.push({
        server_id: purchase.server_id,
        status: 'missing_datacenter'
      });
      continue;
    }

    try {
      const readiness = await waitForReadiness(
        dc,
        purchase.server_id,
        { timeoutMs }
      );

      await db.updateScopedStatus?.(
        purchase.telegram_id,
        purchase.server_id,
        purchase.datacenter,
        readiness.status
      );

      if (readiness.ready) {
        await db.markDelivered?.(
          purchase.telegram_id,
          purchase.server_id,
          purchase.datacenter,
          readiness.ip
        );
      }

      results.push({
        server_id: purchase.server_id,
        status: readiness.status,
        ready: readiness.ready
      });
    } catch (error) {
      if (isNotFound(error)) {
        await db.updateScopedStatus?.(
          purchase.telegram_id,
          purchase.server_id,
          purchase.datacenter,
          'provider_missing'
        );

        results.push({
          server_id: purchase.server_id,
          status: 'provider_missing',
          ready: false
        });
      } else {
        results.push({
          server_id: purchase.server_id,
          status: 'check_failed',
          ready: false
        });
      }
    }
  }

  return results;
}

async function rebuildServerLifecycle({
  db,
  dc,
  telegramId,
  serverId,
  datacenter,
  imageId,
  waitOptions
}) {
  return withLock(
    `rebuild:${datacenter}:${serverId}`,
    async () => {
      const purchase =
        await db.getPurchaseForOwner?.(
          telegramId,
          serverId,
          datacenter
        ) ||
        await db.getPurchaseForUserServer?.(
          telegramId,
          serverId,
          datacenter
        );

      if (!purchase) {
        const error = new Error('NOT_FOUND');
        error.code = 'NOT_FOUND';
        throw error;
      }

      const previousStatus = purchase.status || 'active';

      await db.updateScopedStatus?.(
        telegramId,
        serverId,
        datacenter,
        'rebuilding'
      );

      try {
        const result = await cloud.rebuildServer(
          dc,
          null,
          serverId,
          imageId
        );

        const readiness = await waitForReadiness(
          dc,
          serverId,
          {
            waitActionId: result?.action?.id || result?.id,
            ...(waitOptions || {})
          }
        );

        await db.updatePurchaseOsLabel?.(serverId, imageId);
        await db.updateScopedStatus?.(
          telegramId,
          serverId,
          datacenter,
          readiness.status
        );

        if (readiness.ready) {
          await db.markDelivered?.(
            telegramId,
            serverId,
            datacenter,
            readiness.ip
          );
        }

        return {
          ok: readiness.ready,
          status: readiness.status,
          ip: readiness.ip,
          root_password: result?.root_password || null
        };
      } catch (error) {
        await db.updateScopedStatus?.(
          telegramId,
          serverId,
          datacenter,
          previousStatus
        );

        throw error;
      }
    }
  );
}

async function changePublicIpLifecycle({
  db,
  dc,
  telegramId,
  serverId,
  datacenter,
  waitOptions
}) {
  return withLock(
    `change-ip:${datacenter}:${serverId}`,
    async () => {
      const purchase =
        await db.getPurchaseForOwner?.(
          telegramId,
          serverId,
          datacenter
        ) ||
        await db.getPurchaseForUserServer?.(
          telegramId,
          serverId,
          datacenter
        );

      const currentStatus = String(
        purchase?.status || ''
      ).toLowerCase();

      if (!purchase || !VALID_OPERATION_STATUSES.has(currentStatus)) {
        const error = new Error('CONFLICT');
        error.code = 'CONFLICT';
        throw error;
      }

      const previousStatus = purchase.status || 'active';
      const server = await cloud.getServer(dc, null, serverId);
      const oldIpId =
        server?.primary_ipv4_id ||
        server?.public_net?.ipv4?.id;
      const oldIp = publicIpv4(server);
      const location =
        server?.location?.name ||
        server?.location ||
        dc?.HETZNER_LOCATION;

      if (!oldIpId || !oldIp || !location) {
        const error = new Error('PRIMARY_IPV4_NOT_FOUND');
        error.code = 'PRIMARY_IPV4_NOT_FOUND';
        throw error;
      }

      await db.updateScopedStatus?.(
        telegramId,
        serverId,
        datacenter,
        'changing_ip'
      );

      let newIp = null;
      let newAssigned = false;
      let oldUnassigned = false;

      try {
        const powerOffAction = await cloud.powerOffHetznerServer(
          dc,
          serverId
        );
        await cloud.waitHetznerAction(
          dc,
          powerOffAction?.id,
          180000
        );

        newIp = await cloud.createPrimaryIpv4(dc, location);

        const unassignOldAction = await cloud.unassignPrimaryIp(
          dc,
          oldIpId
        );
        await cloud.waitHetznerAction(
          dc,
          unassignOldAction?.id,
          180000
        );
        oldUnassigned = true;

        const assignNewAction = await cloud.assignPrimaryIp(
          dc,
          newIp.id,
          serverId
        );
        await cloud.waitHetznerAction(
          dc,
          assignNewAction?.id,
          180000
        );
        newAssigned = true;

        const powerOnAction = await cloud.powerOnHetznerServer(
          dc,
          serverId
        );

        const readiness = await waitForReadiness(
          dc,
          serverId,
          {
            waitActionId: powerOnAction?.id,
            ...(waitOptions || {})
          }
        );

        if (!readiness.ready) {
          const error = new Error('NEW_IP_NOT_READY');
          error.code = 'NEW_IP_NOT_READY';
          throw error;
        }

        let oldIpCleanupPending = false;

        await cloud.deletePrimaryIp(dc, oldIpId)
          .catch(error => {
            oldIpCleanupPending = true;
            console.error('[HETZNER_OLD_PRIMARY_IP_DELETE_FAILED]', {
              server_id: serverId,
              primary_ip_id: oldIpId,
              message: error.message
            });
          });

        await db.updatePublicIp?.(
          telegramId,
          serverId,
          datacenter,
          readiness.ip || newIp.ip
        );

        await db.updateScopedStatus?.(
          telegramId,
          serverId,
          datacenter,
          'active'
        );

        return {
          status: 'active',
          old_ip: oldIp,
          new_ip: readiness.ip || newIp.ip,
          cleanup_pending: oldIpCleanupPending
        };
      } catch (cause) {
        let rollbackSucceeded = false;

        try {
          const latest = await cloud.getServer(dc, null, serverId)
            .catch(() => null);

          if (
            latest &&
            !['off', 'stopped'].includes(
              String(latest.status || '').toLowerCase()
            )
          ) {
            const action = await cloud.powerOffHetznerServer(
              dc,
              serverId
            );

            await cloud.waitHetznerAction(
              dc,
              action?.id,
              180000
            );
          }

          if (newAssigned && newIp?.id) {
            const action = await cloud.unassignPrimaryIp(
              dc,
              newIp.id
            );

            await cloud.waitHetznerAction(
              dc,
              action?.id,
              180000
            );
          }

          if (oldUnassigned) {
            const action = await cloud.assignPrimaryIp(
              dc,
              oldIpId,
              serverId
            );

            await cloud.waitHetznerAction(
              dc,
              action?.id,
              180000
            );
          }

          const powerOnAction = await cloud.powerOnHetznerServer(
            dc,
            serverId
          );

          await cloud.waitHetznerAction(
            dc,
            powerOnAction?.id,
            180000
          );

          if (newIp?.id) {
            await cloud.deletePrimaryIp(dc, newIp.id)
              .catch(() => null);
          }

          rollbackSucceeded = true;
        } catch (rollbackError) {
          console.error('[HETZNER_CHANGE_IP_ROLLBACK_FAILED]', {
            server_id: serverId,
            cause: rollbackError.message
          });
        }

        await db.updateScopedStatus?.(
          telegramId,
          serverId,
          datacenter,
          rollbackSucceeded ? previousStatus : 'manual_review'
        );

        const error = new Error('CHANGE_IP_FAILED');
        error.code = 'CHANGE_IP_FAILED';
        error.cause = cause;
        error.rollbackSucceeded = rollbackSucceeded;
        throw error;
      }
    }
  );
}

module.exports = {
  HOURS_IN_CYCLE,
  NON_BILLABLE_STATUSES,
  BILLABLE_STATUSES,
  isBillablePurchase,
  cycleHours,
  getFlavorCyclePrice,
  getPurchaseCycleAmount,
  calculateCycleChange,
  architectureForServerType,
  filterCompatibleImages,
  waitTcp22,
  waitForReadiness,
  deletePurchaseServer,
  reconcileDeletionPending,
  reconcileProvisioning,
  rebuildServerLifecycle,
  changePublicIpLifecycle,
  safeProviderMessage,
  publicIpv4,
  isNotFound
};
