'use strict';

const fs = require('fs');
const path = require('path');
const { applyPatches } = require('../runtime-bootstrap');
const { architectureForServerType, imageArchitecture } = require('../hetzner-purchase-images');

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`OK ${message}`);
}

const corePath = path.join(__dirname, '..', 'index-core.js');
const source = fs.readFileSync(corePath, 'utf8');
const patched = applyPatches(source);

assert(architectureForServerType('cax11') === 'arm', 'CAX plans resolve to ARM');
assert(architectureForServerType('cax21') === 'arm', 'CAX21 resolves to ARM');
assert(architectureForServerType('ccx13') === 'x86', 'CCX plans resolve to x86');
assert(architectureForServerType('cx33') === 'x86', 'CX plans resolve to x86');
assert(imageArchitecture({ architecture: 'arm' }) === 'arm', 'explicit ARM image architecture is preserved');
assert(imageArchitecture({ architecture: 'x86' }) === 'x86', 'explicit x86 image architecture is preserved');

const helperCalls = (patched.match(/hetzner-purchase-images'\)\.listCompatibleImages/g) || []).length;
assert(helperCalls === 2, 'purchase flow uses architecture-aware image catalog in both selection steps');
assert(patched.includes('const selectedFlavorForImages = state[userId]?.selectedFlavor;'), 'image callback revalidates against selected flavor');
assert(patched.includes('const tok = isHetznerDc(dcConfig) ? null : await openstackApi.getToken(dcConfig);'), 'Hetzner image selection skips OpenStack token lookup');
assert(!patched.includes('Fetching images & snapshots for ${dcConfig.name}`);\n    const [images, snapshots] = await Promise.all([\n      openstackApi.listImages(dcConfig, tok).catch'), 'flavor step no longer uses unfiltered Hetzner image list');

const snapshotBypasses = (patched.match(/!isHetznerDc\(dcConfig\) && hasCapability\(dcConfig, 'listSnapshots'\)/g) || []).length;
assert(snapshotBypasses === 2, 'Hetzner purchase flow bypasses unsupported snapshot lookup in both selection steps');
assert(patched.includes('// HAMOON_IMAGE_CONFIRM_RESILIENT_V2'), 'image confirmation uses resilient Telegram edit fallback');
assert(patched.includes("await editOrSendMessage(chatId, messageId, messageText, {\n      parse_mode: 'MarkdownV2'"), 'image confirmation falls back from edit to send');

new Function('require', 'module', 'exports', '__filename', '__dirname', patched);
console.log('validate-hetzner-purchase-architecture: ok');
