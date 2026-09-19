const net = require('net');
const cloud = require('../cloud-api');
const { isHetznerConfig } = require('../provider-detector');
const { reserveUniquePrimaryIpv4, rememberIp } = require('./hetzner-change-ip');

const HOURS_IN_CYCLE = Object.freeze({ hourly: 1, daily: 24, weekly: 168, monthly: 720 });
const NON_BILLABLE_STATUSES = new Set([
  'deleted','deletion_pending','provider_missing','provisioning','pending_ip','pending_ssh',
  'pending_ip_quality','provisioning_failed','manual_review','upgrading','rebuilding'
]);
const VALID_OPERATION_STATUSES = new Set(['active','suspended','stopped','shutoff']);
const locks = new Set();
const pendingSshRecoveryAttempted = new Set();
const unavailable = new Map();
const CHECK_HOST_BASE = 'https://check-host.net';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isBillablePurchase(p) {
  if (!p) return false;
  const status = String(p.status || '').toLowerCase();
  if (NON_BILLABLE_STATUSES.has(status)) return false;

  // Hetzner billing starts only after the server has passed the delivery
  // barrier (provider running + SSH + IP quality) and delivered_at is set.
  // This is intentionally independent from status so an accidental/stale
  // "active" status can never bill an undelivered VM.
  const dc = String(p.datacenter || '').toLowerCase();
  const isHetznerPurchase = dc === 'hetzner' || dc.startsWith('hetzner-');
  if (isHetznerPurchase && !p.delivered_at) return false;

  return true;
}
function isNotFound(err) { return Number(err?.status || err?.statusCode || err?.response?.status) === 404; }
function safeProviderMessage(err) {
  if (err?.code === 'HETZNER_PLACEMENT_UNAVAILABLE') return 'ظرفیت این پلن در لوکیشن انتخاب‌شده موقتاً در دسترس نیست. لطفاً پلن دیگری انتخاب کنید یا بعداً دوباره تلاش کنید.';
  if (err?.code === 'HETZNER_INVALID_IMAGE_ARCH') return 'ایمیج انتخاب‌شده با معماری پلن سازگار نیست.';
  return 'عملیات ارائه‌دهنده با خطا روبه‌رو شد. لطفاً کمی بعد دوباره تلاش کنید یا با پشتیبانی تماس بگیرید.';
}
function withLock(key, fn) {
  if (locks.has(key)) { const e = new Error('OPERATION_IN_PROGRESS'); e.code = 'OPERATION_IN_PROGRESS'; throw e; }
  locks.add(key);
  return Promise.resolve().then(fn).finally(() => locks.delete(key));
}
function cycleHours(cycle) {
  const h = HOURS_IN_CYCLE[cycle];
  if (!h) { const e = new Error('INVALID_BILLING_CYCLE'); e.code = 'INVALID_BILLING_CYCLE'; throw e; }
  return h;
}
function getFlavorCyclePrice(plan, cycle) {
  cycleHours(cycle);
  const monthly = Number(plan.amount_monthly ?? plan.monthly_toman ?? plan.monthly_price_toman ?? 0);
  const hourly = Number(plan.amount_hourly ?? plan.price ?? plan.hourly_price_toman ?? (monthly / 720));
  if (cycle === 'hourly') return hourly;
  if (cycle === 'daily') return hourly * 24;
  if (cycle === 'weekly') return hourly * 168;
  return monthly || hourly * 720;
}
function calculateCycleChange({ currentAmount, currentCycle, targetAmount, lastBilledAt, now = new Date() }) {
  const elapsed = Math.max(0, (new Date(now) - new Date(lastBilledAt || now)) / 3600000);
  const totalHours = cycleHours(currentCycle);
  const unused = Math.max(0, totalHours - Math.min(totalHours, elapsed));
  const credit = Number(currentAmount || 0) / totalHours * unused;
  return { elapsedHours: elapsed, unusedHours: unused, credit, targetAmount: Number(targetAmount || 0), difference: Number(targetAmount || 0) - credit };
}
function architectureForServerType(type) { return String(type || '').toLowerCase().startsWith('cax') ? 'arm' : 'x86'; }
function imageArch(img) {
  const explicit = img?.architecture || img?.arch || img?.labels?.architecture;
  if (explicit) return String(explicit).toLowerCase();
  return String(img?.name || img?.id || '').toLowerCase().includes('arm') ? 'arm' : 'x86';
}
function filterCompatibleImages(images, serverType) {
  const arch = architectureForServerType(serverType);
  return (images || []).filter(i => !i.deprecated && imageArch(i).startsWith(arch));
}
function markPlanUnavailable(location, serverType, ttlMs = Number(process.env.HETZNER_UNAVAILABLE_PLAN_CACHE_MS || 10 * 60 * 1000)) {
  unavailable.set(`${location}:${serverType}`.toLowerCase(), Date.now() + ttlMs);
}
function isPlanTemporarilyUnavailable(location, serverType) {
  const key = `${location}:${serverType}`.toLowerCase();
  const exp = unavailable.get(key);
  if (!exp) return false;
  if (exp < Date.now()) { unavailable.delete(key); return false; }
  return true;
}
function filterSellablePlans(plans, { location, image, allowedTypes, disabledTypes } = {}) {
  const allowed = new Set(String(allowedTypes || process.env.HETZNER_ALLOWED_SERVER_TYPES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  const disabled = new Set(String(disabledTypes || process.env.HETZNER_DISABLED_SERVER_TYPES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  const imgArch = image ? imageArch(image) : null;
  return (plans || []).filter(p => p && p.available !== false && !p.deprecated && !p.deprecation && (!allowed.size || allowed.has(p.id)) && !disabled.has(p.id) && (!location || !isPlanTemporarilyUnavailable(location, p.id)) && (!imgArch || architectureForServerType(p.id) === imgArch));
}

async function waitTcp22(ip, timeoutMs = 300000, dial = net.createConnection) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await new Promise(resolve => {
      const s = dial({ host: ip, port: 22, timeout: 2500 }, () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
      s.on('timeout', () => { s.destroy(); resolve(false); });
    })) return true;
    await sleep(1000);
  }
  return false;
}
function publicIpv4(server) {
  return server?.public_net?.ipv4?.ip || server?.public_ip || server?.addresses?.public?.find?.(a => Number(a.version) === 4)?.addr || null;
}

async function fetchJson(url, { fetchImpl = global.fetch, timeoutMs = 7000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('FETCH_UNAVAILABLE');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'HamoonCloud/1.0' },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`CHECK_HOST_HTTP_${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function pingNodeSuccess(value) {
  if (value === null || value === undefined) return null;
  let sawFailure = false;
  const visit = v => {
    if (typeof v === 'string') {
      const x = v.toUpperCase();
      if (x === 'OK') return true;
      if (x.includes('TIMEOUT') || x.includes('MALFORMED') || x.includes('ERROR') || x.includes('FAIL')) sawFailure = true;
      return false;
    }
    if (Array.isArray(v)) {
      for (const x of v) if (visit(x)) return true;
      return false;
    }
    if (v && typeof v === 'object') {
      for (const x of Object.values(v)) if (visit(x)) return true;
    }
    return false;
  };
  if (visit(value)) return true;
  return sawFailure || value !== null ? false : null;
}

function selectCheckHostNodes(payload, { iranCount = 4, globalCount = 6 } = {}) {
  const entries = Object.entries(payload?.nodes || {}).filter(([, meta]) => Array.isArray(meta?.location));
  const iranAll = entries.filter(([, meta]) => String(meta.location[0] || '').toLowerCase() === 'ir');
  const iran = [];
  const iranCities = new Set();
  for (const [name, meta] of iranAll) {
    const city = String(meta.location[2] || '').toLowerCase();
    if (iran.length < iranCount && (!city || !iranCities.has(city))) {
      iran.push(name);
      if (city) iranCities.add(city);
    }
  }
  for (const [name] of iranAll) if (iran.length < iranCount && !iran.includes(name)) iran.push(name);

  const priority = ['de','nl','gb','us','fi','fr','sg','ca','ch','se','pl','tr','jp','au'];
  const outside = entries.filter(([, meta]) => String(meta.location[0] || '').toLowerCase() !== 'ir');
  const global = [];
  const usedCountries = new Set();
  for (const cc of priority) {
    const found = outside.find(([name, meta]) => String(meta.location[0] || '').toLowerCase() === cc && !global.includes(name));
    if (found && global.length < globalCount) { global.push(found[0]); usedCountries.add(cc); }
  }
  for (const [name, meta] of outside) {
    if (global.length >= globalCount) break;
    const cc = String(meta.location[0] || '').toLowerCase();
    if (!usedCountries.has(cc)) { global.push(name); usedCountries.add(cc); }
  }
  return { iran, global };
}

function qualitySummary(q) {
  if (!q) return 'quality=unknown';
  return `iran=${q.iran?.success || 0}/${q.iran?.selected || 0};global=${q.global?.success || 0}/${q.global?.selected || 0};reason=${q.reason || (q.ok ? 'ok' : 'unknown')}`.slice(0, 255);
}

async function checkIpQuality(ip, options = {}) {
  const iranCount = Math.max(2, Number(options.iranCount ?? process.env.HETZNER_IP_QUALITY_IR_NODES ?? 4));
  const iranMin = Math.max(1, Number(options.iranMin ?? process.env.HETZNER_IP_QUALITY_IR_MIN_SUCCESS ?? 3));
  const globalCount = Math.max(3, Number(options.globalCount ?? process.env.HETZNER_IP_QUALITY_GLOBAL_NODES ?? 6));
  const globalRatio = Math.min(1, Math.max(0.5, Number(options.globalRatio ?? process.env.HETZNER_IP_QUALITY_GLOBAL_MIN_RATIO ?? 0.67)));
  const polls = Math.max(2, Number(options.polls ?? 6));
  const pollDelayMs = Math.max(250, Number(options.pollDelayMs ?? 1500));
  const fetchImpl = options.fetchImpl || global.fetch;
  try {
    const nodePayload = options.nodesPayload || await fetchJson(`${CHECK_HOST_BASE}/nodes/hosts`, { fetchImpl, timeoutMs: 7000 });
    const selected = selectCheckHostNodes(nodePayload, { iranCount, globalCount });
    if (selected.iran.length < 2 || selected.global.length < 3) {
      return { ok: false, checked: false, definitive: false, reason: 'probe_nodes_unavailable', iran: { selected: selected.iran.length, success: 0, completed: 0 }, global: { selected: selected.global.length, success: 0, completed: 0 } };
    }
    const allNodes = [...selected.iran, ...selected.global];
    const u = new URL(`${CHECK_HOST_BASE}/check-ping`);
    u.searchParams.set('host', ip);
    for (const node of allNodes) u.searchParams.append('node', node);
    const request = await fetchJson(u.toString(), { fetchImpl, timeoutMs: 7000 });
    if (!request?.ok || !request?.request_id) throw new Error('CHECK_HOST_REQUEST_REJECTED');

    let result = {};
    for (let i = 0; i < polls; i += 1) {
      if (i) await sleep(pollDelayMs);
      result = await fetchJson(`${CHECK_HOST_BASE}/check-result/${encodeURIComponent(request.request_id)}`, { fetchImpl, timeoutMs: 7000 });
      const completed = allNodes.filter(n => pingNodeSuccess(result?.[n]) !== null).length;
      if (completed === allNodes.length) break;
    }
    const count = names => {
      const states = names.map(n => pingNodeSuccess(result?.[n]));
      return { selected: names.length, success: states.filter(v => v === true).length, failed: states.filter(v => v === false).length, completed: states.filter(v => v !== null).length };
    };
    const iran = count(selected.iran);
    const global = count(selected.global);
    const iranRequired = Math.min(iran.selected, iranMin);
    const globalRequired = Math.max(1, Math.ceil(global.selected * globalRatio));
    const ok = iran.success >= iranRequired && global.success >= globalRequired;
    const iranImpossible = iran.success + (iran.selected - iran.completed) < iranRequired;
    const globalImpossible = global.success + (global.selected - global.completed) < globalRequired;
    const definitive = ok || iranImpossible || globalImpossible || (iran.completed === iran.selected && global.completed === global.selected);
    return { ok, checked: true, definitive, reason: ok ? 'ok' : (definitive ? 'failed_threshold' : 'insufficient_results'), iran: { ...iran, required: iranRequired }, global: { ...global, required: globalRequired } };
  } catch (error) {
    return { ok: false, checked: false, definitive: false, reason: `probe_error:${String(error?.message || error).slice(0, 80)}`, iran: { selected: 0, success: 0, completed: 0 }, global: { selected: 0, success: 0, completed: 0 } };
  }
}

function shouldRequireIpQuality(dc, explicit) {
  if (explicit !== undefined) return Boolean(explicit);
  return dc?.HETZNER_PURCHASE_HEALTH_GATE === true && process.env.HETZNER_IP_QUALITY_REQUIRED !== 'false';
}

async function waitForReadiness(dc, serverId, { waitActionId, timeoutMs = 300000, waitTcp = waitTcp22, checkQuality = checkIpQuality, requireIpQuality } = {}) {
  if (waitActionId) await cloud.waitHetznerAction(dc, waitActionId, timeoutMs);
  const start = Date.now();
  let server = null;
  let ip = null;
  while (Date.now() - start < timeoutMs) {
    server = await cloud.getServer(dc, null, serverId);
    ip = publicIpv4(server);
    if (String(server?.status || '').toLowerCase() === 'running' && ip) {
      const remaining = Math.max(1000, timeoutMs - (Date.now() - start));
      const reachable = await waitTcp(ip, Math.min(30000, remaining));
      if (reachable) {
        if (!shouldRequireIpQuality(dc, requireIpQuality)) return { server, ip, status: 'active', ready: true, quality: { ok: true, skipped: true, reason: 'not_required' } };
        const quality = await checkQuality(ip);
        if (quality?.ok) return { server, ip, status: 'active', ready: true, quality };
        return { server, ip, status: 'pending_ip_quality', ready: false, quality };
      }
    }
    await sleep(3000);
  }
  return { server, ip, status: ip ? 'pending_ssh' : 'pending_ip', ready: false, quality: null };
}

async function waitActionMaybe(dc, action) {
  const id = action?.id || action?.action?.id;
  if (id) await cloud.waitHetznerAction(dc, id, 180000);
}

async function rotateProvisioningIp({ dc, serverId, db, telegramId, datacenter }) {
  const provider = cloud.pick(dc);
  if (typeof provider.getHetznerServer !== 'function') throw new Error('HETZNER_RAW_SERVER_UNAVAILABLE');
  const raw = await provider.getHetznerServer(dc, serverId);
  const oldIpId = raw?.public_net?.ipv4?.id;
  const oldIp = raw?.public_net?.ipv4?.ip;
  const location = raw?.datacenter?.location?.name || dc?.HETZNER_LOCATION;
  if (!oldIpId || !oldIp || !location) throw new Error('HETZNER_PRIMARY_IP_METADATA_MISSING');

  let newIp;
  if (db && telegramId != null && datacenter) {
    await rememberIp(db, {
      telegramId,
      datacenter,
      serverId,
      ip: oldIp,
      event: 'provisioning_quality_rejected'
    });
    newIp = await reserveUniquePrimaryIpv4(db, {
      dc,
      telegramId,
      datacenter,
      serverId,
      location,
      oldIp
    });
  } else {
    newIp = await cloud.createPrimaryIpv4(dc, null, location);
  }

  if (!newIp?.id || !newIp?.ip) throw new Error('HETZNER_NEW_IP_CREATE_FAILED');
  let oldUnassigned = false;
  let newAssigned = false;
  try {
    if (!['off','stopped'].includes(String(raw?.status || '').toLowerCase())) await waitActionMaybe(dc, await cloud.powerOffHetznerServer(dc, serverId));
    await waitActionMaybe(dc, await cloud.unassignPrimaryIp(dc, null, oldIpId));
    oldUnassigned = true;
    await waitActionMaybe(dc, await cloud.assignPrimaryIp(dc, null, newIp.id, serverId));
    newAssigned = true;
    await cloud.deletePrimaryIp(dc, null, oldIpId);
    await waitActionMaybe(dc, await cloud.powerOnHetznerServer(dc, serverId));
    if (db && telegramId != null && datacenter) {
      await rememberIp(db, {
        telegramId,
        datacenter,
        serverId,
        ip: newIp.ip,
        event: 'provisioning_candidate_assigned'
      }).catch(() => null);
    }
    return { oldIp, newIp: newIp.ip, newIpId: newIp.id };
  } catch (error) {
    try {
      if (newAssigned) {
        await waitActionMaybe(dc, await cloud.unassignPrimaryIp(dc, null, newIp.id));
        await waitActionMaybe(dc, await cloud.assignPrimaryIp(dc, null, oldIpId, serverId));
      } else if (oldUnassigned) {
        await waitActionMaybe(dc, await cloud.assignPrimaryIp(dc, null, oldIpId, serverId));
      }
      await cloud.deletePrimaryIp(dc, null, newIp.id).catch(() => null);
      await waitActionMaybe(dc, await cloud.powerOnHetznerServer(dc, serverId)).catch(() => null);
    } catch (_) {}
    throw error;
  }
}

async function deletePurchaseServer({ db, dc, telegramId, serverId, datacenter }) {
  if (!isHetznerConfig(dc)) throw new Error('NOT_HETZNER');
  const purchase = await db.getPurchaseForOwner?.(telegramId, serverId, datacenter);
  if (!purchase) { const e = new Error('NOT_FOUND'); e.code = 'NOT_FOUND'; throw e; }
  const previous = purchase.status || 'active';
  await db.markDeletionPending?.(telegramId, serverId, datacenter, previous);
  let providerDeleted = false;
  try {
    try {
      await cloud.deleteServer(dc, null, serverId);
      providerDeleted = true;
    } catch (providerError) {
      if (!isNotFound(providerError)) throw providerError;
      providerDeleted = true;
    }

    const refund = await require('../server-deletion-refund').refundUnusedServerCycle({
      db, telegramId, serverId, datacenter
    });
    await db.markDeleted?.(telegramId, serverId, datacenter);
    return { status: 'deleted', refund };
  } catch (e) {
    if (!providerDeleted) {
      await db.restorePurchaseStatus?.(telegramId, serverId, datacenter, previous);
      e.safeMessage = safeProviderMessage(e);
    } else {
      e.safeMessage = 'سرور حذف شده است اما ثبت نهایی بازگشت اعتبار در حال تکمیل است.';
    }
    throw e;
  }
}

async function reconcileDeletionPending({ db, dc }) {
  const rows = await db.listDeletionPending?.();
  const out = [];
  for (const p of rows || []) {
    try {
      await cloud.getServer(dc, null, p.server_id);
      out.push({ server_id: p.server_id, status: 'manual_review_provider_still_exists' });
    } catch (e) {
      if (isNotFound(e)) {
        try {
          const refund = await require('../server-deletion-refund').refundUnusedServerCycle({
            db,
            telegramId: p.telegram_id,
            serverId: p.server_id,
            datacenter: p.datacenter
          });
          await db.markDeleted?.(p.telegram_id, p.server_id, p.datacenter);
          out.push({ server_id: p.server_id, status: 'deleted', refund });
        } catch (refundError) {
          out.push({ server_id: p.server_id, status: 'refund_retry_failed', reason: refundError.code || refundError.message });
        }
      }
      else out.push({ server_id: p.server_id, status: 'check_failed' });
    }
  }
  return out;
}

async function reconcileProvisioning({ db, resolveDatacenter, timeoutMs = 15000, maxIpRotations = Number(process.env.HETZNER_MAX_IP_QUALITY_ROTATIONS || 3) }) {
  const rows = await db.listPendingProvisioning?.();
  const results = [];
  const deliveryStatuses = new Set(['provisioning','pending_ip','pending_ssh','pending_ip_quality']);
  for (const purchase of rows || []) {
    const dc = resolveDatacenter(purchase.datacenter, purchase);
    if (!dc || !isHetznerConfig(dc)) { results.push({ server_id: purchase.server_id, status: 'missing_datacenter' }); continue; }
    const isDelivery = deliveryStatuses.has(String(purchase.status || '').toLowerCase());
    try {
      if (isDelivery && dc.HETZNER_PASSWORD_ONLY) {
        let stored = null;
        try {
          stored = await db.getServerSecret?.(purchase.server_id, 'root_password');
        } catch (secretError) {
          const secretCode = String(secretError?.code || secretError?.message || 'secret_decrypt_failed');
          const reason = secretCode === 'SERVER_SECRET_KEY_MISSING'
            ? 'secret_key_missing'
            : 'secret_decrypt_failed';
          await db.updateScopedStatus?.(purchase.telegram_id, purchase.server_id, purchase.datacenter, 'manual_review');
          results.push({
            server_id: purchase.server_id,
            telegram_id: purchase.telegram_id,
            datacenter: purchase.datacenter,
            status: 'manual_review',
            reason,
            secret_error: secretCode.slice(0, 80)
          });
          continue;
        }

        // HETZNER_PASSWORD_AUTORECOVERY_V2
        // A missing provider password is recoverable and should not notify the user/admin
        // until the automatic reset + encrypted store + read-back has actually failed.
        if (!stored) {
          try {
            await cloud.getServer(dc, null, purchase.server_id);
            const recoveredPassword = await cloud.resetServerPassword(dc, null, purchase.server_id);
            if (!recoveredPassword) {
              const err = new Error('RESET_PASSWORD_RETURNED_EMPTY');
              err.code = 'RESET_PASSWORD_RETURNED_EMPTY';
              throw err;
            }
            if (typeof db.upsertServerSecret !== 'function') {
              const err = new Error('SERVER_SECRET_STORE_UNAVAILABLE');
              err.code = 'SERVER_SECRET_STORE_UNAVAILABLE';
              throw err;
            }
            await db.upsertServerSecret({
              telegramId: purchase.telegram_id,
              serverId: purchase.server_id,
              datacenter: purchase.datacenter,
              secretType: 'root_password',
              secretValue: recoveredPassword
            });
            const verified = await db.getServerSecret?.(purchase.server_id, 'root_password');
            if (!verified || verified !== recoveredPassword) {
              const err = new Error('SERVER_SECRET_READBACK_MISMATCH');
              err.code = 'SERVER_SECRET_READBACK_MISMATCH';
              throw err;
            }
            stored = verified;
          } catch (recoveryError) {
            const recoveryCode = String(recoveryError?.code || recoveryError?.message || 'password_recovery_failed').slice(0, 100);
            await db.updateScopedStatus?.(purchase.telegram_id, purchase.server_id, purchase.datacenter, 'manual_review');
            results.push({
              server_id: purchase.server_id,
              telegram_id: purchase.telegram_id,
              datacenter: purchase.datacenter,
              status: 'manual_review',
              reason: 'password_recovery_failed',
              recovery_error: recoveryCode
            });
            continue;
          }
        }
      }

      let readiness = await waitForReadiness(dc, purchase.server_id, { timeoutMs });
      if (readiness.quality && db.updateIpQualityResult) {
        await db.updateIpQualityResult(purchase.telegram_id, purchase.server_id, purchase.datacenter, qualitySummary(readiness.quality), false);
      }

      // A Hetzner VM that stays pending_ssh for several minutes must not spin
      // forever. Perform one non-destructive power-cycle per process lifetime,
      // then re-run the full readiness barrier. If SSH is still unavailable,
      // move it to manual_review so billing remains blocked and support can
      // repair/rebuild it deliberately instead of repeatedly rebooting it.
      if (isDelivery && readiness.status === 'pending_ssh') {
        const createdMs = new Date(purchase.created_at || 0).getTime();
        const pendingAgeMs = Number.isFinite(createdMs) && createdMs > 0
          ? Math.max(0, Date.now() - createdMs)
          : 0;
        const recoveryAfterMs = Math.max(
          3 * 60 * 1000,
          Number(process.env.HETZNER_PENDING_SSH_RECOVERY_AFTER_MS || 8 * 60 * 1000)
        );
        const recoveryKey = `${purchase.datacenter}:${purchase.server_id}`;

        if (pendingAgeMs >= recoveryAfterMs && pendingSshRecoveryAttempted.has(recoveryKey)) {
          await db.updateScopedStatus?.(
            purchase.telegram_id,
            purchase.server_id,
            purchase.datacenter,
            'manual_review'
          );
          results.push({
            server_id: purchase.server_id,
            telegram_id: purchase.telegram_id,
            datacenter: purchase.datacenter,
            previous_status: purchase.status,
            status: 'manual_review',
            ready: false,
            ip: readiness.ip || null,
            reason: 'ssh_unstable_after_recovery'
          });
          continue;
        }

        if (pendingAgeMs >= recoveryAfterMs && !pendingSshRecoveryAttempted.has(recoveryKey)) {
          pendingSshRecoveryAttempted.add(recoveryKey);
          try {
            const live = await cloud.getServer(dc, null, purchase.server_id);
            const liveStatus = String(live?.status || live?.state || '').toLowerCase();
            if (liveStatus === 'running') {
              await waitActionMaybe(dc, await cloud.powerOffHetznerServer(dc, purchase.server_id));
            }
            await waitActionMaybe(dc, await cloud.powerOnHetznerServer(dc, purchase.server_id));

            readiness = await waitForReadiness(dc, purchase.server_id, {
              timeoutMs: Math.max(
                30000,
                Number(process.env.HETZNER_PENDING_SSH_RECOVERY_TIMEOUT_MS || 90000)
              )
            });

            if (readiness.quality && db.updateIpQualityResult) {
              await db.updateIpQualityResult(
                purchase.telegram_id,
                purchase.server_id,
                purchase.datacenter,
                qualitySummary(readiness.quality),
                false
              );
            }

            console.log('[HETZNER_PENDING_SSH_RECOVERY]', {
              server_id: String(purchase.server_id),
              status: readiness.status,
              ready: Boolean(readiness.ready),
              ip: readiness.ip || null
            });

            if (readiness.ready) {
              const newlyDelivered = Boolean(await db.markDelivered?.(
                purchase.telegram_id,
                purchase.server_id,
                purchase.datacenter,
                readiness.ip
              ));
              results.push({
                server_id: purchase.server_id,
                telegram_id: purchase.telegram_id,
                datacenter: purchase.datacenter,
                previous_status: purchase.status,
                status: 'active',
                ready: true,
                newly_delivered: newlyDelivered,
                ip: readiness.ip,
                quality: readiness.quality,
                ssh_recovered: true
              });
              continue;
            }

            if (readiness.status === 'pending_ip_quality') {
              await db.updateScopedStatus?.(
                purchase.telegram_id,
                purchase.server_id,
                purchase.datacenter,
                'pending_ip_quality'
              );
              results.push({
                server_id: purchase.server_id,
                telegram_id: purchase.telegram_id,
                datacenter: purchase.datacenter,
                previous_status: purchase.status,
                status: 'pending_ip_quality',
                ready: false,
                ip: readiness.ip || null,
                quality: readiness.quality,
                ssh_recovered: true,
                reason: 'ssh_recovered_quality_pending'
              });
              continue;
            }

            // Before parking an undelivered VM in manual_review, rotate its
            // primary IPv4 once and rerun the full readiness barrier. This
            // prevents a failed SSH delivery from getting stuck forever on the
            // same address after a power-cycle.
            if (readiness.status === 'pending_ssh') {
              try {
                const rotated = await rotateProvisioningIp({
                  dc,
                  serverId: purchase.server_id,
                  db,
                  telegramId: purchase.telegram_id,
                  datacenter: purchase.datacenter
                });
                await db.updatePublicIp?.(
                  purchase.telegram_id,
                  purchase.server_id,
                  purchase.datacenter,
                  rotated.newIp
                );
                await db.updateScopedStatus?.(
                  purchase.telegram_id,
                  purchase.server_id,
                  purchase.datacenter,
                  'pending_ssh'
                );

                readiness = await waitForReadiness(dc, purchase.server_id, {
                  timeoutMs: Math.max(
                    30000,
                    Number(process.env.HETZNER_PENDING_SSH_IP_ROTATION_TIMEOUT_MS || 90000)
                  )
                });

                if (readiness.quality && db.updateIpQualityResult) {
                  await db.updateIpQualityResult(
                    purchase.telegram_id,
                    purchase.server_id,
                    purchase.datacenter,
                    qualitySummary(readiness.quality),
                    false
                  );
                }

                console.log('[HETZNER_PENDING_SSH_IP_ROTATION]', {
                  server_id: String(purchase.server_id),
                  old_ip: rotated.oldIp || null,
                  new_ip: rotated.newIp || null,
                  status: readiness.status,
                  ready: Boolean(readiness.ready)
                });

                if (readiness.ready) {
                  const newlyDelivered = Boolean(await db.markDelivered?.(
                    purchase.telegram_id,
                    purchase.server_id,
                    purchase.datacenter,
                    readiness.ip || rotated.newIp
                  ));
                  results.push({
                    server_id: purchase.server_id,
                    telegram_id: purchase.telegram_id,
                    datacenter: purchase.datacenter,
                    previous_status: purchase.status,
                    status: 'active',
                    ready: true,
                    newly_delivered: newlyDelivered,
                    ip: readiness.ip || rotated.newIp,
                    quality: readiness.quality,
                    ssh_recovered: true,
                    ip_rotated_after_ssh_failure: true
                  });
                  continue;
                }

                if (readiness.status === 'pending_ip_quality') {
                  await db.updateScopedStatus?.(
                    purchase.telegram_id,
                    purchase.server_id,
                    purchase.datacenter,
                    'pending_ip_quality'
                  );
                  results.push({
                    server_id: purchase.server_id,
                    telegram_id: purchase.telegram_id,
                    datacenter: purchase.datacenter,
                    previous_status: purchase.status,
                    status: 'pending_ip_quality',
                    ready: false,
                    ip: readiness.ip || rotated.newIp,
                    quality: readiness.quality,
                    ip_rotated_after_ssh_failure: true,
                    reason: 'ssh_ip_rotated_quality_pending'
                  });
                  continue;
                }
              } catch (rotationError) {
                console.warn('[HETZNER_PENDING_SSH_IP_ROTATION_FAILED]', {
                  server_id: String(purchase.server_id),
                  error: String(rotationError?.message || rotationError).slice(0, 120)
                });
              }
            }

            await db.updateScopedStatus?.(
              purchase.telegram_id,
              purchase.server_id,
              purchase.datacenter,
              'manual_review'
            );
            results.push({
              server_id: purchase.server_id,
              telegram_id: purchase.telegram_id,
              datacenter: purchase.datacenter,
              previous_status: purchase.status,
              status: 'manual_review',
              ready: false,
              ip: readiness.ip || null,
              reason: readiness.status === 'pending_ssh'
                ? 'ssh_unreachable_after_powercycle_and_ip_rotation'
                : 'ssh_unreachable_after_powercycle'
            });
            continue;
          } catch (recoveryError) {
            await db.updateScopedStatus?.(
              purchase.telegram_id,
              purchase.server_id,
              purchase.datacenter,
              'manual_review'
            ).catch(() => null);
            results.push({
              server_id: purchase.server_id,
              telegram_id: purchase.telegram_id,
              datacenter: purchase.datacenter,
              previous_status: purchase.status,
              status: 'manual_review',
              ready: false,
              reason: 'pending_ssh_recovery_failed',
              error: String(recoveryError?.message || recoveryError).slice(0, 120)
            });
            continue;
          }
        }
      }

      // Check-Host is an external signal, not the server itself. If Hetzner is running,
      // IPv4 exists and SSH/22 was reachable, an inconclusive probe must not strand a
      // healthy purchase forever. Keep a grace period for repeated probes, then fail open
      // only for non-definitive quality results. Definitive failures still rotate IPs below.
      const configuredQualityFailOpenMs = Number(process.env.HETZNER_IP_QUALITY_INCONCLUSIVE_FAIL_OPEN_MS || 5 * 60 * 1000);
      const qualityFailOpenMs = Number.isFinite(configuredQualityFailOpenMs)
        ? Math.max(60 * 1000, configuredQualityFailOpenMs)
        : 5 * 60 * 1000;
      const purchaseCreatedMs = new Date(purchase.created_at || purchase.lifecycle_updated_at || 0).getTime();
      const qualityPendingAgeMs = Number.isFinite(purchaseCreatedMs) && purchaseCreatedMs > 0
        ? Math.max(0, Date.now() - purchaseCreatedMs)
        : 0;
      const qualityInconclusiveTimedOut = Boolean(
        isDelivery &&
        readiness.status === 'pending_ip_quality' &&
        readiness.ip &&
        readiness.quality &&
        readiness.quality.definitive === false &&
        qualityPendingAgeMs >= qualityFailOpenMs
      );

      if (qualityInconclusiveTimedOut) {
        const failOpenQuality = {
          ...readiness.quality,
          fail_open: true,
          reason: `${readiness.quality.reason || 'inconclusive'}:fail_open_after_timeout`
        };
        if (db.updateIpQualityResult) {
          await db.updateIpQualityResult(
            purchase.telegram_id,
            purchase.server_id,
            purchase.datacenter,
            qualitySummary(failOpenQuality),
            false
          );
        }
        const newlyDelivered = Boolean(await db.markDelivered?.(
          purchase.telegram_id,
          purchase.server_id,
          purchase.datacenter,
          readiness.ip
        ));
        results.push({
          server_id: purchase.server_id,
          telegram_id: purchase.telegram_id,
          datacenter: purchase.datacenter,
          previous_status: purchase.status,
          status: 'active',
          ready: true,
          newly_delivered: newlyDelivered,
          ip: readiness.ip,
          quality: failOpenQuality,
          quality_fail_open: true
        });
        continue;
      }

      if (readiness.ready) {
        let newlyDelivered = false;
        if (isDelivery) newlyDelivered = Boolean(await db.markDelivered?.(purchase.telegram_id, purchase.server_id, purchase.datacenter, readiness.ip));
        else await db.updateScopedStatus?.(purchase.telegram_id, purchase.server_id, purchase.datacenter, 'active');
        results.push({ server_id: purchase.server_id, telegram_id: purchase.telegram_id, datacenter: purchase.datacenter, previous_status: purchase.status, status: 'active', ready: true, newly_delivered: newlyDelivered, ip: readiness.ip, quality: readiness.quality });
        continue;
      }

      // If a provisioning server exists at Hetzner but lost its primary IPv4
      // during an interrupted/rolled-back rotation, repair it automatically instead
      // of leaving the paid server in pending_ip forever.
      if (isDelivery && readiness.status === 'pending_ip') {
        let repairIp = null;
        let repairAssigned = false;
        try {
          const providerServer = await cloud.getServer(dc, null, purchase.server_id);
          if (!publicIpv4(providerServer)) {
            const location =
              providerServer?.datacenter?.location?.name ||
              providerServer?.location?.name ||
              providerServer?.location ||
              dc?.HETZNER_LOCATION;
            if (!location) throw new Error('HETZNER_MISSING_IP_LOCATION_UNKNOWN');

            repairIp = await cloud.createPrimaryIpv4(dc, null, location);
            if (!repairIp?.id || !repairIp?.ip) throw new Error('HETZNER_MISSING_IP_CREATE_FAILED');

            await waitActionMaybe(dc, await cloud.assignPrimaryIp(dc, null, repairIp.id, purchase.server_id));
            repairAssigned = true;
            await db.updatePublicIp?.(purchase.telegram_id, purchase.server_id, purchase.datacenter, repairIp.ip);

            const providerState = String(providerServer?.status || providerServer?.state || '').toLowerCase();
            if (['off','stopped','shutoff','suspended'].some(state => providerState.includes(state))) {
              await waitActionMaybe(dc, await cloud.powerOnHetznerServer(dc, purchase.server_id));
            }

            await db.updateScopedStatus?.(purchase.telegram_id, purchase.server_id, purchase.datacenter, 'pending_ssh');
            results.push({
              server_id: purchase.server_id,
              telegram_id: purchase.telegram_id,
              datacenter: purchase.datacenter,
              previous_status: purchase.status,
              status: 'pending_ssh',
              ready: false,
              ip: repairIp.ip,
              ip_repaired: true,
              reason: 'missing_primary_ip_repaired'
            });
            continue;
          }
        } catch (repairError) {
          if (repairIp?.id) {
            if (repairAssigned) {
              await waitActionMaybe(dc, await cloud.unassignPrimaryIp(dc, null, repairIp.id)).catch(() => null);
            }
            await cloud.deletePrimaryIp(dc, null, repairIp.id).catch(() => null);
          }
          results.push({
            server_id: purchase.server_id,
            telegram_id: purchase.telegram_id,
            datacenter: purchase.datacenter,
            previous_status: purchase.status,
            status: 'pending_ip',
            ready: false,
            reason: 'missing_primary_ip_repair_failed',
            error: String(repairError?.message || repairError).slice(0, 120)
          });
          continue;
        }
      }

      await db.updateScopedStatus?.(purchase.telegram_id, purchase.server_id, purchase.datacenter, readiness.status);
      if (readiness.status === 'pending_ip_quality' && readiness.quality?.definitive) {
        const attempts = Number(purchase.ip_quality_attempts || 0);
        if (attempts >= maxIpRotations) {
          await db.updateScopedStatus?.(purchase.telegram_id, purchase.server_id, purchase.datacenter, 'manual_review');
          results.push({ server_id: purchase.server_id, telegram_id: purchase.telegram_id, datacenter: purchase.datacenter, status: 'manual_review', reason: 'ip_quality_exhausted', quality: readiness.quality });
          continue;
        }
        await db.updateIpQualityResult?.(purchase.telegram_id, purchase.server_id, purchase.datacenter, qualitySummary(readiness.quality), true);
        try {
          const rotated = await rotateProvisioningIp({
            dc,
            serverId: purchase.server_id,
            db,
            telegramId: purchase.telegram_id,
            datacenter: purchase.datacenter
          });
          await db.updatePublicIp?.(purchase.telegram_id, purchase.server_id, purchase.datacenter, rotated.newIp);
          await db.updateScopedStatus?.(purchase.telegram_id, purchase.server_id, purchase.datacenter, 'pending_ssh');
          results.push({ server_id: purchase.server_id, telegram_id: purchase.telegram_id, datacenter: purchase.datacenter, status: 'pending_ssh', ready: false, ip_rotated: true, quality: readiness.quality });
          continue;
        } catch (rotationError) {
          if (attempts + 1 >= maxIpRotations) await db.updateScopedStatus?.(purchase.telegram_id, purchase.server_id, purchase.datacenter, 'manual_review');
          results.push({ server_id: purchase.server_id, telegram_id: purchase.telegram_id, datacenter: purchase.datacenter, status: attempts + 1 >= maxIpRotations ? 'manual_review' : 'pending_ip_quality', ready: false, reason: 'ip_rotation_failed', error: String(rotationError?.message || rotationError).slice(0, 120) });
          continue;
        }
      }
      results.push({ server_id: purchase.server_id, telegram_id: purchase.telegram_id, datacenter: purchase.datacenter, previous_status: purchase.status, status: readiness.status, ready: false, ip: readiness.ip || null, quality: readiness.quality });
    } catch (error) {
      if (isNotFound(error)) {
        await db.updateScopedStatus?.(purchase.telegram_id, purchase.server_id, purchase.datacenter, 'provider_missing');
        results.push({ server_id: purchase.server_id, telegram_id: purchase.telegram_id, datacenter: purchase.datacenter, status: 'provider_missing', ready: false });
      } else {
        results.push({ server_id: purchase.server_id, telegram_id: purchase.telegram_id, datacenter: purchase.datacenter, status: 'check_failed', ready: false, error: String(error?.message || error).slice(0, 120) });
      }
    }
  }
  return results;
}

async function rebuildServerLifecycle({ db, dc, telegramId, serverId, datacenter, imageId, waitOptions }) {
  return withLock(`rebuild:${datacenter}:${serverId}`, async () => {
    const p = await db.getPurchaseForOwner?.(telegramId, serverId, datacenter);
    if (!p) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
    await db.updateScopedStatus?.(telegramId, serverId, datacenter, 'rebuilding');
    const r = await cloud.rebuildServer(dc, null, serverId, imageId);
    const ready = await waitForReadiness(dc, serverId, { waitActionId: r?.action?.id || r?.id, ...(waitOptions || {}) });
    await db.updatePurchaseOsLabel?.(serverId, imageId);
    await db.updateScopedStatus?.(telegramId, serverId, datacenter, ready.ready ? 'active' : ready.status);
    return { ok: ready.ready, status: ready.status, ip: ready.ip || null, root_password: r?.root_password || null };
  });
}

async function changePublicIpLifecycle({ db, dc, telegramId, serverId, datacenter, provider, waitOptions }) {
  return withLock(`change-ip:${datacenter}:${serverId}`, async () => {
    const p = await db.getPurchaseForOwner?.(telegramId, serverId, datacenter);
    if (!p || !VALID_OPERATION_STATUSES.has(String(p.status))) throw Object.assign(new Error('CONFLICT'), { code: 'CONFLICT' });
    const s = await provider.getServer(serverId);
    const oldIpId = s.primary_ipv4_id;
    const oldIp = s.public_ip;
    const newIp = await provider.createPrimaryIpv4(s.location);
    try {
      await provider.powerOff(serverId);
      await provider.waitAction('poweroff');
      await provider.unassignPrimaryIp(oldIpId);
      await provider.assignPrimaryIp(newIp.id, serverId);
      await provider.deletePrimaryIp(oldIpId, { onlyIfUnassigned: true });
      await provider.powerOn(serverId);
      const ready = await waitForReadiness(dc, serverId, waitOptions || {});
      await db.updatePublicIp?.(telegramId, serverId, datacenter, ready.ip || newIp.ip);
      return { status: ready.ready ? 'active' : ready.status, old_ip: oldIp, new_ip: ready.ip || newIp.ip };
    } catch (e) {
      try {
        await provider.assignPrimaryIp(oldIpId, serverId);
        if (newIp?.id) await provider.deletePrimaryIp(newIp.id, { onlyIfUnassigned: true });
      } catch {
        await db.updateScopedStatus?.(telegramId, serverId, datacenter, 'manual_review');
      }
      throw Object.assign(new Error('CHANGE_IP_FAILED'), { code: 'CHANGE_IP_FAILED' });
    }
  });
}

module.exports = {
  HOURS_IN_CYCLE, NON_BILLABLE_STATUSES, isBillablePurchase, getFlavorCyclePrice, calculateCycleChange,
  architectureForServerType, filterCompatibleImages, filterSellablePlans, markPlanUnavailable,
  isPlanTemporarilyUnavailable, waitForReadiness, checkIpQuality, pingNodeSuccess, selectCheckHostNodes,
  qualitySummary, rotateProvisioningIp, deletePurchaseServer, reconcileDeletionPending, reconcileProvisioning,
  rebuildServerLifecycle, changePublicIpLifecycle, safeProviderMessage, publicIpv4
};
