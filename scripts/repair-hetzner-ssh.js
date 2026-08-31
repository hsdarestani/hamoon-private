'use strict';

require('dotenv').config();
const net = require('net');
const { Client } = require('ssh2');
const db = require('../db');
const datacenters = require('../datacenters');
const hetzner = require('../Hetzner/hetzner-api');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function tcpOpen(host, port = 22, timeoutMs = 3000) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function waitTcp(host, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await tcpOpen(host, 22, 3000)) return true;
    await sleep(2500);
  }
  return false;
}

async function waitAction(dc, action) {
  const id = action?.id || action?.action?.id;
  if (id) await hetzner.waitHetznerAction(dc, id, 180000);
}

function sshExec({ host, password, command, timeoutMs = 120000 }) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let timer = null;
    let stdout = '';
    let stderr = '';
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      try { conn.end(); } catch (_) {}
    };
    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) { cleanup(); reject(err); return; }
        stream.on('close', code => {
          cleanup();
          if (code === 0) resolve({ stdout, stderr });
          else reject(new Error(`REMOTE_REPAIR_FAILED_${code}: ${stderr.slice(-600)}`));
        });
        stream.on('data', data => { stdout += data.toString(); });
        stream.stderr.on('data', data => { stderr += data.toString(); });
      });
    });
    conn.on('error', err => { cleanup(); reject(err); });
    conn.connect({
      host,
      port: 22,
      username: 'root',
      password,
      readyTimeout: 20000,
      keepaliveInterval: 5000,
      keepaliveCountMax: 3
    });
    timer = setTimeout(() => {
      cleanup();
      reject(new Error('SSH_REPAIR_TIMEOUT'));
    }, timeoutMs);
  });
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function buildRepairCommand(rootPassword) {
  const rootPass = shellSingleQuote(rootPassword);
  const script = `set -euo pipefail
ROOT_DEV="$(lsblk -bpnro NAME,TYPE,FSTYPE,SIZE | awk '($2=="part" || $2=="lvm") && ($3=="ext4" || $3=="xfs" || $3=="btrfs") {print $4, $1}' | sort -nr | head -n1 | awk '{print $2}')"
if [ -z "$ROOT_DEV" ]; then
  echo ROOT_DEVICE_NOT_FOUND >&2
  exit 31
fi
mkdir -p /mnt/hamoon-root
mount "$ROOT_DEV" /mnt/hamoon-root
cleanup() {
  for p in run sys proc dev; do umount -R "/mnt/hamoon-root/$p" 2>/dev/null || true; done
  umount /mnt/hamoon-root 2>/dev/null || true
}
trap cleanup EXIT
for p in dev proc sys run; do
  mkdir -p "/mnt/hamoon-root/$p"
  mount --rbind "/$p" "/mnt/hamoon-root/$p"
  mount --make-rslave "/mnt/hamoon-root/$p" || true
done
mkdir -p /mnt/hamoon-root/etc/ssh/sshd_config.d
cat > /mnt/hamoon-root/etc/ssh/sshd_config.d/99-hamooncloud.conf <<'EOF'
PasswordAuthentication yes
PermitRootLogin yes
KbdInteractiveAuthentication yes
UsePAM yes
EOF
if [ ! -f /mnt/hamoon-root/etc/ssh/sshd_config ]; then
  echo 'Include /etc/ssh/sshd_config.d/*.conf' > /mnt/hamoon-root/etc/ssh/sshd_config
fi
if ! grep -Eq '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config.d/\\*.conf' /mnt/hamoon-root/etc/ssh/sshd_config; then
  printf '\\nInclude /etc/ssh/sshd_config.d/*.conf\\n' >> /mnt/hamoon-root/etc/ssh/sshd_config
fi
printf 'root:%s\\n' ${rootPass} | chroot /mnt/hamoon-root chpasswd
chroot /mnt/hamoon-root ssh-keygen -A
chroot /mnt/hamoon-root /usr/sbin/sshd -t
chroot /mnt/hamoon-root systemctl enable ssh.service >/dev/null 2>&1 || chroot /mnt/hamoon-root systemctl enable sshd.service >/dev/null 2>&1 || true
rm -f /mnt/hamoon-root/run/nologin /mnt/hamoon-root/etc/nologin 2>/dev/null || true
echo REPAIR_OK
`;
  return `bash -lc ${shellSingleQuote(script)}`;
}

