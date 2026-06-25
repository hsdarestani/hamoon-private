#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
function read(f){return fs.existsSync(f)?fs.readFileSync(f,'utf8'):''}
function fail(m){throw new Error(m)}
const files = ['index.js','db.js','scheduler.js','dashboard-api.js','openstack-api.js','public/dashboard/app.js'];
const all = files.map(read).join('\n');
if (/purchases\.id\b/i.test(all)) fail('purchases.id reference found');
if ((() => { const m=/async function handleFreeTrialRequest[\s\S]*?async function handleCycleSelection/.exec(read('index.js')); return m && m[0].includes("short('ASK_DELETE')"); })()) fail('undefined short in handleFreeTrialRequest');
if (/handleRebuildAsk\(/.test(read('index.js')) && !/async function handleRebuildAsk/.test(read('index.js'))) fail('handleRebuildAsk ReferenceError risk');
if (!/isBillablePurchaseStatus/.test(read('index.js')) || !/isBillablePurchaseStatus/.test(read('scheduler.js'))) fail('billing does not use isBillablePurchaseStatus');
if (/Math\.random|sampleData|demoData|mock|hardcoded report arrays/i.test(read('public/dashboard/app.js'))) fail('dashboard fake data marker found');
if (/dcTRAFFIC_API_KEY/.test(all)) fail('undefined dcTRAFFIC_API_KEY reference found');
for (const ep of ['/alerts','/alerts/counts','/providers/health','/providers/:dcKey/preflight']) if (!read('dashboard-api.js').includes(ep)) fail(`missing endpoint ${ep}`);
if (!/CREATE TABLE IF NOT EXISTS system_alerts/.test(read('db.js'))) fail('system_alerts migration missing');
if (!/ensureColumn\(connection, 'test_servers', 'status'/.test(read('db.js'))) fail('test_servers compatible migration missing');
console.log('Production patch validation passed.');
