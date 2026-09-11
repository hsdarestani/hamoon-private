'use strict';

const fs = require('fs');
const path = 'server-display-names-bootstrap.js';
let source = fs.readFileSync(path, 'utf8');

const oldBlock = `  source = replaceInSection(
    source,
    \`async function handleServerDeletion(chatId, userId, serverId, dcConfig) {\`,
    \`async function getPrivateKey(chatId, serverId) {\`,
    \`        sendMessage(chatId, '✅ سرور با موفقیت حذف شد.');\`,
    \`        await clearServerDisplayName(userId, serverId, dcConfig.key).catch(() => {});\\n        sendMessage(chatId, '✅ سرور با موفقیت حذف شد.');\`,
    'clear display name after deletion'
  );`;

const newBlock = `  source = replaceInSection(
    source,
    \`async function handleServerDeletion(chatId, userId, serverId, dcConfig) {\`,
    \`async function getPrivateKey(chatId, serverId) {\`,
    \`        logServerEvent({ type: 'server_deleted', server_id: serverId, user_id: userId, datacenter: dcConfig.key });\`,
    \`        await clearServerDisplayName(userId, serverId, dcConfig.key).catch(() => {});\\n        logServerEvent({ type: 'server_deleted', server_id: serverId, user_id: userId, datacenter: dcConfig.key });\`,
    'clear display name after deletion'
  );`;

if (source.includes(newBlock)) {
  console.log('server-display-names delete bootstrap already fixed');
  process.exit(0);
}
if (!source.includes(oldBlock)) {
  throw new Error('expected old server-display-names deletion patch block not found');
}
source = source.replace(oldBlock, newBlock);
fs.writeFileSync(path, source);
console.log('server-display-names deletion bootstrap fixed');
