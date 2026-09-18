'use strict';

require('dotenv').config();
const net = require('net');
const { Client } = require('ssh2');
const db = require('../db');
const datacenters = require('../datacenters');
const hetzner = require('../Hetzner/hetzner-api');

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

async function waitTcp(host, timeoutMs = 150000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await tcpOpen(host, 22, 3000)) return true;
    await sleep(3000);
  }
  return false;
}

async function waitAction(dc, action, timeoutMs = 180000) {
  const id = action?.id || action?.action?.id;
  if (!id) return;
  await hetzner.waitHetznerAction(dc, id, timeoutMs);
}

async function hardCycle(dc, serverId) {
  const state = await hetzner.getHetznerServer(dc, serverId);
  if (String(state?.status || '').toLowerCase() !== 'off') {
    const off = await hetzner.hetznerRequest(dc, 'POST', `/servers/${serverId}/actions/poweroff`, {});
    await waitAction(dc, off?.action);
  }
  await sleep(4000);
  const on = await hetzner.hetznerRequest(dc, 'POST', `/servers/${serverId}/actions/poweron`, {});
  await waitAction(dc, on?.action);
}

function sshExec({host, password, command, timeoutMs = 120000}) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = '', stderr = '', timer;
    const cleanup = () => { if (timer) clearTimeout(timer); try { conn.end(); } catch (_) {} };
    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) { cleanup(); reject(err); return; }
        stream.on('data', d => stdout += d.toString());
        stream.stderr.on('data', d => stderr += d.toString());
        stream.on('close', code => {
          cleanup();
          if (code === 0) resolve({stdout, stderr});
          else reject(new Error('REMOTE_DIAG_FAILED_' + code + ':' + stderr.slice(-400)));
        });
      });
    });
    conn.on('error', err => { cleanup(); reject(err); });
    conn.connect({host, port:22, username:'root', password, readyTimeout:20000, keepaliveInterval:5000, keepaliveCountMax:3});
    timer = setTimeout(() => { cleanup(); reject(new Error('REMOTE_DIAG_TIMEOUT')); }, timeoutMs);
  });
}

