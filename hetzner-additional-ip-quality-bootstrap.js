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
      '      description: `HamoonCloud user ${userId} server ${serverId}`,',
      '      onProgress: async progress => {',
      "        if (progress?.stage === 'quality_check') {",
      '          const label = Number(progress.attempt || 1);',
      '          const total = Number(progress.attempts || 1);',
      "          await sendMessage(chatId, `🔎 IP کاندید ${label} از ${total} ساخته شد و الان دسترسی آن از ایران و خارج در حال تست است...`);",
      '        }',
      "        if (progress?.stage === 'candidate_rejected' && Number(progress.attempt || 0) < Number(progress.attempts || 0)) {",
      '          const next = Number(progress.attempt || 0) + 1;',
      '          const total = Number(progress.attempts || 1);',
      "          await sendMessage(chatId, `🔄 این IP مناسب نبود. در حال امتحان IP ${next} از ${total}...`);",
      '        }',
      '      }',
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
      "    if (error.code === 'ADDITIONAL_IP_SEARCH_TIMEOUT') {",
      "      return sendMessage(chatId, '⏱ در بازه زمانی تعیین‌شده IP سالم و تأییدشده پیدا نشد. عملیات خودکار متوقف شد، IP موقت پاک شد و هیچ هزینه‌ای کسر نشد. دوباره تلاش کنید.');",
      '    }',
      "    if (error.code === 'NO_CLEAN_ADDITIONAL_IPV4_AVAILABLE') {",
      "      return sendMessage(chatId, '❌ چند IPv4 بررسی شد اما فعلاً IP سالم و تأییدشده‌ای پیدا نشد. هیچ IP تأییدنشده‌ای ثبت نشد و هزینه‌ای هم کسر نشد.');",
      '    }',
      "    if (error.code === 'ADDITIONAL_IP_QUALITY_VERIFY_UNAVAILABLE') {",
      "      const cause = error?.cause?.code || '';",
      "      if (cause === 'SSH_AUTH_FAILED') return sendMessage(chatId, '❌ اتصال SSH با رمز ذخیره‌شده تأیید نشد. یک بار از مدیریت سرور ریست پسورد را انجام دهید و سپس دوباره افزودن IP را بزنید. هزینه‌ای کسر نشد.');",
      "      if (cause === 'SSH_TIMEOUT' || cause === 'SSH_CONNECTION_FAILED') return sendMessage(chatId, '❌ اتصال SSH به سرور برقرار نشد. روشن بودن سرور و دسترسی پورت ۲۲ را بررسی کنید. هزینه‌ای کسر نشد.');",
      "      return sendMessage(chatId, '❌ تست خودکار IP روی سرور کامل نشد؛ برای جلوگیری از تحویل IP تأییدنشده عملیات متوقف شد و هزینه‌ای کسر نشد.');",
      '    }',
      "    return sendMessage(chatId, '❌ ساخت IP اضافه در Hetzner انجام نشد. لطفاً دوباره تلاش کنید.');"
    ].join('\n'),
    'errors'
  );

  return source;
}

module.exports = { applyHetznerAdditionalIpQualityPatches };
