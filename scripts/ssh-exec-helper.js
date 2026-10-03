#!/usr/bin/env node
'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function runAskpass() {
  const socketPath = String(process.env.HAMOON_ASKPASS_SOCKET || '');
  if (!socketPath) {
    process.exitCode = 2;
    return;
  }

  const socket = net.createConnection(socketPath);
  let secret = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => { secret += String(chunk); });
  socket.on('end', () => {
    process.stdout.write(secret);
    process.stdout.write('\n');
  });
  socket.on('error', () => {
    process.exitCode = 2;
  });
}

function runExecutor() {
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

    const sshBin = fs.existsSync('/usr/bin/ssh') ? '/usr/bin/ssh' : 'ssh';
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hamoon-ssh-'));
    const socketPath = path.join(tempDir, 'askpass.sock');
    const askpassPath = path.join(tempDir, 'askpass.sh');

    fs.writeFileSync(
      askpassPath,
      '#!/bin/sh\nexec node ' + JSON.stringify(__filename) + ' --askpass\n',
      { mode: 0o700 }
    );

    let child = null;
    let server = null;
    let timer = null;
    let settled = false;
    let stdout = '';
    let stderr = '';
    const startedAt = Date.now();

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      try { server?.close(); } catch (_) {}
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
    };

    const finish = (ok, code, message) => {
      if (settled) return;
      settled = true;
      cleanup();
      process.stdout.write(JSON.stringify({
        ok: !!ok,
        code: code || null,
        message: String(message || '').slice(0, 240),
        elapsed_ms: Date.now() - startedAt
      }) + '\n');
      process.exitCode = ok ? 0 : 1;
      setTimeout(() => process.exit(process.exitCode || 0), 10).unref();
    };

    server = net.createServer(socket => {
      socket.end(password);
    });

    server.on('error', error => {
      finish(false, 'SSH_HELPER_FAILED', error?.message || 'askpass_socket_error');
    });

    server.listen(socketPath, () => {
      try { fs.chmodSync(socketPath, 0o600); } catch (_) {}

      const connectSeconds = Math.max(2, Math.ceil(Math.min(timeoutMs, 20000) / 1000));
      const args = [
        '-T',
        '-o', 'BatchMode=no',
        '-o', 'PreferredAuthentications=password,keyboard-interactive',
        '-o', 'PubkeyAuthentication=no',
        '-o', 'NumberOfPasswordPrompts=1',
        '-o', 'ConnectTimeout=' + String(connectSeconds),
        '-o', 'ConnectionAttempts=1',
        '-o', 'ServerAliveInterval=5',
        '-o', 'ServerAliveCountMax=2',
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'LogLevel=ERROR',
        'root@' + host,
        command
      ];

      child = spawn(sshBin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          DISPLAY: process.env.DISPLAY || ':0',
          SSH_ASKPASS: askpassPath,
          SSH_ASKPASS_REQUIRE: 'force',
          HAMOON_ASKPASS_SOCKET: socketPath
        }
      });

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        stdout += String(chunk);
        if (stdout.length > 8192) stdout = stdout.slice(-8192);
      });
      child.stderr.on('data', chunk => {
        stderr += String(chunk);
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      });

      child.on('error', error => {
        finish(false, 'SSH_HELPER_FAILED', error?.message || 'openssh_spawn_failed');
      });

      child.on('close', exitCode => {
        if (Number(exitCode) === 0) return finish(true, null, '');
        const msg = String(stderr || stdout || '').toLowerCase();
        const code = msg.includes('permission denied') || msg.includes('authentication')
          ? 'SSH_AUTH_FAILED'
          : (msg.includes('timed out') || msg.includes('timeout')
            ? 'SSH_TIMEOUT'
            : (msg.includes('connection refused') || msg.includes('no route') || msg.includes('network is unreachable')
              ? 'SSH_CONNECTION_FAILED'
              : 'SSH_COMMAND_FAILED'));
        finish(false, code, stderr || stdout || ('openssh_exit_' + String(exitCode)));
      });

      timer = setTimeout(() => {
        try { child?.kill('SIGKILL'); } catch (_) {}
        finish(false, 'SSH_TIMEOUT', 'hard_timeout');
      }, timeoutMs + 1500);
    });
  });

  process.stdin.resume();
}

if (process.argv.includes('--askpass')) runAskpass();
else runExecutor();
