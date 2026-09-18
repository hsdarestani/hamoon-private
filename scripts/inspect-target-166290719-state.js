'use strict';
require('dotenv').config();
const db=require('../db');
const datacenters=require('../datacenters');
const hetzner=require('../Hetzner/hetzner-api');
(async()=>{
 const ps=await db.getAllPurchases();
 const p=ps.find(x=>String(x.server_id)==='166290719');
 if(!p) throw new Error('TARGET_NOT_FOUND');
 const dc=datacenters[p.datacenter]||datacenters.hetzner;
 const s=await hetzner.getHetznerServer(dc,'166290719');
 const out={id:s.id,status:s.status,locked:s.locked,rescue_enabled:s.rescue_enabled,primary_disk_size:s.primary_disk_size,public_net:s.public_net,datacenter:s.datacenter,server_type:s.server_type};
 console.log(JSON.stringify(out,null,2));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{await db.pool.end().catch(()=>{})});