async function main() {
  const ip = String(process.argv[2] || '').trim();
  const expectedServerId = String(process.argv[3] || '').trim();
  const purchases = await db.getAllPurchases();
  const p = purchases.find(x => String(x.public_ip || '').trim() === ip);
  if (!p) throw new Error('PURCHASE_NOT_FOUND_FOR_IP');
  const serverId = String(p.server_id);
  if (expectedServerId && serverId !== expectedServerId) throw new Error('SERVER_ID_MISMATCH');
  const dc = datacenters[p.datacenter] || datacenters.hetzner;

  let rescueEnabled = false;
  try {
    const rescue = await hetzner.hetznerRequest(dc, 'POST', `/servers/${serverId}/actions/enable_rescue`, {type:'linux64'});
    const rescuePassword = rescue?.root_password || rescue?.action?.root_password || null;
    if (!rescuePassword) throw new Error('RESCUE_PASSWORD_MISSING');
    rescueEnabled = true;
    await waitAction(dc, rescue?.action);
    await hardCycle(dc, serverId);
    if (!await waitTcp(ip, 150000)) throw new Error('RESCUE_SSH_DID_NOT_START_AFTER_HARD_CYCLE');

    const command = String.raw`set -euo pipefail
ROOT_DEV="$(lsblk -bpnro NAME,TYPE,FSTYPE,SIZE | awk '($2=="part" || $2=="lvm") && ($3=="ext4" || $3=="xfs" || $3=="btrfs") {print $4, $1}' | sort -nr | head -n1 | awk '{print $2}')"
echo "ROOT_DEV=$ROOT_DEV"
[ -n "$ROOT_DEV" ] || exit 31
mkdir -p /mnt/hamoon-root
mount -o ro "$ROOT_DEV" /mnt/hamoon-root
trap 'umount /mnt/hamoon-root 2>/dev/null || true' EXIT
echo '=== OS ==='
sed -n '1,25p' /mnt/hamoon-root/etc/os-release 2>/dev/null || true
echo '=== NETPLAN ==='
for f in /mnt/hamoon-root/etc/netplan/*.yaml /mnt/hamoon-root/etc/netplan/*.yml; do [ -f "$f" ] && { echo "--- $f"; sed -n '1,220p' "$f"; }; done
echo '=== IFUPDOWN ==='
[ -f /mnt/hamoon-root/etc/network/interfaces ] && sed -n '1,220p' /mnt/hamoon-root/etc/network/interfaces || true
for f in /mnt/hamoon-root/etc/network/interfaces.d/*; do [ -f "$f" ] && { echo "--- $f"; sed -n '1,220p' "$f"; }; done
echo '=== SYSTEMD NETWORK ==='
for f in /mnt/hamoon-root/etc/systemd/network/*; do [ -f "$f" ] && { echo "--- $f"; sed -n '1,220p' "$f"; }; done
echo '=== CLOUD INIT NETWORK ==='
grep -R -n -E 'network:|config:[[:space:]]*disabled' /mnt/hamoon-root/etc/cloud/cloud.cfg.d 2>/dev/null | head -n 120 || true
echo '=== SSHD EFFECTIVE CONFIG FILES ==='
grep -R -n -E '^[[:space:]]*(Port|ListenAddress|PasswordAuthentication|PermitRootLogin|Include|AllowUsers|DenyUsers|AllowGroups|DenyGroups)' /mnt/hamoon-root/etc/ssh/sshd_config /mnt/hamoon-root/etc/ssh/sshd_config.d 2>/dev/null | head -n 180 || true
echo '=== UFW CONFIG ==='
grep -E '^(ENABLED|IPV6)=' /mnt/hamoon-root/etc/ufw/ufw.conf 2>/dev/null || true
grep -n -E '(^### tuple|^-A ufw-user-input|^COMMIT)' /mnt/hamoon-root/etc/ufw/user.rules 2>/dev/null | head -n 160 || true
echo '=== IPTABLES PERSISTENT ==='
sed -n '1,220p' /mnt/hamoon-root/etc/iptables/rules.v4 2>/dev/null || true
echo '=== NFTABLES ==='
sed -n '1,260p' /mnt/hamoon-root/etc/nftables.conf 2>/dev/null || true
for f in /mnt/hamoon-root/etc/nftables.d/*; do [ -f "$f" ] && { echo "--- $f"; sed -n '1,220p' "$f"; }; done
echo '=== OFFLINE SERVICE ENABLEMENT ==='
for svc in systemd-networkd.service systemd-networkd-wait-online.service ssh.service sshd.service nftables.service ufw.service firewalld.service netfilter-persistent.service docker.service; do
  printf '%s=' "$svc"
  systemctl --root=/mnt/hamoon-root is-enabled "$svc" 2>/dev/null || true
done
echo '=== NETWORKD GENERATED FILES ==='
find /mnt/hamoon-root/run/systemd/network /mnt/hamoon-root/etc/systemd/network -maxdepth 1 -type f -print 2>/dev/null | head -n 80 || true
echo '=== LAST BOOT NETWORK/SSH JOURNAL ==='
journalctl --directory=/mnt/hamoon-root/var/log/journal -b -1 --no-pager -u systemd-networkd.service -u systemd-networkd-wait-online.service -u ssh.service -u nftables.service -u ufw.service 2>/dev/null | tail -n 320 || true
echo '=== CLOUD INIT LOG TAIL ==='
tail -n 220 /mnt/hamoon-root/var/log/cloud-init.log 2>/dev/null || true
echo '=== BOOT LOG CLUES ==='
grep -R -h -E 'networkd|DHCP|eth0|ssh|nft|iptables|ufw|failed|error' /mnt/hamoon-root/var/log/syslog /mnt/hamoon-root/var/log/kern.log 2>/dev/null | tail -n 260 || true
echo '=== FSTAB ==='
sed -n '1,120p' /mnt/hamoon-root/etc/fstab 2>/dev/null || true
echo '=== DIAG_DONE ==='
`;

    const result = await sshExec({host:ip, password:rescuePassword, command, timeoutMs:120000});
    console.log('INSTALLED_DIAG_BEGIN');
    console.log(result.stdout.slice(0,30000));
    if (result.stderr) console.log('INSTALLED_DIAG_STDERR=' + result.stderr.slice(0,3000));
    console.log('INSTALLED_DIAG_END');

    const disable = await hetzner.hetznerRequest(dc, 'POST', `/servers/${serverId}/actions/disable_rescue`, {});
    await waitAction(dc, disable?.action);
    rescueEnabled = false;
    await hardCycle(dc, serverId);
    console.log('RETURNED_TO_INSTALLED_OS=1');
  } finally {
    if (rescueEnabled) {
      try {
        const disable = await hetzner.hetznerRequest(dc, 'POST', `/servers/${serverId}/actions/disable_rescue`, {});
        await waitAction(dc, disable?.action);
        await hardCycle(dc, serverId);
      } catch (_) {}
    }
    await db.pool.end().catch(() => {});
  }
}

main().catch(error => {
  console.error('INSTALLED_DIAG_FATAL=' + String(error?.message || error).slice(0,300));
  process.exitCode = 1;
});
