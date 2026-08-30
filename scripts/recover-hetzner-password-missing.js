'use strict';

require('dotenv').config();
const db = require('../db');
const datacenters = require('../datacenters');
const cloud = require('../cloud-api');

function isHetznerDcKey(key) {
  const dc = datacenters[key];
  if (!dc) return false;
  return String(dc.provider || '').toLowerCase() === 'hetzner' ||
    String(dc.apiType || '').toLowerCase() === 'hetzner' ||
    String(key || '').toLowerCase() === 'hetzner' ||
    String(key || '').toLowerCase().startsWith('hetzner-');
}

async function secretRowExists(serverId) {
  const [rows] = await db.pool.query(
    `SELECT id FROM server_secrets WHERE server_id = ? AND secret_type = 'root_password' LIMIT 1`,
    [String(serverId)]
  );
  return rows.length > 0;
}

async function recoverOne(purchase) {
  const serverId = String(purchase.server_id);
  const dc = datacenters[purchase.datacenter];
  if (!dc || !isHetznerDcKey(purchase.datacenter)) {
    return { server_id: serverId, status: 'skip', reason: 'not_hetzner' };
  }

  const attempts = Number(purchase.ip_quality_attempts || 0);
  const hasRow = await secretRowExists(serverId);

  if (hasRow) {
    try {
      const existing = await db.getServerSecret(serverId, 'root_password');
      if (!existing) return { server_id: serverId, status: 'skip', reason: 'empty_secret' };
      if (attempts > 0) {
        return { server_id: serverId, status: 'skip', reason: 'manual_review_has_ip_quality_history' };
      }
      await db.updateScopedStatus(purchase.telegram_id, serverId, purchase.datacenter, 'provisioning');
      return { server_id: serverId, status: 'requeued', reason: 'existing_secret_verified' };
    } catch (error) {
      return {
        server_id: serverId,
        status: 'skip',
        reason: String(error.code || error.message || 'secret_decrypt_failed').slice(0, 100)
      };
    }
  }

  // Missing secret row: only recover undelivered manual-review servers without prior IP-quality rotations.
  // This is the exact password_missing failure mode and avoids touching intentional IP-quality reviews.
  if (attempts > 0) {
    return { server_id: serverId, status: 'skip', reason: 'missing_secret_but_ip_quality_history_present' };
  }

  try {
    await cloud.getServer(dc, null, serverId);
  } catch (error) {
    return { server_id: serverId, status: 'skip', reason: `provider_lookup_failed:${String(error.message || error).slice(0, 80)}` };
  }

  let password;
  try {
    password = await cloud.resetServerPassword(dc, null, serverId);
  } catch (error) {
    return { server_id: serverId, status: 'skip', reason: `reset_password_failed:${String(error.code || error.message).slice(0, 80)}` };
  }

  if (!password) {
    return { server_id: serverId, status: 'skip', reason: 'reset_password_returned_empty' };
  }

  try {
    await db.upsertServerSecret({
      telegramId: purchase.telegram_id,
      serverId,
      datacenter: purchase.datacenter,
      secretType: 'root_password',
      secretValue: password
    });
  } catch (error) {
    return { server_id: serverId, status: 'skip', reason: `secret_store_failed:${String(error.code || error.message).slice(0, 80)}` };
  }

  // Read-back verification before allowing the reconciler to continue.
  try {
    const verified = await db.getServerSecret(serverId, 'root_password');
    if (!verified || verified !== password) throw new Error('SECRET_READBACK_MISMATCH');
  } catch (error) {
    return { server_id: serverId, status: 'skip', reason: `secret_readback_failed:${String(error.code || error.message).slice(0, 80)}` };
  }

  await db.updateScopedStatus(purchase.telegram_id, serverId, purchase.datacenter, 'provisioning');
  return { server_id: serverId, status: 'recovered', reason: 'password_reset_stored_and_requeued' };
}

(async () => {
  if (!process.env.SERVER_SECRET_KEY) {
    throw new Error('SERVER_SECRET_KEY_MISSING');
  }

  const [rows] = await db.pool.query(`
    SELECT p.*
    FROM purchases p
    WHERE p.status = 'manual_review'
      AND p.delivered_at IS NULL
      AND (LOWER(p.datacenter) = 'hetzner' OR LOWER(p.datacenter) LIKE 'hetzner-%')
    ORDER BY p.created_at DESC
  `);

  const results = [];
  for (const purchase of rows) {
    results.push(await recoverOne(purchase));
  }

  console.log('HETZNER_PASSWORD_RECOVERY_RESULTS=' + JSON.stringify(results));
  const recovered = results.filter(r => r.status === 'recovered' || r.status === 'requeued').length;
  console.log('HETZNER_PASSWORD_RECOVERY_COUNT=' + recovered);
  await db.pool.end();
})().catch(async error => {
  console.error('HETZNER_PASSWORD_RECOVERY_FAILED=' + String(error.code || error.message || error));
  try { await db.pool.end(); } catch (_) {}
  process.exit(1);
});
