'use strict';

const cloud = require('../cloud-api');

const PENDING_STATUSES = new Set([
  'provisioning',
  'pending_ip',
  'pending_ssh',
  'pending_ip_quality',
  'manual_review'
]);

const MIGRATION_TABLES = [
  'api_usage_events',
  'billing_events',
  'hetzner_additional_ip_billing',
  'hetzner_traffic_addons',
  'hetzner_traffic_alerts',
  'hetzner_traffic_billing',
  'key_pairs',
  'server_display_names',
  'server_ip_history',
  'test_servers'
];

function normalizeLocation(value) {
  return String(value?.name || value || '').trim().toLowerCase();
}

function providerLocation(server, dc = {}) {
  return normalizeLocation(
    server?.datacenter?.location?.name ||
    server?.location?.name ||
    server?.location ||
    dc?.HETZNER_LOCATION ||
    dc?.location ||
    ''
  );
}

function buildForcedLocationDc(dc = {}, targetLocation = 'fsn1') {
  const target = normalizeLocation(targetLocation || 'fsn1') || 'fsn1';
  return {
    ...dc,
    HETZNER_LOCATION: target,
    HETZNER_LOCATION_FALLBACKS: target,
    location: target
  };
}

function shouldRelocateToFsn({ result, purchase, threshold = 2 } = {}) {
  if (!result?.server_id || !purchase) return false;
  if (String(result.datacenter || purchase.datacenter || '') !== 'hetzner') return false;
  if (result.ready === true || purchase.delivered_at) return false;
  if (!PENDING_STATUSES.has(String(purchase.status || result.status || '').toLowerCase())) return false;
  const attempts = Number(purchase.ip_quality_attempts || 0);
  return Number.isFinite(attempts) && attempts >= Math.max(1, Number(threshold || 2));
}

function cloudInitForPasswordLogin() {
  return `#cloud-config
ssh_pwauth: true
disable_root: false
write_files:
  - path: /etc/ssh/sshd_config.d/99-hamoon.conf
    permissions: '0644'
    content: |
      PasswordAuthentication yes
      PermitRootLogin yes
runcmd:
  - systemctl reload ssh || systemctl restart ssh
`;
}

async function existingMigrationTables(conn) {
  if (!MIGRATION_TABLES.length) return [];
  const placeholders = MIGRATION_TABLES.map(() => '?').join(',');
  const [rows] = await conn.query(
    `SELECT TABLE_NAME
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN (${placeholders})`,
    MIGRATION_TABLES
  );
  const found = new Set((rows || []).map(row => String(row.TABLE_NAME)));
  return MIGRATION_TABLES.filter(name => found.has(name));
}

async function migrateServerIdAtomic({
  db,
  telegramId,
  datacenter,
  oldServerId,
  newServerId,
  newIp,
  qualitySummary
}) {
  if (!db?.pool?.getConnection) {
    throw Object.assign(new Error('DB_POOL_UNAVAILABLE'), { code: 'DB_POOL_UNAVAILABLE' });
  }
  const conn = await db.pool.getConnection();
  try {
    await conn.beginTransaction();
    const [lockedRows] = await conn.query(
      `SELECT server_id, status, delivered_at, boot_volume_id
         FROM purchases
        WHERE telegram_id = ? AND server_id = ? AND datacenter = ?
        LIMIT 1 FOR UPDATE`,
      [String(telegramId), String(oldServerId), String(datacenter)]
    );
    const locked = lockedRows?.[0];
    if (!locked) throw Object.assign(new Error('PURCHASE_NOT_FOUND'), { code: 'PURCHASE_NOT_FOUND' });
    if (locked.delivered_at) {
      throw Object.assign(new Error('PURCHASE_ALREADY_DELIVERED'), { code: 'PURCHASE_ALREADY_DELIVERED' });
    }
    if (!PENDING_STATUSES.has(String(locked.status || '').toLowerCase())) {
      throw Object.assign(new Error('PURCHASE_NOT_PENDING'), { code: 'PURCHASE_NOT_PENDING' });
    }

    const tables = await existingMigrationTables(conn);
    for (const table of tables) {
      await conn.query(
        `UPDATE \`${table}\` SET server_id = ? WHERE server_id = ?`,
        [String(newServerId), String(oldServerId)]
      );
    }

    // A console session belongs to the old VM process and must never be carried
    // across to the replacement VM.
    const [consoleTable] = await conn.query(
      `SELECT 1 FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'console_sessions' LIMIT 1`
    );
    if (consoleTable?.length) {
      await conn.query('DELETE FROM console_sessions WHERE server_id = ?', [String(oldServerId)]);
    }

    const [purchaseUpdate] = await conn.query(
      `UPDATE purchases
          SET server_id = ?,
              boot_volume_id = CASE WHEN boot_volume_id = ? THEN ? ELSE boot_volume_id END,
              public_ip = ?,
              provider_action_id = NULL,
              provider_status = 'active',
              provider_status_checked_at = NOW(),
              status = 'active',
              delivered_at = NOW(),
              ip_quality_summary = ?,
              ip_quality_checked_at = NOW(),
              lifecycle_error_code = NULL,
              lifecycle_updated_at = NOW(),
              updated_at = NOW()
        WHERE telegram_id = ? AND server_id = ? AND datacenter = ? AND delivered_at IS NULL`,
      [
        String(newServerId),
        String(oldServerId),
        String(newServerId),
        String(newIp),
        String(qualitySummary || '').slice(0, 255) || null,
        String(telegramId),
        String(oldServerId),
        String(datacenter)
      ]
    );
    if (purchaseUpdate.affectedRows !== 1) {
      throw Object.assign(new Error('PURCHASE_MIGRATION_CONFLICT'), { code: 'PURCHASE_MIGRATION_CONFLICT' });
    }

    // The replacement password has already been stored under newServerId.
    await conn.query(
      `DELETE FROM server_secrets WHERE server_id = ? AND secret_type = 'root_password'`,
      [String(oldServerId)]
    );

    await conn.commit();
    return true;
  } catch (error) {
    await conn.rollback().catch(() => null);
    throw error;
  } finally {
    conn.release();
  }
}

