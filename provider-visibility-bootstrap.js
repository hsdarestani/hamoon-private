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
    '            if (userServers.length === 0) {'
  ].join('\n');

  source = replaceOnce(
    source,
    manageNeedle,
    manageReplacement,
    'use owned purchase fallback when provider list misses a server'
  );

  return source;
}

module.exports = { applyProviderVisibilityPatches };
