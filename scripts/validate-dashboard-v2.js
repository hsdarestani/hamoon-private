'use strict';
const fs = require('fs');

let failed = 0;
function assert(ok, message) {
  if (ok) console.log('OK:', message);
  else { console.error('FAIL:', message); failed += 1; }
}
function read(path) { return fs.readFileSync(path, 'utf8'); }

const required = [
  'public/dashboard/index.html',
  'public/dashboard/app.js',
  'public/dashboard/runtime-fix.js',
  'public/dashboard/dashboard-v2.js',
  'public/dashboard/styles.css',
  'public/dashboard/dashboard-v2.css',
  'dashboard-api.js',
  'db.js',
  'server.js'
];
required.forEach(path => assert(fs.existsSync(path), `${path} exists`));

const index = read('public/dashboard/index.html');
const v2 = read('public/dashboard/dashboard-v2.js');
const css = read('public/dashboard/dashboard-v2.css');
const api = read('dashboard-api.js');
const db = read('db.js');
const server = read('server.js');

assert(index.indexOf('dashboard-v2.css') < index.indexOf('</head>'), 'v2 CSS is loaded in head');
assert(index.indexOf('runtime-fix.js') < index.indexOf('dashboard-v2.js'), 'v2 JS is loaded after runtime hardening');
assert(index.includes('viewport-fit=cover'), 'mobile viewport supports safe areas');
assert(index.includes('aria-live="polite"'), 'toast has live-region accessibility');

['overview','users','servers','wallet','purchases','dcs','logs','tools','apiClients','userDetail','serverDetail','metricDetails'].forEach(name => {
  assert(new RegExp(`\\b${name}\\s*=|function\\s+${name}\\b`).test(v2), `v2 renderer/action ${name} exists`);
});
assert(v2.includes("new Set(['POST', 'PUT', 'PATCH', 'DELETE'])"), 'frontend admin header covers all mutating methods');
assert(v2.includes('AbortController'), 'API calls have timeout/abort protection');
assert(v2.includes('data-label='), 'responsive table cells carry mobile labels');
assert(v2.includes('mobile-nav-open'), 'mobile off-canvas navigation is wired');
assert(v2.includes("event.key === 'Escape'"), 'Escape closes overlays');
assert(v2.includes("key.toLowerCase() === 'k'"), 'Ctrl/Cmd+K quick search is wired');
assert(v2.includes("window.addEventListener('offline'"), 'offline state is surfaced');

assert(css.includes('@media(max-width:980px)'), 'tablet/mobile breakpoint exists');
assert(css.includes('@media(max-width:720px)'), 'phone breakpoint exists');
assert(css.includes('.table-wrap td::before{content:attr(data-label)'), 'tables become labeled mobile cards');
assert(css.includes('.shell.mobile-nav-open aside'), 'mobile sidebar state is styled');
assert(css.includes('max-height:96dvh'), 'mobile modal height is bounded');
assert(css.includes('@media(prefers-reduced-motion:reduce)'), 'reduced-motion accessibility is supported');

assert(/\['POST','PUT','PATCH','DELETE'\]\.includes\(req\.method\)/.test(api), 'backend protects POST/PUT/PATCH/DELETE admin writes');
assert(/SUM\(wallet\).*totalWalletBalance FROM users/.test(db), 'overview total balance uses current user wallets');
assert(db.includes("GROUP BY DATE_FORMAT(${dateField}, '%Y-%m-%d') ORDER BY day"), 'chart dailyStats is ONLY_FULL_GROUP_BY compatible');
assert(/COALESCE\(u\.wallet,\s*wl\.wallet_balance,\s*0\) wallet_balance/.test(db), 'users list prefers current wallet balance');
assert(db.includes("'pending_ip_quality'") && db.includes("'suspended'"), 'overview pending/suspended status coverage is complete');
assert(server.includes("Cache-Control', 'no-store, max-age=0'"), 'dashboard assets are served no-store');

const forbidden = [
  /ADMIN_DASHBOARD_PASSWORD/i,
  /SERVER_SECRET_KEY/i,
  /HAMOON_SERVER_SSH_KEY/i,
  /DB_PASSWORD/i
];
forbidden.forEach(rx => assert(!rx.test(v2 + css + index), `frontend excludes secret marker ${rx}`));

if (failed) {
  console.error(`Dashboard v2 validation failed with ${failed} issue(s).`);
  process.exit(1);
}
console.log('Dashboard v2 validation passed.');
