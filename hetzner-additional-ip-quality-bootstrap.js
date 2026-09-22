'use strict';

function count(source, needle) {
  return String(source).split(needle).length - 1;
}
function once(source, before, after, label) {
  const n = count(source, before);
  if (n !== 1) throw new Error(`[hetzner-additional-ip-quality] ${label}: ${n}`);
  return source.replace(before, after);
}

function applyHetznerAdditionalIpQualityPatches(coreSource) {
  let source = String(coreSource);

  source = once(
    source,
    "const additionalIps = require('./services/hetzner-additional-ips');\nconst additionalIpBilling = require('./services/hetzner-additional-ip-billing');",
    "const additionalIps = require('./services/hetzner-additional-ips');\nconst additionalIpQuality = require('./services/hetzner-additional-ip-quality');\nconst additionalIpBilling = require('./services/hetzner-additional-ip-billing');",
    'import'
  );

  source = once(
    source,
    [
      '    const result = await additionalIps.addAdditionalIpv4({',
      '      dc: dcConfig,',
      '      serverId,',
      '      description: `HamoonCloud user ${userId} server ${serverId}`',
      '    });'
    ].join('\n'),
    [
      '    const result = await additionalIpQuality.createVerifiedAdditionalIpv4({',
      '      dc: dcConfig,',
      '      serverId,',
      '      telegramId: userId,',
      '      description: `HamoonCloud user ${userId} server ${serverId}`',
      '    });'
    ].join('\n'),
    'create'
  );

  source = once(
    source,
    "await additionalIps.deleteAdditionalIp({ dc: dcConfig, serverId, floatingIpId: result.ip.id }).catch(() => {});",
    "await additionalIpQuality.deleteVerifiedAdditionalIp({ dc: dcConfig, serverId, floatingIpId: result.ip.id }).catch(() => {});",
    'billing cleanup'
  );

  source = once(
    source,
    "await additionalIps.deleteAdditionalIp({ dc, serverId: row.server_id, floatingIpId: row.floating_ip_id });",
    "await additionalIpQuality.deleteVerifiedAdditionalIp({ dc, serverId: row.server_id, floatingIpId: row.floating_ip_id });",
    'renewal cleanup'
  );

  source = once(
    source,
    "    return sendMessage(chatId, `✅ IPv4 اضافه با موفقیت ساخته و به سرور متصل شد:\\n${result.ip.ip}\\n💳 مبلغ ${pricing.amount.toLocaleString('fa-IR')} تومان از کیف پول کسر شد (اعتبار ۳۰ روز).\\n\\n⚠️ برای قابل استفاده شدن، این Floating IP را داخل سیستم‌عامل سرور هم پیکربندی کنید.`);",
    "    return sendMessage(chatId, `✅ IPv4 اضافه ساخته شد و تست دسترسی از ایران را پاس کرد:\\n${result.ip.ip}\\n💳 مبلغ ${pricing.amount.toLocaleString('fa-IR')} تومان از کیف پول کسر شد (اعتبار ۳۰ روز).\\n\\n✅ IP روی سیستم‌عامل سرور هم فعال شد. در صورت ریبوت سرور، تنظیم persistent شبکه باید حفظ/بررسی شود.`);",
    'success text'
  );

  source = once(
    source,
    [
      "    if (error.code === 'ADDITIONAL_IP_LIMIT_REACHED') {",
      "      return sendMessage(chatId, `❌ سقف IP اضافه این سرور (حداکثر ${error.limit}) پر شده است.`);",
      '    }',
      "    return sendMessage(chatId, '❌ ساخت IP اضافه در Hetzner انجام نشد. لطفاً دوباره تلاش کنید.');"
    ].join('\n'),
    [
      "    if (error.code === 'ADDITIONAL_IP_LIMIT_REACHED') {",
      "      return sendMessage(chatId, `❌ سقف IP اضافه این سرور (حداکثر ${error.limit}) پر شده است.`);",
      '    }',
      "    if (error.code === 'NO_CLEAN_ADDITIONAL_IPV4_AVAILABLE') {",
      "      return sendMessage(chatId, '❌ چند IPv4 بررسی شد اما فعلاً IP سالم و تأییدشده‌ای پیدا نشد. هیچ IP تأییدنشده‌ای ثبت نشد و هزینه‌ای هم کسر نشد.');",
      '    }',
      "    if (error.code === 'ADDITIONAL_IP_QUALITY_VERIFY_UNAVAILABLE') {",
      "      return sendMessage(chatId, '❌ تست خودکار IP روی سرور کامل نشد؛ برای جلوگیری از تحویل IP تأییدنشده عملیات متوقف شد و هزینه‌ای کسر نشد.');",
      '    }',
      "    return sendMessage(chatId, '❌ ساخت IP اضافه در Hetzner انجام نشد. لطفاً دوباره تلاش کنید.');"
    ].join('\n'),
    'errors'
  );

  return source;
}

module.exports = { applyHetznerAdditionalIpQualityPatches };
