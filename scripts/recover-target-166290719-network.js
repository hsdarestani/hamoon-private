'use strict';

require('dotenv').config();
const net = require('net');
const { Client } = require('ssh2');
const db = require('../db');
const datacenters = require('../datacenters');
const hetzner = require('../Hetzner/hetzner-api');

const TARGET_IP = '91.107.245.81';
const TARGET_SERVER_ID = '166290719';
const TARGET_MAC = '92:00:09:e9:65:1f';
const TARGET_GW = '172.31.1.1';
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

async function waitTcp(host, timeoutMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await tcpOpen(host, 22, 4000)) return true;
    await sleep(3000);
  }
  return false;
}

async function waitAction(dc, action) {
  const id = action?.id || action?.action?.id;
  if (id) await hetzner.waitHetznerAction(dc, id, 180000);
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

function sshExec({ host, password, command, timeoutMs = 120000 }) {
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
          code === 0 ? resolve({ stdout, stderr }) : reject(new Error('REMOTE_EXIT_' + code + ':' + stderr.slice(-600)));
        });
      });
    });
    conn.on('error', err => { cleanup(); reject(err); });
    conn.connect({ host, port:22, username:'root', password, readyTimeout:20000, keepaliveInterval:5000, keepaliveCountMax:3 });
    timer = setTimeout(() => { cleanup(); reject(new Error('SSH_TIMEOUT')); }, timeoutMs);
  });
}

function sq(v) {
  return "'" + String(v).replace(/'/g, "'\"'\"'") + "'";
}

function buildInstallCommand() {
  const scriptLines = [
    'set -euo pipefail',
    'ROOT_DEV=/dev/sda1',
    'mkdir -p /mnt/hamoon-root',
    'mount "$ROOT_DEV" /mnt/hamoon-root',
    'cleanup() { umount /mnt/hamoon-root 2>/dev/null || true; }',
    'trap cleanup EXIT',
    'STAMP="$(date -u +%Y%m%dT%H%M%SZ)"',
    'BACKUP="/mnt/hamoon-root/root/hamoon-static-network-$STAMP"',
    'mkdir -p "$BACKUP"',
    'cp -a /mnt/hamoon-root/etc/systemd/system "$BACKUP/systemd-system" 2>/dev/null || true',
    'cp -a /mnt/hamoon-root/usr/local/sbin/hamoon-network-recovery "$BACKUP/" 2>/dev/null || true',
    'mkdir -p /mnt/hamoon-root/usr/local/sbin',
    'cat > /mnt/hamoon-root/usr/local/sbin/hamoon-network-recovery <<\'SH\'',
    '#!/bin/sh',
    'set -eu',
    'TARGET_MAC="92:00:09:e9:65:1f"',
    'TARGET_IP="91.107.245.81"',
    'TARGET_GW="172.31.1.1"',
    'IFACE=""',
    'i=0',
    'while [ "$i" -lt 30 ]; do',
    '  for p in /sys/class/net/*; do',
    '    n=$(basename "$p")',
    '    [ "$n" = "lo" ] && continue',
    '    mac=$(cat "$p/address" 2>/dev/null || true)',
    '    if [ "$mac" = "$TARGET_MAC" ]; then IFACE="$n"; break; fi',
    '  done',
    '  [ -n "$IFACE" ] && break',
    '  i=$((i+1))',
    '  sleep 1',
    'done',
    '[ -n "$IFACE" ] || exit 20',
    'IPBIN=$(command -v ip || true)',
    '[ -n "$IPBIN" ] || exit 21',
    '"$IPBIN" link set dev "$IFACE" up',
    '"$IPBIN" addr replace "$TARGET_IP/32" dev "$IFACE"',
    '"$IPBIN" route replace "$TARGET_GW" dev "$IFACE" scope link',
    '"$IPBIN" route replace default via "$TARGET_GW" dev "$IFACE" onlink',
    'mkdir -p /run/hamoon-recovery',
    'printf "%s %s %s\\n" "$IFACE" "$TARGET_IP" "$TARGET_GW" > /run/hamoon-recovery/network.ok',
    'exit 0',
    'SH',
    'chmod 755 /mnt/hamoon-root/usr/local/sbin/hamoon-network-recovery',
    'cat > /mnt/hamoon-root/etc/systemd/system/hamoon-network-recovery.service <<\'UNIT\'',
    '[Unit]',
    'Description=Hamoon emergency network recovery',
    'After=systemd-udevd.service',
    'Before=network-online.target ssh.service ssh.socket',
    'Wants=systemd-udev-settle.service',
    '',
    '[Service]',
    'Type=oneshot',
    'ExecStart=/usr/local/sbin/hamoon-network-recovery',
    'RemainAfterExit=yes',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    'UNIT',
    'mkdir -p /mnt/hamoon-root/etc/systemd/system/multi-user.target.wants',
    'ln -sfn ../hamoon-network-recovery.service /mnt/hamoon-root/etc/systemd/system/multi-user.target.wants/hamoon-network-recovery.service',
    'mkdir -p /mnt/hamoon-root/etc/systemd/system/ssh.service.d',
    'cat > /mnt/hamoon-root/etc/systemd/system/ssh.service.d/90-hamoon-network.conf <<\'UNIT\'',
    '[Unit]',
    'After=hamoon-network-recovery.service',
    'Requires=hamoon-network-recovery.service',
    'UNIT',
    'if [ -e /mnt/hamoon-root/usr/lib/systemd/system/ssh.service ]; then',
    '  ln -sfn /usr/lib/systemd/system/ssh.service /mnt/hamoon-root/etc/systemd/system/multi-user.target.wants/ssh.service',
    'elif [ -e /mnt/hamoon-root/lib/systemd/system/ssh.service ]; then',
    '  ln -sfn /lib/systemd/system/ssh.service /mnt/hamoon-root/etc/systemd/system/multi-user.target.wants/ssh.service',
    'else',
    '  echo SSH_UNIT_MISSING >&2',
    'fi',
    'rm -f /mnt/hamoon-root/run/nologin /mnt/hamoon-root/etc/nologin 2>/dev/null || true',
    'echo STATIC_RECOVERY_INSTALLED',
    'echo "BACKUP=$BACKUP"'
  ];
  return 'bash -lc ' + sq(scriptLines.join('\n'));
}

