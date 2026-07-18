#!/usr/bin/env node
const fs = require('fs');
function read(p){return fs.existsSync(p)?fs.readFileSync(p,'utf8'):''}
function assert(name, ok){ if(!ok){ console.error('FAIL', name); process.exitCode=1; } else console.log('OK', name); }
const index = read('index.js');
const all = ['index.js','db.js','scheduler.js','dashboard-api.js','openstack-api.js','datacenters.js','billing-utils.js'].map(read).join('\n');
assert('no purchases.id references', !/purchases\.id/.test(all) && !/purchases\s+p[\s\S]{0,80}p\.id\b/.test(all));
assert('no dcTRAFFIC_API_KEY references', !/dcTRAFFIC_API_KEY/.test(all));
const free = index.split('async function handleFreeTrialRequest')[1]?.split('async function handleCycleSelection')[0]||'';
assert('no undefined short in handleFreeTrialRequest', !/short\('ASK_DELETE'\)/.test(free));
assert('no handleRebuildAsk ReferenceError pattern', !/handleRebuildAsk is not defined/.test(all));
assert('Tebyan direct image boot', /forceImageBoot[\s\S]{0,120}serverDetails\.imageRef = imageRef/.test(read('openstack-api.js')));
assert('cloud-init root password login', /ssh_pwauth: true/.test(index) && /disable_root: false/.test(index) && /PermitRootLogin yes/.test(index) && /PasswordAuthentication yes/.test(index) && /name: root/.test(index));
assert('billing eligibility guard exists', /function\s+isBillingEligiblePurchase\s*\(/.test(index) && /if\s*\(\s*!isBillingEligiblePurchase\(purchase\)\s*\)\s*continue/.test(index));
assert('traffic test script exists', fs.existsSync('scripts/test-traffic-api.js'));
assert('dashboard search endpoints exist', /router\.get\('\/servers'/.test(read('dashboard-api.js')) && /router\.get\('\/users'/.test(read('dashboard-api.js')));
assert('dashboard billing traffic endpoints exist', /\/servers\/:serverId\/billing/.test(read('dashboard-api.js')) && /traffic-health/.test(read('dashboard-api.js')));
assert('dashboard frontend no Math.random/mock/demo', !/Math\.random|mock data|demo data/i.test(read('public/dashboard/app.js')+read('public/dashboard/index.html')));
assert('price label helper exists and used', /formatBillingAmountLabel/.test(all));
process.exit(process.exitCode||0);
