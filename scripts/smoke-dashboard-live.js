'use strict';
require('dotenv').config();

const base = process.env.DASHBOARD_SMOKE_BASE_URL || `http://127.0.0.1:${Number(process.env.DASHBOARD_PORT || process.env.PORT || 3000)}`;
const user = process.env.ADMIN_DASHBOARD_USER;
const password = process.env.ADMIN_DASHBOARD_PASSWORD;
if (!user || !password) {
  console.error('SMOKE FAIL: ADMIN_DASHBOARD_USER/PASSWORD are not configured.');
  process.exit(1);
}

let cookie = '';
let failed = 0;
function ok(message) { console.log('OK:', message); }
function fail(message) { console.error('FAIL:', message); failed += 1; }

async function raw(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (['POST','PUT','PATCH','DELETE'].includes(method)) headers['X-Admin-Action'] = 'true';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    return await fetch(base + path, { ...options, method, headers, signal: controller.signal });
  } finally { clearTimeout(timer); }
}

async function json(path, options = {}) {
  const response = await raw(path, options);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`${path}: invalid JSON (${response.status})`); }
  if (!response.ok || body.ok === false) throw new Error(`${path}: ${response.status} ${body.message || body.error || text.slice(0,160)}`);
  return body.data === undefined ? body : body.data;
}

async function check(path, validator = () => true) {
  try {
    const data = await json(path);
    if (!validator(data)) throw new Error('unexpected response shape');
    ok(path);
    return data;
  } catch (error) {
    fail(`${path} — ${error.message}`);
    return null;
  }
}

(async () => {
  try {
    const loginResponse = await raw('/dashboard/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: user, password })
    });
    const loginText = await loginResponse.text();
    let loginBody = {};
    try { loginBody = JSON.parse(loginText); } catch {}
    if (!loginResponse.ok || loginBody.ok === false) throw new Error(loginBody.message || `HTTP ${loginResponse.status}`);
    const setCookie = loginResponse.headers.get('set-cookie') || '';
    cookie = setCookie.split(';')[0];
    if (!cookie.includes('hamoon_admin_session=')) throw new Error('admin session cookie was not returned');
    ok('admin login');

    await check('/health', d => d && d.ok === true && typeof d.db === 'string');
    await check('/dashboard/api/me', d => d && d.user);
    const overview = await check('/dashboard/api/overview', d => d && Number.isFinite(Number(d.totalUsers)));
    await check('/dashboard/api/charts/revenue?days=30', d => Array.isArray(d) && d.length > 0);
    await check('/dashboard/api/charts/purchases?days=30', d => Array.isArray(d) && d.length > 0);
    await check('/dashboard/api/charts/wallet-flow?days=30', d => Array.isArray(d) && d.length > 0);
    await check('/dashboard/api/charts/servers-by-datacenter', d => Array.isArray(d));

    const users = await check('/dashboard/api/users?page=1&pageSize=3', d => d && Array.isArray(d.rows));
    const servers = await check('/dashboard/api/servers?page=1&pageSize=3', d => d && Array.isArray(d.rows));
    await check('/dashboard/api/wallet/logs?page=1&pageSize=3', d => d && Array.isArray(d.rows));
    await check('/dashboard/api/purchases?page=1&pageSize=3', d => d && Array.isArray(d.rows));
    await check('/dashboard/api/datacenters', d => Array.isArray(d));
    await check('/dashboard/api/logs/server-events?limit=5', d => Array.isArray(d));
    await check('/dashboard/api/logs/audit?limit=5', d => Array.isArray(d));
    await check('/dashboard/api/api-clients', d => Array.isArray(d));
    await check('/dashboard/api/hetzner/plans', d => Array.isArray(d));

    if (users?.rows?.[0]?.telegram_id) {
      await check('/dashboard/api/users/' + encodeURIComponent(users.rows[0].telegram_id), d => d && d.user && Array.isArray(d.servers));
    } else ok('user detail skipped — no user row');

    if (servers?.rows?.[0]?.server_id) {
      await check('/dashboard/api/servers/' + encodeURIComponent(servers.rows[0].server_id), d => d && d.purchase);
    } else ok('server detail skipped — no server row');

    try {
      const exportResponse = await raw('/dashboard/api/export/users.csv?limit=3');
      const exportText = await exportResponse.text();
      if (!exportResponse.ok || !/text\/csv/i.test(exportResponse.headers.get('content-type') || '') || !exportText.trim()) throw new Error(`HTTP ${exportResponse.status}`);
      ok('CSV export');
    } catch (error) { fail(`CSV export — ${error.message}`); }

    if (overview && Number(overview.totalUsers) < 0) fail('overview totalUsers is negative');

    try {
      await json('/dashboard/api/logout', { method: 'POST', body: '{}' });
      ok('admin logout');
    } catch (error) { fail(`admin logout — ${error.message}`); }
  } catch (error) {
    fail(`setup — ${error.message}`);
  }

  if (failed) {
    console.error(`Dashboard live smoke failed with ${failed} issue(s).`);
    process.exit(1);
  }
  console.log('Dashboard live smoke passed.');
})().catch(error => { console.error(error); process.exit(1); });
