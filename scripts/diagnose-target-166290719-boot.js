'use strict';

require('dotenv').config();
const net = require('net');
const { Client } = require('ssh2');
const db = require('../db');
const datacenters = require('../datacenters');
const hetzner = require('../Hetzner/hetzner-api');

const TARGET_IP = '91.107.245.81';
const TARGET_SERVER_ID = '166290719';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function tcpOpen(host, port = 22, timeoutMs = 3000) {
  return new Promise(resolve => {
    const s = net.createConnection({host, port});
    let done = false;
    const finish = v => { if (done) return; done = true; s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs, () => finish(false));
    s.once('connect', () => finish(true));
    s.once('error', () => finish(false));
  });
}
async function waitTcp(host, timeoutMs = 150000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await tcpOpen(host)) return true;
    await sleep(3000);
  }
  return false;
}
async function waitAction(dc, action, timeoutMs = 180000) {
  const id = action?.id || action?.action?.id;
  if (id) await hetzner.waitHetznerAction(dc, id, timeoutMs);
}
async function hardCycle(dc, serverId) {
  const state = await hetzner.getHetznerServer(dc, serverId);
  if (String(state?.status || '').toLowerCase() !== 'off') {
    const off = await hetzner.hetznerRequest(dc, 'POST', '/servers/' + serverId + '/actions/poweroff', {});
    await waitAction(dc, off?.action);
  }
  await sleep(4000);
  const on = await hetzner.hetznerRequest(dc, 'POST', '/servers/' + serverId + '/actions/poweron', {});
  await waitAction(dc, on?.action);
}
function sshExec({host, password, command, timeoutMs = 120000}) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = '', stderr = '', timer;
    const cleanup = () => { if (timer) clearTimeout(timer); try { conn.end(); } catch (_) {} };
    conn.on('ready', () => conn.exec(command, (err, stream) => {
      if (err) { cleanup(); return reject(err); }
      stream.on('data', d => stdout += d.toString());
      stream.stderr.on('data', d => stderr += d.toString());
      stream.on('close', code => {
        cleanup();
        code === 0 ? resolve({stdout, stderr}) : reject(new Error('REMOTE_EXIT_' + code + ':' + stderr.slice(-600)));
      });
    }));
    conn.on('error', err => { cleanup(); reject(err); });
    conn.connect({host, port:22, username:'root', password, readyTimeout:20000, keepaliveInterval:5000, keepaliveCountMax:3});
    timer = setTimeout(() => { cleanup(); reject(new Error('SSH_TIMEOUT')); }, timeoutMs);
  });
}

