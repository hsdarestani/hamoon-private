'use strict';

const fs = require('fs');

function replaceOnce(path, oldText, newText, label) {
  const source = fs.readFileSync(path, 'utf8');
  if (source.includes(newText)) {
    console.log(`${path}: ${label} already applied`);
    return;
  }
  const count = source.split(oldText).length - 1;
  if (count !== 1) throw new Error(`${path}: ${label} expected 1 match, found ${count}`);
  fs.writeFileSync(path, source.replace(oldText, newText));
  console.log(`${path}: ${label} applied`);
}

replaceOnce(
  'runtime-bootstrap.js',
  `    HETZNER_IP_QUALITY_INCONCLUSIVE_FAIL_OPEN_MS: String(10 * 365 * 24 * 60 * 60 * 1000),\n    HETZNER_IP_QUALITY_INCONCLUSIVE_ROTATE_PROBES: '2',`,
  `    // If the server itself is running and SSH is reachable, an external Check-Host\n    // inconclusive result must not strand a paid server indefinitely. Keep a short\n    // observation window, then deliver while background checks may continue.\n    HETZNER_IP_QUALITY_INCONCLUSIVE_FAIL_OPEN_MS: String(3 * 60 * 1000),\n    // Definitive failures still rotate immediately in the lifecycle. Inconclusive\n    // probes should wait for fail-open instead of churning IPs.\n    HETZNER_IP_QUALITY_INCONCLUSIVE_ROTATE_PROBES: '10',`,
  'bounded inconclusive fail-open'
);

replaceOnce(
  'index-core.js',
  `        '✅ SSH در دسترس است.',\n        '✅ تست دسترسی IP از ایران و چند نقطه خارجی تأیید شد.',\n        \`🔑 <b>رمز عبور روت:</b>\\n\${htmlCodeBlock(password)}\``,
  `        '✅ SSH در دسترس است.',\n        item.quality_fail_open\n          ? '✅ سرور روشن و SSH قابل دسترسی است؛ بررسی‌های تکمیلی شبکه در پس‌زمینه ادامه دارد.'\n          : '✅ تست دسترسی IP از ایران و چند نقطه خارجی تأیید شد.',\n        \`🔑 <b>رمز عبور روت:</b>\\n\${htmlCodeBlock(password)}\``,
  'accurate fail-open delivery message'
);

console.log('apply-hetzner-pending-delivery-unblock: ok');
