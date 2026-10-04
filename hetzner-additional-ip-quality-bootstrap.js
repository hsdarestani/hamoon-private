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
    "async function handleHetznerAdditionalIpCreate(chatId, userId, serverId, dcConfig) {\n  const lockKey",
    "async function handleHetznerAdditionalIpCreate(chatId, userId, serverId, dcConfig) {\n  let additionalIpProgressMessage = null;\n  const lockKey",
    'progress state'
  );

  source = once(
    source,
    [
      "    await sendMessage(",
      "      chatId,",
      "      '⏳ درخواست ثبت شد. در حال ساخت، تنظیم و تست IP از ایران و خارج هستم. پیدا کردن IP سالم ممکن است چند دقیقه طول بکشد؛ تا اعلام نتیجه دوباره روی پرداخت نزنید.'",
      "    );"
    ].join('\n'),
    [
      "    additionalIpProgressMessage = await sendMessage(",
      "      chatId,",
      "      '⏳ در حال پیدا کردن IP سالم هستم. تست سریع انجام می‌شود و فقط کاندید مناسب وارد بررسی کامل خواهد شد.'",
      "    );"
    ].join('\n'),
    'progress message'
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
      '      maxAttempts: 6,',
      '      onProgress: async progress => {',
      "        if (progress?.stage !== 'attempt_start') return;",
      '        const label = Number(progress.attempt || 1);',
      '        const total = Number(progress.attempts || 1);',
      "        await editOrSendMessage(chatId, additionalIpProgressMessage?.message_id, `⏳ در حال جستجوی IP سالم... کاندید ${label} از ${total}`);",
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
    "    return editOrSendMessage(chatId, additionalIpProgressMessage?.message_id, `✅ IPv4 اضافه ساخته شد و تست دسترسی از ایران و خارج را پاس کرد:\\n${result.ip.ip}\\n💳 مبلغ ${pricing.amount.toLocaleString('fa-IR')} تومان از کیف پول کسر شد (اعتبار ۳۰ روز).\\n\\n✅ IP روی سیستم‌عامل سرور هم فعال شد.`);",
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
      "      return editOrSendMessage(chatId, additionalIpProgressMessage?.message_id, '⏱ در بازه زمانی تعیین‌شده IP سالم و تأییدشده پیدا نشد. عملیات متوقف شد و هیچ هزینه‌ای کسر نشد. دوباره تلاش کنید.');",
      '    }',
      "    if (error.code === 'NO_CLEAN_ADDITIONAL_IPV4_AVAILABLE') {",
      "      return editOrSendMessage(chatId, additionalIpProgressMessage?.message_id, '❌ چند IPv4 از چند pool بررسی شد اما فعلاً IP سالم پیدا نشد. هیچ IP تأییدنشده‌ای ثبت نشد و هزینه‌ای هم کسر نشد.');",
      '    }',
      "    if (error.code === 'ADDITIONAL_IP_QUALITY_VERIFY_UNAVAILABLE') {",
      "      const cause = error?.cause?.code || '';",
      "      if (cause === 'ROOT_PASSWORD_MISSING') return editOrSendMessage(chatId, additionalIpProgressMessage?.message_id, '❌ رمز روت ذخیره‌شده برای این سرور پیدا نشد. از مدیریت سرور یک بار ریست پسورد را بزنید و سپس افزودن IP را دوباره امتحان کنید. هزینه‌ای کسر نشد.');",
      "      if (cause === 'SERVER_METADATA_MISSING') return editOrSendMessage(chatId, additionalIpProgressMessage?.message_id, '❌ اطلاعات شبکه سرور از Hetzner کامل دریافت نشد. عملیات متوقف شد و هزینه‌ای کسر نشد.');",
      "      if (cause === 'SSH_AUTH_FAILED') return editOrSendMessage(chatId, additionalIpProgressMessage?.message_id, '❌ اتصال SSH با رمز ذخیره‌شده تأیید نشد. یک بار از مدیریت سرور ریست پسورد را انجام دهید و سپس دوباره افزودن IP را بزنید. هزینه‌ای کسر نشد.');",
      "      if (cause === 'SSH_TIMEOUT' || cause === 'SSH_CONNECTION_FAILED') return editOrSendMessage(chatId, additionalIpProgressMessage?.message_id, '❌ اتصال SSH به سرور برقرار نشد. روشن بودن سرور و دسترسی پورت ۲۲ را بررسی کنید. هزینه‌ای کسر نشد.');",
      "      return editOrSendMessage(chatId, additionalIpProgressMessage?.message_id, '❌ تست خودکار IP کامل نشد؛ برای جلوگیری از تحویل IP تأییدنشده عملیات متوقف شد و هزینه‌ای کسر نشد.');",
      '    }',
      "    return editOrSendMessage(chatId, additionalIpProgressMessage?.message_id, '❌ ساخت IP اضافه در Hetzner انجام نشد. لطفاً دوباره تلاش کنید.');"
    ].join('\n'),
    'errors'
  );

  source = once(
    source,
    "    console.error('[HETZNER_ADDITIONAL_IP_CREATE]', error.code || error.message);",
    "    console.error('[HETZNER_ADDITIONAL_IP_CREATE]', { code: error?.code || null, cause: error?.cause?.code || null, message: error?.message || String(error) });",
    'error logging'
  );

  return source;
}

module.exports = { applyHetznerAdditionalIpQualityPatches };
