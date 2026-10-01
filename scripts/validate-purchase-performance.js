#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { applyPatches } = require('../runtime-bootstrap');

function assert(name, ok) {
  if (!ok) {
    console.error('FAIL', name);
    process.exitCode = 1;
  } else {
    console.log('OK', name);
  }
}

const core = fs.readFileSync('index-core.js', 'utf8');
const hetznerApi = fs.readFileSync('Hetzner/hetzner-api.js', 'utf8');
const purchaseImages = fs.readFileSync('hetzner-purchase-images.js', 'utf8');

assert('positive channel membership cache is enabled', core.includes('positiveChannelMembershipCache'));
assert('purchase plan catalog is prewarmed after datacenter selection', core.includes('[PURCHASE_PREWARM_PLANS_OK]'));
assert('purchase image catalogs are prewarmed after cycle selection', core.includes('[PURCHASE_PREWARM_IMAGES_DONE]'));
assert('purchase flavor catalog is reused inside the flow', core.includes('purchaseFlavorCatalog'));
assert('Hetzner plan requests are deduplicated', hetznerApi.includes('serverTypeInFlight') && hetznerApi.includes('const existingRequest = serverTypeInFlight.get(cacheKey)'));
assert('Hetzner image requests are deduplicated', purchaseImages.includes('imageInFlight') && purchaseImages.includes('const existingRequest = imageInFlight.get(key)'));

try {
  const runtime = applyPatches(core);
  new Function(runtime);
  assert('full runtime parses with purchase performance changes', true);
  assert('architecture aware purchase images remain enabled', runtime.includes("require('./hetzner-purchase-images').listCompatibleImages"));
  assert('purchase plan prewarm survives runtime patching', runtime.includes('[PURCHASE_PREWARM_PLANS_OK]'));
  assert('purchase image prewarm survives runtime patching', runtime.includes('[PURCHASE_PREWARM_IMAGES_DONE]'));
  assert('management remains DB first', runtime.includes('const datacenterKeys = []; // MANAGE_DB_FIRST'));
} catch (error) {
  console.error('FAIL runtime composition', error.message);
  process.exitCode = 1;
}

process.exit(process.exitCode || 0);