async function deleteCandidateSecret(db, serverId) {
  if (!db?.pool?.query || !serverId) return;
  await db.pool.query(
    `DELETE FROM server_secrets WHERE server_id = ? AND secret_type = 'root_password'`,
    [String(serverId)]
  ).catch(() => null);
}

async function safeDeleteServer(dc, serverId) {
  if (!serverId) return false;
  try {
    await cloud.deleteServer(dc, null, serverId);
    return true;
  } catch (error) {
    const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
    if (status === 404) return true;
    console.warn('[HETZNER_LOCATION_FALLBACK_DELETE_FAILED]', {
      server_id: String(serverId),
      message: String(error?.message || error).slice(0, 120)
    });
    return false;
  }
}

async function ensureCandidatePassword({ db, purchase, candidate, dc }) {
  let password = candidate?.root_password || null;
  if (!password) password = await cloud.resetServerPassword(dc, null, candidate.id);
  if (!password) {
    throw Object.assign(new Error('REPLACEMENT_PASSWORD_MISSING'), { code: 'REPLACEMENT_PASSWORD_MISSING' });
  }

  if (typeof db?.upsertServerSecret !== 'function' || typeof db?.getServerSecret !== 'function') {
    throw Object.assign(new Error('SERVER_SECRET_STORE_UNAVAILABLE'), { code: 'SERVER_SECRET_STORE_UNAVAILABLE' });
  }
  await db.upsertServerSecret({
    telegramId: purchase.telegram_id,
    serverId: String(candidate.id),
    datacenter: purchase.datacenter,
    secretType: 'root_password',
    secretValue: password
  });
  const verified = await db.getServerSecret(String(candidate.id), 'root_password');
  if (!verified || verified !== password) {
    throw Object.assign(new Error('SERVER_SECRET_READBACK_MISMATCH'), { code: 'SERVER_SECRET_READBACK_MISMATCH' });
  }
  return password;
}

