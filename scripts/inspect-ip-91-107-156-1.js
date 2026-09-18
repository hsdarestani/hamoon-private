#!/usr/bin/env node
'use strict';

const IP = process.argv[2] || '91.107.156.1';
const BASE = 'https://check-host.net';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'HamoonCloud-Diagnostic/1.0' }});
  if (!r.ok) throw new Error(`HTTP_${r.status}: ${url}`);
  return r.json();
}

function flattenPing(v, out=[]) {
  if (typeof v === 'string') {
    const s=v.toUpperCase();
    if (s === 'OK') out.push(true);
    else if (s.includes('TIMEOUT') || s.includes('ERROR') || s.includes('FAIL') || s.includes('MALFORMED')) out.push(false);
  } else if (Array.isArray(v)) {
    for (const x of v) flattenPing(x,out);
  } else if (v && typeof v === 'object') {
    for (const x of Object.values(v)) flattenPing(x,out);
  }
  return out;
}
function pingState(v) {
  if (v == null) return null;
  const a=flattenPing(v);
  if (!a.length) return null;
  return {ok:a.filter(Boolean).length,total:a.length,pass:a.filter(Boolean).length >= Math.max(3,Math.ceil(a.length*0.75))};
}
function tcpState(v) {
  if (v == null) return null;
  let ok=false, fail=false, reasons=[];
  const visit=x=>{
    if (Array.isArray(x)) return x.forEach(visit);
    if (!x || typeof x!=='object') return;
    if (x.error) { fail=true; reasons.push(String(x.error)); }
    if ((Number.isFinite(Number(x.time)) && Number(x.time)>=0) || x.address) ok=true;
    for (const y of Object.values(x)) if (y && typeof y==='object') visit(y);
  };
  visit(v);
  return {ok: ok ? true : fail ? false : null, reasons:[...new Set(reasons)].slice(0,3)};
}

async function dispatch(path, host, nodes) {
  const u=new URL(BASE+path); u.searchParams.set('host',host);
  nodes.forEach(n=>u.searchParams.append('node',n));
  const p=await getJson(u);
  if (!p.ok || !p.request_id) throw new Error('dispatch failed '+JSON.stringify(p));
  let result={};
  for (let i=0;i<16;i++) {
    if(i) await sleep(1500);
    result=await getJson(BASE+'/check-result/'+encodeURIComponent(p.request_id));
    const done=nodes.filter(n=>result[n]!=null).length;
    if(done===nodes.length) break;
  }
  return result;
}

(async()=>{
  const np=await getJson(BASE+'/nodes/hosts');
  const entries=Object.entries(np.nodes||{}).filter(([,m])=>Array.isArray(m.location));
  const iran=entries.filter(([,m])=>String(m.location[0]||'').toLowerCase()==='ir').slice(0,10);
  if(!iran.length) throw new Error('NO_IRAN_NODES');
  const nodes=iran.map(([n])=>n);
  console.log('IP',IP);
  console.log('Iran nodes:', iran.map(([n,m])=>({node:n,location:m.location})));

  const ping=await dispatch('/check-ping',IP,nodes);
  const tcp22=await dispatch('/check-tcp',IP+':22',nodes);

  const rows=iran.map(([n,m])=>({
    node:n,
    location:m.location,
    ping:pingState(ping[n]),
    tcp22:tcpState(tcp22[n])
  }));
  console.log('RESULT_ROWS='+JSON.stringify(rows,null,2));
  const pOk=rows.filter(r=>r.ping?.pass===true).length;
  const tOk=rows.filter(r=>r.tcp22?.ok===true).length;
  const tFail=rows.filter(r=>r.tcp22?.ok===false).length;
  console.log('SUMMARY='+JSON.stringify({selected:rows.length,pingStrictSuccess:pOk,tcp22Success:tOk,tcp22Failure:tFail},null,2));
})().catch(e=>{console.error(e);process.exit(1);});
