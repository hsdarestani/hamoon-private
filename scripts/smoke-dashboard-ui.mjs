import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const dashboardDir = path.join(root, 'public', 'dashboard');
const json = (res, payload, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
};
const ok = data => ({ ok: true, data });
const now = new Date().toISOString();
const days = Array.from({ length: 30 }, (_, i) => ({ day: new Date(Date.now() - (29 - i) * 86400000).toISOString().slice(0, 10), value: i % 5 === 0 ? 0 : (i + 1) * 1250 }));
const flow = days.map((r, i) => ({ day: r.day, credits: (i + 1) * 800, debits: i % 4 === 0 ? 200 : (i + 1) * 310 }));
const userRows = [
  { telegram_id: '123456789', phone: '*******1234', national_id: '******4321', wallet_balance: 1250000, purchases_count: 3, active_servers: 2, pending_servers: 1, deleted_servers: 0, created_at: now, last_activity_at: now },
  { telegram_id: '987654321', phone: '*******5678', national_id: '******8765', wallet_balance: 440000, purchases_count: 1, active_servers: 1, pending_servers: 0, deleted_servers: 0, created_at: now, last_activity_at: now }
];
const serverRows = [
  { server_name: 'web-prod-01', server_id: 'srv-001', telegram_id: '123456789', phone: '*******1234', datacenter: 'hetzner-finland', datacenter_label: 'Hetzner Finland', provider: 'hetzner', public_ip: '203.0.113.10', ip: '203.0.113.10', status: 'active', os_label: 'Ubuntu 24.04', flavor_id: 'cx22', duration: 'monthly', amount: 499000, password_stored: 1, created_at: now, last_billed_at: now, capabilities: { refresh: true, suspend: true, resume: true, delete: true, setPassword: true, revealPassword: true, resetPassword: true } },
  { server_name: 'worker-02', server_id: 'srv-002', telegram_id: '987654321', phone: '*******5678', datacenter: 'tebyan', datacenter_label: 'Tebyan', provider: 'openstack', public_ip: '203.0.113.20', ip: '203.0.113.20', status: 'pending_ssh', os_label: 'Debian 12', flavor_id: 's2', duration: 'hourly', amount: 12000, password_stored: 0, created_at: now, last_billed_at: null, capabilities: { refresh: true, suspend: true, resume: true, delete: true, setPassword: true, revealPassword: false, resetPassword: false, checkSsh: true } }
];
const walletRows = [
  { id: 1, telegram_id: '123456789', current_balance: 1250000, amount: 500000, type: 'topup', description: 'شارژ کیف پول', timestamp: now },
  { id: 2, telegram_id: '123456789', current_balance: 1250000, amount: -250000, type: 'purchase', description: 'خرید سرور', timestamp: now }
];
const dcs = [
  { key: 'hetzner-finland', name: 'Hetzner Finland', provider: 'hetzner', buyEnabled: true, manageEnabled: true, allowedCycles: ['hourly','daily','weekly','monthly'], trafficSupport: true },
  { key: 'tebyan', name: 'Tebyan', provider: 'openstack', buyEnabled: true, manageEnabled: true, allowedCycles: ['monthly'], trafficSupport: true },
  { key: 'afracloud', name: 'AfraCloud', provider: 'afracloud', buyEnabled: false, manageEnabled: true, allowedCycles: ['monthly'], trafficSupport: false }
];

