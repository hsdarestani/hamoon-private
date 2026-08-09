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
  const needle = [
    '    }',
    '    return out;',
    '  }',
    '',
    '  // بدون پروژه اختصاصی → DCهای پایه با فیلتر متادیتا'
  ].join('\n');
  const replacement = [
    '    }',
    "    require('./provider-visibility').appendSharedNonOpenStackProviders(out, baseDatacenters);",
    '    return out;',
    '  }',
    '',
    '  // بدون پروژه اختصاصی → DCهای پایه با فیلتر متادیتا'
  ].join('\n');

  source = replaceOnce(source, needle, replacement, 'keep shared non-OpenStack providers for custom-project users');
  return source;
}

module.exports = { applyProviderVisibilityPatches };
