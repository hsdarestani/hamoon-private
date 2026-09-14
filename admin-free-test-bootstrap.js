'use strict';

function replaceOnce(source, from, to, label) {
  if (source.includes(to)) return source;
  if (!source.includes(from)) {
    throw new Error(`ADMIN_FREE_TEST_PATCH_MARKER_MISSING:${label}`);
  }
  return source.replace(from, to);
}

function applyAdminUnlimitedFreeTestPatches(coreSource) {
  let source = String(coreSource || '');

  source = replaceOnce(
    source,
    "    hasUsedFreeTestServer,\n    recordTestServer,",
    "    hasUsedFreeTestServer,\n    getUserActiveTestServers,\n    recordTestServer,",
    'db_import'
  );

  source = replaceOnce(
    source,
    `    const hasUsed = await hasUsedFreeTestServer(userId, dcConfig.key);\n    if (hasUsed) {\n        return sendMessage(chatId, \`❌ شما قبلاً از سرور تست رایگان در دیتاسنتر \${dcConfig.name} استفاده کرده‌اید.\`);\n    }`,
    `    const isSupportAdmin = Boolean(SUPPORT_ID) && String(userId) === String(SUPPORT_ID);\n\n    if (isSupportAdmin) {\n        // Support/admin can use the free-test flow an unlimited number of times,\n        // but never create two concurrent test VMs in the same datacenter. The\n        // test_servers table has one row per user+datacenter, so overwriting an\n        // active row would orphan the previous VM from automatic cleanup.\n        const activeTests = await getUserActiveTestServers(userId);\n        const activeHere = (activeTests || []).find(row =>\n            String(row.datacenter) === String(dcConfig.key) &&\n            row.server_id != null &&\n            String(row.server_id).trim() !== ''\n        );\n        if (activeHere) {\n            return sendMessage(chatId, \`⚠️ یک سرور تست فعال در دیتاسنتر \${dcConfig.name} دارید. بعد از حذف یا انقضای آن می‌توانید دوباره تست رایگان بسازید.\`);\n        }\n    } else {\n        const hasUsed = await hasUsedFreeTestServer(userId, dcConfig.key);\n        if (hasUsed) {\n            return sendMessage(chatId, \`❌ شما قبلاً از سرور تست رایگان در دیتاسنتر \${dcConfig.name} استفاده کرده‌اید.\`);\n        }\n    }`,
    'free_trial_limit'
  );

  return source;
}

module.exports = {
  applyAdminUnlimitedFreeTestPatches
};
