'use strict';
const net = require('net');

function tebyanCloudConfig() {
  return `#cloud-config
package_update: false
ssh_pwauth: false
runcmd:
  - [ bash, -lc, "ufw allow 22/tcp || true" ]
  - [ bash, -lc, "systemctl unmask ssh.service ssh.socket || true" ]
  - [ bash, -lc, "systemctl enable --now ssh.socket || systemctl enable --now ssh.service || true" ]
  - [ bash, -lc, "echo HAMOON_CLOUD_INIT_DONE >/dev/ttyS0" ]
`;
}

function getDefaultSshUser(osLabel) {
  return String(osLabel || '').toLowerCase().includes('ubuntu-24.04') ? 'ubuntu' : 'root';
}

function tcpCheck(host, port = 22, timeout = Number(process.env.PROVISIONING_SSH_TIMEOUT_MS || 5000)) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    let done = false;
    const finish = reachable => { if (done) return; done = true; socket.destroy(); resolve(reachable); };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

module.exports = { tebyanCloudConfig, getDefaultSshUser, tcpCheck };