(async () => {
  const purchases = await db.getAllPurchases();
  const p = purchases.find(x => String(x.server_id) === TARGET_SERVER_ID && String(x.public_ip || '') === TARGET_IP);
  if (!p) throw new Error('TARGET_PURCHASE_NOT_FOUND');
  const dc = datacenters[p.datacenter] || datacenters.hetzner;

  const rescue = await hetzner.hetznerRequest(dc, 'POST', `/servers/${TARGET_SERVER_ID}/actions/enable_rescue`, {type:'linux64'});
  const rescuePassword = rescue?.root_password || rescue?.action?.root_password;
  if (!rescuePassword) throw new Error('RESCUE_PASSWORD_MISSING');
  await waitAction(dc, rescue?.action);
  await hardCycle(dc, TARGET_SERVER_ID);
  if (!await waitTcp(TARGET_IP, 150000)) throw new Error('RESCUE_SSH_NOT_READY');

  const applied = await sshExec({host:TARGET_IP, password:rescuePassword, command:buildInstallCommand(), timeoutMs:120000});
  console.log(applied.stdout);
  if (!applied.stdout.includes('STATIC_RECOVERY_INSTALLED')) throw new Error('STATIC_RECOVERY_NOT_CONFIRMED');

  const disable = await hetzner.hetznerRequest(dc, 'POST', `/servers/${TARGET_SERVER_ID}/actions/disable_rescue`, {});
  await waitAction(dc, disable?.action);
  await hardCycle(dc, TARGET_SERVER_ID);

  const ready = await waitTcp(TARGET_IP, 180000);
  console.log('NORMAL_OS_SSH=' + (ready ? 'up' : 'down'));
  if (!ready) throw new Error('NORMAL_OS_STILL_UNREACHABLE');

  console.log('TARGET_NETWORK_RECOVERY_SUCCESS=1');
})()
  .catch(e => {
    console.error('TARGET_NETWORK_RECOVERY_FAILED=' + String(e?.message || e).slice(0,300));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.pool.end().catch(() => {});
  });