function route(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  if (p === '/health') return json(res, { ok: true, app: 'dashboard-server', db: 'ok', time: now });
  if (p === '/dashboard' || p === '/dashboard/' || p === '/dashboard/login') {
    let html = fs.readFileSync(path.join(dashboardDir, 'index.html'), 'utf8');
    html = html.replace(/<link[^>]+https:\/\/cdn\.jsdelivr\.net[^>]+>/g, '').replace(/<script[^>]+https:\/\/cdn\.jsdelivr\.net[^>]+><\/script>/g, '');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }
  if (p.startsWith('/dashboard/') && !p.startsWith('/dashboard/api/')) {
    const file = path.join(dashboardDir, p.slice('/dashboard/'.length));
    if (!file.startsWith(dashboardDir) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file);
    const type = ext === '.css' ? 'text/css' : ext === '.js' ? 'application/javascript' : 'text/plain';
    res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(file));
  }
  if (!p.startsWith('/dashboard/api/')) { res.writeHead(404); return res.end('not found'); }
  const api = p.slice('/dashboard/api'.length);
  if (api === '/me') return json(res, ok({ user: 'smoke-admin', configured: true }));
  if (api === '/login') return json(res, ok({ user: 'smoke-admin' }));
  if (api === '/logout') return json(res, ok({ loggedOut: true }));
  if (api === '/overview') return json(res, ok({ totalUsers: 257, approvedTopups: 238, totalWalletBalance: 12500000, activeServers: 131, suspendedServers: 13, deletedServers: 703, totalPurchases: 866, purchasesToday: 6, purchasesThisMonth: 227, revenueToday: 500000, revenueThisMonth: 194876561, revenue30d: 428842461, tebyanServers: 79, hetznerServers: 787, afraServers: 0, openstackServers: 0, failedOperationsLast24h: 0 }));
  if (api === '/charts/revenue' || api === '/charts/purchases') return json(res, ok(days));
  if (api === '/charts/wallet-flow') return json(res, ok(flow));
  if (api === '/charts/servers-by-datacenter') return json(res, ok([{datacenter:'hetzner-finland',status:'active',count:80},{datacenter:'hetzner-finland',status:'deleted',count:15},{datacenter:'tebyan',status:'active',count:42},{datacenter:'tebyan',status:'pending_ssh',count:4}]));
  if (api === '/users') return json(res, { ok: true, page: 1, pageSize: 25, total: userRows.length, rows: userRows });
  if (api === '/servers') return json(res, ok({ page: 1, pageSize: 25, total: serverRows.length, rows: serverRows }));
  if (api === '/wallet/logs') return json(res, ok({ page: 1, pageSize: 25, total: walletRows.length, rows: walletRows }));
  if (api === '/purchases') return json(res, ok({ page: 1, pageSize: 25, total: serverRows.length, rows: serverRows }));
  if (api === '/datacenters') return json(res, ok(dcs));
  if (api === '/logs/server-events') return json(res, ok(['server boot ok', 'billing scheduler ok']));
  if (api === '/logs/audit') return json(res, ok([{ actor:'admin', action:'server_refresh', target_type:'server', target_id:'srv-001', metadata:{result:'ok'}, created_at:now }]));
  if (api === '/api-clients') return json(res, ok([{ id:1, name:'Demo reseller', telegram_id:'123456789', wallet:1250000, active_servers:2, active_keys:1, last_used_at:now, is_active:1 }]));
  if (api === '/hetzner/plans') return json(res, ok([{ id:'cx22', cores:2, memory:4, disk:40, amount_hourly:15000, amount_monthly:490000, available:true }]));
  if (api === '/search') return json(res, ok({ users:userRows.slice(0,1), servers:serverRows.slice(0,1), purchases:serverRows.slice(0,1) }));
  if (/^\/users\/[^/]+$/.test(api)) return json(res, ok({ user:{ telegram_id:'123456789', phone:'09120001234', national_code_masked:'******4321', shahkar_verified:1, wallet:1250000, created_at:now }, wallet_logs:walletRows, servers:serverRows, purchases:serverRows }));
  if (/^\/servers\/[^/]+$/.test(api)) return json(res, ok({ purchase:serverRows[0], user:{ telegram_id:'123456789', phone:'09120001234', wallet:1250000 }, password_stored:true, provider:'hetzner', datacenter_label:'Hetzner Finland', capabilities:serverRows[0].capabilities, wallet_logs:walletRows, audit_logs:[] }));
  if (/^\/metrics\/[^/]+\/details$/.test(api)) return json(res, { ok:true, metric:'users_total', title:'جزئیات', total:2, rowTotal:2, page:1, pageSize:25, columns:[{key:'telegram_id',label:'تلگرام'},{key:'wallet',label:'کیف پول'},{key:'created_at',label:'ایجاد'}], rows:userRows.map(r=>({telegram_id:r.telegram_id,wallet:r.wallet_balance,created_at:r.created_at})) });
  if (/^\/datacenters\/[^/]+\/health$/.test(api)) return json(res, ok({ healthy:true, provider:'mock' }));
  if (/^\/api-clients\/1$/.test(api)) return json(res, ok({ id:1,name:'Demo reseller',telegram_id:'123456789',wallet:1250000,is_active:1 }));
  if (/^\/api-clients\/1\/keys$/.test(api)) return json(res, ok([{ id:1,key_prefix:'hm_live_demo',label:'main',scopes:'servers:read',is_active:1,last_used_at:now,created_at:now }]));
  if (/^\/api-clients\/1\/usage$/.test(api)) return json(res, ok({active_servers:2,monthly_spend:1000000}));
  if (/^\/api-clients\/1\/logs$/.test(api)) return json(res, ok([{method:'GET',path:'/api/v1/me',status_code:200,ip:'127.0.0.1',request_id:'req-1',created_at:now}]));
  if (req.method !== 'GET') return json(res, ok({ updated:true, message:'mock mutation accepted' }));
  return json(res, { ok:false, message:`unmocked endpoint ${api}` }, 404);
}

