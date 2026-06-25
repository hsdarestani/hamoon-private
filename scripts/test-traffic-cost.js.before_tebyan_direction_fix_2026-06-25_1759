#!/usr/bin/env node
require('dotenv').config();
const db = require('../db');
const datacenters = require('../datacenters');
const { calculateTrafficCost } = require('../billing-utils');
(async () => {
  const serverId = process.argv[2];
  if (!serverId) { console.error('Usage: node scripts/test-traffic-cost.js SERVER_ID'); process.exit(2); }
  const p = await db.getPurchaseByServerId(serverId);
  if (!p) throw new Error('Purchase not found');
  const c = await calculateTrafficCost(p, p.created_at, new Date(), datacenters[p.datacenter]);
  console.log(`received: ${c.received_gb} GB`);
  console.log(`transmitted: ${c.transmitted_gb} GB`);
  console.log(`free allowance: ${c.freeAllowanceGb} GB`);
  console.log(`billable GB: ${c.cumulativeBillableAfterFreeGb}`);
  console.log(`already billed GB: ${c.alreadyBilledGb}`);
  console.log(`new billable GB: ${c.newBillableGb}`);
  console.log(`price per GB: ${c.pricePerGb}`);
  console.log(`traffic cost: ${c.trafficCost}`);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
