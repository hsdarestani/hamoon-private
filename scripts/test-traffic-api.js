#!/usr/bin/env node
require('dotenv').config();
const datacenters = require('../datacenters');
const { fetchServerTraffic } = require('../billing-utils');
(async () => {
  const dcKey = process.argv[2] || 'tebyan';
  const serverId = process.argv[3];
  if (!serverId) { console.error('Usage: node scripts/test-traffic-api.js tebyan SERVER_ID'); process.exit(2); }
  const end = Math.floor(Date.now()/1000); const start = end - 3600;
  const data = await fetchServerTraffic(datacenters[dcKey], serverId, start, end);
  console.log(JSON.stringify(data, null, 2));
})().catch(e => { console.error(e.message); process.exit(1); });
