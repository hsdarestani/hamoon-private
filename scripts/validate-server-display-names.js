#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { applyPatches } = require('../server-display-names-bootstrap');

function assert(name, ok) {
  if (!ok) {
    console.error('FAIL', name);
    process.exitCode = 1;
  } else {
    console.log('OK', name);
  }
}

const corePath = path.join(__dirname, '..', 'index-core.js');
assert('index-core.js exists', fs.existsSync(corePath));
if (!fs.existsSync(corePath)) process.exit(1);

const original = fs.readFileSync(corePath, 'utf8');
let patched = '';
try {
  patched = applyPatches(original);
  console.log('OK source patches apply exactly once');
} catch (err) {
  console.error('FAIL source patches', err.message);
  process.exit(1);
}

assert('rename callback exists', patched.includes("case 'RENAME_SERVER':"));
assert('clear-name callback exists', patched.includes("case 'CLEAR_SERVER_NAME':"));
assert('rename text state exists', patched.includes("WAIT_SERVER_RENAME"));
assert('management view uses display name', patched.includes('escapeMarkdownV2(shownName)'));
assert('regular list uses aliases', patched.includes('getServerDisplayNameFromMap(serverDisplayNames, s.datacenter, s.id)'));
assert('project list uses aliases', patched.includes('getServerDisplayNameFromMap(serverDisplayNames, dc.key, s.id)'));
assert('delete clears alias', patched.includes('clearServerDisplayName(userId, serverId, dcConfig.key)'));

try {
  // Parse only; do not execute the bot or connect to providers/database.
  new Function(patched);
  console.log('OK patched index parses');
} catch (err) {
  console.error('FAIL patched index syntax', err.message);
  process.exitCode = 1;
}

process.exit(process.exitCode || 0);
