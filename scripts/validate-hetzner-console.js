#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { applyPatches } = require('../hetzner-console-bootstrap');

function assert(name, ok) {
  if (!ok) {
    console.error('FAIL', name);
    process.exitCode = 1;
  } else {
    console.log('OK', name);
  }
}

const corePath = path.join(__dirname, '..', 'index-core.js');
const core = fs.readFileSync(corePath, 'utf8');
let patched = '';
try {
  patched = applyPatches(core);
  console.log('OK console patches apply');
} catch (e) {
  console.error('FAIL console patches', e.message);
  process.exit(1);
}

assert('console callback exists', patched.includes("case 'HCONSOLE':"));
assert('console button exists', patched.includes("text: '🖥 کنسول'"));
assert('Hetzner request_console endpoint exists', patched.includes('/actions/request_console'));
assert('ownership check exists', patched.includes("String(purchase.telegram_id) !== String(userId)"));
assert('console credentials are not logged', !/console\.log\([^\n]*(wss_url|wssUrl|password)/i.test(patched));
assert('console message auto deletes', patched.includes('bot.deleteMessage(chatId, sent.message_id)'));
assert('new-link action exists', patched.includes("text: '🔄 ساخت لینک جدید'"));
assert('browser console button exists', patched.includes("text: '🖥 باز کردن کنسول'"));
assert('server-side console session is created', patched.includes('createConsoleSession'));
assert('raw console credentials are not shown', !patched.includes('کپی آدرس کنسول') && !patched.includes('کپی رمز کنسول'));
assert('HTTPS console base URL required', patched.includes('CONSOLE_PUBLIC_BASE_URL_MISSING'));
assert('display name patches still exist', patched.includes("case 'RENAME_SERVER':") && patched.includes('WAIT_SERVER_RENAME'));

try {
  new Function(patched);
  console.log('OK patched production source parses');
} catch (e) {
  console.error('FAIL patched production source syntax', e.message);
  process.exitCode = 1;
}

process.exit(process.exitCode || 0);
