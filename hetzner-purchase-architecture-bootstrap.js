'use strict';

function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`[hetzner-purchase-architecture-bootstrap] ${label}: expected 1 match, found ${count}`);
  }
  return source.replace(before, after);
}

function applyHetznerPurchaseArchitecturePatches(coreSource) {
  let source = String(coreSource);

  const flavorBefore = [
    '    console.log(`🟢 [handleFlavorSelection] Fetching images & snapshots for ${dcConfig.name}`);',
    '    const [images, snapshots] = await Promise.all([',
    '      openstackApi.listImages(dcConfig, tok).catch(err => {'
  ].join('\n');

  const flavorAfter = [
    '    console.log(`🟢 [handleFlavorSelection] Fetching images & snapshots for ${dcConfig.name}`);',
    '    const purchaseImagePromise = isHetznerDc(dcConfig)',
    "      ? require('./hetzner-purchase-images').listCompatibleImages(dcConfig, selectedFlavor.id || selectedFlavor.hetzner_type || selectedFlavor.server_type)",
    '      : openstackApi.listImages(dcConfig, tok);',
    '    const [images, snapshots] = await Promise.all([',
    '      purchaseImagePromise.catch(err => {'
  ].join('\n');

  source = replaceOnce(source, flavorBefore, flavorAfter, 'flavor image catalog');

  const imageBefore = [
    '    console.log(`🟢 [handleImageSelection] Triggered for user ${userId} in ${dcConfig.name}`);',
    '    const tok = await openstackApi.getToken(dcConfig);',
    '',
    '    // دریافت ایمیج‌ها و اسنپ‌شات‌های مخصوص همین کاربر',
    '    const [images, snapshots] = await Promise.all([',
    '      openstackApi.listImages(dcConfig, tok).catch(err => {'
  ].join('\n');

  const imageAfter = [
    '    console.log(`🟢 [handleImageSelection] Triggered for user ${userId} in ${dcConfig.name}`);',
    '    const tok = isHetznerDc(dcConfig) ? null : await openstackApi.getToken(dcConfig);',
    '    const selectedFlavorForImages = state[userId]?.selectedFlavor;',
    '    if (isHetznerDc(dcConfig) && !selectedFlavorForImages) {',
    "      return sendMessage(chatId, '❌ اطلاعات پلن منقضی شده است. لطفاً خرید را دوباره شروع کنید.');",
    '    }',
    '    const purchaseImagePromise = isHetznerDc(dcConfig)',
    "      ? require('./hetzner-purchase-images').listCompatibleImages(dcConfig, selectedFlavorForImages.id || selectedFlavorForImages.hetzner_type || selectedFlavorForImages.server_type)",
    '      : openstackApi.listImages(dcConfig, tok);',
    '',
    '    // دریافت ایمیج‌ها و اسنپ‌شات‌های مخصوص همین کاربر',
    '    const [images, snapshots] = await Promise.all([',
    '      purchaseImagePromise.catch(err => {'
  ].join('\n');

  source = replaceOnce(source, imageBefore, imageAfter, 'selected image validation');

  return source;
}

module.exports = { applyHetznerPurchaseArchitecturePatches };
