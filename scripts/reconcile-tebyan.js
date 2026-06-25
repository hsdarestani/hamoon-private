#!/usr/bin/env node
'use strict';
require('dotenv').config();
const db = require('../db');
const dc = require('../datacenters').tebyan;
const cloud = require('../cloud-api');
const { isBillablePurchaseStatus } = require('../billing-status');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const confirm = args.includes('--confirm');
const serverArg = args[args.indexOf('--server') + 1];
if (apply && !confirm && args.includes('--stuck')) { console.error('--stuck --apply requires --confirm'); process.exit(2); }
(async()=>{
  const report = { mode: apply ? 'apply' : 'dry-run', findings: [] };
  const purchases = await db.getAllPurchases().catch(()=>[]);
  const selected = serverArg ? purchases.filter(p=>String(p.server_id)===String(serverArg)) : purchases.filter(p=>p.datacenter==='tebyan');
  let tok=null; try { tok = await cloud.getToken(dc); } catch(e) { report.findings.push({code:'TEBYAN_AUTH_FAILED', error:e.code||e.message}); }
  for (const p of selected) {
    if (!p.server_id) { report.findings.push({code:'STALE_NULL_TEST_OR_PURCHASE_ROW', purchase:p}); continue; }
    let live=null, err=null;
    if (tok) try { live = await cloud.getServer(dc,tok,p.server_id); } catch(e) { err=e; }
    const status = String(live?.status||'').toUpperCase();
    const task = live?.['OS-EXT-STS:task_state'];
    if (p.status==='active' && status==='BUILD') report.findings.push({code: task==='block_device_mapping'?'DB_ACTIVE_PROVIDER_STUCK_BUILD':'DB_ACTIVE_PROVIDER_BUILD', server_id:p.server_id, telegram_id:p.telegram_id, task_state:task, billable:isBillablePurchaseStatus(p.status)});
    if (p.status==='active' && status==='ERROR') report.findings.push({code:'DB_ACTIVE_PROVIDER_ERROR', server_id:p.server_id});
    if (p.status==='active' && err?.response?.status===404) report.findings.push({code:'DB_ACTIVE_PROVIDER_404', server_id:p.server_id});
    if (p.status==='deleted' && live) report.findings.push({code: status==='BUILD'?'DB_DELETED_PROVIDER_STILL_DELETING':'DB_DELETED_PROVIDER_EXISTS', server_id:p.server_id, provider_status:status});
    if (live && !JSON.stringify(live.addresses||{}).match(/\b\d+\.\d+\.\d+\.\d+\b/)) report.findings.push({code:'MISSING_IP', server_id:p.server_id});
    if (['pending_ssh','pending_ip','provisioning','building'].includes(p.status)) report.findings.push({code:p.status.toUpperCase(), server_id:p.server_id});
  }
  console.log(JSON.stringify(report,null,2));
  await db.pool.end();
})().catch(async e=>{ console.error(e); await db.pool.end().catch(()=>{}); process.exit(1); });
