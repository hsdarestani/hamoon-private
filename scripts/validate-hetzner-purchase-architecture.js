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
assert(helperCalls === 3, 'purchase and rebuild flows use the architecture-aware image catalog');
assert(patched.includes('const selectedFlavorForImages = state[userId]?.selectedFlavor;'), 'image callback revalidates against selected flavor');
assert(patched.includes('const tok = isHetznerDc(dcConfig) ? null : await openstackApi.getToken(dcConfig);'), 'Hetzner image selection skips OpenStack token lookup');
assert(!patched.includes('Fetching images & snapshots for ${dcConfig.name}`);\n    const [images, snapshots] = await Promise.all([\n      openstackApi.listImages(dcConfig, tok).catch'), 'flavor step no longer uses unfiltered Hetzner image list');

assert(patched.includes('let serverType = purchase?.flavor_id || state[userId]?.selectedFlavor?.id || \'\';'), 'rebuild resolves the managed server plan from the purchase first');
assert(patched.includes('const providerServer = await openstackApi.getServer(dcConfig, null, serverId).catch(() => null);'), 'rebuild falls back to the provider server type when DB plan metadata is missing');
assert(patched.includes("? await require('./hetzner-purchase-images').listCompatibleImages(dcConfig, serverType)"), 'rebuild requests images for the current Hetzner architecture');
assert(patched.includes("return bot.sendMessage(chatId, '❌ در حال حاضر سیستم‌عامل سازگاری برای این پلن پیدا نشد. لطفاً با پشتیبانی تماس بگیرید.');"), 'rebuild never sends an empty image keyboard');

const snapshotBypasses = (patched.match(/!isHetznerDc\(dcConfig\) && hasCapability\(dcConfig, 'listSnapshots'\)/g) || []).length;
assert(snapshotBypasses === 2, 'Hetzner purchase flow bypasses unsupported snapshot lookup in both selection steps');
assert(patched.includes('// HAMOON_IMAGE_CONFIRM_RESILIENT_V2'), 'image confirmation uses resilient Telegram edit fallback');
assert(patched.includes("await editOrSendMessage(chatId, messageId, messageText, {\n      parse_mode: 'MarkdownV2'"), 'image confirmation falls back from edit to send');
assert(patched.includes("escapeMarkdownV2('-' + formatToman(loyaltyPreview.creditUsable))"), 'negative loyalty credit is escaped as one MarkdownV2 value');
assert(!patched.includes('اعتبار باشگاه: -${escapeMarkdownV2(formatToman(loyaltyPreview.creditUsable))}'), 'raw MarkdownV2 minus is removed from loyalty confirmation');
assert(patched.includes('// HAMOON_MARKDOWNV2_PLAIN_FALLBACK_V1'), 'MarkdownV2 confirmation has a plain-text last-resort fallback');
assert(patched.includes("delete safeOptions.parse_mode;"), 'plain-text fallback removes Markdown parse mode');

new Function('require', 'module', 'exports', '__filename', '__dirname', patched);
console.log('validate-hetzner-purchase-architecture: ok');