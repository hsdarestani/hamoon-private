'use strict';

function applyZibalRefererPatches(source) {
  const direct = 'const payUrl = `https://gateway.zibal.ir/start/${trackId}`;';
  const intermediary = 'const payUrl = `https://pay.hamooncloud.ir/payment/start/${trackId}`;';

  const count = String(source).split(direct).length - 1;
  if (count !== 1) {
    const err = new Error(`ZIBAL_REFERER_PAYMENT_URL_MARKER_MISMATCH:${count}`);
    err.code = 'ZIBAL_REFERER_PAYMENT_URL_MARKER_MISMATCH';
    throw err;
  }

  const patched = String(source).replace(direct, intermediary);
  if (!patched.includes(intermediary) || patched.includes(direct)) {
    const err = new Error('ZIBAL_REFERER_PATCH_FAILED');
    err.code = 'ZIBAL_REFERER_PATCH_FAILED';
    throw err;
  }
  return patched;
}

module.exports = { applyZibalRefererPatches };
