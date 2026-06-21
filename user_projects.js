// user_projects.js
// نگاشت یوزر تلگرام → لیست پروژه‌های OpenStack که باید باهاش‌ها لاگین کنیم
// هر آیتم: { dcKey, label, auth: { OS_* } }

const MAP = {
  // --- کاربر 570598631 ---
  '570598631': [
    {
      dcKey: 'tebyan',
      label: 'Tebyan / Account #2740',
      auth: {
        OS_AUTH_URL: 'http://94.232.171.61:5000',
        OS_INTERFACE: 'public',
        OS_IDENTITY_API_VERSION: '3',

        OS_PROJECT_ID: '2191f1b901cc4a0eac18cfa5e9d25973',
        OS_PROJECT_NAME: 'Account #2740',
        OS_USER_DOMAIN_NAME: 'Default',
        OS_PROJECT_DOMAIN_ID: 'default',
        OS_USERNAME: 'hb_client_3330_1',
        OS_PASSWORD: '7XxijLNE',
      },
      pricePerGbToman: 400,
      downloadOnly: true,
minAlertToman: 1000000
    },    {
      dcKey: 'tehran',
      label: 'Tehran / Account #2801',
      auth: {
        OS_AUTH_URL: 'http://cloud.sc1.abraraz.com:5000',
        OS_INTERFACE: 'public',
        OS_IDENTITY_API_VERSION: '3',

        OS_PROJECT_ID: '5ef8555922a041edb8c7f40cd116627d',
        OS_PROJECT_NAME: 'Account #2801',
        OS_USER_DOMAIN_NAME: 'Default',
        OS_PROJECT_DOMAIN_ID: 'default',
        OS_USERNAME: 'hsbl3330_2',
        OS_PASSWORD: 'b1LpLn84',
      },
      pricePerGbToman: 400,
      downloadOnly: true,
minAlertToman: 1000000
    },
       {
      dcKey: 'respina',
      label: 'Respina / Account #2842',
      auth: {
        OS_AUTH_URL: 'http://77.104.65.250:50000',
        OS_INTERFACE: 'public',
        OS_IDENTITY_API_VERSION: '3',

        OS_PROJECT_ID: 'f09c6b71574e4c6697d56ea14a5a9f50',
        OS_PROJECT_NAME: 'Account_Araz2842',
        OS_USER_DOMAIN_NAME: 'Default',
        OS_PROJECT_DOMAIN_ID: 'default',
        OS_USERNAME: 'hb_araz3330_3',
        OS_PASSWORD: 'sf5x1PYa',
      },
      pricePerGbToman: 370,
      downloadOnly: true,
minAlertToman: 1000000
    },
  ],

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
