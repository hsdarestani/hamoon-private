'use strict';

const db = require('../db');

const baseUrl = String(process.env.RESELLER_API_SMOKE_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const telegramId = `api-smoke-${Date.now()}`;
let client = null;
let keyId = null;

async function request(path, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal
    });
    let body = null;
    try { body = await response.json(); } catch (_) {}
    if (response.status !== 200 || !body?.ok) {
      throw new Error(`${path} failed: HTTP ${response.status} ${JSON.stringify(body)}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function cleanup() {
  if (!client) return;
  try {
    if (keyId) await db.revokeApiKey(keyId).catch(() => {});
    await db.updateApiClient(client.id, { isActive: 0 }).catch(() => {});
    if (db.pool?.execute) {
      await db.pool.execute('DELETE FROM api_request_logs WHERE client_id=?', [client.id]).catch(() => {});
      await db.pool.execute('DELETE FROM api_usage_events WHERE client_id=?', [client.id]).catch(() => {});
      await db.pool.execute('DELETE FROM api_keys WHERE client_id=?', [client.id]).catch(() => {});
      await db.pool.execute('DELETE FROM api_clients WHERE id=?', [client.id]).catch(() => {});
      await db.pool.execute('DELETE FROM users WHERE telegram_id=?', [telegramId]).catch(() => {});
    }
  } catch (error) {
    console.warn('[RESELLER_API_SMOKE_CLEANUP_FAILED]', error.message || error);
  }
}

async function main() {
  try {
    client = await db.createApiClient({
      telegramId,
      name: 'Automated reseller API smoke',
      notes: 'Temporary CI smoke client; safe to delete',
      maxServers: 1,
      allowedDatacenters: 'hetzner',
      minWalletBalance: 0,
      isActive: 1
    });
    const key = await db.createApiKey(client.id, 'automated-smoke', 'read');
    const keys = await db.listApiKeys(client.id);
    keyId = keys.find(k => k.key_prefix === key.key_prefix)?.id || null;

    const me = await request('/api/v1/me', key.rawKey);
    if (String(me.client?.id) !== String(client.id)) throw new Error('Authenticated /me returned wrong client');
    console.log('PASS authenticated /api/v1/me');

    const wallet = await request('/api/v1/wallet', key.rawKey);
    if (!wallet.wallet || !Number.isFinite(Number(wallet.wallet.balance))) throw new Error('Wallet payload invalid');
    console.log('PASS authenticated /api/v1/wallet');

    const prices = await request('/api/v1/prices', key.rawKey);
    if (!Array.isArray(prices.plans) || prices.plans.length === 0) throw new Error('No sellable plans returned');
    console.log(`PASS authenticated /api/v1/prices (${prices.plans.length} plans)`);

    const servers = await request('/api/v1/servers', key.rawKey);
    if (!Array.isArray(servers.servers)) throw new Error('Servers payload invalid');
    console.log('PASS authenticated /api/v1/servers');
  } finally {
    await cleanup();
  }
}

main().then(() => process.exit(0)).catch(error => {
  console.error('[RESELLER_API_AUTH_SMOKE_FAILED]', error.message || error);
  process.exit(1);
});
