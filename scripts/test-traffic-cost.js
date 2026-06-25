#!/usr/bin/env node
'use strict';

require('dotenv').config();

const db = require('../db');
const datacenters = require('../datacenters');
const { calculateTrafficCost } = require('../billing-utils');

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let dcKey;
let serverId;

if (uuidRe.test(String(process.argv[2] || ''))) {
  serverId = process.argv[2];
  dcKey = process.argv[3];
} else {
  dcKey = process.argv[2];
  serverId = process.argv[3];
}

if (!serverId) {
  console.error('Usage:');
  console.error('  node scripts/test-traffic-cost.js SERVER_ID');
  console.error('  node scripts/test-traffic-cost.js tebyan SERVER_ID');
  process.exit(2);
}

(async () => {
  const [rows] = await db.pool.execute(
    `SELECT *
     FROM purchases
     WHERE server_id = ?
     LIMIT 1`,
    [serverId]
  );

  if (!rows.length) {
    console.error('Purchase not found:', serverId);
    process.exit(1);
  }

  const purchase = rows[0];
  dcKey = dcKey || purchase.datacenter;

  const dcConfig = datacenters[dcKey];

  if (!dcConfig) {
    throw new Error(`Datacenter not found: ${dcKey}`);
  }

  const result = await calculateTrafficCost(
    purchase,
    purchase.created_at,
    new Date(),
    dcConfig
  );

  console.log('SERVER:', {
    server_id: purchase.server_id,
    server_name: purchase.server_name,
    datacenter: purchase.datacenter,
    status: purchase.status,
    duration: purchase.duration,
    price_per_gb: Number(purchase.price_per_gb || 0),
    download_only: Number(purchase.download_only || 0),
    last_billed_traffic_gb: Number(purchase.last_billed_traffic_gb || 0)
  });

  console.log('PROVIDER_RAW:', {
    received_gb: result.provider_received_gb,
    transmitted_gb: result.provider_transmitted_gb
  });

  console.log('CUSTOMER_VIEW:', {
    download_gb: result.download_gb ?? result.received_gb,
    upload_gb: result.upload_gb ?? result.transmitted_gb,
    total_gb: Number(result.rawBillableGb || 0)
  });

  console.log('BILLING:', {
    freeAllowanceGb: result.freeAllowanceGb,
    cumulativeBillableAfterFreeGb: result.cumulativeBillableAfterFreeGb,
    alreadyBilledGb: result.alreadyBilledGb,
    newBillableGb: result.newBillableGb,
    pricePerGb: result.pricePerGb,
    trafficCost: result.trafficCost
  });

  await db.pool.end();
})().catch(async error => {
  console.error('FATAL:', error.message);
  try { await db.pool.end(); } catch {}
  process.exit(1);
});
