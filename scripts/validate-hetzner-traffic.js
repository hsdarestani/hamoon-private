#!/usr/bin/env node
'use strict';

const fs = require('fs');
const traffic = require('../hetzner-traffic');
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

const core = fs.readFileSync('index-core.js', 'utf8');
try {
  const patched = applyPatches(core);
  new Function(patched);
  console.log('OK full runtime source parses');
  assert('Hetzner traffic callback restored', patched.includes("case 'HETZNER_TRAFFIC':"));
  assert('Hetzner traffic button restored', patched.includes("text: '📊 مصرف ترافیک'"));
  assert('traffic handler restored', patched.includes('async function handleHetznerTrafficInfo('));
  assert('current/24h/7d/30d controls restored', ['📊 دوره جاری', '🕐 ۲۴ ساعت', '📅 ۷ روز', '🗓 ۳۰ روز'].every(x => patched.includes(x)));
  assert('console remains active', patched.includes("case 'HCONSOLE':"));
  assert('rename remains active', patched.includes("case 'RENAME_SERVER':"));
  assert('provider visibility remains active', patched.includes('appendSharedNonOpenStackProviders(out, baseDatacenters)'));
} catch (error) {
  console.error('FAIL full runtime traffic patch', error.stack || error.message);
  process.exitCode = 1;
}

process.exit(process.exitCode || 0);
