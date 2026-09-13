#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { applyPatches } = require('../runtime-bootstrap');

const corePath = path.join(__dirname, '..', 'index-core.js');
const source = fs.readFileSync(corePath, 'utf8');
const composed = applyPatches(source);
const paginatedListPath = path.join(__dirname, '..', 'services', 'hetzner-list-all-servers.js');
const paginatedListSource = fs.readFileSync(paginatedListPath, 'utf8');

const statusLabelMarker = '${compactServerStatusIcon(s.status)} ${getServerDisplayNameFromMap(serverDisplayNames, s.datacenter, s.id) || s.purchase?.server_name || s.name}';

const required = [
  "text: '📊 مصرف ترافیک'",
  "text: '🔄 تغییر IP'",
  "text: '🖥 کنسول'",
  "customDisplayName ? '✏️ تغییر نام نمایشی' : '🏷️ نام‌گذاری سرور'",
  "case 'HETZNER_CHANGE_IP_ASK':",
  "case 'HETZNER_CHANGE_IP_CONFIRM':",
  "case 'HETZNER_CHANGE_IP_CANCEL':",
  "case 'HETZNER_TRAFFIC':",
  "case 'HCONSOLE':",
  "case 'RENAME_SERVER':",
  "const isHetzner = dcConfig.provider === 'hetzner' || dcConfig.apiType === 'hetzner';",
  'if (isAfra || isHetzner) return idMatch;',
  'function compactServerStatusIcon(status)',
  'async function listServersForManagement(dcConfig, token)',
  'HETZNER_MANAGEMENT_CACHE_MS',
  'hetznerManagementServerListInFlight',
  "restartableById = new Map(",
  "provider_state_drift",
  "providerStatus = String(providerServer?.status",
  "require('./services/hetzner-list-all-servers')",
  'return listServersForManagement(dcConfig, tok);',
  "return '🟢';",
  "return '🔴';",
  "return '🟡';",
  "return '⚪';",
  statusLabelMarker,
];

for (const marker of required) {
  assert(composed.includes(marker), `missing composed management marker: ${marker}`);
}

const paginationRequired = [
  'async function listAllHetznerServers(dcConfig, options = {})',
  '`/servers?page=${page}&per_page=${perPage}`',
  'data?.meta?.pagination?.next_page',
  'rawById.set(String(server.id), server)',
];
for (const marker of paginationRequired) {
  assert(paginatedListSource.includes(marker), `missing Hetzner pagination marker: ${marker}`);
}

const trafficIndex = composed.indexOf("text: '📊 مصرف ترافیک'");
const changeIpIndex = composed.indexOf("text: '🔄 تغییر IP'");
const consoleIndex = composed.indexOf("text: '🖥 کنسول'");
assert(trafficIndex >= 0 && changeIpIndex > trafficIndex, 'change-IP button must coexist after traffic');
assert(consoleIndex > changeIpIndex, 'console button must coexist after change-IP');

const statusHelperIndex = composed.indexOf('function compactServerStatusIcon(status)');
const statusLabelIndex = composed.indexOf(statusLabelMarker);
assert(statusHelperIndex >= 0, 'compact status helper must exist');
assert(statusLabelIndex > statusHelperIndex, 'management list must use live provider status icon');

new vm.Script(composed, { filename: 'index-core.composed.js' });
new vm.Script(paginatedListSource, { filename: 'hetzner-list-all-servers.js' });

console.log('validate-hetzner-management-buttons: ok');
