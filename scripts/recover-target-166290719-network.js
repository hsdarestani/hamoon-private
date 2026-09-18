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
    'EFI_DEV=/dev/sda15',
    'ROOT=/mnt/hamoon-root',
    'mkdir -p "$ROOT"',
    'mount "$ROOT_DEV" "$ROOT"',
    'mkdir -p "$ROOT/boot/efi"',
    'mount "$EFI_DEV" "$ROOT/boot/efi"',
    'cleanup() { set +e; umount -R "$ROOT/run" 2>/dev/null || true; umount -R "$ROOT/sys" 2>/dev/null || true; umount -R "$ROOT/proc" 2>/dev/null || true; umount -R "$ROOT/dev" 2>/dev/null || true; umount "$ROOT/boot/efi" 2>/dev/null || true; umount "$ROOT" 2>/dev/null || true; }',
    'trap cleanup EXIT',
    'STAMP="$(date -u +%Y%m%dT%H%M%SZ)"',
    'BACKUP="$ROOT/root/hamoon-core-repair-$STAMP"',
    'mkdir -p "$BACKUP"',
    'cp -a "$ROOT/etc/default/grub" "$BACKUP/grub.default" 2>/dev/null || true',
    'cp -a "$ROOT/boot/grub/grub.cfg" "$BACKUP/grub.cfg" 2>/dev/null || true',
    'cp -a "$ROOT/var/lib/dpkg/status" "$BACKUP/dpkg.status" 2>/dev/null || true',
    'if [ -L "$ROOT/etc/resolv.conf" ]; then readlink "$ROOT/etc/resolv.conf" > "$BACKUP/resolv.link"; else cp -a "$ROOT/etc/resolv.conf" "$BACKUP/resolv.file" 2>/dev/null || true; fi',
    'rm -f "$ROOT/etc/resolv.conf"',
    'cp -L /etc/resolv.conf "$ROOT/etc/resolv.conf"',
    'mkdir -p "$ROOT/usr/bin" "$ROOT/usr/sbin"',
    'test -x "$ROOT/usr/bin/dash"',
    'ln -sfn dash "$ROOT/usr/bin/sh"',
    'test -x "$ROOT/usr/lib/systemd/systemd"',
    'ln -sfn ../lib/systemd/systemd "$ROOT/usr/sbin/init"',
    'for d in dev proc sys run; do mkdir -p "$ROOT/$d"; mount --rbind "/$d" "$ROOT/$d"; mount --make-rslave "$ROOT/$d"; done',
    'echo CORE_REPAIR_PRECHECK',
    'for x in sh dash bash env mount systemctl init; do printf "%s=" "$x"; if chroot "$ROOT" /usr/bin/test -e "/usr/bin/$x" 2>/dev/null || chroot "$ROOT" /usr/bin/test -e "/usr/sbin/$x" 2>/dev/null; then echo present; else echo missing; fi; done || true',
    'chroot "$ROOT" /usr/bin/apt-get update',
    'chroot "$ROOT" /usr/bin/env DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get -o Dpkg::Options::=--force-confold install --reinstall -y bash dash coreutils mount util-linux systemd systemd-sysv iproute2 openssh-server init-system-helpers',
    'chroot "$ROOT" /usr/bin/dpkg --configure -a',
    'test -x "$ROOT/usr/bin/bash"',
    'test -x "$ROOT/usr/bin/env"',
    'test -x "$ROOT/usr/bin/mount"',
    'test -x "$ROOT/usr/bin/systemctl"',
    'test -e "$ROOT/usr/sbin/init"',
    'test -x "$ROOT/usr/sbin/sshd"',
    'ln -sfn dash "$ROOT/usr/bin/sh"',
    'ln -sfn ../lib/systemd/systemd "$ROOT/usr/sbin/init"',
    'if [ -x "$ROOT/usr/sbin/update-initramfs" ]; then chroot "$ROOT" /usr/sbin/update-initramfs -u -k 6.8.0-139-generic; chroot "$ROOT" /usr/sbin/update-initramfs -u -k 6.8.0-138-generic; fi',
    'if [ -x "$ROOT/usr/sbin/update-grub" ]; then chroot "$ROOT" /usr/sbin/update-grub; fi',
    'mkdir -p "$ROOT/etc/systemd/system/multi-user.target.wants"',
    'if [ -e "$ROOT/usr/lib/systemd/system/ssh.service" ]; then ln -sfn /usr/lib/systemd/system/ssh.service "$ROOT/etc/systemd/system/multi-user.target.wants/ssh.service"; fi',
    'rm -f "$ROOT/run/nologin" "$ROOT/etc/nologin" 2>/dev/null || true',
    'rm -f "$ROOT/etc/resolv.conf"',
    'if [ -f "$BACKUP/resolv.link" ]; then ln -s "$(cat "$BACKUP/resolv.link")" "$ROOT/etc/resolv.conf"; elif [ -f "$BACKUP/resolv.file" ]; then cp -a "$BACKUP/resolv.file" "$ROOT/etc/resolv.conf"; else cp -L /etc/resolv.conf "$ROOT/etc/resolv.conf"; fi',
    'sync',
    'echo CORE_PACKAGES_REPAIRED',
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
