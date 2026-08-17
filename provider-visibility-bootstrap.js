'use strict';

function countOccurrences(source, needle) {
  let count = 0;
  let from = 0;
  while (true) {
    const idx = source.indexOf(needle, from);
    if (idx === -1) return count;
    count += 1;
    from = idx + needle.length;
  }
}

function replaceOnce(source, needle, replacement, label) {
  const count = countOccurrences(source, needle);
  if (count !== 1) {
    throw new Error(`[provider-visibility] patch "${label}" expected exactly 1 match, found ${count}`);
  }
  return source.replace(needle, replacement);
}

function applyProviderVisibilityPatches(coreSource) {
  let source = String(coreSource);

  const effectiveDcNeedle = [
    '    }',
    '    return out;',
    '  }',
    '',
    '  // بدون پروژه اختصاصی → DCهای پایه با فیلتر متادیتا'
  ].join('\n');
  const effectiveDcReplacement = [
    '    }',
    "    require('./provider-visibility').appendSharedNonOpenStackProviders(out, baseDatacenters);",
    '    return out;',
    '  }',
    '',
    '  // بدون پروژه اختصاصی → DCهای پایه با فیلتر متادیتا'
  ].join('\n');

  source = replaceOnce(
    source,
    effectiveDcNeedle,
    effectiveDcReplacement,
    'keep shared non-OpenStack providers for custom-project users'
  );

  source = replaceOnce(
    source,
    ' const promises = datacenterKeys.map(dcKey => {',
    [
      ' const manageProviderErrors = [];',
      ' const promises = datacenterKeys.map(dcKey => {'
    ].join('\n'),
    'track manage provider errors'
  );

  const manageCatchNeedle = [
    '                    .catch(error => {',
    'console.error(`Could not fetch servers from ${dcConfig?.name || dcKey}: ${error.message}`);',
    '  return [];',
    '                    });'
  ].join('\n');
  const manageCatchReplacement = [
    '                    .catch(error => {',
    'console.error(`Could not fetch servers from ${dcConfig?.name || dcKey}: ${error.message}`);',
    '  manageProviderErrors.push({ dcKey, name: dcConfig?.name || dcKey, message: String(error?.message || error) });',
    '  return [];',
    '                    });'
  ].join('\n');

  source = replaceOnce(
    source,
    manageCatchNeedle,
    manageCatchReplacement,
    'remember unavailable providers during manage'
  );

  const manageNeedle = [
    '            const results = await Promise.all(promises);',
    '            const userServers = results.flat();',
    "  console.log('[MANAGE] TOTAL servers for user', effectiveUserId, '=', userServers.length);",
    '',
    '            if (userServers.length === 0) {'
  ].join('\n');
  const manageReplacement = [
    '            const results = await Promise.all(promises);',
    '            const userServers = results.flat();',
    '            const managedServerKeys = new Set(userServers.map(s => `${s.datacenter}:${String(s.id ?? s.uuid ?? \'\')}`));',
    '            for (const p of userPurchases) {',
    "              const dcKey = String(p.datacenter || '');",
    "              const serverId = String(p.server_id || '');",
    '              if (!dcKey || !serverId || !userDCs[dcKey]) continue;',
    '              const managedKey = `${dcKey}:${serverId}`;',
    '              if (managedServerKeys.has(managedKey)) continue;',
    '              userServers.push({',
    '                id: serverId,',
    '                uuid: serverId,',
    '                name: p.server_name || serverId,',
    '                datacenter: dcKey,',
    '                purchase: p,',
    '                providerUnavailable: true',
    '              });',
    '              managedServerKeys.add(managedKey);',
    "              console.warn('[MANAGE] provider list missed owned server; using purchase fallback', { datacenter: dcKey, server_id: serverId });",
    '            }',
    "  console.log('[MANAGE] TOTAL servers for user', effectiveUserId, '=', userServers.length);",
    '',
    '            if (userServers.length === 0 && manageProviderErrors.length > 0) {',
    '              const failedNames = [...new Set(manageProviderErrors.map(item => item.name))].join("، ");',
    "              return sendMessage(effectiveChatId, `⚠️ در حال حاضر ارتباط با ${failedNames} برقرار نیست و لیست سرورها قابل دریافت نیست. این پیام به معنی حذف شدن یا نداشتن سرور نیست. لطفاً کمی بعد دوباره تلاش کنید.`);",
    '            }',
    '',
    '            if (userServers.length === 0) {'
  ].join('\n');

  source = replaceOnce(
    source,
    manageNeedle,
    manageReplacement,
    'use owned purchase fallback when provider list misses a server'
  );

  const buyMenuNeedle = [
    ' const keys = Object.keys(dcs).filter(key => {',
    '   // فقط موقع تست، فیلتر کن',
    "   if (actionPrefix !== 'DC_TEST') return true;"
  ].join('\n');
  const buyMenuReplacement = [
    ' const keys = Object.keys(dcs).filter(key => {',
    '   // Afracloud/Afranet and Tebyan are temporarily unavailable for new purchases.',
    "   if (actionPrefix === 'DC_BUY' && (dcs[key]?.provider === 'afracloud' || dcs[key]?.apiType === 'afracloud' || dcs[key]?.key === 'tebyan' || key === 'tebyan')) return false;",
    '   // فقط موقع تست، فیلتر کن',
    "   if (actionPrefix !== 'DC_TEST') return true;"
  ].join('\n');

  source = replaceOnce(
    source,
    buyMenuNeedle,
    buyMenuReplacement,
    'hide unavailable providers from the buy datacenter menu'
  );

  const buyCallbackNeedle = [
    "    } else if (flowType === 'BUY') {",
    '      const dbUser = await getUser(effectiveUserId);'
  ].join('\n');
  const buyCallbackReplacement = [
    "    } else if (flowType === 'BUY') {",
    "      if (dcConfig?.provider === 'afracloud' || dcConfig?.apiType === 'afracloud') {",
    "        return sendMessage(effectiveChatId, '⛔️ فروش سرویس افرانت/افراکلود متوقف شده و امکان خرید جدید وجود ندارد.');",
    '      }',
    "      if (dcConfig?.key === 'tebyan') {",
    "        return sendMessage(effectiveChatId, '⛔️ فروش سرویس تبیان فعلاً متوقف شده و امکان خرید جدید وجود ندارد.');",
    '      }',
    '      const dbUser = await getUser(effectiveUserId);'
  ].join('\n');

  source = replaceOnce(
    source,
    buyCallbackNeedle,
    buyCallbackReplacement,
    'block stale unavailable-provider buy callbacks'
  );

  const finalPurchaseNeedle = [
    '    const isHetzner = isHetznerDc(effectiveDc);',
    "    const isAfra = effectiveDc.provider === 'afracloud' || effectiveDc.apiType === 'afracloud';",
    "    const isTebyan = effectiveDc.key === 'tebyan';"
  ].join('\n');
  const finalPurchaseReplacement = [
    '    const isHetzner = isHetznerDc(effectiveDc);',
    "    const isAfra = effectiveDc.provider === 'afracloud' || effectiveDc.apiType === 'afracloud';",
    "    const isTebyan = effectiveDc.key === 'tebyan';",
    '',
    '    // Hard stop for any already-open or deep-linked unavailable-provider purchase flow.',
    '    if (isAfra || isTebyan) {',
    "      const unavailableName = isTebyan ? 'تبیان' : 'افرانت/افراکلود';",
    "      return sendMessage(chatId, `⛔️ فروش سرویس ${unavailableName} فعلاً متوقف شده و امکان خرید جدید وجود ندارد.`, mainMenu);",
    '    }'
  ].join('\n');

  source = replaceOnce(
    source,
    finalPurchaseNeedle,
    finalPurchaseReplacement,
    'hard-block unavailable providers before server creation'
  );

  return source;
}

module.exports = { applyProviderVisibilityPatches };
