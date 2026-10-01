#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { applyPatches } = require('../runtime-bootstrap');

function check(name, ok) {
  if (!ok) {
    console.error('FAIL', name);
    process.exitCode = 1;
  } else {
    console.log('OK', name);
  }
}

const core = fs.readFileSync('index-core.js', 'utf8');
const billing = fs.readFileSync('services/hetzner-additional-ip-billing.js', 'utf8');
const rebuild = fs.readFileSync('rebuild-bootstrap.js', 'utf8');

check('Hetzner manage has nonblocking background refresh', core.includes('scheduleHetznerManageRefresh(dcConfig, serverId)'));
check('Hetzner manage uses DB purchase before provider fallback', core.includes('if (isHetzner && purchase)'));
check('managed additional IP menu reads DB first', core.includes('additionalIpBilling.listActiveForServer'));
check('additional IP billing exposes fast server list', billing.includes('async function listActiveForServer') && billing.includes('listActiveForServer, listDue'));
check('rebuild fallback uses management cache', rebuild.includes('getCachedHetznerManageServer(dcConfig, serverId)'));
check('rebuild fallback no longer awaits provider server', !rebuild.includes('const providerServer = await openstackApi.getServer(dcConfig, null, serverId).catch(() => null)'));

try {
  const runtime = applyPatches(core);
  new Function(runtime);
  const manageStart = runtime.indexOf('async function handleServerManagement(chatId, userId, serverId, dcConfig)');
  const manageEnd = runtime.indexOf('async function getProjectTrafficSummary', manageStart);
  const manageBody = runtime.slice(manageStart, manageEnd);
  const rebuildStart = runtime.indexOf('async function handleRebuildAsk');
  const rebuildEnd = runtime.indexOf('async function handleRebuildConfirm', rebuildStart);
  const rebuildBody = runtime.slice(rebuildStart, rebuildEnd);

  check('runtime parses', true);
  check('runtime Hetzner management is DB first', manageBody.includes('if (isHetzner && purchase)'));
  check('runtime management schedules live refresh instead of awaiting it', manageBody.includes('scheduleHetznerManageRefresh(dcConfig, serverId)'));
  check('runtime rebuild does not block on getServer', !rebuildBody.includes('await openstackApi.getServer(dcConfig, null, serverId)'));
  check('runtime rebuild uses cached/prewarmed image catalog', rebuildBody.includes("require('./hetzner-purchase-images').listCompatibleImages"));
  check('management list remains DB first', runtime.includes('const datacenterKeys = []; // MANAGE_DB_FIRST'));
} catch (error) {
  console.error('FAIL runtime composition', error.stack || error.message);
  process.exitCode = 1;
}

process.exit(process.exitCode || 0);
