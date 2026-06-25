#!/usr/bin/env node
'use strict';
require('dotenv').config();
const datacenters = require('../datacenters');
const dcKey = process.argv[2] || 'tebyan';
const id = process.argv[3] || process.env.TRAFFIC_TEST_SERVER_ID;
const project = process.argv.includes('--project');
const dc = datacenters[dcKey];
if (!dc?.TRAFFIC_API_BASE_URL || !dc?.TRAFFIC_API_KEY) throw new Error('traffic API is not configured');
if (!id) throw new Error('server_id/projectId argument required');
const end = Math.floor(Date.now()/1000), start = end - 3600;
const url = `${dc.TRAFFIC_API_BASE_URL}${project?'project/':''}${encodeURIComponent(id)}?start_time=${start}&end_time=${end}`;
fetch(url, { headers: { Authorization: dc.TRAFFIC_API_KEY } }).then(async r=>{ console.log(JSON.stringify({url, status:r.status, ok:r.ok, body:(await r.text()).slice(0,1000)}, null, 2)); if(!r.ok) process.exit(1); }).catch(e=>{ console.error(e); process.exit(1); });