const server = http.createServer(route);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/dashboard`;
let browser;
let failures = 0;
function check(condition, message) {
  if (condition) console.log('OK:', message);
  else { console.error('FAIL:', message); failures += 1; }
}

async function sectionSmoke(page, section) {
  await page.locator(`nav button[data-s="${section}"]`).click();
  await page.waitForFunction(() => !document.querySelector('#content .skeleton'), null, { timeout: 8000 });
  check(await page.locator('#content .error-box').count() === 0, `${section}: no render error`);
  check((await page.locator('#content').innerText()).trim().length > 10, `${section}: content rendered`);
}

try {
  browser = await chromium.launch({ headless: true });

  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  desktop.on('pageerror', error => consoleErrors.push(error.message));
  await desktop.goto(base, { waitUntil: 'networkidle' });
  await desktop.locator('#app:not(.hidden)').waitFor({ timeout: 8000 });
  await desktop.locator('.kpi-card').first().waitFor();
  check(await desktop.locator('.kpi-card').count() >= 8, 'desktop: KPI grid rendered');
  check(await desktop.locator('.provider-chip').count() >= 4, 'desktop: provider strip rendered');
  check(await desktop.locator('.overview-panels .panel').count() >= 4, 'desktop: overview charts/panels rendered');
  for (const section of ['users','servers','wallet','purchases','datacenters','api','logs','tools','overview']) await sectionSmoke(desktop, section);
  check(consoleErrors.length === 0, `desktop: no uncaught JS errors${consoleErrors.length ? ` (${consoleErrors.join(' | ')})` : ''}`);
  await desktop.close();

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mobileErrors = [];
  mobile.on('pageerror', error => mobileErrors.push(error.message));
  await mobile.goto(base, { waitUntil: 'networkidle' });
  await mobile.locator('#app:not(.hidden)').waitFor({ timeout: 8000 });
  check(await mobile.locator('.mobile-menu-btn').isVisible(), 'mobile: menu button visible');
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 2, `mobile: no page-level horizontal overflow (${overflow}px)`);
  await mobile.locator('.mobile-menu-btn').click();
  check(await mobile.evaluate(() => document.querySelector('#app').classList.contains('mobile-nav-open')), 'mobile: sidebar opens');
  await mobile.locator('nav button[data-s="users"]').click();
  await mobile.waitForFunction(() => !document.querySelector('#content .skeleton'));
  const rowDisplay = await mobile.locator('.table-wrap tbody tr').first().evaluate(el => getComputedStyle(el).display);
  check(rowDisplay === 'block', `mobile: tables render as cards (${rowDisplay})`);
  const firstUserButton = mobile.locator('.table-wrap tbody tr').first().locator('button').filter({ hasText: 'جزئیات' }).first();
  await firstUserButton.click();
  await mobile.locator('#drawer:not(.hidden)').waitFor();
  const drawerWidth = await mobile.locator('#drawer').evaluate(el => el.getBoundingClientRect().width);
  check(drawerWidth <= 391, `mobile: detail drawer fits viewport (${drawerWidth}px)`);
  await mobile.keyboard.press('Escape');
  check(await mobile.locator('#drawer').evaluate(el => el.classList.contains('hidden')), 'mobile: Escape closes drawer');
  await mobile.locator('.table-wrap tbody tr').first().locator('button').filter({ hasText: 'شارژ' }).click();
  await mobile.locator('#modal:not(.hidden)').waitFor();
  const modalWidth = await mobile.locator('.modal-card').evaluate(el => el.getBoundingClientRect().width);
  check(modalWidth <= 390, `mobile: modal fits viewport (${modalWidth}px)`);
  await mobile.keyboard.press('Escape');
  for (const section of ['servers','wallet','purchases','datacenters','api','logs','tools','overview']) {
    await mobile.locator('.mobile-menu-btn').click();
    await sectionSmoke(mobile, section);
    const over = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(over <= 2, `mobile ${section}: no page overflow (${over}px)`);
  }
  check(mobileErrors.length === 0, `mobile: no uncaught JS errors${mobileErrors.length ? ` (${mobileErrors.join(' | ')})` : ''}`);
  await mobile.close();
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}

if (failures) {
  console.error(`Dashboard UI smoke failed with ${failures} issue(s).`);
  process.exit(1);
}
console.log('Dashboard desktop + mobile UI smoke passed.');
