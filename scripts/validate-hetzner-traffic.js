#!/usr/bin/env node
'use strict';

const fs = require('fs');
const traffic = require('../hetzner-traffic');
const addons = require('../hetzner-traffic-addons');
const alerts = require('../hetzner-traffic-alerts');
const { applyPatches } = require('../runtime-bootstrap');

function assert(name, ok) {
  if (!ok) {
    console.error('FAIL', name);
    process.exitCode = 1;
  } else {
    console.log('OK', name);
  }
}

assert('valid traffic ranges preserved', ['current', '24h', '7d', '30d'].every(r => traffic.VALID_RANGES.has(r)));
assert('invalid traffic range falls back to current', traffic.selectedTrafficRange('weird') === 'current');
assert('24h metrics window uses network metrics', traffic.buildMetricsPath('123', '24h', new Date('2026-08-09T12:00:00Z')).path.includes('/servers/123/metrics?'));
assert('24h metrics step is 60 seconds', traffic.buildMetricsPath('123', '24h', new Date('2026-08-09T12:00:00Z')).step === 60);
assert('bandwidth integration converts rate over time', traffic.integrateHetznerBandwidthSeries([[0, 100], [60, 100]], 60) === 12000);
assert('metric direction sums matching network series only', traffic.sumHetznerMetricDirection({
  'network.0.bandwidth.in': { values: [[0, 10], [60, 10]] },
  'network.0.bandwidth.out': { values: [[0, 20], [60, 20]] }
}, 'in', 60) === 1200);

const month = traffic.currentHetznerTrafficPeriod(new Date('2026-08-29T12:00:00Z'));
assert('Hetzner traffic month starts on first UTC day', month.start === '2026-08-01T00:00:00.000Z');
assert('Hetzner traffic month resets on next first UTC day', month.reset === '2026-09-01T00:00:00.000Z');

assert('traffic packages are exactly 5/10/20 TB', [5, 10, 20].every(x => addons.ALLOWED_PACKAGE_TB.has(x)) && addons.ALLOWED_PACKAGE_TB.size === 3);
assert('invalid traffic package is rejected', addons.quoteTrafficAddon(1, 7).ok === false);
const sampleQuote = addons.quoteTrafficAddon(1, 5);
assert('valid traffic package produces a positive quote', sampleQuote.ok && sampleQuote.extraBytes === 5_000_000_000_000 && sampleQuote.amountToman > 0);

const twentyTb = 20 * alerts.DECIMAL_TB_BYTES;
assert('quota alert stays silent below 20 TB allowance', alerts.shouldNotifyTrafficQuotaExhausted(twentyTb - 1, twentyTb) === false);
assert('quota alert fires exactly at 20 TB allowance', alerts.shouldNotifyTrafficQuotaExhausted(twentyTb, twentyTb) === true);
assert('quota alert stays active above exhausted allowance', alerts.shouldNotifyTrafficQuotaExhausted(twentyTb + 1, twentyTb) === true);
assert('quota alert ignores missing allowance', alerts.shouldNotifyTrafficQuotaExhausted(1, 0) === false);

const core = fs.readFileSync('index-core.js', 'utf8');
try {
  const patched = applyPatches(core);
  new Function(patched);
  console.log('OK full runtime source parses');
  assert('Hetzner traffic callback restored', patched.includes("case 'HETZNER_TRAFFIC':"));
  assert('Hetzner traffic button restored', patched.includes("text: '📊 مصرف ترافیک'"));
  assert('traffic handler restored', patched.includes('async function handleHetznerTrafficInfo('));
  assert('current/24h/7d/30d controls restored', ['📊 ماه جاری Hetzner', '🕐 ۲۴ ساعت', '📅 ۷ روز', '🗓 ۳۰ روز'].every(x => patched.includes(x)));
  assert('calendar traffic period is explained', patched.includes('شروع دوره ترافیک') && patched.includes('ریست بعدی'));
  assert('purchase cycle separation is explained', patched.includes('مستقل از تاریخ خرید یا تمدید سرور است'));
  assert('buy extra traffic button is present', patched.includes("text: '➕ خرید ترافیک'") && patched.includes("text: '➕ خرید ترافیک اضافه'"));
  assert('buy extra traffic callbacks are present', ["case 'HETZNER_TRAFFIC_BUY':", "case 'HETZNER_TRAFFIC_BUY_QUOTE':", "case 'HETZNER_TRAFFIC_BUY_CONFIRM':"].every(x => patched.includes(x)));
  assert('traffic package confirmation is idempotent', patched.includes('purchaseTrafficAddonAtomic({') && patched.includes('nonce: payload.nonce'));
  assert('prepaid traffic extends automatic billing allowance', patched.includes('customerIncludedBytes') && patched.includes("require('./hetzner-traffic-addons').getTrafficAddonSummary"));
  assert('quota exhausted alert is wired into runtime billing', patched.includes("require('./hetzner-traffic-alerts')") && patched.includes('claimTrafficQuotaExhaustedAlert({'));
  assert('quota alert does not block overage settlement', patched.includes('[HETZNER_TRAFFIC_ALERT_ERROR]') && patched.includes('const trafficSettlement = await settleHetznerTrafficOverage({'));
  assert('console remains active', patched.includes("case 'HCONSOLE':"));
  assert('rename remains active', patched.includes("case 'RENAME_SERVER':"));
  assert('provider visibility remains active', patched.includes('appendSharedNonOpenStackProviders(out, baseDatacenters)'));
} catch (error) {
  console.error('FAIL full runtime traffic patch', error.stack || error.message);
  process.exitCode = 1;
}

process.exit(process.exitCode || 0);
