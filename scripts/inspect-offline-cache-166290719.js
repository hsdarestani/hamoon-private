'use strict';
require('dotenv').config();
const net=require('net');
const {Client}=require('ssh2');
const db=require('../db');
const datacenters=require('../datacenters');
const hetzner=require('../Hetzner/hetzner-api');
const ID='166290719', IP='91.107.245.81';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitAction(dc,a){const id=a?.id||a?.action?.id;if(id)await hetzner.waitHetznerAction(dc,id,180000)}
async function hardCycle(dc){const s=await hetzner.getHetznerServer(dc,ID);if(String(s.status).toLowerCase()!=='off'){const a=await hetzner.hetznerRequest(dc,'POST','/servers/'+ID+'/actions/poweroff',{});await waitAction(dc,a?.action)}await sleep(3000);const b=await hetzner.hetznerRequest(dc,'POST','/servers/'+ID+'/actions/poweron',{});await waitAction(dc,b?.action)}
function tcp(){return new Promise(res=>{const s=net.createConnection({host:IP,port:22});let d=false;const f=v=>{if(d)return;d=true;s.destroy();res(v)};s.setTimeout(3000,()=>f(false));s.once('connect',()=>f(true));s.once('error',()=>f(false))})}
async function waitTcp(){for(let i=0;i<50;i++){if(await tcp())return true;await sleep(3000)}return false}
function ssh(password,command){return new Promise((resolve,reject)=>{const c=new Client();let out='',err='';c.on('ready',()=>c.exec(command,(e,st)=>{if(e)return reject(e);st.on('data',d=>out+=d);st.stderr.on('data',d=>err+=d);st.on('close',code=>{c.end();code===0?resolve(out):reject(new Error('REMOTE_'+code+':'+err.slice(-800)))})}));c.on('error',reject);c.connect({host:IP,port:22,username:'root',password,readyTimeout:20000})})}
(async()=>{
 const ps=await db.getAllPurchases();const p=ps.find(x=>String(x.server_id)===ID);if(!p)throw new Error('TARGET_NOT_FOUND');
 const dc=datacenters[p.datacenter]||datacenters.hetzner;
 const st=await hetzner.getHetznerServer(dc,ID);
 if(st.rescue_enabled){const d=await hetzner.hetznerRequest(dc,'POST','/servers/'+ID+'/actions/disable_rescue',{});await waitAction(dc,d?.action)}
 const r=await hetzner.hetznerRequest(dc,'POST','/servers/'+ID+'/actions/enable_rescue',{type:'linux64'});const pw=r?.root_password||r?.action?.root_password;if(!pw)throw new Error('NO_RESCUE_PASSWORD');await waitAction(dc,r?.action);await hardCycle(dc);if(!await waitTcp())throw new Error('RESCUE_SSH_DOWN');
 const sh=[
  'set -euo pipefail',
  'mkdir -p /mnt/r',
  'mount -o ro /dev/sda1 /mnt/r',
  "trap 'umount /mnt/r 2>/dev/null || true' EXIT",
  "echo '=== CACHE ==='",
  'find /mnt/r/var/cache/apt/archives -maxdepth 1 -type f -name "*.deb" -printf "%f %s\\n" 2>/dev/null | sort | tail -n 120 || true',
  "echo '=== BINARIES ==='",
  'for x in apt apt-get dpkg dpkg-deb bash dash env mount systemctl ip sshd init curl wget; do for d in /usr/bin /usr/sbin /bin /sbin; do if [ -e "/mnt/r$d/$x" ] || [ -L "/mnt/r$d/$x" ]; then echo "$x -> $d/$x"; ls -l "/mnt/r$d/$x"; break; fi; done; done',
  "echo '=== VERSIONS ==='",
  "for p in apt bash dash coreutils mount util-linux systemd systemd-sysv iproute2 openssh-server libc6 libsystemd0 libapt-pkg6.0t64; do printf '%s=' \"$p\"; dpkg-query --admindir=/mnt/r/var/lib/dpkg -W -f='${Version} ${db:Status-Abbrev}\\n' \"$p\" 2>/dev/null || true; done",
  "echo '=== LIST FILES ==='",
  'for p in apt bash coreutils mount util-linux systemd systemd-sysv iproute2 openssh-server; do echo "---$p"; grep -E "/(apt-get|apt|bash|env|mount|systemctl|systemd|init|ip|sshd)$" "/mnt/r/var/lib/dpkg/info/$p.list" 2>/dev/null || true; done',
  "echo '=== APT LISTS ==='",
  'find /mnt/r/var/lib/apt/lists -maxdepth 1 -type f -printf "%f %s\\n" 2>/dev/null | sort | tail -n 80 || true',
  "echo '=== RESCUE TOOLS ==='",
  'command -v curl || true; command -v wget || true; command -v dpkg-deb || true; command -v gzip || true; command -v xz || true',
  "echo '=== DONE ==='"
 ].join('\n');
 console.log(await ssh(pw,sh));
})().catch(e=>{console.error('CACHE_DIAG_FATAL='+String(e.message||e));process.exitCode=1}).finally(async()=>{await db.pool.end().catch(()=>{})});