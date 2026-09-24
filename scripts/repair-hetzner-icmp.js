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

async function hardPowerCycle(dc, serverId) {
  const current = await hetzner.getHetznerServer(dc, serverId);
  if (String(current?.status || '').toLowerCase() !== 'off') {
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
          else reject(new Error(`REMOTE_ICMP_REPAIR_FAILED_${code}: ${stderr.slice(-600)}`));
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
      reject(new Error('SSH_ICMP_REPAIR_TIMEOUT'));
    }, timeoutMs);
  });
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function buildRepairCommand() {
  const lines = [
    'set -euo pipefail',
    'ROOT_DEV="$(lsblk -bpnro NAME,FSTYPE,SIZE | grep -E \' (ext4|xfs|btrfs) \' | sort -k3,3nr | head -n1 | awk \'{print $1}\')"',
    'if [ -z "$ROOT_DEV" ]; then echo ROOT_DEVICE_NOT_FOUND >&2; exit 31; fi',
    'mkdir -p /mnt/hamoon-root',
    'mount "$ROOT_DEV" /mnt/hamoon-root',
    'cleanup() { umount /mnt/hamoon-root 2>/dev/null || true; }',
    'trap cleanup EXIT',
    'test -f /mnt/hamoon-root/etc/os-release || { echo INSTALLED_ROOT_NOT_FOUND >&2; exit 32; }',
    'STAMP="$(date -u +%Y%m%dT%H%M%SZ)"',
    'BACKUP="/mnt/hamoon-root/root/hamoon-icmp-recovery-$STAMP"',
    'mkdir -p "$BACKUP"',
    'cp -a /mnt/hamoon-root/etc/sysctl.conf "$BACKUP/" 2>/dev/null || true',
    'cp -a /mnt/hamoon-root/etc/sysctl.d "$BACKUP/" 2>/dev/null || true',
    'cp -a /mnt/hamoon-root/etc/ufw "$BACKUP/" 2>/dev/null || true',
    'mkdir -p /mnt/hamoon-root/etc/sysctl.d',
    'printf "%s\\n" "net.ipv4.icmp_echo_ignore_all = 0" > /mnt/hamoon-root/etc/sysctl.d/99-hamoon-icmp.conf',
    'if [ -f /mnt/hamoon-root/etc/ufw/before.rules ]; then',
    '  if ! grep -Eq "ufw-before-input.*icmp.*echo-request.*ACCEPT" /mnt/hamoon-root/etc/ufw/before.rules; then',
    '    python3 - <<\'PY\'',
    'from pathlib import Path',
    'p=Path("/mnt/hamoon-root/etc/ufw/before.rules")',
    's=p.read_text()',
    'rule="-A ufw-before-input -p icmp --icmp-type echo-request -j ACCEPT"',
    'if rule not in s:',
    '    idx=s.find("\\nCOMMIT\\n")',
    '    if idx == -1:',
    '        raise SystemExit("UFW_COMMIT_NOT_FOUND")',
    '    s=s[:idx]+"\\n"+rule+s[idx:]',
    '    p.write_text(s)',
    'PY',
    '  fi',
    'fi',
    'cat > /mnt/hamoon-root/etc/systemd/system/hamoon-icmp-allow.service <<\'EOF\'',
    '[Unit]',
    'Description=Allow ICMP echo requests for monitoring',
    'After=network-online.target ufw.service',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=oneshot',
    'ExecStart=/bin/sh -c \'/usr/sbin/iptables -C INPUT -p icmp --icmp-type echo-request -j ACCEPT 2>/dev/null || /usr/sbin/iptables -I INPUT 1 -p icmp --icmp-type echo-request -j ACCEPT\'',
    'RemainAfterExit=yes',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    'EOF',
    'mkdir -p /mnt/hamoon-root/etc/systemd/system/multi-user.target.wants',
    'ln -sf /etc/systemd/system/hamoon-icmp-allow.service /mnt/hamoon-root/etc/systemd/system/multi-user.target.wants/hamoon-icmp-allow.service',
    'echo "ROOT_DEV=$ROOT_DEV"',
    'echo "ICMP_SYSCTL=$(cat /mnt/hamoon-root/etc/sysctl.d/99-hamoon-icmp.conf)"',
    'echo "ICMP_SERVICE=$(test -L /mnt/hamoon-root/etc/systemd/system/multi-user.target.wants/hamoon-icmp-allow.service && echo enabled || echo missing)"',
    'echo "REPAIR_BACKUP=$BACKUP"',
    'echo ICMP_REPAIR_OK'
  ];
  return 'bash -lc ' + shellSingleQuote(lines.join('\n'));
}

async function pingCheck(ip) {
  const { execFile } = require('child_process');
  return new Promise(resolve => {
    execFile('ping', ['-c', '3', '-W', '2', ip], { timeout: 10000 }, err => resolve(!err));
  });
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

  let rescueEnabled = false;
  try {
    const rescue = await hetzner.hetznerRequest(dc, 'POST', `/servers/${serverId}/actions/enable_rescue`, { type: 'linux64' });
    const rescuePassword = rescue?.root_password || rescue?.action?.root_password || null;
    if (!rescuePassword) throw new Error('RESCUE_PASSWORD_MISSING');
    rescueEnabled = true;
    await waitAction(dc, rescue?.action);

    await hardPowerCycle(dc, serverId);
    if (!await waitTcp(ip, 150000)) throw new Error('RESCUE_SSH_DID_NOT_START');

    const repaired = await sshExec({
      host: ip,
      password: rescuePassword,
      command: buildRepairCommand(),
      timeoutMs: 120000
    });
    if (!repaired.stdout.includes('ICMP_REPAIR_OK')) throw new Error('ICMP_REPAIR_CONFIRMATION_MISSING');
    console.log(repaired.stdout);

    const disable = await hetzner.hetznerRequest(dc, 'POST', `/servers/${serverId}/actions/disable_rescue`, {});
    await waitAction(dc, disable?.action);
    rescueEnabled = false;

    await hardPowerCycle(dc, serverId);
    if (!await waitTcp(ip, 150000)) throw new Error('SSH_NOT_REACHABLE_AFTER_ICMP_REPAIR');

    const pingOk = await pingCheck(ip);
    console.log('[ICMP_REPAIR] VERIFY', { server_id: serverId, ip, ssh: true, ping: pingOk });
    if (!pingOk) throw new Error('PING_STILL_UNREACHABLE_AFTER_REPAIR');
  } catch (error) {
    if (rescueEnabled) {
      try {
        const disable = await hetzner.hetznerRequest(dc, 'POST', `/servers/${serverId}/actions/disable_rescue`, {});
        await waitAction(dc, disable?.action);
        await hardPowerCycle(dc, serverId);
      } catch (_) {}
    }
    throw error;
  } finally {
    await db.pool.end().catch(() => {});
  }
}

main().catch(error => {
  console.error('[ICMP_REPAIR] FAILED:', String(error?.message || error).slice(0, 240));
  process.exitCode = 1;
});
