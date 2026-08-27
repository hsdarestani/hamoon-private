'use strict';

const net = require('net');
const { Client } = require('ssh2');
require('dotenv').config();
const mysql = require('mysql2/promise');
const dcs = require('../datacenters');
const hetzner = require('../Hetzner/hetzner-api');

const USER_ID = '138279367';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function tcp22(ip, timeout = 4000) {
  return new Promise(resolve => {
    if (!ip) return resolve(false);
    const socket = net.createConnection({ host: ip, port: 22 });
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function waitTcp(ip, attempts = 30, delay = 3000) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const ok = await tcp22(ip);
    console.log('WAIT_TCP22', { attempt, ip, ok });
    if (ok) return true;
    if (attempt < attempts) await sleep(delay);
  }
  return false;
}

async function rawServer(dc, serverId) {
  const data = await hetzner.hetznerRequest(dc, 'GET', `/servers/${encodeURIComponent(String(serverId))}`);
  return data.server;
}

function sshExec(host, password, script) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = '';
    let stderr = '';
    conn.on('ready', () => {
      conn.exec('bash -s', (err, stream) => {
        if (err) {
          conn.end();
          reject(err);
          return;
        }
        stream.on('close', code => {
          conn.end();
          if (code === 0) resolve({ stdout, stderr });
          else reject(Object.assign(new Error(`RESCUE_SCRIPT_EXIT_${code}: ${stderr.slice(-1200)}`), { stdout, stderr, code }));
        });
        stream.on('data', chunk => { stdout += chunk.toString(); });
        stream.stderr.on('data', chunk => { stderr += chunk.toString(); });
        stream.end(script);
      });
    });
    conn.on('error', reject);
    conn.connect({
      host,
      port: 22,
      username: 'root',
      password,
      readyTimeout: 20000,
      keepaliveInterval: 5000,
      keepaliveCountMax: 4
    });
  });
}

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function buildRepairScript(oldIp, newIp) {
  return String.raw`set -euo pipefail
OLD_IP=${shellQuote(oldIp)}
NEW_IP=${shellQuote(newIp)}
ROOT_PART="$(lsblk -rpno NAME,TYPE,FSTYPE | awk '$2=="part" && ($3=="ext4" || $3=="xfs" || $3=="btrfs") {print $1; exit}')"
if [ -z "$ROOT_PART" ]; then
  ROOT_PART="$(lsblk -rpno NAME,TYPE,FSTYPE | awk '$2=="disk" && ($3=="ext4" || $3=="xfs" || $3=="btrfs") {print $1; exit}')"
fi
[ -n "$ROOT_PART" ] || { echo ROOT_PART_NOT_FOUND >&2; lsblk -f >&2; exit 20; }
mkdir -p /mnt/root
mount "$ROOT_PART" /mnt/root
echo "ROOT_PART=$ROOT_PART"
mkdir -p /mnt/root/dev /mnt/root/proc /mnt/root/sys /mnt/root/run
mount --bind /dev /mnt/root/dev
mount -t proc proc /mnt/root/proc
mount -t sysfs sys /mnt/root/sys
mount --bind /run /mnt/root/run || true
cp -L /etc/resolv.conf /mnt/root/etc/resolv.conf || true
if [ -n "$OLD_IP" ] && [ -n "$NEW_IP" ] && [ "$OLD_IP" != "$NEW_IP" ]; then
  for dir in /mnt/root/etc/netplan /mnt/root/etc/network /mnt/root/etc/systemd/network; do
    [ -d "$dir" ] || continue
    grep -RIl -- "$OLD_IP" "$dir" 2>/dev/null | while read -r file; do
      cp -a "$file" "$file.hamoon-backup"
      sed -i "s/$OLD_IP/$NEW_IP/g" "$file"
      echo "UPDATED_IP_CONFIG=$file"
    done
  done
fi
mkdir -p /mnt/root/etc/ssh/sshd_config.d
cat > /mnt/root/etc/ssh/sshd_config.d/99-hamoon-recovery.conf <<'EOF'
Port 22
PermitRootLogin yes
PasswordAuthentication yes
KbdInteractiveAuthentication yes
UsePAM yes
EOF
if [ ! -x /mnt/root/usr/sbin/sshd ]; then
  chroot /mnt/root /usr/bin/apt-get update
  chroot /mnt/root /usr/bin/env DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get install -y openssh-server
fi
chroot /mnt/root /usr/sbin/sshd -t
systemctl --root=/mnt/root enable ssh.service >/dev/null 2>&1 || systemctl --root=/mnt/root enable sshd.service >/dev/null 2>&1 || true
if [ -x /mnt/root/usr/sbin/ufw ]; then
  chroot /mnt/root /usr/sbin/ufw --force insert 1 allow 22/tcp || true
fi
rm -f /mnt/root/etc/ssh/sshd_not_to_be_run 2>/dev/null || true
sync
echo GUEST_REPAIR_OK
`;
}

