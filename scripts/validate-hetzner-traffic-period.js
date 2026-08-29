#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const traffic = require('../hetzner-traffic');

const period = traffic.currentHetznerTrafficPeriod(new Date('2026-08-29T17:05:56Z'));
assert.strictEqual(period.basis, 'calendar_month');
assert.strictEqual(period.start, '2026-08-01T00:00:00.000Z');
assert.strictEqual(period.reset, '2026-09-01T00:00:00.000Z');

const source = fs.readFileSync(path.join(__dirname, '../hetzner-traffic-bootstrap.js'), 'utf8');
assert(source.includes('ماه تقویمی جاری Hetzner'));
assert(source.includes('شروع دوره ترافیک'));
assert(source.includes('ریست بعدی'));
assert(source.includes('مستقل از تاریخ خرید یا تمدید سرور است'));
assert(source.includes('ابتدای هر ماه میلادی ریست می‌شود'));

console.log('validate-hetzner-traffic-period: ok');
