#!/usr/bin/env node
'use strict';

const { Client } = require('ssh2');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += String(chunk);
  if (input.length > 1024 * 1024) {
    process.stderr.write('input_too_large\n');
    process.exit(2);
  }
});
process.stdin.on('end', () => {
  let payload;
  try {
    payload = JSON.parse(input || '{}');
  } catch (_) {
    process.stdout.write(JSON.stringify({ ok: false, code: 'SSH_HELPER_FAILED', message: 'invalid_input' }) + '\n');
    process.exit(2);
    return;
  }

  const host = String(payload.host || '').trim();
  const password = String(payload.password || '');
  const command = String(payload.command || '');
  const timeoutMs = Math.max(1500, Number(payload.timeoutMs) || 30000);
  if (!host || !password || !command) {
    process.stdout.write(JSON.stringify({ ok: false, code: 'SSH_HELPER_FAILED', message: 'missing_input' }) + '\n');
    process.exit(2);
    return;
  }

  const conn = new Client();
  let settled = false;
  let timer = null;

  const finish = (ok, code, message) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    try { conn.end(); } catch (_) {}
    try { conn.destroy(); } catch (_) {}
    process.stdout.write(JSON.stringify({
      ok: !!ok,
      code: code || null,
      message: String(message || '').slice(0, 200)
    }) + '\n');
    process.exitCode = ok ? 0 : 1;
    setTimeout(() => process.exit(process.exitCode || 0), 10).unref();
  };

  timer = setTimeout(() => finish(false, 'SSH_TIMEOUT', 'hard_timeout'), timeoutMs);

  conn.on('ready', () => {
    conn.exec(command, (error, stream) => {
      if (error) return finish(false, 'SSH_COMMAND_FAILED', error.message);
      let stderr = '';
      stream.stderr?.on('data', chunk => {
        stderr += String(chunk);
        if (stderr.length > 4096) stderr = stderr.slice(-4096);
      });
      stream.on('error', error => finish(false, 'SSH_COMMAND_FAILED', error.message));
      stream.on('close', code => {
        if (Number(code) === 0) finish(true, null, '');
        else finish(false, 'SSH_COMMAND_FAILED', stderr || 'exit_' + String(code));
      });
    });
  });

  conn.on('error', error => {
    const msg = String(error?.message || '').toLowerCase();
    const code = msg.includes('auth')
      ? 'SSH_AUTH_FAILED'
      : (msg.includes('timeout') ? 'SSH_TIMEOUT' : 'SSH_CONNECTION_FAILED');
    finish(false, code, error?.message || code);
  });

  conn.connect({
    host,
    port: 22,
    username: 'root',
    password,
    readyTimeout: Math.max(1000, Math.min(timeoutMs - 250, 15000)),
    tryKeyboard: false,
    keepaliveInterval: 5000,
    keepaliveCountMax: 2
  });
});
process.stdin.resume();