async function relocatePendingPurchase({
  db,
  dc,
  lifecycle,
  purchase,
  targetLocation = process.env.HETZNER_GERMANY_LOCATION_FALLBACK_TARGET || 'fsn1',
  maxCandidates = Number(process.env.HETZNER_FSN_LOCATION_FALLBACK_CANDIDATES || 3),
  timeoutMs = Number(process.env.HETZNER_LOCATION_FALLBACK_READY_TIMEOUT_MS || 150000)
}) {
  if (!db || !dc || !lifecycle || !purchase) throw new Error('LOCATION_FALLBACK_ARGUMENTS_MISSING');
  const oldServerId = String(purchase.server_id);
  const telegramId = String(purchase.telegram_id);
  const datacenter = String(purchase.datacenter);
  if (datacenter !== 'hetzner' || purchase.delivered_at) {
    return { skipped: true, reason: 'not_eligible' };
  }

  const provider = cloud.pick(dc);
  const rawOld = typeof provider.getHetznerServer === 'function'
    ? await provider.getHetznerServer(dc, oldServerId)
    : await cloud.getServer(dc, null, oldServerId);
  const fromLocation = providerLocation(rawOld, dc);
  const target = normalizeLocation(targetLocation || 'fsn1') || 'fsn1';
  if (fromLocation === target) return { skipped: true, reason: 'already_target_location' };
  if (fromLocation && fromLocation !== 'nbg1') {
    return { skipped: true, reason: `source_location_${fromLocation}` };
  }

  const serverType = String(rawOld?.server_type?.name || rawOld?.server_type || purchase.flavor_id || '').trim().toLowerCase();
  const image = rawOld?.image?.id || rawOld?.image?.name || null;
  if (!serverType || !image) {
    throw Object.assign(new Error('REPLACEMENT_METADATA_MISSING'), { code: 'REPLACEMENT_METADATA_MISSING' });
  }

  const targetDc = buildForcedLocationDc(dc, target);
  const tries = Math.max(1, Math.min(5, Number(maxCandidates || 3)));
  let lastFailure = null;

  for (let attempt = 1; attempt <= tries; attempt += 1) {
    let candidate = null;
    try {
      const suffix = `${Date.now().toString(36)}-${attempt}`;
      const tempName = `${String(purchase.server_name || 'Srv-HET').slice(0, 48)}-fsn-${suffix}`.slice(0, 63);
      candidate = await cloud.createServer(targetDc, null, {
        name: tempName,
        serverType,
        image,
        location: target,
        key_id: purchase.ssh_key_id || null,
        userLabel: telegramId,
        user_data: cloudInitForPasswordLogin()
      });
      if (!candidate?.id) {
        throw Object.assign(new Error('REPLACEMENT_CREATE_NO_ID'), { code: 'REPLACEMENT_CREATE_NO_ID' });
      }

      const readiness = await lifecycle.waitForReadiness(targetDc, String(candidate.id), {
        waitActionId: candidate?.action?.id || candidate?.action_id || null,
        timeoutMs: Math.max(60000, Number(timeoutMs || 150000)),
        requireIpQuality: true
      });

      if (!readiness?.ready || !readiness?.quality?.ok) {
        lastFailure = {
          code: 'REPLACEMENT_QUALITY_REJECTED',
          status: readiness?.status || null,
          ip: readiness?.ip || null,
          quality: readiness?.quality || null
        };
        console.warn('[HETZNER_LOCATION_FALLBACK_CANDIDATE_REJECTED]', {
          old_server_id: oldServerId,
          candidate_server_id: String(candidate.id),
          attempt,
          ip: readiness?.ip || null,
          quality: readiness?.quality ? lifecycle.qualitySummary(readiness.quality) : null
        });
        await safeDeleteServer(targetDc, candidate.id);
        await deleteCandidateSecret(db, candidate.id);
        continue;
      }

      await ensureCandidatePassword({ db, purchase, candidate, dc: targetDc });
      const summary = lifecycle.qualitySummary(readiness.quality);

      await migrateServerIdAtomic({
        db,
        telegramId,
        datacenter,
        oldServerId,
        newServerId: String(candidate.id),
        newIp: readiness.ip,
        qualitySummary: summary
      });

      // The DB switch is the commit point. Cleanup failures must not roll the
      // customer back to a dirty NBG VM after a verified FSN VM is delivered.
      const oldDeleted = await safeDeleteServer(dc, oldServerId);
      try {
        if (typeof provider.hetznerRequest === 'function') {
          await provider.hetznerRequest(targetDc, 'PUT', `/servers/${candidate.id}`, {
            name: String(purchase.server_name || tempName).slice(0, 63)
          });
        }
      } catch (renameError) {
        console.warn('[HETZNER_LOCATION_FALLBACK_RENAME_FAILED]', {
          server_id: String(candidate.id),
          message: String(renameError?.message || renameError).slice(0, 120)
        });
      }

      console.log('[HETZNER_LOCATION_FALLBACK_COMMITTED]', {
        user_id: telegramId,
        old_server_id: oldServerId,
        new_server_id: String(candidate.id),
        from_location: fromLocation || 'nbg1',
        to_location: target,
        ip: readiness.ip,
        old_deleted: oldDeleted,
        quality: summary
      });

      return {
        server_id: String(candidate.id),
        old_server_id: oldServerId,
        telegram_id: telegramId,
        datacenter,
        previous_status: purchase.status,
        status: 'active',
        ready: true,
        newly_delivered: true,
        ip: readiness.ip,
        quality: readiness.quality,
        location_fallback: true,
        from_location: fromLocation || 'nbg1',
        to_location: target,
        old_server_deleted: oldDeleted
      };
    } catch (error) {
      lastFailure = {
        code: error?.code || 'LOCATION_FALLBACK_FAILED',
        message: String(error?.message || error).slice(0, 160)
      };
      console.warn('[HETZNER_LOCATION_FALLBACK_ATTEMPT_FAILED]', {
        old_server_id: oldServerId,
        candidate_server_id: candidate?.id ? String(candidate.id) : null,
        attempt,
        code: error?.code || null,
        message: String(error?.message || error).slice(0, 120)
      });
      if (candidate?.id) {
        await safeDeleteServer(targetDc, candidate.id);
        await deleteCandidateSecret(db, candidate.id);
      }
    }
  }

  await db.updateScopedStatus?.(telegramId, oldServerId, datacenter, 'manual_review').catch(() => null);
  return {
    server_id: oldServerId,
    telegram_id: telegramId,
    datacenter,
    status: 'manual_review',
    ready: false,
    reason: 'fsn_location_fallback_exhausted',
    error: lastFailure?.message || lastFailure?.code || null,
    location_fallback: true,
    from_location: fromLocation || 'nbg1',
    to_location: target
  };
}

module.exports = {
  PENDING_STATUSES,
  MIGRATION_TABLES,
  normalizeLocation,
  providerLocation,
  buildForcedLocationDc,
  shouldRelocateToFsn,
  migrateServerIdAtomic,
  relocatePendingPurchase
};
