#!/usr/bin/env node
require('dotenv').config();
const db = require('../db');
const dc = require('../datacenters').tebyan;
const cloud = require('../cloud-api');
(async () => {
  const apply = process.argv.includes('--apply') && process.argv.includes('--confirm');
  console.log(`[reconcile-tebyan] mode=${apply ? 'apply' : 'dry-run'}`);
  let purchases;
  try { purchases = await db.listAdminServers({ datacenter: 'tebyan', limit: 200 }); }
  catch (e) { console.warn('[reconcile-tebyan] database unavailable; dry-run cannot inspect DB:', e.message); process.exit(0); }
  let tok = null;
  try { tok = await cloud.getToken(dc); } catch (e) { console.log('provider auth failed:', e.message); }
  for (const p of purchases.rows) {
    const issue = [];
    if (['pending_ssh','provisioning','deletion_pending'].includes(p.status)) issue.push(p.status);
    if (tok) {
      try { const s = await cloud.getServer(dc, tok, p.server_id); if (p.status === 'active' && ['BUILD','ERROR'].includes(s.status)) issue.push(`provider_${s.status}`); if (s['OS-EXT-STS:task_state']==='block_device_mapping') issue.push('stuck_block_device_mapping'); }
      catch(e){ if(e.response?.status===404 && p.status==='active') issue.push('provider_404'); }
    }
    if (issue.length) console.log(JSON.stringify({ server_id:p.server_id, db_status:p.status, issue }));
  }
  console.log('[reconcile-tebyan] no destructive action was performed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
