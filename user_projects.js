// user_projects.js
// نگاشت یوزر تلگرام → لیست پروژه‌های OpenStack که باید باهاش‌ها لاگین کنیم
// هر آیتم: { dcKey, label, auth: { OS_* } }

const MAP = {
  // --- کاربر 570598631 ---

  // --- کاربر 6246251909 ---
  '6246251909': [
    {
      dcKey: 'tebyan',
      label: 'Tebyan / Account #2742',
      auth: {
        OS_AUTH_URL: 'http://94.232.171.61:5000',
        OS_INTERFACE: 'public',
        OS_IDENTITY_API_VERSION: '3',

        OS_PROJECT_ID: '524f514c2d5a4ae1aa155a00beda0410',
        OS_PROJECT_NAME: 'Account #2742',
        OS_USER_DOMAIN_NAME: 'Default',
        OS_PROJECT_DOMAIN_ID: 'default',

        OS_USERNAME: 'hb_client_3335_1',
        OS_PASSWORD: '8Lm5gdTS',
      },
      pricePerGbToman: 720,
      downloadOnly: true,
minAlertToman: 100000
},
    {
      dcKey: 'tabriz',
      label: 'Tabriz / Account #2743',
      auth: {
        OS_AUTH_URL: 'http://cloud.tbz.abraraz.com:5000',
        OS_INTERFACE: 'public',
        OS_IDENTITY_API_VERSION: '3',

        OS_PROJECT_ID: 'fe905dfaff6f41f08d09a4ea46ad6084',
        OS_PROJECT_NAME: 'Account #2743',
        OS_USER_DOMAIN_NAME: 'Default',
        OS_PROJECT_DOMAIN_ID: 'default',

        OS_USERNAME: 'tbz3335_2',
        OS_PASSWORD: 'yQr1WGZn',
      },
      pricePerGbToman: 720,
      downloadOnly: true,
minAlertToman: 100000
   },

  ],

    '1413154830': [
    {
      dcKey: 'tebyan',
      label: 'Tebyan / Account #2742',
      auth: {
        OS_AUTH_URL: 'http://94.232.171.61:5000',
        OS_INTERFACE: 'public',
        OS_IDENTITY_API_VERSION: '3',

        OS_PROJECT_ID: 'a4cd35bea1ac44b391948d878ac14d44',
        OS_PROJECT_NAME: 'Account #2806',
        OS_USER_DOMAIN_NAME: 'Default',
        OS_PROJECT_DOMAIN_ID: 'default',

        OS_USERNAME: 'hb_client_3400_1',
        OS_PASSWORD: 'OEBgmv8R',
      },
      pricePerGbToman: 400,
      downloadOnly: true,
minAlertToman: 100000
},
  ],

    '925143600': [
    {
      dcKey: 'tebyan',
      label: 'Tebyan / Account #2844',
      auth: {
        OS_AUTH_URL: 'http://94.232.171.61:5000',
        OS_INTERFACE: 'public',
        OS_IDENTITY_API_VERSION: '3',

        OS_PROJECT_ID: '1135d79cbec94e8588ea64a995178589',
        OS_PROJECT_NAME: 'Account #2844',
        OS_USER_DOMAIN_NAME: 'Default',
        OS_PROJECT_DOMAIN_ID: 'default',

        OS_USERNAME: 'hb_client_3446_1',
        OS_PASSWORD: '15zv8BQE',
      },
      pricePerGbToman: 500,
      downloadOnly: true,
minAlertToman: 100000
},
  ],
};

/**
 * برمی‌گردونه لیست پروژه‌های اوپن‌استک برای این یوزر (ممکنه خالی باشه)
 * @param {string|number} telegramId
 * @returns {Array<{dcKey:string,label:string,auth:Object}>}
 */
function getUserProjects(telegramId) {
  return MAP[String(telegramId)] || [];
}
function getAllProjectUserIds() {
  return Object.keys(MAP);
}
module.exports = { getUserProjects, getAllProjectUserIds };

// --- Hamoon production hotfix ---
// Disable legacy project-credit source for user 570598631.
// Normal wallet balance must come from wallet_logs only.
(() => {
  const DISABLED_PROJECT_USERS = new Set(['570598631']);

  const originalGetUserProjects = module.exports.getUserProjects;
  const originalGetAllProjectUserIds = module.exports.getAllProjectUserIds;

  if (typeof originalGetUserProjects === 'function') {
    module.exports.getUserProjects = function patchedGetUserProjects(userId) {
      if (DISABLED_PROJECT_USERS.has(String(userId))) return [];
      return originalGetUserProjects(userId);
    };
  }

  if (typeof originalGetAllProjectUserIds === 'function') {
    module.exports.getAllProjectUserIds = function patchedGetAllProjectUserIds() {
      return originalGetAllProjectUserIds()
        .map(String)
        .filter(userId => !DISABLED_PROJECT_USERS.has(userId));
    };
  }
})();
