#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const runtime = require('../runtime-bootstrap');

runtime.applyRuntimeSafetyDefaults();

assert.strictEqual(
  process.env.HETZNER_CHANGE_IP_CLEAN_ATTEMPTS,
  '8',
  'manual Change-IP must try up to eight verified candidate cycles'
);
assert.strictEqual(
  process.env.HETZNER_CHANGE_IP_INCONCLUSIVE_CANDIDATES,
  '2',
  'manual Change-IP must stop after two inconclusive candidates'
);

const source = fs.readFileSync(
  path.join(__dirname, '../services/hetzner-clean-ip-change.js'),
  'utf8'
);
assert(source.includes("HETZNER_CHANGE_IP_CLEAN_ATTEMPTS, 8, 1, 8"));
assert(source.includes("HETZNER_CHANGE_IP_INCONCLUSIVE_CANDIDATES,\n    2,"));
assert(source.includes("error.code = 'NO_CLEAN_IPV4_AVAILABLE'"));
assert(source.includes('error.attempts = maxAttempts'));
assert(source.includes('IP قبلی حفظ شد'));
assert(source.includes('هیچ IP سالمی در لوکیشن فعلی پیدا نشد'));

console.log('validate-manual-change-ip-cap: ok');
