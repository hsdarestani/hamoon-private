#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const runtime = require('../runtime-bootstrap');

const core = fs.readFileSync(path.join(__dirname, '../index-core.js'), 'utf8');
const composed = runtime.applyPatches(core);

assert(composed.includes('function hetznerArchitectureFromType(value)'), 'upgrade architecture helper missing');
assert(composed.includes("if (type.startsWith('cax')) return 'arm';"), 'CAX must be treated as ARM');
assert(composed.includes("if (/^(cx|cpx|ccx)/.test(type)) return 'x86';"), 'CX/CPX/CCX must be treated as x86');
assert(composed.includes('if (currentFlavor && !sameHetznerArchitecture(currentFlavor, f)) return false;'), 'upgrade menu must filter cross-architecture targets');
assert(composed.includes("providerArchitecture !== targetArchitecture"), 'upgrade confirm must reject cross-architecture target before poweroff');
assert(composed.includes('let poweredOffForUpgrade = false;'), 'upgrade power recovery state missing');
assert(composed.includes("[HETZNER_UPGRADE_RECOVERED_POWER]"), 'upgrade failure power recovery missing');
assert(composed.includes("[HETZNER_UPGRADE_POWER_RECOVERY_FAILED]"), 'upgrade recovery diagnostics missing');
new vm.Script(composed, { filename: 'index-core.composed.js' });

const cleanPath = path.join(__dirname, '../services/hetzner-clean-ip-change.js');
const cleanSource = fs.readFileSync(cleanPath, 'utf8');
assert(cleanSource.includes('HETZNER_CHANGE_IP_INCONCLUSIVE_CANDIDATES'), 'inconclusive candidate budget missing');
assert(cleanSource.includes('[HETZNER_CHANGE_IP_INCONCLUSIVE_RETRY]'), 'inconclusive retry diagnostic missing');
assert(cleanSource.includes('inconclusiveCandidates < maxInconclusiveCandidates'), 'manual Change-IP must retry inconclusive candidates');
assert(cleanSource.includes('continue;'), 'inconclusive retry loop missing');
new vm.Script(cleanSource, { filename: 'hetzner-clean-ip-change.js' });

runtime.applyRuntimeSafetyDefaults();
assert.strictEqual(process.env.HETZNER_CHANGE_IP_INCONCLUSIVE_CANDIDATES, '2');
assert.strictEqual(process.env.HETZNER_CHANGE_IP_CLEAN_ATTEMPTS, '8');

console.log('validate-upgrade-change-ip-fixes: ok');
