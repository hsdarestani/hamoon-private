#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { applyAdminUnlimitedFreeTestPatches } = require('../admin-free-test-bootstrap');

const core = fs.readFileSync(path.join(__dirname, '../index-core.js'), 'utf8');
const patched = applyAdminUnlimitedFreeTestPatches(core);

assert(patched.includes('getUserActiveTestServers,'), 'active test helper must be imported');
assert(patched.includes('const isSupportAdmin = Boolean(SUPPORT_ID) && String(userId) === String(SUPPORT_ID);'), 'admin/support bypass must be scoped to SUPPORT_ID');
assert(patched.includes('const activeTests = await getUserActiveTestServers(userId);'), 'admin path must guard concurrent active tests');
assert(patched.includes('String(row.datacenter) === String(dcConfig.key)'), 'active guard must be datacenter-scoped');
assert(patched.includes('const hasUsed = await hasUsedFreeTestServer(userId, dcConfig.key);'), 'ordinary-user historical limit must remain');
assert(patched.includes('شما قبلاً از سرور تست رایگان'), 'ordinary-user denial message must remain');
assert(patched.includes('بعد از حذف یا انقضای آن می‌توانید دوباره تست رایگان بسازید'), 'admin concurrent-test message must be present');
assert.strictEqual((patched.match(/const isSupportAdmin =/g) || []).length, 1, 'admin bypass should be installed exactly once');

const patchedTwice = applyAdminUnlimitedFreeTestPatches(patched);
assert.strictEqual(patchedTwice, patched, 'patch must be idempotent');

new vm.Script(patched, { filename: 'index-core.admin-free-test.patched.js' });
console.log('validate-admin-free-test: ok');
