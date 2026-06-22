const { Client } = require('ssh2');

function safeError(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

async function resetLinuxRootPasswordOverSsh({ host, port = 22, username = 'root', currentPassword, newPassword, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch (_) {}
      if (err) reject(err); else resolve(true);
    };

    conn.on('ready', () => {
      conn.exec('chpasswd', (err, stream) => {
        if (err) return finish(safeError('SSH_COMMAND_FAILED'));
        stream.on('close', (code) => finish(code === 0 ? null : safeError('SSH_COMMAND_FAILED')));
        stream.on('error', () => finish(safeError('SSH_COMMAND_FAILED')));
        stream.write(`root:${newPassword}\n`);
        stream.end();
      });
    });
    conn.on('error', (err) => {
      const msg = String(err && err.message || '').toLowerCase();
      if (msg.includes('authentication') || msg.includes('auth')) return finish(safeError('SSH_AUTH_FAILED'));
      if (msg.includes('timed out') || msg.includes('timeout')) return finish(safeError('SSH_TIMEOUT'));
      return finish(safeError('SSH_CONNECTION_FAILED'));
    });
    conn.on('timeout', () => finish(safeError('SSH_TIMEOUT')));
    conn.connect({ host, port, username, password: currentPassword, readyTimeout: timeoutMs, tryKeyboard: false });
  });
}

module.exports = { resetLinuxRootPasswordOverSsh };
