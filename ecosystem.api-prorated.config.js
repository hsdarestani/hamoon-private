'use strict';

module.exports = {
  apps: [
    {
      name: 'hamoonbot',
      script: 'api-prorated-bot-entry.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true
    },
    {
      name: 'dashboard-server',
      script: 'api-prorated-dashboard-entry.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true
    }
  ]
};