async function findPurchaseByIp(ip) {
  const purchases = await db.getAllPurchases();
  return purchases.find(p => String(p.public_ip || '').trim() === ip) || null;
}

async function main() {
  const ip = String(process.argv[2] || '').trim();
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) throw new Error('VALID_IPV4_REQUIRED');

  const purchase = await findPurchaseByIp(ip);
  if (!purchase) throw new Error('PURCHASE_NOT_FOUND_FOR_IP');
  const dc = datacenters[purchase.datacenter] || { provider: 'hetzner' };
  const serverId = String(purchase.server_id);

  const server = await hetzner.getHetznerServer(dc, serverId);
  const providerIp = String(server?.public_net?.ipv4?.ip || '');
  if (providerIp !== ip) throw new Error(`PROVIDER_IP_MISMATCH:${providerIp || 'none'}`);

  console.log('[SSH_REPAIR] target', {
    server_id: serverId,
    datacenter: purchase.datacenter,
    location: server?.datacenter?.location?.name || null,
    provider_status: server?.status || null,
    ip,
    current_port22: await tcpOpen(ip)
  });

  if (await tcpOpen(ip)) {
    console.log('[SSH_REPAIR] port 22 is already reachable; no mutation needed');
    return;
  }

  const originalRootPassword = await db.getServerSecret(serverId, 'root_password');
  if (!originalRootPassword) throw new Error('STORED_ROOT_PASSWORD_MISSING');

  let rescueEnabled = false;
  try {
    const rescue = await hetzner.hetznerRequest(dc, 'POST', `/servers/${serverId}/actions/enable_rescue`, { type: 'linux64' });
    const rescuePassword = rescue?.root_password || rescue?.action?.root_password || null;
    if (!rescuePassword) throw new Error('RESCUE_PASSWORD_MISSING');
    rescueEnabled = true;
    await waitAction(dc, rescue?.action);

    const reboot = await hetzner.hetznerRequest(dc, 'POST', `/servers/${serverId}/actions/reboot`, {});
    await waitAction(dc, reboot?.action);
    if (!await waitTcp(ip, 120000)) throw new Error('RESCUE_SSH_DID_NOT_START');

    console.log('[SSH_REPAIR] rescue SSH reachable; repairing installed system');
    const repaired = await sshExec({
      host: ip,
      password: rescuePassword,
      command: buildRepairCommand(originalRootPassword),
      timeoutMs: 120000
    });
    if (!repaired.stdout.includes('REPAIR_OK')) throw new Error('REPAIR_CONFIRMATION_MISSING');

    const disable = await hetzner.hetznerRequest(dc, 'POST', `/servers/${serverId}/actions/disable_rescue`, {});
    await waitAction(dc, disable?.action);
    rescueEnabled = false;

    const rebootBack = await hetzner.hetznerRequest(dc, 'POST', `/servers/${serverId}/actions/reboot`, {});
    await waitAction(dc, rebootBack?.action);
    const ready = await waitTcp(ip, 150000);
    if (!ready) throw new Error('SSH_STILL_UNREACHABLE_AFTER_REPAIR');

    await db.updateScopedStatus?.(purchase.telegram_id, serverId, purchase.datacenter, 'active');
    await db.adminAuditLog?.('server_ssh_repaired', 'automation', { type: 'server', id: serverId }, {
      result: 'ok', datacenter: purchase.datacenter, ip
    }, null).catch(() => {});

    console.log('[SSH_REPAIR] SUCCESS', { server_id: serverId, ip, port22: true });
  } catch (error) {
    await db.adminAuditLog?.('server_ssh_repair_failed', 'automation', { type: 'server', id: serverId }, {
      result: 'failed', datacenter: purchase.datacenter, ip, error: String(error?.message || error).slice(0, 160)
    }, null).catch(() => {});
    if (rescueEnabled) {
      try {
        const disable = await hetzner.hetznerRequest(dc, 'POST', `/servers/${serverId}/actions/disable_rescue`, {});
        await waitAction(dc, disable?.action);
        const rebootBack = await hetzner.hetznerRequest(dc, 'POST', `/servers/${serverId}/actions/reboot`, {});
        await waitAction(dc, rebootBack?.action);
      } catch (_) {}
    }
    throw error;
  } finally {
    await db.pool.end().catch(() => {});
  }
}

main().catch(error => {
  console.error('[SSH_REPAIR] FAILED:', String(error?.message || error).slice(0, 240));
  process.exitCode = 1;
});
