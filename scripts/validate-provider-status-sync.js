#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { normalizeProviderStatus } = require('../services/hetzner-status-sync');
const { applyPatches } = require('../runtime-bootstrap');

assert.strictEqual(normalizeProviderStatus('running'), 'active');
assert.strictEqual(normalizeProviderStatus('off'), 'suspended');
assert.strictEqual(normalizeProviderStatus('starting'), 'starting');
assert.strictEqual(normalizeProviderStatus('stopping'), 'stopping');

const core = fs.readFileSync(path.join(__dirname, '..', 'index-core.js'), 'utf8');
const composed = applyPatches(core);
for (const marker of [
  "status: p.provider_status || p.status,",
  "cron.schedule('*/30 * * * *', refreshHetznerProviderStatusSnapshot);",
  'syncHetznerProviderStatuses',
  'provider_status_checked_at'
]) {
  assert(composed.includes(marker) || fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8').includes(marker), 'missing status snapshot marker: ' + marker);
}
new Function(composed);
console.log('validate-provider-status-sync: ok');
