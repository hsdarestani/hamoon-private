#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const runtime = require('../runtime-bootstrap');

runtime.applyRuntimeSafetyDefaults();

assert.strictEqual(
  process.env.HETZNER_CHANGE_IP_CLEAN_ATTEMPTS,
  '10',
  'production manual Change-IP must try up to ten verified candidate cycles'
);
assert.strictEqual(
  process.env.HETZNER_CHANGE_IP_INCONCLUSIVE_CANDIDATES,
  '3',
  'manual Change-IP must stop after three inconclusive candidates'
);

const source = fs.readFileSync(
  path.join(__dirname, '../services/hetzner-clean-ip-change.js'),
  'utf8'
);
assert(source.includes("HETZNER_CHANGE_IP_CLEAN_ATTEMPTS, 4, 1, 12"));
assert(source.includes("HETZNER_CHANGE_IP_INCONCLUSIVE_CANDIDATES,\n    3,"));
assert(source.includes("error.code = 'NO_CLEAN_IPV4_AVAILABLE'"));
assert(source.includes('error.attempts = maxAttempts'));
assert(source.includes('IP قبلی حفظ شد'));
assert(source.includes('هیچ IP سالمی در لوکیشن فعلی پیدا نشد'));
assert(source.includes('rangeRejected: true'), 'definitive Iran failure must mark the IPv4 range as bad');

const baseSource = fs.readFileSync(
  path.join(__dirname, '../services/hetzner-change-ip.js'),
  'utf8'
);
assert(baseSource.includes('hetzner_bad_ipv4_ranges'), 'bad IPv4 range cache table missing');
assert(baseSource.includes('same_or_recently_bad_range'), 'same/bad range fast rejection missing');
assert(baseSource.includes('NO_DIFFERENT_IPV4_RANGE_AVAILABLE'), 'different-range exhaustion guard missing');
assert(baseSource.includes('blockedRanges.add(oldRange)'), 'manual Change-IP must leave the current /24 range');

assert(baseSource.includes('HETZNER_AUDITED_CLEAN_IP_CLAIMED'), 'preverified clean pool preference missing');

console.log('validate-manual-change-ip-cap: ok');