(async () => {
  const purchases = await db.getAllPurchases();
  const p = purchases.find(x => String(x.server_id) === TARGET_SERVER_ID && String(x.public_ip || '') === TARGET_IP);
  if (!p) throw new Error('TARGET_PURCHASE_NOT_FOUND');
  const dc = datacenters[p.datacenter] || datacenters.hetzner;
  let rescueEnabled = false;
  try {
    const rescue = await hetzner.hetznerRequest(dc, 'POST', '/servers/' + TARGET_SERVER_ID + '/actions/enable_rescue', {type:'linux64'});
    const rescuePassword = rescue?.root_password || rescue?.action?.root_password;
    if (!rescuePassword) throw new Error('RESCUE_PASSWORD_MISSING');
    rescueEnabled = true;
    await waitAction(dc, rescue?.action);
    await hardCycle(dc, TARGET_SERVER_ID);
    if (!await waitTcp(TARGET_IP, 150000)) throw new Error('RESCUE_SSH_NOT_READY');

    const cmd = [
      'set -euo pipefail',
      'ROOT_DEV=/dev/sda1',
      'mkdir -p /mnt/hamoon-root',
      'mount -o ro "$ROOT_DEV" /mnt/hamoon-root',
      "trap 'umount /mnt/hamoon-root 2>/dev/null || true' EXIT",
      "echo '=== ARCH ==='",
      'uname -a || true',
      'file /mnt/hamoon-root/bin/sh /mnt/hamoon-root/usr/lib/systemd/systemd 2>/dev/null || true',
      'cat /mnt/hamoon-root/etc/os-release 2>/dev/null || true',
      "echo '=== USR-MERGE / INIT ==='",
      'ls -ld /mnt/hamoon-root/bin /mnt/hamoon-root/sbin /mnt/hamoon-root/lib /mnt/hamoon-root/lib64 2>/dev/null || true',
      'ls -l /mnt/hamoon-root/bin/sh /mnt/hamoon-root/usr/bin/sh /mnt/hamoon-root/usr/bin/bash /mnt/hamoon-root/sbin/init /mnt/hamoon-root/usr/sbin/init 2>/dev/null || true',
      'readlink /mnt/hamoon-root/bin 2>/dev/null || true',
      'readlink /mnt/hamoon-root/sbin 2>/dev/null || true',
      'readlink /mnt/hamoon-root/lib 2>/dev/null || true',
      'readlink /mnt/hamoon-root/lib64 2>/dev/null || true',
      "echo '=== CRITICAL BINARIES ==='",
      'ls -ld /mnt/hamoon-root/usr/bin /mnt/hamoon-root/usr/sbin /mnt/hamoon-root/usr/lib/systemd 2>/dev/null || true',
      'for x in sh dash bash env mount ip systemctl init; do echo --$x--; find /mnt/hamoon-root/usr /mnt/hamoon-root/bin /mnt/hamoon-root/sbin -maxdepth 4 -name "$x" -ls 2>/dev/null | head -n 12; done',
      'for x in /mnt/hamoon-root/usr/bin/dash /mnt/hamoon-root/usr/bin/bash /mnt/hamoon-root/usr/bin/env /mnt/hamoon-root/usr/bin/mount /mnt/hamoon-root/usr/bin/systemctl /mnt/hamoon-root/usr/sbin/init /mnt/hamoon-root/usr/lib/systemd/systemd; do printf "%s " "$x"; if [ -e "$x" ] || [ -L "$x" ]; then stat -Lc "%F %a %s" "$x" 2>/dev/null || ls -l "$x"; else echo MISSING; fi; done',
      "echo '=== PACKAGE STATUS ==='",
      "dpkg-query --admindir=/mnt/hamoon-root/var/lib/dpkg -W -f='${Package} ${Version} ${db:Status-Abbrev}\\n' bash dash systemd systemd-sysv init-system-helpers openssh-server 2>/dev/null || true",
      "echo '=== FSTAB ==='",
      'cat /mnt/hamoon-root/etc/fstab 2>/dev/null || true',
      "echo '=== PARTITIONS ==='",
      'lsblk -o NAME,PATH,SIZE,TYPE,FSTYPE,UUID,PARTUUID,LABEL,MOUNTPOINTS || true',
      'blkid || true',
      'fdisk -l /dev/sda 2>/dev/null || true',
      "echo '=== EFI PARTITION ==='",
      'EFI_DEV=$(blkid -U EC56-40F3 2>/dev/null || true)',
      'echo EFI_DEV=$EFI_DEV',
      'if [ -n "$EFI_DEV" ]; then mkdir -p /mnt/hamoon-efi; mount -o ro "$EFI_DEV" /mnt/hamoon-efi; find /mnt/hamoon-efi -maxdepth 4 -type f -printf "%p %s bytes %TY-%Tm-%Td %TH:%TM:%TS\\n" 2>/dev/null | sort; umount /mnt/hamoon-efi; fi',
      "echo '=== ROOT FS ==='",
      'df -h /mnt/hamoon-root || true',
      "tune2fs -l \"$ROOT_DEV\" 2>/dev/null | grep -E 'Filesystem state|Errors behavior|Last mount time|Last write time|Mount count|Maximum mount count|Last checked|Check interval' || true",
      "echo '=== BOOT TREE ==='",
      "find /mnt/hamoon-root/boot -maxdepth 2 -type f -printf '%p %s bytes\\n' 2>/dev/null | sort | tail -n 220 || true",
      'ls -lah /mnt/hamoon-root/boot 2>/dev/null || true',
      'ls -lah /mnt/hamoon-root/boot/grub 2>/dev/null || true',
      "echo '=== KERNELS ==='",
      'ls -1 /mnt/hamoon-root/lib/modules 2>/dev/null || true',
      'ls -l /mnt/hamoon-root/vmlinuz /mnt/hamoon-root/initrd.img 2>/dev/null || true',
      "echo '=== GRUB DEFAULT ==='",
      'cat /mnt/hamoon-root/etc/default/grub 2>/dev/null || true',
      "echo '=== GRUB MENU ==='",
      "grep -nE '^(menuentry|submenu)|linux[[:space:]]+/boot|initrd[[:space:]]+/boot' /mnt/hamoon-root/boot/grub/grub.cfg 2>/dev/null | tail -n 220 || true",
      "echo '=== DEFAULT TARGET ==='",
      'readlink -f /mnt/hamoon-root/etc/systemd/system/default.target 2>/dev/null || true',
      "echo '=== LAST BOOTS ==='",
      'journalctl --directory=/mnt/hamoon-root/var/log/journal --list-boots --no-pager 2>/dev/null | tail -n 24 || true',
      "echo '=== LAST BOOT WARNINGS ==='",
      'journalctl --directory=/mnt/hamoon-root/var/log/journal -b -1 -p warning..alert --no-pager 2>/dev/null | tail -n 600 || true',
      "echo '=== LAST BOOT KERNEL ==='",
      'journalctl --directory=/mnt/hamoon-root/var/log/journal -b -1 -k --no-pager 2>/dev/null | tail -n 650 || true',
      "echo '=== LAST BOOT CORE ==='",
      "journalctl --directory=/mnt/hamoon-root/var/log/journal -b -1 --no-pager 2>/dev/null | grep -E 'Reached target|Failed to|Dependency failed|emergency|rescue|mount|fsck|systemd-networkd|network-online|sshd|ssh.service|cloud-init|cloud-final|segfault|panic|OOM|read-only|I/O error' | tail -n 850 || true",
      "echo '=== RECOVERY SERVICE ==='",
      'ls -l /mnt/hamoon-root/etc/systemd/system/multi-user.target.wants/hamoon-network-recovery.service 2>/dev/null || true',
      'cat /mnt/hamoon-root/etc/systemd/system/hamoon-network-recovery.service 2>/dev/null || true',
      'test -e /mnt/hamoon-root/run/hamoon-recovery/network.ok && cat /mnt/hamoon-root/run/hamoon-recovery/network.ok || echo RECOVERY_RUNTIME_MARKER_ABSENT',
      "echo '=== SSH UNIT ==='",
      'ls -l /mnt/hamoon-root/usr/lib/systemd/system/ssh.service /mnt/hamoon-root/lib/systemd/system/ssh.service /mnt/hamoon-root/etc/systemd/system/multi-user.target.wants/ssh.service 2>/dev/null || true',
      "grep -nE '^(ExecStart|After|Wants|Requires|Condition|Type|WantedBy|Alias)' /mnt/hamoon-root/usr/lib/systemd/system/ssh.service 2>/dev/null || true",
      "echo '=== BOOT DIAG DONE ==='"
    ].join('\n');
    const out = await sshExec({host:TARGET_IP, password:rescuePassword, command:cmd, timeoutMs:120000});
    console.log(out.stdout.slice(0,100000));
    if (out.stderr) console.log('STDERR=' + out.stderr.slice(0,5000));
  } finally {
    if (rescueEnabled) {
      try {
        const disable = await hetzner.hetznerRequest(dc, 'POST', '/servers/' + TARGET_SERVER_ID + '/actions/disable_rescue', {});
        await waitAction(dc, disable?.action);
        await hardCycle(dc, TARGET_SERVER_ID);
      } catch (_) {}
    }
    await db.pool.end().catch(() => {});
  }
})().catch(e => {
  console.error('BOOT_DIAG_FATAL=' + String(e?.message || e).slice(0,500));
  process.exitCode = 1;
});