async function dbConnection() {
  return mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'hamooncloud_db'
  });
}

async function main() {
  const conn = await dbConnection();
  let purchases;
  try {
    [purchases] = await conn.execute(
      "SELECT server_id,datacenter,public_ip,status FROM purchases WHERE telegram_id=? AND status<>'deleted' ORDER BY created_at DESC",
      [USER_ID]
    );
  } finally {
    await conn.end();
  }

  if (purchases.length !== 1) throw new Error(`EXPECTED_ONE_LIVE_PURCHASE_GOT_${purchases.length}`);
  const purchase = purchases[0];
  const dc = dcs[purchase.datacenter];
  if (!dc || String(dc.provider || dc.apiType || '').toLowerCase() !== 'hetzner') throw new Error('LIVE_PURCHASE_NOT_HETZNER');

  let server = await rawServer(dc, purchase.server_id);
  const oldDbIp = purchase.public_ip || null;
  const ip = server?.public_net?.ipv4?.ip || oldDbIp;
  if (!ip) throw new Error('SERVER_IPV4_MISSING');
  console.log('START', { server_id: String(purchase.server_id), status: server.status, ip, db_ip: oldDbIp });

  const rescue = await hetzner.hetznerRequest(dc, 'POST', `/servers/${purchase.server_id}/actions/enable_rescue`, { type: 'linux64' });
  const rescuePassword = rescue?.root_password;
  if (!rescuePassword) throw new Error('RESCUE_PASSWORD_MISSING');
  if (rescue?.action?.id) await hetzner.waitHetznerAction(dc, rescue.action.id, 120000);

  const reboot = await hetzner.hetznerRequest(dc, 'POST', `/servers/${purchase.server_id}/actions/reboot`, {});
  if (reboot?.action?.id) await hetzner.waitHetznerAction(dc, reboot.action.id, 180000);
  if (!(await waitTcp(ip, 30, 3000))) throw new Error('RESCUE_SSH_NOT_REACHABLE');
  console.log('RESCUE_SSH_READY');

  const repair = await sshExec(ip, rescuePassword, buildRepairScript(oldDbIp, ip));
  console.log(repair.stdout.trim().split('\n').slice(-30).join('\n'));
  if (repair.stderr.trim()) console.log('RESCUE_STDERR', repair.stderr.trim().slice(-1500));

  const disable = await hetzner.hetznerRequest(dc, 'POST', `/servers/${purchase.server_id}/actions/disable_rescue`, {}).catch(() => null);
  if (disable?.action?.id) await hetzner.waitHetznerAction(dc, disable.action.id, 120000).catch(() => null);

  const finalReboot = await hetzner.hetznerRequest(dc, 'POST', `/servers/${purchase.server_id}/actions/reboot`, {});
  if (finalReboot?.action?.id) await hetzner.waitHetznerAction(dc, finalReboot.action.id, 180000);

  const finalOk = await waitTcp(ip, 40, 3000);
  server = await rawServer(dc, purchase.server_id);
  const finalIp = server?.public_net?.ipv4?.ip || ip;
  console.log('FINAL_PROVIDER', { status: server.status, ip: finalIp, tcp22: finalOk });

  const sync = await dbConnection();
  try {
    await sync.execute(
      "UPDATE purchases SET public_ip=?,status='active',suspend_reason=NULL,lifecycle_error_code=NULL,lifecycle_updated_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE telegram_id=? AND server_id=? AND datacenter=? AND status<>'deleted'",
      [finalIp, USER_ID, String(purchase.server_id), String(purchase.datacenter)]
    );
  } finally {
    await sync.end();
  }

  if (!finalOk) throw Object.assign(new Error('GUEST_SSH_STILL_UNREACHABLE_AFTER_RESCUE_REPAIR'), { code: 'GUEST_SSH_STILL_UNREACHABLE_AFTER_RESCUE_REPAIR' });
  console.log('RECOVERY_SUCCESS');
}

main().catch(error => {
  console.error('RECOVERY_FATAL', { code: error?.code || null, message: String(error?.message || error).slice(0, 500) });
  process.exitCode = 1;
});
