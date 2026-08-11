const dns = require('dns');
try {
  dns.setDefaultResultOrder('ipv4first');
} catch (e) {
  console.warn('[DNS] Could not set ipv4first:', e.message);
}

// Importing necessary modules
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const net = require('net');
const cron = require('node-cron');
const { hasCapability, getCapabilityLabel } = require('./provider-capabilities');
const { normalizeNationalCode, verifyShahkarLite } = require('./services/shahkar');
const { generateStrongPassword } = require('./services/passwords');
const { resetLinuxRootPasswordOverSsh } = require('./services/ssh-reset-password');

// Importing datacenter configurations
//const datacenters = require('./datacenters');
function ensureUserState(uid) {
  if (!state[uid]) state[uid] = {};
  if (!state[uid].cb) state[uid].cb = {};
}
// === Low-balance helpers ===
async function getUserTopupTotal(userId) {
  // مجموع همه شارژها (هیچ‌وقت کم نمی‌کنیم؛ فقط مقایسه)
  const logs = await getWalletLogs(userId, null) || [];
  // اگر لاگ‌تایپ “approved” داری ازش استفاده کن؛ وگرنه هر amount مثبت
  let sum = 0;
  for (const l of logs) {
    const amt = Number(l.amount || 0);
    const type = String(l.type || '').toLowerCase();
    if (amt > 0 && (type === 'approved' || type === 'deposit' || type === 'charge' || !l.type)) {
      sum += amt;
    }
  }
  return Math.max(0, Math.floor(sum));
}

async function getProjectCost(userId, dc, projectId, downloadOnly, pricePerGb) {
  try {
    const start = 0;
    const end   = Math.floor(Date.now() / 1000);
    const url   = `${dc.TRAFFIC_API_BASE_URL}project/${encodeURIComponent(projectId)}?start_time=${start}&end_time=${end}`;

    const controller = new AbortController();
    const tmo = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(url, { headers: { Authorization: dc.TRAFFIC_API_KEY }, signal: controller.signal });
    clearTimeout(tmo);
    if (!resp.ok) {
      console.error(`[getProjectCost] Traffic API error for project ${projectId}: ${resp.status} ${resp.statusText}`);
      return { gb: 0, cost: 0 };
    }

    const data = await resp.json();
    const rx = Number(data?.received_gb || 0);
    const tx = Number(data?.transmitted_gb || 0);

    const billableGb = downloadOnly ? rx : (rx + tx);
    const cost = billableGb * pricePerGb;

    return { gb: billableGb, cost: Math.floor(cost) };
  } catch (err) {
    console.error(`[getProjectCost] Fatal error for project ${projectId}:`, err.message);
    return { gb: 0, cost: 0 };
  }
}


async function getUserProjectTrafficCost(userId) {
  const projects = getUserProjects(String(userId)) || [];
  if (!projects.length) return { gb: 0, cost: 0 };

  const userDCs = getUserEffectiveDCs(String(userId)); // شامل TRAFFIC_API_BASE_URL/KEY
  let totalGb = 0;
  let totalCost = 0;

  for (const proj of projects) {
    // کلید DC مؤثر (پروژه‌محور)
    const alias = proj.alias || proj.auth?.OS_PROJECT_ID || `u_${userId}`;
    const dc =
      userDCs[`${proj.dcKey}__${alias}`] ||
      userDCs[proj.dcKey] ||
      baseDatacenters[proj.dcKey];

    if (!dc || !dc.TRAFFIC_API_BASE_URL) continue;

    const projectId = proj.auth?.OS_PROJECT_ID || proj.projectId;
    if (!projectId) continue;

    const start = 0; // از ابتدای زمان
    const end   = Math.floor(Date.now() / 1000);
    const url   = `${dc.TRAFFIC_API_BASE_URL}project/${encodeURIComponent(projectId)}?start_time=${start}&end_time=${end}`;

    try {
      const controller = new AbortController();
      const tmo = setTimeout(() => controller.abort(), 15000);
      const resp = await fetch(url, { headers: { Authorization: dc.TRAFFIC_API_KEY }, signal: controller.signal });
      clearTimeout(tmo);
      if (!resp.ok) continue;

      const data = await resp.json();

      // ✅ جمع RX/TX برای فرمت { servers: { id: { receive, transmit } } } هم پشتیبانی بشه
      let rx = 0, tx = 0;
      if (data && data.servers && typeof data.servers === 'object') {
        for (const s of Object.values(data.servers)) {
          rx += Number(s?.receive || 0);
          tx += Number(s?.transmit || 0);
        }
      } else {
        rx = Number(data?.received_gb || 0);
        tx = Number(data?.transmitted_gb || 0);
      }

      const dlOnly = !!proj.downloadOnly;
      const billableGb = dlOnly ? rx : (rx + tx);
      const price = Number(proj.pricePerGbToman ?? DEFAULT_PRICE_PER_GB);

      totalGb   += billableGb;
      totalCost += billableGb * price;
    } catch (e) {
      console.error('[getUserProjectTrafficCost] fetch error for', projectId, e.message);
    }
  }

  return { gb: totalGb, cost: Math.floor(totalCost) };
}




async function hasRecentLowBalanceAlert(userId, hours = 24) {
  const logs = await getWalletLogs(userId, 100) || [];
  const since = Date.now() - hours * 3600 * 1000;
  return logs.some(l =>
    String(l.type || '').toLowerCase() === 'low_balance_alert' &&
    new Date(l.timestamp).getTime() >= since
  );
}

async function sendLowBalanceAlertIfNeeded(userId, chatId, remainingToman, reason) {
  // reason: توضیح کوتاه (مثل «active server» یا «project usage»)
  const already = await hasRecentLowBalanceAlert(userId, 24);
  if (already) return;

  await recordWalletLog(userId, 0, `Low balance alert (<100k) — ${reason}; remaining=${remainingToman}`, 'low_balance_alert');
  await sendMessage(chatId, `⚠️ موجودی قابل‌استفاده شما برای ترافیک به کمتر از ۱۰۰٬۰۰۰ تومان رسیده.\n` +
                            `برای جلوگیری از اختلال، لطفاً «💰 افزایش اعتبار» را انجام دهید.`);
}
function makeShortCb(uid, payload) {
  ensureUserState(uid);
  const token = 'C' + crypto.randomBytes(3).toString('hex'); // مثل C8f3a1b
  state[uid].cb[token] = payload;
  return token;
}

function readShortCb(uid, token) {
  return state[uid]?.cb?.[token] || null;
}


 const baseDatacenters = require('./datacenters');
 //const userProjectsMap = require('./user_projects');
const { getUserProjects } = require('./user_projects');


function getUserEffectiveDCs(userId) {
  const list = getUserProjects(String(userId)) || []; // ← از تابع خودت

  // اگر پروژه اختصاصی تعریف شده، فقط همون‌ها
  if (list.length > 0) {
    const out = {};
    for (const proj of list) {
      const base = baseDatacenters[proj.dcKey];
      if (!base) continue;

      const isOpenStack =
        !!base.OS_AUTH_URL || base.provider === 'openstack' || base.apiType === 'openstack';
      if (!isOpenStack) continue;

      // alias اگر ندادی، از PROJECT_ID می‌سازیم تا یکتا باشد
      const alias = proj.alias || proj.auth?.OS_PROJECT_ID || `u_${userId}`;
      const vKey  = `${proj.dcKey}__${alias}`;

      out[vKey] = {
        ...base,
        key: vKey,
        name: proj.label || `${base.name} / ${alias}`,

        // نگاشت auth → overrides
        OS_AUTH_URL:          proj.auth?.OS_AUTH_URL          ?? base.OS_AUTH_URL,
        OS_PROJECT_ID:        proj.auth?.OS_PROJECT_ID        ?? base.OS_PROJECT_ID,
        OS_USER_DOMAIN_NAME:  proj.auth?.OS_USER_DOMAIN_NAME  ?? base.OS_USER_DOMAIN_NAME,
        OS_PROJECT_DOMAIN_ID: proj.auth?.OS_PROJECT_DOMAIN_ID ?? base.OS_PROJECT_DOMAIN_ID,
        OS_USERNAME:          proj.auth?.OS_USERNAME          ?? base.OS_USERNAME,
        OS_PASSWORD:          proj.auth?.OS_PASSWORD          ?? base.OS_PASSWORD,
        OS_NETWORK_ID:        proj.auth?.OS_NETWORK_ID        ?? base.OS_NETWORK_ID,

        // اگر برای ترافیک چیزی خواستی override کنی:
        TRAFFIC_API_BASE_URL: proj.auth?.TRAFFIC_API_BASE_URL ?? base.TRAFFIC_API_BASE_URL,
        TRAFFIC_API_KEY:      proj.auth?.TRAFFIC_API_KEY      ?? base.TRAFFIC_API_KEY,

        apiType: base.apiType || 'openstack',
        __baseKey: proj.dcKey,
        __alias: alias,

        // خیلی مهم
        sharedProject: false,
      };
    }
    return out;
  }

  // بدون پروژه اختصاصی → DCهای پایه با فیلتر متادیتا
  const out = {};
  for (const key of Object.keys(baseDatacenters)) {
    const base = baseDatacenters[key];
    out[key] = { ...base, key, sharedProject: true };
  }
  return out;
}


const prices = require('./prices');
const { formatBillingAmountLabel, formatBillingCycleFa } = require('./billing-utils');
const hetznerLifecycle = require('./services/hetzner-lifecycle');
function mdCodeBlock(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function htmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function htmlCodeBlock(s) {
  return `<pre><code>${htmlEscape(s)}</code></pre>`;
}


function tcpCheck(host, port = 22, timeout = 4500) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let done = false;
    const finish = reachable => { if (done) return; done = true; sock.destroy(); resolve({ reachable }); };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

// API IMPORTS
//const openstackApi = require('./openstack-api');
const openstackApi = require('./cloud-api'); // روتینگ بین OpenStack و Hetzner

// Importing database utility functions
const {
    upsertUser,
    getUser,
    getUserWallet,
    debitUser,
    creditUser,
    recordPurchase,
    setPurchaseAutoRenew,
    setPurchaseRenewalStopped,
    updatePurchaseSuspendReason,
    hasUsedFreeTestServer,
    recordTestServer,
    storeKeyPair,
    getKeyPair,
    deleteKeyPairFromDb,
    recordWalletLog,
    getWalletLogs,
    getAllPurchases,
    updatePurchaseStatus,
    getPurchaseByServerId,
    deleteTestServer,
    updatePurchaseOsLabel,
    updatePurchaseBilling,
    updatePurchaseFreeTraffic,
    updatePurchaseCycle,
    updateUserShahkar,
    getUserActivePurchases,
    getUserRestartablePurchases,
    upsertServerSecret,
    getServerSecret,
    getPurchaseForUserServer,
    updatePurchasePlan,
    setPurchaseStatusForUser,
    recordServerUpgradeLog
} = require('./db');

// Environment variables
const token = process.env.TELEGRAM_BOT_TOKEN;
const SUPPORT_ID = parseInt(process.env.SUPPORT_ID || '0');
const SUPPORT_USERNAME = process.env.SUPPORT_USERNAME || 'Support';
const CHANNEL_USERNAME = 'HamoonCloud';
const CHANNEL_LINK = 'https://t.me/HamoonCloud';

if (!token) {
    console.error('TELEGRAM_BOT_TOKEN is not set. Exiting.');
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

// Global state to manage user interactions and admin actions
const state = {};
const adminState = { impersonating: null };
let orderCounter = 10000;
const hetznerUpgradeLocks = new Map();

// Main menu keyboard layout
const mainMenu = {
    reply_markup: {
        resize_keyboard: true,
        keyboard: [
            ['🆓 تست رایگان'],
            ['🛒 خرید سرور', '💰 افزایش اعتبار'],
            ['👛 کیف پول'],
            ['⚙️ مدیریت سرورها'],
            ['⚡ روشن‌کردن سرورها'],
            ['📞 پشتیبانی']
        ]
    }
};

// --- Billing Configuration ---
const DEFAULT_PRICE_PER_GB = 500;
const DEFAULT_DOWNLOAD_ONLY = 0;
const HOURS_IN_CYCLE = {
    hourly: 1,
    daily: 24,
    weekly: 168,
    monthly: 720
};

function getAllowedCycles(dcConfig) {
  if (Array.isArray(dcConfig?.allowedCycles) && dcConfig.allowedCycles.length) {
    return dcConfig.allowedCycles.filter(c => HOURS_IN_CYCLE[c]);
  }
  return Object.keys(HOURS_IN_CYCLE);
}

function getCycleLabel(cycle) { return formatBillingCycleFa(cycle); }

function getFlavorCyclePrice(flavor, cycle) {
  const cycleHours = HOURS_IN_CYCLE[cycle];
  if (!cycleHours) return 0;
  if (flavor?.pricesByCycle && Number(flavor.pricesByCycle[cycle]) > 0) {
    return Math.round(Number(flavor.pricesByCycle[cycle]));
  }
  const monthly = Number(
    flavor?.amount_monthly ??
    flavor?.monthly_toman ??
    flavor?.monthly_price_toman ??
    flavor?.monthly_price ??
    flavor?.monthlyPrice ??
    0
  );
  const hourly = Number(
    flavor?.amount_hourly ??
    flavor?.hourly_price_toman ??
    flavor?.price ??
    (monthly > 0 ? monthly / HOURS_IN_CYCLE.monthly : 0)
  );
  if (cycle === 'monthly') return Math.round(monthly || hourly * HOURS_IN_CYCLE.monthly);
  return Math.round(hourly * cycleHours);
}

function normalizeStoredCycleAmount(purchase, dcConfig = null) {
  const amount = Number(purchase?.amount || 0);
  const cycle = String(purchase?.duration || 'hourly');
  const cycleHours = HOURS_IN_CYCLE[cycle];
  if (!(amount > 0) || !cycleHours || cycle === 'hourly') return amount;

  const dc = dcConfig || baseDatacenters[purchase?.datacenter] || null;
  const flavorId = String(purchase?.flavor_id || '').toLowerCase();
  const configuredFlavor = (dc?.flavors || []).find((flavor) => {
    const ids = [flavor?.id, flavor?.hetzner_type, flavor?.server_type]
      .map((value) => String(value || '').toLowerCase());
    return ids.includes(flavorId);
  });
  const expectedCycleAmount = configuredFlavor ? getFlavorCyclePrice(configuredFlavor, cycle) : 0;
  if (!(expectedCycleAmount > 0)) return amount;

  const expandedLegacyAmount = Math.round(amount * cycleHours);
  const storedDistance = Math.abs(amount - expectedCycleAmount);
  const expandedDistance = Math.abs(expandedLegacyAmount - expectedCycleAmount);
  return expandedDistance < storedDistance ? expandedLegacyAmount : amount;
}

function formatToman(n) {
  return Number(n || 0).toLocaleString('en-US');
}


function buildTebyanRootPasswordCloudInit(rootPassword) {
  const pwd = String(rootPassword).replace(/\\/g, '\\\\').replace(/"/g, '\"');
  return `#cloud-config
package_update: false
ssh_pwauth: true
disable_root: false

chpasswd:
  expire: false
  users:
    - name: root
      password: "${pwd}"
      type: text
    - name: ubuntu
      password: "${pwd}"
      type: text

write_files:
  - path: /etc/ssh/sshd_config.d/60-hamoon-password-login.conf
    permissions: '0644'
    content: |
      PasswordAuthentication yes
      KbdInteractiveAuthentication yes
      PubkeyAuthentication yes
      PermitRootLogin yes
      UsePAM yes

runcmd:
  - [ bash, -lc, "passwd -u root || true" ]
  - [ bash, -lc, "ufw allow 22/tcp || true" ]
  - [ bash, -lc, "systemctl unmask ssh.service ssh.socket || true" ]
  - [ bash, -lc, "systemctl enable --now ssh.socket || systemctl enable --now ssh.service || true" ]
  - [ bash, -lc, "systemctl restart ssh.service || systemctl restart ssh.socket || true" ]
  - [ bash, -lc, "echo HAMOON_ROOT_PASSWORD_LOGIN_ENABLED >/dev/ttyS0" ]
  - [ bash, -lc, "echo HAMOON_CLOUD_INIT_DONE >/dev/ttyS0" ]
`;
}

function requiresShahkar(dcConfig, action) {
  return dcConfig?.authPolicy?.[action] === 'shahkar';
}

function isShahkarVerified(user) {
  return Number(user?.shahkar_verified || 0) === 1;
}

function unsupportedFeature(chatId, text = 'این قابلیت برای این دیتاسنتر فعال نیست.') {
  return sendMessage(chatId, text);
}

function requireCapabilityOrReply(chatId, dcConfig, feature, text) {
  if (dcConfig && hasCapability(dcConfig, feature)) return true;
  unsupportedFeature(chatId, text);
  return false;
}


// --- Helper Functions ---
function logServerEvent(eventDetails) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${JSON.stringify(eventDetails)}\n`;
    fs.appendFile(path.join(__dirname, 'server_events.log'), logEntry, (err) => {
        if (err) console.error('Failed to write to server_events.log:', err);
    });
}

function escapeMarkdownV2(text) {
  if (!text) return '';
  text = String(text);
  return text
    .replace(/\\/g, '\\\\')
    .replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}




function formatRemainingTime(lastBilledAt, duration) {
    const now = new Date();
    const lastBilledDate = new Date(lastBilledAt);
    const cycleHours = HOURS_IN_CYCLE[duration];
    const expiryDate = new Date(lastBilledDate.getTime() + cycleHours * 60 * 60 * 1000);

    const diffMs = expiryDate - now;
    if (diffMs <= 0) return "پایان یافته";

    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

    let result = '';
    if (days > 0) result += `${days} روز و `;
    if (hours > 0) result += `${hours} ساعت و `;
    result += `${minutes} دقیقه`;
    return result;
}

async function sendMessage(chatId, text, options) {
    try {
        return await bot.sendMessage(chatId, text, options);
    } catch (error) {
        console.error(`Error sending message to ${chatId}:`, error.message);
        if (error.response && error.response.body) {
             console.error('Telegram API Error Body:', error.response.body);
        }
        return null;
    }
}

async function editOrSendMessage(chatId, messageId, text, options = {}) {
  if (messageId) {
    try {
      return await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
    } catch (e) {
      console.warn('[Telegram] editMessageText failed, falling back to sendMessage:', e.message);
    }
  }
  return sendMessage(chatId, text, options);
}

async function notifyPurchaseSuccess(chatId, messageId, html, replyMarkup) {
  return editOrSendMessage(chatId, messageId, html, { parse_mode: 'HTML', reply_markup: replyMarkup });
}

function extractServerIp(srv) {
  if (!srv) return null;
  const candidates = [];
  if (srv.addresses && typeof srv.addresses === 'object') {
    for (const items of Object.values(srv.addresses)) {
      if (Array.isArray(items)) for (const a of items) if (a?.addr) candidates.push(a.addr);
    }
  }
  for (const key of ['instancePrivateIp', 'privateIp', 'publicIp', 'publicIP', 'ip']) {
    if (srv.raw?.[key]) candidates.push(srv.raw[key]);
    if (srv[key]) candidates.push(srv[key]);
  }
  return candidates.find(ip => /^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip))) || null;
}

async function fetchAfraPasswordWithRetry(dcConfig, tok, serverId, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try {
      const pw = await openstackApi.resetServerPassword(dcConfig, tok, serverId);
      if (pw) return pw;
    } catch (e) {
      console.warn('[AfraCloud] password fetch failed:', { server_id: serverId, message: e.message });
    }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, 3000));
  }
  return null;
}

async function showBillingCycleSelection(chatId, userId, messageId, dcConfig) {
  const cycles = getAllowedCycles(dcConfig);
  if (!cycles.length) return sendMessage(chatId, '❌ برای این دیتاسنتر سیکل پرداختی تعریف نشده است.');

  state[userId] = {
    ...state[userId],
    step: 'SELECT_BILLING_CYCLE',
    selectedDatacenterConfig: dcConfig
  };

  const keyboard = cycles.map(cycle => ([
    { text: getCycleLabel(cycle), callback_data: `CYCLE_${cycle}` }
  ]));
  keyboard.push([{ text: '❌ انصراف', callback_data: 'CANCEL' }]);

  const text = '🔹 سیکل پرداخت را انتخاب کنید:';
  const opts = { reply_markup: { inline_keyboard: keyboard } };
  if (messageId) {
    return bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts }).catch(() => sendMessage(chatId, text, opts));
  }
  return sendMessage(chatId, text, opts);
}

async function handleShahkarNationalCodeMessage(chatId, userId, text) {
  const current = state[userId];
  const dcConfig = current?.selectedDatacenterConfig;
  if (!dcConfig) {
    state[userId] = { step: 'READY' };
    return sendMessage(chatId, '❌ اطلاعات دیتاسنتر منقضی شده است. لطفاً دوباره خرید را شروع کنید.');
  }

  let nationalCode;
  try {
    nationalCode = normalizeNationalCode(text);
  } catch (_) {
    return sendMessage(chatId, '❌ کد ملی نامعتبر است. لطفاً کد ملی ۱۰ رقمی معتبر وارد کنید:');
  }

  const dbUser = await getUser(userId);
  if (!dbUser?.phone || dbUser.phone === 'EXEMPT') {
    return sendMessage(chatId, '⚠️ برای احراز شاهکار، ابتدا /start را بزنید و شماره موبایل واقعی خود را به اشتراک بگذارید.');
  }

  try {
    const result = await verifyShahkarLite({ nationalCode, mobile: dbUser.phone });
    if (!result.ok) {
      return sendMessage(chatId, '❌ کد ملی با شماره موبایل شما تطابق ندارد. لطفاً دوباره تلاش کنید:');
    }
    await updateUserShahkar(userId, nationalCode, result.raw);
    await sendMessage(chatId, '✅ احراز هویت شاهکار با موفقیت انجام شد.');
    if (current?.afterShahkar === 'CONTINUE_BUY' && current?.selectedDatacenterConfig) {
      return showBillingCycleSelection(chatId, userId, current.messageId, current.selectedDatacenterConfig);
    }
    return showBillingCycleSelection(chatId, userId, current.messageId, dcConfig);
  } catch (error) {
    console.error('[Shahkar flow] verification failed:', error.message);
    return sendMessage(chatId, '❌ خطا در استعلام شاهکار. چند دقیقه بعد دوباره تلاش کنید.');
  }
}

async function isUserChannelMember(userId) {
    try {
        const chatMember = await bot.getChatMember(`@${CHANNEL_USERNAME}`, userId);
        const status = chatMember.status;
        return ['member', 'administrator', 'creator'].includes(status);
    } catch (error) {
        if (error.response && error.response.body.description.includes('user not found')) {
            return false;
        }
        console.error(`Error checking channel membership for user ${userId}:`, error.message);
        return false;
    }
}

async function showMainMenu(chatId, effectiveUserId) {
    const targetUserId = effectiveUserId || String(chatId);
    state[targetUserId] = { step: 'READY' };
    await upsertUser({ telegram_id: targetUserId, step: 'READY' });
let message = '☁️ به HamoonCloud خوش آمدید';
if (adminState.impersonating) {
  message = `*شما در نقش کاربر ${escapeMarkdownV2(adminState.impersonating)} هستید.*\n\n${escapeMarkdownV2(message)}`;
}
sendMessage(chatId, escapeMarkdownV2(message), { ...mainMenu, parse_mode: 'MarkdownV2' });


}


function showDatacenterSelection(chatId, actionPrefix, userId) {
  const dcs = getUserEffectiveDCs(userId);
// const keyboard = Object.keys(dcs).map(key => {
 //  return [{ text: dcs[key].name, callback_data: `${actionPrefix}_${key}` }];
//  });
 const keys = Object.keys(dcs).filter(key => {
   // فقط موقع تست، فیلتر کن
   if (actionPrefix !== 'DC_TEST') return true;
   // اگر allowTest=false بود، حذفش کن
   if (dcs[key]?.allowTest === false) return false;
   // اگر کلید پروژه‌دار بود مثل "hetzner__<alias>"، بیس‌کی رو در بیار
   const baseKey = dcs[key].__baseKey || key.split('__')[0] || key;
  // احتیاط: هرچی بیس‌کی آلمان باشه، حذف
   if (baseKey === 'hetzner') return false;
  return true;
 });
const keyboard = keys.map(key => ([
  { text: dcs[key].name, callback_data: `${actionPrefix}_${key}` }
 ]));

    keyboard.push([{ text: '❌ انصراف', callback_data: 'CANCEL' }]);

    sendMessage(chatId, '🔹 لطفاً دیتاسنتر مورد نظر خود را انتخاب کنید:', {
        reply_markup: { inline_keyboard: keyboard }
    });
}

// --- Admin Impersonation Commands ---
bot.onText(/\/impersonate (\d+)/, async (msg, match) => {
    if (String(msg.from.id) !== String(SUPPORT_ID)) return;
    const targetUserId = match[1];
    const userExists = await getUser(targetUserId);
    if (!userExists) {
        return sendMessage(msg.chat.id, `کاربری با آیدی ${targetUserId} یافت نشد.`);
    }
    adminState.impersonating = targetUserId;
    sendMessage(msg.chat.id, `✅ شما اکنون در نقش کاربر ${targetUserId} هستید. برای خروج /impersonate_end را ارسال کنید.`);
    showMainMenu(msg.chat.id, targetUserId);
});

bot.onText(/\/impersonate_end/, async (msg) => {
    if (String(msg.from.id) !== String(SUPPORT_ID)) return;
    adminState.impersonating = null;
    sendMessage(msg.chat.id, '✅ شما از نقش کاربر خارج شدید.');
    showMainMenu(msg.chat.id);
});

// --- Bot Command Handlers ---

bot.on('message', async (msg) => {
    const adminId = String(msg.from.id);
    const isImpersonating = adminId === String(SUPPORT_ID) && adminState.impersonating;

    const effectiveUserId = isImpersonating ? adminState.impersonating : String(msg.from.id);
    const effectiveChatId = msg.chat.id;

    const text = msg.text || '';

    if (text.startsWith('/')) {
        if (text.startsWith('/start')) {
            let dbUser = await getUser(effectiveUserId);
            if (!dbUser) {
                await upsertUser({ telegram_id: effectiveUserId, phone: null, step: 'READY' });
                dbUser = await getUser(effectiveUserId);
            } else {
                await upsertUser({ telegram_id: effectiveUserId, step: 'READY' });
            }

            const isMember = await isUserChannelMember(effectiveUserId);
            if (!isMember) {
                return sendMessage(effectiveChatId, `⚠️ برای استفاده از ربات، ابتدا باید عضو کانال ما شوید: ${escapeMarkdownV2(CHANNEL_LINK)}\nپس از عضویت، دوباره /start را ارسال کنید\\.`, {
                    parse_mode: 'MarkdownV2',
                    reply_markup: { inline_keyboard: [[{ text: 'عضویت در کانال', url: CHANNEL_LINK }]] }
                });
            }
            if (!isImpersonating && (!dbUser || !dbUser.phone)) {
    // 👇 اضافه کن:
    const exemptUsers = ['5794972968']; // آیدی‌هایی که نیاز به وریفای ندارن
    if (exemptUsers.includes(effectiveUserId)) {
        await upsertUser({ telegram_id: effectiveUserId, phone: 'EXEMPT', step: 'READY' });
        return showMainMenu(effectiveChatId, effectiveUserId);
    }

    // حالت عادی
    state[effectiveUserId] = { step: 'WAIT_CONTACT' };
    return sendMessage(effectiveChatId, '📞 برای ادامه، لطفاً شماره تلفن خود را از طریق دکمه زیر به اشتراک بگذارید', {
        parse_mode: 'MarkdownV2',
        reply_markup: { keyboard: [[{ text: 'اشتراک گذاری شماره تلفن', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true }
    });
}

            showMainMenu(effectiveChatId, effectiveUserId);
        }
        return;
    }

    if (msg.contact) {
        if (state[effectiveUserId]?.step !== 'WAIT_CONTACT' || String(msg.contact.user_id) !== effectiveUserId) {
            return sendMessage(effectiveChatId, '⚠️ شماره نامعتبر');
        }
        await upsertUser({ telegram_id: effectiveUserId, phone: msg.contact.phone_number, step: 'READY' });
        showMainMenu(effectiveChatId, effectiveUserId);
        return;
    }

    if (state[effectiveUserId]?.step === 'WAIT_SHAHKAR_NATIONAL_CODE') {
        return handleShahkarNationalCodeMessage(effectiveChatId, effectiveUserId, text);
    }

    switch (text) {
        case '🆓 تست رایگان':
            const isMemberTest = await isUserChannelMember(effectiveUserId);
            const dbUserTest = await getUser(effectiveUserId);
            if (!isMemberTest || !dbUserTest || (!dbUserTest.phone && !isImpersonating)) {
                return sendMessage(effectiveChatId, '⚠️ لطفاً ابتدا احراز هویت و عضویت در کانال را تکمیل کنید\\. /start', { parse_mode: 'MarkdownV2' });
            }
            state[effectiveUserId] = { step: 'SELECT_DATACENTER_TEST' };
            showDatacenterSelection(effectiveChatId, 'DC_TEST',effectiveUserId);
            break;
        case '🛒 خرید سرور':
            const isMemberBuy = await isUserChannelMember(effectiveUserId);
            const dbUserBuy = await getUser(effectiveUserId);
            if (!isMemberBuy || !dbUserBuy || (!dbUserBuy.phone && !isImpersonating)) {
                return sendMessage(effectiveChatId, '⚠️ لطفاً ابتدا احراز هویت و عضویت در کانال را تکمیل کنید\\. /start', { parse_mode: 'MarkdownV2' });
            }
            state[effectiveUserId] = { step: 'SELECT_DATACENTER_BUY' };
            showDatacenterSelection(effectiveChatId, 'DC_BUY',effectiveUserId);
            break;
        case '💰 افزایش اعتبار':
            const isMemberDeposit = await isUserChannelMember(effectiveUserId);
            const dbUserDeposit = await getUser(effectiveUserId);
             if (!isMemberDeposit || !dbUserDeposit || (!dbUserDeposit.phone && !isImpersonating)) {
                return sendMessage(effectiveChatId, '⚠️ لطفاً ابتدا احراز هویت و عضویت در کانال را تکمیل کنید\\. /start', { parse_mode: 'MarkdownV2' });
            }
            state[effectiveUserId] = { step: 'WAIT_DEPOSIT' };
            sendMessage(effectiveChatId, '💵 مبلغ را وارد کنید (تومان):');
            break;


case '👛 کیف پول': {
  const logs = await getWalletLogs(effectiveUserId, 10);

  const history = logs.map(l => {
    const amountValue = parseFloat(l.amount);
    const descriptionValue = String(l.description);
    const timestamp = new Date(l.timestamp).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' });
    return `${escapeMarkdownV2(timestamp)} \\| ${amountValue > 0 ? '\\+' : ''}${escapeMarkdownV2(amountValue.toFixed(2))} — ${escapeMarkdownV2(descriptionValue)}`;
  }).join('\n') || 'بدون سابقه';

  const userProjects = getUserProjects(String(effectiveUserId)) || [];
  let messageText = '';

  if (userProjects.length > 0) {
    const topupsTotal = await getUserTopupTotal(effectiveUserId);
    const { cost: globalCost } = await getUserProjectTrafficCost(effectiveUserId);
    const remainingTotal = Math.max(0, topupsTotal - globalCost);

    messageText =
      `💰 موجودی: ${escapeMarkdownV2(remainingTotal.toFixed(0))} تومان\n\n` +
      `📜 سابقه \\(۱۰ مورد اخیر\\):\n${history}`;
  } else {
    // کاربر عادی (بدون پروژه)
    const balance = await getUserWallet(effectiveUserId);
    messageText =
      `💰 موجودی: ${escapeMarkdownV2(balance.toFixed(0))} تومان\n\n` +
      `📜 سابقه \\(۱۰ مورد اخیر\\):\n${history}`;
  }

  sendMessage(effectiveChatId, messageText, {
    parse_mode: 'MarkdownV2',
    reply_markup: {
      inline_keyboard: [
        [{ text: '⬇️ دانلود سابقه کامل (CSV)', callback_data: 'DOWNLOAD_WALLET_HISTORY' }]
      ]
    }
  });
  break;
}


        case '⚡ روشن‌کردن سرورها':
        case '🔌 روشن کردن سرورها':
        case 'روشن کردن سرورها':
            return handleStartMySuspendedServers(effectiveChatId, effectiveUserId);

        case '⚙️ مدیریت سرورها':
           // sendMessage(effectiveChatId, 'در حال دریافت لیست سرورها از تمام دیتاسنترها...');
            //const datacenterKeys = Object.keys(datacenters);
 sendMessage(effectiveChatId, 'در حال دریافت لیست سرورها از دیتاسنترهای شما...');
  const projects = getUserProjects(String(effectiveUserId)) || [];
  if (projects.length > 0) {
    const keyboard = projects.map(p => ([
      { text: `📂 ${p.label || p.dcKey}`, callback_data: makeShortCb(effectiveUserId, { action: 'OPEN_PROJECT', projectId: p.auth?.OS_PROJECT_ID, dcKey: `${p.dcKey}__${p.alias || p.auth?.OS_PROJECT_ID || 'u_' + effectiveUserId}`}) }
    ]));
    return sendMessage(effectiveChatId, '📂 لطفاً یک پروژه انتخاب کنید:', { reply_markup: { inline_keyboard: keyboard } });
  }
 const userDCs = getUserEffectiveDCs(effectiveUserId);
 const datacenterKeys = Object.keys(userDCs);
  console.log('[MANAGE] effectiveUserId =', effectiveUserId, ' impersonating =', isImpersonating);
  console.log('[MANAGE] DC keys =', Object.keys(userDCs));
 const userPurchases = await getUserActivePurchases(effectiveUserId);
 const purchaseByServerId = new Map();
 const purchaseIdsByDc = new Map();
 for (const p of userPurchases) {
   const ids = [p.server_id, p.boot_volume_id].filter(Boolean).map(String);
   if (!purchaseIdsByDc.has(p.datacenter)) purchaseIdsByDc.set(p.datacenter, new Set());
   for (const id of ids) { purchaseIdsByDc.get(p.datacenter).add(id); purchaseByServerId.set(id, p); }
 }
 const promises = datacenterKeys.map(dcKey => {
const dcConfig = userDCs[dcKey];
console.log('[MANAGE] begin DC', dcKey, 'name =', dcConfig?.name);
 return openstackApi.getToken(dcConfig)
                    .then(tok => {
        console.log('[MANAGE] token for', dcKey, tok ? 'OK' : 'NULL');
        return openstackApi.listServers(dcConfig, tok);
      })
                    .then(allServersInDC => {
  console.log('[MANAGE] raw servers count in', dcKey, '=', Array.isArray(allServersInDC) ? allServersInDC.length : 'NOT_ARRAY');
     const isShared = dcConfig.sharedProject === true;
     const purchaseIds = purchaseIdsByDc.get(dcKey) || new Set();
     const isAfra = dcConfig.provider === 'afracloud' || dcConfig.apiType === 'afracloud';
      const filtered = isShared
         ? allServersInDC.filter(s => {
             const idMatch = purchaseIds.has(String(s.id)) || purchaseIds.has(String(s.uuid));
             if (isAfra) return idMatch;
             return String(s.metadata?.user || '') === String(effectiveUserId) || idMatch;
           })
         : allServersInDC;
 console.log('[MANAGE] filtered servers in', dcKey, '=', filtered.length, ' (sharedProject=', isShared, ')');
return filtered.map(s => ({ ...s, datacenter: dcKey, purchase: purchaseByServerId.get(String(s.id)) || purchaseByServerId.get(String(s.uuid)) }));
 }                  )
                    .catch(error => {
console.error(`Could not fetch servers from ${dcConfig?.name || dcKey}: ${error.message}`);
  return [];
                    });
            });

            const results = await Promise.all(promises);
            const userServers = results.flat();
  console.log('[MANAGE] TOTAL servers for user', effectiveUserId, '=', userServers.length);

            if (userServers.length === 0) {
                return sendMessage(effectiveChatId, 'شما هیچ سروری ندارید.');
            }

ensureUserState(effectiveUserId);

const keyboard = userServers.map(s => {
  const token = makeShortCb(effectiveUserId, {
    action: 'M',
    dcKey: s.datacenter,
    serverId: s.id,
  });
  return [
    { text: `${s.purchase?.server_name || s.name} (${userDCs[s.datacenter]?.name || s.datacenter})`, callback_data: token }
  ];
});


            sendMessage(effectiveChatId, 'سرورهای شما:', { reply_markup: { inline_keyboard: keyboard } });
            break;
        case '📞 پشتیبانی':
            sendMessage(effectiveChatId, `✉️ برای پشتیبانی با \\@${escapeMarkdownV2(SUPPORT_USERNAME)} در تماس باشید\\.`, { parse_mode: 'MarkdownV2'});
            break;


default:
    if (state[effectiveUserId]?.step === 'WAIT_DEPOSIT' && /^\d+$/.test(text)) {
const amount = parseInt(text);
const originalAmount = amount;                        // مبلغ اصلی
const payableToman = Math.ceil(originalAmount * 1.1); // مبلغ با ۱۰٪ مالیات
const payableRial  = payableToman * 10;

if (originalAmount < 100) {
  return sendMessage(effectiveChatId, 'حداقل مبلغ شارژ 100 تومان است.');
}
await sendMessage(
    effectiveChatId,
    `💵 مبلغ شارژ انتخابی شما: ${originalAmount} تومان\n` +
    `📌 مالیات (۱۰٪): ${payableToman - originalAmount} تومان\n` +
    `💳 مبلغ قابل پرداخت: ${payableToman} تومان`
);
        const orderId = ++orderCounter;
        state[effectiveUserId] = { step: 'READY' };
        try {
            const axios = require('axios');
const res = await axios.post('https://gateway.zibal.ir/v1/request', {
    merchant: "68985f4ba45c72000bcfd5a2",
    amount: payableRial,
    callbackUrl: "https://pay.hamooncloud.ir/zibal/callback",
    orderId: `${effectiveUserId}-${orderId}-${originalAmount}`, // ← مبلغ اصلی را در orderId قرار بده
    description: "شارژ کیف پول (با مالیات)"
});


            if (res.data.result !== 100) {
                return sendMessage(effectiveChatId, "❌ خطا در ایجاد تراکنش: " + res.data.message);
            }

            const trackId = res.data.trackId;
            const payUrl = `https://gateway.zibal.ir/start/${trackId}`;
            sendMessage(
                effectiveChatId,
                `برای پرداخت روی لینک زیر کلیک کنید:\n${payUrl}`
            );
        } catch (e) {
            console.error("Zibal error:", e.message);
            sendMessage(effectiveChatId, "❌ خطا در ارتباط با درگاه زیبال.");
        }
    }
    break;

    }
});

// --- REBUILD & RESET PASSWORD & CYCLE CHANGE HANDLERS ---
// کمک‌تابع کوتاه‌ساز callback_data (زیر 64 بایت می‌ماند)
// CC_<dcKey>_<serverId>_<cycle>
function makeCycleCb(dcKey, serverId, cycle) {
  return `CC_${dcKey}_${serverId}_${cycle}`;
}

async function handleChangeCycleAsk(chatId, serverId, dcConfig, messageId) {
  try {
    const purchase = await getPurchaseByServerId(serverId);
    if (!purchase) {
      return bot.editMessageText('❌ اطلاعات خرید این سرور یافت نشد.', { chat_id: chatId, message_id: messageId });
    }

    if (!hasCapability(dcConfig, 'changeCycle') || getAllowedCycles(dcConfig).length <= 1) {
      return bot.editMessageText('این قابلیت برای این دیتاسنتر فعال نیست.', { chat_id: chatId, message_id: messageId });
    }
    const availableCycles = getAllowedCycles(dcConfig).filter(c => c !== purchase.duration);
    const keyboard = availableCycles.map(cycle => ([
      { text: getCycleLabel(cycle), callback_data: makeCycleCb(dcConfig.key, serverId, cycle) }
    ]));
    keyboard.push([{ text: '❌ انصراف', callback_data: 'CANCEL' }]);

    bot.editMessageText(
      `دوره فعلی: *${escapeMarkdownV2(getCycleLabel(purchase.duration))}*\n\nلطفاً دوره جدید را انتخاب کنید:`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: keyboard }
      }
    );
  } catch (e) {
    console.error(`Change Cycle Ask Error: ${e.message}`);
    sendMessage(chatId, `❌ خطایی در نمایش دوره‌ها رخ داد.`);
  }
}


function isAfraDc(dcConfig) {
  return dcConfig?.provider === 'afracloud' || dcConfig?.apiType === 'afracloud';
}

function serverSecretNotConfiguredMessage() {
  return 'ذخیره امن رمز عبور روی سرور تنظیم نشده است. لطفاً با پشتیبانی تماس بگیرید.';
}

async function getAfraPasswordFromApiOnce(dcConfig, serverId) {
  try {
    const tok = await openstackApi.getToken(dcConfig);
    return await openstackApi.resetServerPassword(dcConfig, tok, serverId);
  } catch (e) {
    const status = e?.response?.status || e?.status;
    if (status === 401 || status === 403) {
      const err = new Error('AFRA_PASSWORD_API_FORBIDDEN');
      err.code = 'AFRA_PASSWORD_API_FORBIDDEN';
      throw err;
    }
    throw e;
  }
}

async function handleGetStoredPassword(chatId, userId, serverId, dcConfig, messageId) {
  if (!isAfraDc(dcConfig)) return handleResetPasswordConfirm(chatId, serverId, dcConfig, messageId);
  try {
    let password = await getServerSecret(serverId, 'root_password');
    if (!password) {
      try {
        password = await getAfraPasswordFromApiOnce(dcConfig, serverId);
        if (password) await upsertServerSecret({ telegramId: userId, serverId, datacenter: dcConfig.key, secretType: 'root_password', secretValue: password });
      } catch (e) {
        if (e.code === 'SERVER_SECRET_KEY_MISSING') return sendMessage(chatId, serverSecretNotConfiguredMessage());
        if (e.code === 'AFRA_PASSWORD_API_FORBIDDEN') return sendMessage(chatId, 'برای این سرور رمزی در ربات ذخیره نشده و API افراکلود اجازه دریافت رمز را نمی‌دهد. اگر این سرور قبل از پچ جدید ساخته شده، پشتیبانی باید رمز را یک‌بار ثبت کند.');
        throw e;
      }
    }
    if (!password) return sendMessage(chatId, 'برای این سرور رمزی در ربات ذخیره نشده است. لطفاً با پشتیبانی تماس بگیرید.');
    return sendMessage(chatId, `🔑 رمز عبور سرور:\n${htmlCodeBlock(password)}`, { parse_mode: 'HTML' });
  } catch (e) {
    if (e.code === 'SERVER_SECRET_KEY_MISSING' || e.message === 'SERVER_SECRET_KEY_MISSING') return sendMessage(chatId, serverSecretNotConfiguredMessage());
    console.error('[get_stored_password] failed:', { server_id: serverId, message: e.message });
    return sendMessage(chatId, 'دریافت رمز عبور با خطا مواجه شد. لطفاً با پشتیبانی تماس بگیرید.');
  }
}

async function resetAfraPasswordBySsh({ userId, dcConfig, serverId }) {
  const oldPassword = await getServerSecret(serverId, 'root_password');
  if (!oldPassword) throw new Error('NO_STORED_PASSWORD');
  const tok = await openstackApi.getToken(dcConfig);
  const srv = await openstackApi.getServer(dcConfig, tok, serverId);
  const ip = extractServerIp(srv);
  if (!ip) throw new Error('NO_SERVER_IP');
  const status = String(srv.status || srv.state || '').toLowerCase();
  if (status.includes('stop') || status.includes('suspend') || status.includes('shutoff')) throw new Error('SERVER_NOT_RUNNING');
  const newPassword = generateStrongPassword();
  await resetLinuxRootPasswordOverSsh({ host: ip, username: 'root', currentPassword: oldPassword, newPassword });
  await upsertServerSecret({ telegramId: userId, serverId, datacenter: dcConfig.key, secretType: 'root_password', secretValue: newPassword });
  return { newPassword, ip };
}

async function handleAfraSshResetAsk(chatId, userId, serverId, dcConfig) {
  const keyboard = [
    [{ text: '✅ تایید ریست رمز', callback_data: makeShortCb(userId, { action: 'RESET_PASSWORD_SSH_CONFIRM', dcKey: dcConfig.key, serverId }) }],
    [{ text: '❌ انصراف', callback_data: 'CANCEL' }]
  ];
  return sendMessage(chatId, 'آیا مطمئن هستید؟ رمز قبلی دیگر معتبر نخواهد بود.', { reply_markup: { inline_keyboard: keyboard } });
}

function afraResetErrorMessage(e) {
  const code = e?.code || e?.message;
  return ({
    NO_STORED_PASSWORD: 'برای این سرور رمز قبلی در ربات ذخیره نشده، ریست خودکار ممکن نیست. با پشتیبانی تماس بگیرید.',
    NO_SERVER_IP: 'IP سرور پیدا نشد.',
    SERVER_NOT_RUNNING: 'برای ریست رمز، سرور باید روشن باشد. ابتدا سرور را روشن کنید.',
    SSH_AUTH_FAILED: 'اتصال SSH با رمز ذخیره‌شده برقرار نشد. ممکن است رمز از خارج تغییر کرده باشد.',
    SSH_TIMEOUT: 'اتصال SSH برقرار نشد. مطمئن شوید سرور روشن است و پورت ۲۲ باز است.',
    SSH_COMMAND_FAILED: 'اتصال برقرار شد اما تغییر رمز انجام نشد. لطفاً با پشتیبانی تماس بگیرید.',
    SERVER_SECRET_KEY_MISSING: serverSecretNotConfiguredMessage()
  })[code] || 'ریست رمز عبور با خطا مواجه شد. لطفاً با پشتیبانی تماس بگیرید.';
}

async function handleAfraSshResetConfirm(chatId, userId, serverId, dcConfig, messageId) {
  await bot.editMessageText('⏳ در حال اتصال به سرور و تغییر رمز عبور...', { chat_id: chatId, message_id: messageId }).catch(() => sendMessage(chatId, '⏳ در حال اتصال به سرور و تغییر رمز عبور...'));
  try {
    const { newPassword } = await resetAfraPasswordBySsh({ userId, dcConfig, serverId });
    return sendMessage(chatId, `✅ رمز عبور با موفقیت تغییر کرد.\n🔑 رمز جدید:\n${htmlCodeBlock(newPassword)}\nلطفاً رمز را در جای امن ذخیره کنید.`, { parse_mode: 'HTML' });
  } catch (e) {
    console.error('[afra_ssh_reset] failed:', { server_id: serverId, code: e.code || e.message });
    return sendMessage(chatId, afraResetErrorMessage(e));
  }
}

async function handleResetPasswordAsk(chatId, userId, serverId, dcConfig) {
  if (!requireCapabilityOrReply(chatId, dcConfig, 'resetPassword')) return;
  const keyboard = [
    [{ text: '✅ تأیید ریست پسورد', callback_data: makeShortCb(userId, { action: 'RESETPW', dcKey: dcConfig.key, serverId }) }],
    [{ text: '❌ انصراف', callback_data: 'CANCEL' }]
  ];
  await bot.sendMessage(chatId, `آیا مطمئن هستید می‌خواهید پسورد سرور ${serverId} ریست شود؟`, {
    reply_markup: { inline_keyboard: keyboard }
  });
}
async function handleResetPasswordConfirm(chatId, serverId, dcConfig, messageId) {
  if (!requireCapabilityOrReply(chatId, dcConfig, 'resetPassword')) return;
  try {

    const isHetzner = (dcConfig?.apiType === 'hetzner') || (dcConfig?.provider === 'hetzner');
const isAfra = (dcConfig?.provider === 'afracloud');
    // OpenStack: پسورد را خودمان ست می‌کنیم.
    // Hetzner: API خودش پسورد جدید را تولید و در root_password برمی‌گرداند.
    const tok = await openstackApi.getToken(dcConfig);

    let actualPass = null;
if (isAfra) {
  const actualPass = await openstackApi.resetServerPassword(dcConfig, tok, serverId);

  return bot.editMessageText(
    `✅ رمز فعلی/دریافتی سرور:\n${htmlCodeBlock(actualPass || 'رمزی برنگشت')}`,
    {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'HTML'
    }
  );
}
    if (isHetzner) {
      actualPass = await openstackApi.resetServerPassword(dcConfig, tok, serverId);
    } else {
      const newPass = crypto.randomBytes(6).toString('hex');
      await openstackApi.resetServerPassword(dcConfig, tok, serverId, newPass);
      actualPass = newPass;
    }

    const passText = actualPass ? htmlCodeBlock(actualPass) : '<code>(no password returned)</code>';
    await bot.editMessageText(
      `✅ پسورد سرور ${htmlEscape(serverId)} ریست شد.\n<b>رمز جدید:</b>\n${passText}`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'HTML'
      }
    );
  } catch (e) {
    await bot.editMessageText(`❌ خطا در ریست پسورد: ${e.message}`, {
      chat_id: chatId,
      message_id: messageId
    });
  }
}



async function handleChangeCycleConfirm(chatId, userId, serverId, dcConfig, newCycle, messageId) {
bot.editMessageText('⏳ در حال محاسبه و تغییر دوره پرداخت\\.\u200C\\.\u200C\\.', { // \u200C برای جلوگیری از چسبندگی احتمالی
  chat_id: chatId,
  message_id: messageId,
  reply_markup: null,
  parse_mode: 'MarkdownV2'
}).catch(()=>{});

  try {
    const purchase   = await getPurchaseByServerId(serverId);
    const userWallet = await getUserWallet(userId);

    // اگر خرید نبود
    if (!purchase) {
      return sendMessage(chatId, '❌ اطلاعات خرید سرور یافت نشد. لطفاً با پشتیبانی تماس بگیرید.');
    }

    // ۱) زمان سپری‌شده از سیکل فعلی
    const now            = new Date();
    const lastBilledDate = new Date(purchase.last_billed_at || purchase.created_at || now);
    const elapsedHours   = Math.max(0, (now - lastBilledDate) / (3600 * 1000));

    // ۲) اعتبار زمان استفاده‌نشده در سیکل فعلی بر اساس مبلغ کامل دوره
    const currentCycleHours  = HOURS_IN_CYCLE[purchase.duration];
    if (!currentCycleHours) {
      return sendMessage(chatId, `❌ سیکل فعلی نامعتبر است: ${escapeMarkdownV2(String(purchase.duration))}`);
    }
    const currentCycleAmount = normalizeStoredCycleAmount(purchase);
    const hourlyPrice        = currentCycleAmount / currentCycleHours;
    const unusedHours        = Math.max(0, currentCycleHours - elapsedHours);
    const creditForUnusedTime= unusedHours * hourlyPrice;

    // ۳) هزینه سیکل جدید با همان نرخ ساعتی مؤثر
    const targetCycleHours   = HOURS_IN_CYCLE[newCycle];
    if (!targetCycleHours) {
      return sendMessage(chatId, `❌ سیکل انتخابی نامعتبر است: ${escapeMarkdownV2(String(newCycle))}`);
    }
    const newCyclePrice      = Math.round(hourlyPrice * targetCycleHours);

    // ۴) مابه‌التفاوت
    const difference         = newCyclePrice - creditForUnusedTime;

    if (difference > 0) {
      if (userWallet < difference) {
        const required = Math.ceil(difference - userWallet);
        return sendMessage(
          chatId,
          `❌ موجودی کافی نیست. برای تغییر دوره به ${escapeMarkdownV2(newCycle)}، شما به ${escapeMarkdownV2(difference.toFixed(0))} تومان نیاز دارید.\n` +
          `لطفاً حداقل ${escapeMarkdownV2(required)} تومان کیف پول خود را شارژ کنید.`,
          { parse_mode: 'MarkdownV2' }
        );
      }
      await debitUser(userId, difference);
      await recordWalletLog(userId, -difference, `تغییر دوره سرور ${purchase.server_name} به ${newCycle}`, 'upgrade');
    } else {
      const refund = Math.abs(difference);
      await creditUser(userId, refund);
      await recordWalletLog(userId, refund, `اعتبار بازگشتی از تغییر دوره سرور ${purchase.server_name} به ${newCycle}`, 'downgrade');
    }

    // ۵) به‌روزرسانی دیتابیس
    await updatePurchaseCycle(serverId, newCycle);
    const newBalance = await getUserWallet(userId);

    sendMessage(
      chatId,
      `✅ دوره پرداخت سرور *${escapeMarkdownV2(purchase.server_name)}* با موفقیت به *${escapeMarkdownV2(newCycle)}* تغییر یافت.\n` +
      `موجودی جدید شما: ${escapeMarkdownV2(Number(newBalance).toFixed(0))} تومان.`,
      { parse_mode: 'MarkdownV2' }
    );

  } catch (e) {
    console.error(`Change Cycle Confirm Error for ${serverId}:`, e);
    sendMessage(chatId, `❌ عملیات تغییر دوره با خطا مواجه شد: ${escapeMarkdownV2(String(e.message))}`, { parse_mode: 'MarkdownV2' });
  }
}
async function handleSnapshotAsk(chatId, userId, serverId, dcConfig) {
  if (!requireCapabilityOrReply(chatId, dcConfig, 'snapshot')) return;
  const keyboard = [
    [{ text: '✅ تایید Snapshot', callback_data: makeShortCb(userId, { action: 'SNAPSHOT', dcKey: dcConfig.key, serverId }) }],
    [{ text: '❌ انصراف', callback_data: 'CANCEL' }]
  ];
  await bot.sendMessage(chatId, `آیا مطمئن هستید می‌خواهید از سرور ${serverId} اسنپ‌شات بگیرید؟`, {
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function handleSnapshotConfirm(chatId, userId, serverId, dcConfig, messageId) {
  if (!requireCapabilityOrReply(chatId, dcConfig, 'snapshot')) return;
  try {
    const tok = await openstackApi.getToken(dcConfig);
    const snapName = `snap-${userId}-${Date.now()}`;

    await bot.editMessageText(`⏳ در حال ایجاد Snapshot برای سرور ${serverId}...`, {
      chat_id: chatId,
      message_id: messageId
    });

    await openstackApi.createSnapshot(dcConfig, tok, serverId, snapName, userId);

    await bot.editMessageText(`✅ درخواست ساخت Snapshot با نام \`${snapName}\` ارسال شد.\nممکن است ساخت آن چند دقیقه طول بکشد.`, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown'
    });
  } catch (e) {
    await bot.editMessageText(`❌ خطا در ایجاد Snapshot: ${e.message}`, {
      chat_id: chatId,
      message_id: messageId
    });
  }
}

async function handleBuildFromSnapshot(chatId, userId, dcConfig) {
  if (!requireCapabilityOrReply(chatId, dcConfig, 'buildFromSnapshot')) return;
  try {
    const tok = await openstackApi.getToken(dcConfig);
    const snaps = await openstackApi.listSnapshots(dcConfig, tok, userId);

    if (!snaps.length) {
      return sendMessage(chatId, 'هیچ Snapshotی برای شما یافت نشد.');
    }

    const keyboard = snaps.map(s => ([{
      text: s.name || s.id,
      callback_data: makeShortCb(userId, {
        action: 'BUILD_SNAPSHOT_CONFIRM',
        dcKey: dcConfig.key,
        snapshotId: s.id
      })
    }]));

    keyboard.push([{ text: '❌ انصراف', callback_data: 'CANCEL' }]);

    await sendMessage(chatId, '🧩 یکی از Snapshotهای خود را برای ساخت سرور جدید انتخاب کنید:', {
      reply_markup: { inline_keyboard: keyboard }
    });
  } catch (e) {
    console.error('listSnapshots error:', e.message);
    sendMessage(chatId, '❌ خطا در دریافت لیست Snapshotها.');
  }
}




async function handleBuildSnapshotConfirm(chatId, userId, dcConfig, snapshotId, messageId) {
  try {
    const tok = await openstackApi.getToken(dcConfig);
    const srvName = `from-snap-${Date.now()}`;

    await bot.editMessageText(`🚀 در حال ساخت سرور از Snapshot ${snapshotId}...`, {
      chat_id: chatId,
      message_id: messageId
    });

    const flavor = dcConfig.flavors?.[0];
    if (!flavor) throw new Error("هیچ پلنی در این دیتاسنتر تعریف نشده است.");

    // ✅ اینجا keyName رو null کن چون از snapshot می‌سازیم
    const srv = await openstackApi.createServer(
      dcConfig,
      tok,
      srvName,
      flavor.id,
      snapshotId,
      null, // ✅ دیگه network ID نیست
      { user: userId, fromSnapshot: true },
      flavor.disk,
      "volume"
    );

    await sendMessage(chatId, `✅ سرور جدید با نام \`${srvName}\` از Snapshot ساخته شد.`, {
      parse_mode: "Markdown"
    });
  } catch (e) {
    console.error("❌ handleBuildSnapshotConfirm error:", e.message);
    await sendMessage(chatId, `❌ خطا در ساخت سرور از Snapshot: ${e.message}`);
  }
}







// --- Main Callback Query Handler ---
bot.on('callback_query', async q => {
  await bot.answerCallbackQuery(q.id);

  const adminId = String(q.from.id);
  const isImpersonating = adminId === String(SUPPORT_ID) && adminState.impersonating;

  const effectiveUserId = isImpersonating ? adminState.impersonating : String(q.from.id);
  const effectiveChatId = q.message.chat.id;

  const data = q.data;

  const payload = readShortCb(effectiveUserId, data);
if (payload && payload.action === 'PROJECT_SUM') {
  const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];
  if (!requireCapabilityOrReply(effectiveChatId, dc, 'projectTraffic')) return;
  return getProjectTrafficSummary(effectiveChatId, effectiveUserId, dc, payload.projectId);
}





 if (payload) {
    switch (payload.action) {
         case 'OPEN_PROJECT': {
      const { dcKey, projectId } = payload;
      const allDCs = getUserEffectiveDCs(effectiveUserId);

      // 🔹 دیتاسنتر رو هم با کلید ترکیبی هم با baseKey پیدا کن
      const dc =
        allDCs[dcKey] ||
        Object.values(allDCs).find(d =>
          d.OS_PROJECT_ID === projectId &&
          (d.__baseKey === dcKey || d.key.split('__')[0] === dcKey)
        );

      if (!dc) {
        return sendMessage(effectiveChatId, '❌ دیتاسنتر نامعتبر.');
      }

      let servers = [];
      try {
        const tok = await openstackApi.getToken(dc);
        const all = await openstackApi.listServers(dc, tok);
        servers = all || [];
      } catch (e) {
        console.error("OPEN_PROJECT error", e.message);
      }

      const keyboard = [
        [{
          text: "📊 مشاهده کل ترافیک پروژه",
          callback_data: makeShortCb(effectiveUserId, {
            action: 'PROJECT_SUM',
            dcKey,
            projectId
          })
        }]
      ];

      servers.forEach(s => {
        keyboard.push([{
          text: `🖥 ${s.name}`,
          callback_data: makeShortCb(effectiveUserId, {
            action: 'M',
            dcKey,
            serverId: s.id
          })
        }]);
      });

      return sendMessage(
        effectiveChatId,
        `🖥 سرورهای پروژه ${escapeMarkdownV2(projectId)}:`,
        { parse_mode: 'MarkdownV2', reply_markup: { inline_keyboard: keyboard } }
      );
    }
case 'GET_TRAFFIC_RAW': {
  const cfg = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];
  if (!cfg) return sendMessage(effectiveChatId, '❌ دیتاسنتر نامعتبر.');
  if (!hasCapability(cfg, 'traffic') && !hasCapability(cfg, 'projectTraffic')) return unsupportedFeature(effectiveChatId);
  return getTrafficInfoRaw(effectiveChatId, payload.serverId, cfg);
}
      case 'M': {
        const { dcKey, serverId } = payload;
        const manageDcConfig = getUserEffectiveDCs(effectiveUserId)[dcKey];
        if (!manageDcConfig) return sendMessage(effectiveChatId, '❌ دیتاسنتر نامعتبر.');
        return handleServerManagement(effectiveChatId, effectiveUserId, serverId, manageDcConfig);
      }

      case 'HU': {
        const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey] || baseDatacenters.hetzner;
        if (!isHetznerDc(dc)) return sendMessage(effectiveChatId, '❌ دیتاسنتر نامعتبر.');
        return handleHetznerUpgradeMenu(effectiveChatId, effectiveUserId, payload.serverId, dc);
      }
      case 'HUS': {
        const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey] || baseDatacenters.hetzner;
        if (!isHetznerDc(dc)) return sendMessage(effectiveChatId, '❌ دیتاسنتر نامعتبر.');
        return handleHetznerUpgradeSelect(effectiveChatId, effectiveUserId, payload.serverId, dc, payload.targetFlavor);
      }
      case 'HUC': {
        const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey] || baseDatacenters.hetzner;
        if (!isHetznerDc(dc)) return sendMessage(effectiveChatId, '❌ دیتاسنتر نامعتبر.');
        return handleHetznerUpgradeConfirm(effectiveChatId, effectiveUserId, payload.serverId, dc, payload.targetFlavor, !!payload.upgradeDisk);
      }
      case 'HUCANCEL': {
        return sendMessage(effectiveChatId, 'عملیات ارتقا لغو شد.');
      }

      case 'GET_STORED_PASSWORD': {
        const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];
        return handleGetStoredPassword(effectiveChatId, effectiveUserId, payload.serverId, dc, q.message.message_id);
      }
      case 'RESET_PASSWORD_SSH_ASK': {
        const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];
        return handleAfraSshResetAsk(effectiveChatId, effectiveUserId, payload.serverId, dc);
      }
      case 'RESET_PASSWORD_SSH_CONFIRM': {
        const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];
        return handleAfraSshResetConfirm(effectiveChatId, effectiveUserId, payload.serverId, dc, q.message.message_id);
      }
      case 'GET_KEY': {
        const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];
        if (!requireCapabilityOrReply(effectiveChatId, dc, 'privateKey')) return;
        return getPrivateKey(effectiveChatId, payload.serverId);
      }
case 'SELECT_IMAGE': {
  const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];
  if (!dc) return sendMessage(effectiveChatId, '❌ دیتاسنتر نامعتبر.');
  return handleImageSelection(
    effectiveChatId,
    effectiveUserId,
    q.message.message_id,
    payload.imageId,
    dc
  );
}
      case 'GET_TRAFFIC': {
        const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];
        if (!requireCapabilityOrReply(effectiveChatId, dc, 'traffic')) return;
        return getTrafficInfo(effectiveChatId, payload.serverId, dc);
      }

      case 'ASK_RESETPW': {
        const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];
        if (!requireCapabilityOrReply(effectiveChatId, dc, 'resetPassword')) return;
        return isAfraDc(dc) ? handleGetStoredPassword(effectiveChatId, effectiveUserId, payload.serverId, dc, q.message.message_id) : handleResetPasswordAsk(effectiveChatId,effectiveUserId, payload.serverId, dc);
      }

      case 'CHANGECYCLE_ASK': {
        const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];
        if (!hasCapability(dc, 'changeCycle') || getAllowedCycles(dc).length <= 1) return unsupportedFeature(effectiveChatId, 'برای این دیتاسنتر فقط پرداخت ماهانه فعال است');
        return handleChangeCycleAsk(effectiveChatId, payload.serverId, dc, q.message.message_id);
      }

      case 'REBUILD_ASK': {
        const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];
        if (!requireCapabilityOrReply(effectiveChatId, dc, 'rebuild')) return;
        return handleRebuildAsk(effectiveChatId, effectiveUserId, payload.serverId, dc, q.message.message_id);
      }

      case 'ASK_DELETE': {
        const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];
        if (!requireCapabilityOrReply(effectiveChatId, dc, 'deleteServer')) return;
        return askForDeletionConfirmation(effectiveChatId, effectiveUserId, payload.serverId, dc);
      }
case 'SUSPEND': {
  const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];
  if (!requireCapabilityOrReply(effectiveChatId, dc, 'suspendServer')) return;
  const tok = await openstackApi.getToken(dc);
  await openstackApi.suspendServer(dc, tok, payload.serverId);
  await updatePurchaseStatus(payload.serverId, 'suspended').catch(() => {});
  await sendMessage(effectiveChatId, '✅ دستور خاموش کردن سرور ارسال شد.');
  return handleServerManagement(effectiveChatId, effectiveUserId, payload.serverId, dc);
}
case 'RESUME': {
  const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];
  if (!requireCapabilityOrReply(effectiveChatId, dc, 'resumeServer')) return;
  const tok = await openstackApi.getToken(dc);
  await openstackApi.resumeServer(dc, tok, payload.serverId);
  await updatePurchaseStatus(payload.serverId, 'active').catch(() => {});
  await sendMessage(effectiveChatId, '✅ دستور روشن کردن سرور ارسال شد.');
  return handleServerManagement(effectiveChatId, effectiveUserId, payload.serverId, dc);
}
case 'RENEW_OFF': {
  const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];
  if (!dc) return sendMessage(effectiveChatId, '❌ دیتاسنتر نامعتبر.');
  return sendMessage(effectiveChatId, 'با غیرفعال کردن تمدید خودکار، این سرور تا پایان دوره فعلی فعال می‌ماند و بعد از آن تمدید نمی‌شود و متوقف خواهد شد. آیا مطمئن هستید؟', {
    reply_markup: { inline_keyboard: [
      [{ text: '✅ بله، تمدید خودکار را خاموش کن', callback_data: makeShortCb(effectiveUserId, { action: 'RENEW_OFF_CONFIRM', dcKey: payload.dcKey, serverId: payload.serverId }) }],
      [{ text: '↩️ انصراف', callback_data: makeShortCb(effectiveUserId, { action: 'RENEW_CANCEL', dcKey: payload.dcKey, serverId: payload.serverId }) }]
    ]}
  });
}
case 'RENEW_OFF_CONFIRM': {
  const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];
  if (!dc) return sendMessage(effectiveChatId, '❌ دیتاسنتر نامعتبر.');
  const ok = await setPurchaseAutoRenew(effectiveUserId, payload.serverId, payload.dcKey, false);
  await sendMessage(effectiveChatId, ok ? '✅ تمدید خودکار این سرور غیرفعال شد. سرور تا پایان دوره فعلی فعال می‌ماند و بعد از آن تمدید نمی‌شود.' : '❌ خرید مربوط به این سرور پیدا نشد.');
  return handleServerManagement(effectiveChatId, effectiveUserId, payload.serverId, dc);
}
case 'RENEW_ON': {
  const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];
  if (!dc) return sendMessage(effectiveChatId, '❌ دیتاسنتر نامعتبر.');
  return handlePurchaseAutoRenewEnable(effectiveChatId, effectiveUserId, payload.serverId, dc);
}
case 'RENEW_CANCEL': {
  const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];
  await sendMessage(effectiveChatId, '↩️ عملیات لغو شد.');
  if (dc) return handleServerManagement(effectiveChatId, effectiveUserId, payload.serverId, dc);
  return;
}

case 'CONFIRM_DELETE': {
  const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];
  if (!requireCapabilityOrReply(effectiveChatId, dc, 'deleteServer')) return;
  return handleServerDeletion(effectiveChatId, effectiveUserId, payload.serverId, dc);
}
case 'RESETPW': {
  const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];
  if (!dc) return sendMessage(effectiveChatId, '❌ دیتاسنتر نامعتبر.');
  if (!requireCapabilityOrReply(effectiveChatId, dc, 'resetPassword')) return;
  return isAfraDc(dc) ? handleGetStoredPassword(effectiveChatId, effectiveUserId, payload.serverId, dc, q.message.message_id) : handleResetPasswordConfirm(effectiveChatId, payload.serverId, dc, q.message.message_id);
}
case 'SNAPSHOT_ASK': {
  const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];
  if (!requireCapabilityOrReply(effectiveChatId, dc, 'snapshot')) return;
  console.log('>>> SNAPSHOT_ASK triggered');
  return handleSnapshotAsk(
    effectiveChatId,
    effectiveUserId,
    payload.serverId,
    dc
  );
}

case 'SNAPSHOT': {
  const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];
  if (!requireCapabilityOrReply(effectiveChatId, dc, 'snapshot')) return;
  console.log('>>> SNAPSHOT confirm');
  return handleSnapshotConfirm(
    effectiveChatId,
    effectiveUserId,
    payload.serverId,
    dc,
    q.message.message_id
  );
}

case 'BUILD_FROM_SNAPSHOT': {
  const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];
  if (!requireCapabilityOrReply(effectiveChatId, dc, 'buildFromSnapshot')) return;
  console.log('>>> BUILD_FROM_SNAPSHOT triggered');
  return handleBuildFromSnapshot(effectiveChatId, effectiveUserId, dc);
}

case 'BUILD_SNAPSHOT_CONFIRM': {
  const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];
  if (!requireCapabilityOrReply(effectiveChatId, dc, 'buildFromSnapshot')) return;
  console.log('>>> BUILD_SNAPSHOT_CONFIRM triggered');
  return handleBuildSnapshotConfirm(
    effectiveChatId,
    effectiveUserId,
    dc,
    payload.snapshotId,
    q.message.message_id
  );
}

default:
  console.log('[WARN] Unhandled payload action:', payload.action);
  return;

   }
    return; // ⛔️ خیلی مهم: دیگه به مسیر قدیمی نرو
  }
  const [action, ...params] = data.split('_');

  if (action === 'DC') {
    const flowType = params[0];
    const dcKey = params[1];
   // const dcConfig = datacenters[dcKey];
const dcConfig = getUserEffectiveDCs(effectiveUserId)[dcKey];

    if (!dcConfig) return sendMessage(effectiveChatId, "❌ دیتاسنتر نامعتبر.");
    state[effectiveUserId] = { ...state[effectiveUserId], selectedDatacenterConfig: dcConfig, messageId: q.message.message_id };

    if (flowType === 'TEST') {
      bot.deleteMessage(effectiveChatId, q.message.message_id).catch(()=>{});
      handleFreeTrialRequest(effectiveChatId, effectiveUserId, dcConfig);
    } else if (flowType === 'BUY') {
      const dbUser = await getUser(effectiveUserId);
      if (requiresShahkar(dcConfig, 'buy') && !isShahkarVerified(dbUser)) {
        if (!dbUser?.phone || dbUser.phone === 'EXEMPT') {
          return sendMessage(effectiveChatId, '⚠️ برای خرید این دیتاسنتر، ابتدا /start را بزنید و شماره موبایل واقعی خود را به اشتراک بگذارید.');
        }
        state[effectiveUserId] = {
          ...state[effectiveUserId],
          step: 'WAIT_SHAHKAR_NATIONAL_CODE',
          selectedDatacenterConfig: dcConfig,
          messageId: q.message.message_id,
          afterShahkar: 'CONTINUE_BUY'
        };
        return bot.editMessageText(`🔐 برای خرید سرورهای این دیتاسنتر، احراز هویت شاهکار لازم است.
لطفاً کد ملی مالک همین شماره موبایل را وارد کنید:`, {
          chat_id: effectiveChatId,
          message_id: q.message.message_id
        }).catch(() => sendMessage(effectiveChatId, `🔐 برای خرید سرورهای این دیتاسنتر، احراز هویت شاهکار لازم است.
لطفاً کد ملی مالک همین شماره موبایل را وارد کنید:`));
      }
      return showBillingCycleSelection(effectiveChatId, effectiveUserId, q.message.message_id, dcConfig);
    }
    return;
  }

  if (action === 'CANCEL') {
    if (q.message) {
      bot.deleteMessage(effectiveChatId, q.message.message_id).catch(() => {});
    }
    return showMainMenu(effectiveChatId, effectiveUserId);
  }

  if (action === 'DOWNLOAD') {
    if (params[0] === 'WALLET' && params[1] === 'HISTORY') {
      handleDownloadWalletHistory(effectiveChatId, effectiveUserId);
    }
    return;
  }

  const dcConfigFromState = state[effectiveUserId]?.selectedDatacenterConfig;
  // ← فقط «CC» را به این لیست اضافه کردیم
  const actionRequiresDcInState = !['M', 'ASK', 'CONFIRM', 'GET', 'REBUILD', 'RESETPW', 'CHANGECYCLE', 'CC', 'SUSPEND', 'RESUME'].includes(action);

  if (actionRequiresDcInState && !dcConfigFromState) {
     return sendMessage(effectiveChatId, "خطا: انتخاب دیتاسنتر منقضی شده است. لطفاً دوباره شروع کنید.");
  }

  switch (action) {

    case 'CYCLE':
      handleCycleSelection(effectiveChatId, effectiveUserId, q.message.message_id, params[0], dcConfigFromState);
      break;
    case 'FLAVOR':
      handleFlavorSelection(effectiveChatId, effectiveUserId, q.message.message_id, params[0], dcConfigFromState);
      break;
    case 'IMAGE':
      handleImageSelection(effectiveChatId, effectiveUserId, q.message.message_id, params[0], dcConfigFromState);
      break;
    case 'CONFIRM':
      if (params[0] === 'PURCHASE') {
        handlePurchaseConfirmation(effectiveChatId, effectiveUserId, q.message.message_id, dcConfigFromState);
      } else if (params[0] === 'DELETE') {
        const deleteDcKey = params[1];
        const serverIdToDelete = params[2];
      //  const deleteDcConfig = datacenters[deleteDcKey];
const deleteDcConfig = getUserEffectiveDCs(effectiveUserId)[deleteDcKey];
 if (!requireCapabilityOrReply(effectiveChatId, deleteDcConfig, 'deleteServer')) return;
 handleServerDeletion(effectiveChatId, effectiveUserId, serverIdToDelete, deleteDcConfig);
      }
      break;
    case 'M': {
      const manageDcKey = params[0];
      const serverIdToManage = params[1];
     // const manageDcConfig = datacenters[manageDcKey];
const manageDcConfig = getUserEffectiveDCs(effectiveUserId)[manageDcKey];
handleServerManagement(effectiveChatId, effectiveUserId, serverIdToManage, manageDcConfig);
      break;
    }
    case 'ASK': {
      const askAction = params[0];
      const askDcKey = params[1];
      const serverIdToAsk = params[2];
      const askDcConfig = getUserEffectiveDCs(effectiveUserId)[askDcKey];
      if (askAction === 'DELETE') {
        if (!requireCapabilityOrReply(effectiveChatId, askDcConfig, 'deleteServer')) return;
        askForDeletionConfirmation(effectiveChatId, effectiveUserId, serverIdToAsk, askDcConfig);
      } else if (askAction === 'RESETPW') {
        if (!requireCapabilityOrReply(effectiveChatId, askDcConfig, 'resetPassword')) return;
        handleResetPasswordAsk(effectiveChatId,effectiveUserId, serverIdToAsk, askDcConfig);
      }
      break;
    }
    case 'GET': {
      const getType = params[0];
      const getDcKey = params[1];
      const serverIdForGet = params[2];
      const getDcConfig =  getUserEffectiveDCs(effectiveUserId)[getDcKey];
      if (getType === 'KEY') {
        if (!requireCapabilityOrReply(effectiveChatId, getDcConfig, 'privateKey')) return;
        getPrivateKey(effectiveChatId, serverIdForGet);
      } else if (getType === 'TRAFFIC') {
        if (!requireCapabilityOrReply(effectiveChatId, getDcConfig, 'traffic')) return;
        getTrafficInfo(effectiveChatId, serverIdForGet, getDcConfig);
      }
      break;
    }
    case 'REBUILD': {
      const rebuildAction = params[0];
      if (rebuildAction === 'ASK') {
        const rebuildDcKey = params[1];
        const serverIdToRebuild = params[2];
        const rebuildDcConfig = getUserEffectiveDCs(effectiveUserId)[rebuildDcKey];
        if (!requireCapabilityOrReply(effectiveChatId, rebuildDcConfig, 'rebuild')) return;
        handleRebuildAsk(effectiveChatId, effectiveUserId, serverIdToRebuild, rebuildDcConfig, q.message.message_id);
      } else if (rebuildAction === 'IMG') {
        const imageId = params[1];
        const { serverId, dcConfig: rebuildDcConfigFromState } = state[effectiveUserId]?.rebuildInfo || {};
        if (!serverId || !rebuildDcConfigFromState) {
          return sendMessage(effectiveChatId, '❌ خطایی رخ داد، لطفاً دوباره از منوی مدیریت سرورها تلاش کنید.');
        }
        if (!requireCapabilityOrReply(effectiveChatId, rebuildDcConfigFromState, 'rebuild')) return;
        handleRebuildConfirm(effectiveChatId, effectiveUserId, serverId, imageId, rebuildDcConfigFromState, q.message.message_id);
      }
      break;
    }
    case 'CONFIRM_DELETE': {
  const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];
  if (!requireCapabilityOrReply(effectiveChatId, dc, 'deleteServer')) return;
  return handleServerDeletion(effectiveChatId, effectiveUserId, payload.serverId, dc);
}
case 'RESETPW': {
      const resetPwDcKey = params[0];
      const serverIdToReset = params[1];
      const resetPwDcConfig = getUserEffectiveDCs(effectiveUserId)[resetPwDcKey];
      if (!requireCapabilityOrReply(effectiveChatId, resetPwDcConfig, 'resetPassword')) return;
      handleResetPasswordConfirm(effectiveChatId, serverIdToReset, resetPwDcConfig, q.message.message_id);
      break;
    }
    case 'CHANGECYCLE': {
      const changeAction = params[0];
      const dcKey = params[1];
      const serverId = params[2];
   //   const dcConfig = datacenters[dcKey];
const dcConfig = getUserEffectiveDCs(effectiveUserId)[dcKey];

 if (!hasCapability(dcConfig, 'changeCycle') || getAllowedCycles(dcConfig).length <= 1) return unsupportedFeature(effectiveChatId, 'برای این دیتاسنتر فقط پرداخت ماهانه فعال است');
 if (changeAction === 'ASK') {
        handleChangeCycleAsk(effectiveChatId, serverId, dcConfig, q.message.message_id);
      } else if (changeAction === 'CONFIRM') {
        const newCycle = params[3];
        handleChangeCycleConfirm(effectiveChatId, effectiveUserId, serverId, dcConfig, newCycle, q.message.message_id);
      }
      break;
    }




    // ← الگوی جدید کوتاه برای تغییر سیکل
    case 'SUSPEND': {
      const dcKey = params[0];
      const serverId = params[1];
      const dcConfig = getUserEffectiveDCs(effectiveUserId)[dcKey];
      if (!requireCapabilityOrReply(effectiveChatId, dcConfig, 'suspendServer')) return;
      const tok = await openstackApi.getToken(dcConfig);
      await openstackApi.suspendServer(dcConfig, tok, serverId);
      await updatePurchaseStatus(serverId, 'suspended').catch(() => {});
      await sendMessage(effectiveChatId, '✅ دستور خاموش کردن سرور ارسال شد.');
      return handleServerManagement(effectiveChatId, effectiveUserId, serverId, dcConfig);
    }
    case 'RESUME': {
      const dcKey = params[0];
      const serverId = params[1];
      const dcConfig = getUserEffectiveDCs(effectiveUserId)[dcKey];
      if (!requireCapabilityOrReply(effectiveChatId, dcConfig, 'resumeServer')) return;
      const tok = await openstackApi.getToken(dcConfig);
      await openstackApi.resumeServer(dcConfig, tok, serverId);
      await updatePurchaseStatus(serverId, 'active').catch(() => {});
      await sendMessage(effectiveChatId, '✅ دستور روشن کردن سرور ارسال شد.');
      return handleServerManagement(effectiveChatId, effectiveUserId, serverId, dcConfig);
    }

    case 'CC': {
      const ccDcKey    = params[0];
      const ccServerId = params[1];
      const ccCycle    = params[2];
      const ccDcConfig = getUserEffectiveDCs(effectiveUserId)[ccDcKey];
      if (!ccDcConfig) {
        return sendMessage(effectiveChatId, "❌ دیتاسنتر نامعتبر.");
      }
      if (!hasCapability(ccDcConfig, 'changeCycle') || getAllowedCycles(ccDcConfig).length <= 1) return unsupportedFeature(effectiveChatId, 'برای این دیتاسنتر فقط پرداخت ماهانه فعال است');
      return handleChangeCycleConfirm(
        effectiveChatId,
        effectiveUserId,
        ccServerId,
        ccDcConfig,
        ccCycle,
        q.message.message_id
      );
    }
  }
});


// --- ADMIN COMMANDS ---


bot.onText(/\/set_server_password\s+(\d+)\s+(\S+)\s+(.+)/, async (msg, match) => {
  if (String(msg.from.id) !== String(SUPPORT_ID)) return;
  const [, userId, serverId, password] = match;
  try {
    const existing = await getPurchaseByServerId(serverId);
    let dcConfig = existing ? getUserEffectiveDCs(userId)[existing.datacenter] : (getUserEffectiveDCs(userId).afracloud || baseDatacenters.afracloud);
    if (!existing && dcConfig) {
      const tok = await openstackApi.getToken(dcConfig);
      const srv = await openstackApi.getServer(dcConfig, tok, serverId).catch(() => null);
      if (!srv) return sendMessage(msg.chat.id, '❌ خرید یا سرور افراکلود برای این شناسه پیدا نشد.');
    }
    await upsertServerSecret({ telegramId: userId, serverId, datacenter: dcConfig?.key || 'afracloud', secretType: 'root_password', secretValue: password });
    await sendMessage(userId, '🔐 رمز عبور سرور شما در ربات ثبت شد. از بخش مدیریت سرورها می‌توانید آن را دریافت کنید.').catch(() => null);
    return sendMessage(msg.chat.id, `✅ رمز سرور ${serverId} برای کاربر ${userId} ثبت شد. (masked: ****)`);
  } catch (e) {
    console.error('[set_server_password] failed:', { server_id: serverId, message: e.code || e.message });
    return sendMessage(msg.chat.id, `❌ ثبت رمز انجام نشد: ${e.code || e.message}`);
  }
});

bot.onText(/\/reset_afra_password_ssh\s+(\d+)\s+(\S+)/, async (msg, match) => {
  if (String(msg.from.id) !== String(SUPPORT_ID)) return;
  const [, userId, serverId] = match;
  const dcConfig = getUserEffectiveDCs(userId).afracloud || baseDatacenters.afracloud;
  try {
    const { newPassword } = await resetAfraPasswordBySsh({ userId, dcConfig, serverId });
    await sendMessage(msg.chat.id, `✅ رمز جدید:\n${htmlCodeBlock(newPassword)}`, { parse_mode: 'HTML' });
    await sendMessage(userId, `✅ رمز عبور سرور شما تغییر کرد.\n🔑 رمز جدید:\n${htmlCodeBlock(newPassword)}\nلطفاً رمز را در جای امن ذخیره کنید.`, { parse_mode: 'HTML' }).catch(() => null);
  } catch (e) {
    return sendMessage(msg.chat.id, `❌ ریست SSH انجام نشد: ${afraResetErrorMessage(e)}`);
  }
});

bot.onText(/\/test_afra_password_api\s+(\S+)/, async (msg, match) => {
  if (String(msg.from.id) !== String(SUPPORT_ID)) return;
  const [, serverId] = match;
  const dcConfig = baseDatacenters.afracloud;
  try {
    const password = await getAfraPasswordFromApiOnce(dcConfig, serverId);
    const purchase = await getPurchaseByServerId(serverId);
    if (password && purchase) await upsertServerSecret({ telegramId: purchase.telegram_id, serverId, datacenter: purchase.datacenter, secretType: 'root_password', secretValue: password });
    return sendMessage(msg.chat.id, `✅ Afra password API status: 200\npassword_returned=${password ? 'yes' : 'no'}\nstored=${password && purchase ? 'yes' : 'no'}`);
  } catch (e) {
    const status = e?.response?.status || e?.status || e.code || 'error';
    return sendMessage(msg.chat.id, `⚠️ Afra password API status: ${status}\npassword_returned=no\nmessage=${e.code || 'safe failure'}`);
  }
});


bot.onText(/\/attach_afra\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.+)/, async (msg, match) => {
  if (String(msg.from.id) !== String(SUPPORT_ID)) return;
  const [, userId, serverUuid, serverName, flavorUuid, monthlyPriceRaw, osLabelRaw] = match;
  const passwordMatch = osLabelRaw.match(/\s--password=(?:'([^']*)'|\"([^\"]*)\"|(\S+))/);
  const providedPassword = passwordMatch ? (passwordMatch[1] || passwordMatch[2] || passwordMatch[3]) : null;
  const cleanedLabelRaw = osLabelRaw.replace(/\s--password=(?:'[^']*'|\"[^\"]*\"|\S+)/, '');
  const debitFlag = /\s--debit\s*$/.test(cleanedLabelRaw);
  const osLabel = cleanedLabelRaw.replace(/\s--debit\s*$/, '').trim();
  const monthlyPrice = Number(monthlyPriceRaw);
  const dcConfig = getUserEffectiveDCs(userId).afracloud || baseDatacenters.afracloud;
  if (!dcConfig) return sendMessage(msg.chat.id, '❌ دیتاسنتر afracloud یافت نشد.');
  try {
    const tok = await openstackApi.getToken(dcConfig);
    const srv = await openstackApi.getServer(dcConfig, tok, serverUuid).catch(async () => {
      const servers = await openstackApi.listServers(dcConfig, tok);
      return (servers || []).find(s => String(s.id) === String(serverUuid) || String(s.uuid) === String(serverUuid));
    });
    if (!srv) return sendMessage(msg.chat.id, '❌ سرور در افراکلود پیدا نشد.');
    const existing = await getPurchaseByServerId(serverUuid);
    if (existing) return sendMessage(msg.chat.id, 'ℹ️ این سرور قبلاً به یک خرید متصل شده است.');
    const amountForDb = monthlyPrice / HOURS_IN_CYCLE.monthly;
    await recordPurchase(userId, serverUuid, 'afracloud', serverName, flavorUuid, amountForDb, 'monthly', DEFAULT_PRICE_PER_GB, DEFAULT_DOWNLOAD_ONLY, serverUuid, 'volume', osLabel);
    if (providedPassword) {
      await upsertServerSecret({ telegramId: userId, serverId: serverUuid, datacenter: 'afracloud', secretType: 'root_password', secretValue: providedPassword });
    }
    if (debitFlag) {
      await debitUser(userId, monthlyPrice);
      await recordWalletLog(userId, -monthlyPrice, `بازیابی و اتصال سرور افراکلود ${serverName}`, 'purchase_recovery');
    }
    await sendMessage(userId, `✅ سرور افراکلود شما با نام ${serverName} به حساب شما متصل شد و از بخش مدیریت سرورها قابل مشاهده است.`).catch(() => null);
    await sendMessage(msg.chat.id, `✅ سرور ${serverUuid} برای کاربر ${userId} متصل شد.${debitFlag ? ' کیف پول نیز کسر شد.' : ' کیف پول کسر نشد.'}`);
  } catch (e) {
    console.error('[attach_afra] failed:', { server_id: serverUuid, message: e.message });
    await sendMessage(msg.chat.id, `❌ خطا در اتصال سرور افراکلود: ${e.message}`);
  }
});

bot.onText(/\/credit (\d+) (\d+) (\d+)/, async (msg, match) => {
    if (String(msg.from.id) !== String(SUPPORT_ID)) return;
    const [, userId, amount, orderId] = match;
    await creditUser(userId, parseInt(amount));
    await recordWalletLog(userId, parseInt(amount), `تایید سفارش #${orderId}`, 'approved');
    const newBalance = await getUserWallet(userId);
    sendMessage(msg.chat.id, `✅ کاربر ${userId} شارژ شد. موجودی جدید: ${newBalance} تومان`);
    sendMessage(parseInt(userId), `✅ سفارش \\#${orderId} شما تایید شد. موجودی جدید: ${newBalance} تومان`);
});
bot.onText(/\/debit (\d+) (\d+) (.+)/, async (msg, match) => {
  if (String(msg.from.id) !== String(SUPPORT_ID)) return;
  const [, userId, amount, reason] = match;

  await debitUser(userId, parseInt(amount));
  await recordWalletLog(userId, -parseInt(amount), `کسر دستی: ${reason}`, 'manual_debit');

  const newBalance = await getUserWallet(userId);
  await sendMessage(msg.chat.id, `✅ از کیف پول کاربر ${userId} مبلغ ${amount} تومان کسر شد. موجودی جدید: ${newBalance}`);
  await sendMessage(parseInt(userId), `⚠️ مبلغ ${amount} تومان بابت "${reason}" از کیف پول شما کسر شد. موجودی جدید: ${newBalance} تومان`);
});


async function handleRebuildAsk(chatId, userId, serverId, dcConfig, messageId) {
  const images = await openstackApi.listImages(dcConfig, null);
  const serverType = state[userId]?.selectedFlavor?.id || '';
  const compatible = hetznerLifecycle.filterCompatibleImages(images, serverType);
  state[userId] = { ...(state[userId] || {}), rebuildInfo: { serverId, dcConfig } };
  const keyboard = compatible.slice(0, 20).map(img => [{ text: img.label || img.name || String(img.id), callback_data: `rebuild:IMG:${img.id}` }]);
  return bot.sendMessage(chatId, '⚠️ بازسازی سیستم‌عامل دیسک فعلی را پاک می‌کند. ایمیج سازگار را انتخاب کنید:', { reply_markup: { inline_keyboard: keyboard } });
}
async function handleRebuildConfirm(chatId, userId, serverId, imageId, dcConfig) {
  try {
    const result = await hetznerLifecycle.rebuildServerLifecycle({ db: require('./db'), dc: dcConfig, telegramId: userId, serverId, datacenter: dcConfig.key || dcConfig.__baseKey || 'hetzner', imageId });
    const passNote = result.root_password ? '\nرمز جدید فقط در همین پیام نمایش داده شد.' : '';
    await bot.sendMessage(chatId, `✅ بازسازی تکمیل شد و SSH در دسترس است.${passNote}`);
  } catch (e) {
    console.warn('[HETZNER_REBUILD_FAILED]', { server_id: serverId, code: e.code || e.message });
    await bot.sendMessage(chatId, hetznerLifecycle.safeProviderMessage(e));
  }
}

bot.onText(/\/run_billing/, async (msg) => {
    if (String(msg.from.id) !== String(SUPPORT_ID)) return;
    sendMessage(msg.chat.id, '⚙️ فرآیند صورتحساب به صورت دستی آغاز شد.');
    await runHourlyBilling();
    sendMessage(msg.chat.id, '✅ فرآیند صورتحساب به پایان رسید.');
});

bot.onText(/\/create_purchase (\d+) (.+?) (\w+) (.+?) (.+?) (\w+)/, async (msg, match) => {
    if (String(msg.from.id) !== String(SUPPORT_ID)) return;

    try {
        const [, userId, serverId, dcKey, serverName, flavorId, cycle] = match;

       // const dcConfig = datacenters[dcKey];
const dcConfig = getUserEffectiveDCs(userId)[dcKey];

if (!dcConfig) {
            return sendMessage(msg.chat.id, `❌ دیتاسنتر نامعتبر: ${dcKey}`);
        }

        const flavor = dcConfig.flavors.find(f => f.id === flavorId);
        if (!flavor) {
            return sendMessage(msg.chat.id, `❌ پلن نامعتبر: ${flavorId}`);
        }

        if (!HOURS_IN_CYCLE[cycle]) {
            return sendMessage(msg.chat.id, `❌ دوره پرداخت نامعتبر: ${cycle}`);
        }

        const hourlyPrice = Math.round(flavor.monthly_price * (prices.hourlyFactorFromMonthly || (1 / 720)));

        const tok = await openstackApi.getToken(dcConfig);
        const srv = await openstackApi.getServer(dcConfig, tok, serverId);
        const osLabel = srv.image?.name || 'Unknown OS';

        await recordPurchase(
            userId,
            serverId,
            dcKey,
            serverName,
            flavorId,
            hourlyPrice,
            cycle,
            DEFAULT_PRICE_PER_GB,
            DEFAULT_DOWNLOAD_ONLY,
            srv.id,
            'volume',
            osLabel
        );

        sendMessage(msg.chat.id, `✅ رکورد خرید برای کاربر ${userId} و سرور ${serverName} با موفقیت ایجاد شد.`);
    } catch (e) {
        console.error("Error creating manual purchase:", e);
        sendMessage(msg.chat.id, `❌ خطا در ایجاد رکورد خرید: ${e.message}`);
    }
});

bot.onText(/\/set_billing (.+?) (\d+) (0|1)/, async (msg, match) => {
    if (String(msg.from.id) !== String(SUPPORT_ID)) return;
    try {
        const [, serverId, pricePerGb, downloadOnly] = match;
        await updatePurchaseBilling(serverId, parseInt(pricePerGb), parseInt(downloadOnly));
        sendMessage(msg.chat.id, `✅ تنظیمات صورتحساب برای سرور ${serverId} به‌روزرسانی شد.`);
    } catch (e) {
        console.error("Error setting billing:", e);
        sendMessage(msg.chat.id, `❌ خطا در تنظیم صورتحساب: ${e.message}`);
    }
});

bot.onText(/\/set_traffic (.+?) (\w+) (\d+)/, async (msg, match) => {
    if (String(msg.from.id) !== String(SUPPORT_ID)) return;
    try {
        const [, serverId, cycle, amountGb] = match;
        if (!['hourly', 'daily', 'weekly', 'monthly'].includes(cycle)) {
            return sendMessage(msg.chat.id, '❌ دوره پرداخت نامعتبر است. فقط از hourly, daily, weekly, monthly استفاده کنید.');
        }
        await updatePurchaseFreeTraffic(serverId, cycle, parseInt(amountGb));
        sendMessage(msg.chat.id, `✅ ترافیک رایگان برای سرور ${serverId} به‌روزرسانی شد.`);
    } catch (e) {
        console.error("Error setting free traffic:", e);
        sendMessage(msg.chat.id, `❌ خطا در تنظیم ترافیک رایگان: ${e.message}`);
    }
});


// --- Handler Functions for each step ---
// index.js
bot.onText(/\/set_topup_base (\d+) (\d+)/, async (msg, m) => {
  if (String(msg.from.id) !== String(SUPPORT_ID)) return;
  const [, userId, amount] = m;
  await recordWalletLog(userId, Number(amount), 'Topup baseline set', 'topup_baseline');
  sendMessage(msg.chat.id, `✅ baseline ${amount} برای ${userId} ثبت شد.`);
});

async function getUserTopupTotal(userId) {
  const logs = await getWalletLogs(userId, null) || [];
  let baseline = 0, deposits = 0;
  for (const l of logs) {
    const amt  = Number(l.amount || 0);
    const type = String(l.type || '').toLowerCase();
    if (type === 'topup_baseline') baseline += amt;
    if (amt > 0 && (type === 'approved' || type === 'deposit')) deposits += amt;
  }
  return Math.max(0, Math.floor(baseline + deposits));
}

async function handleFreeTrialRequest(chatId, userId, dcConfig) {
    sendMessage(chatId, `🚀 در حال بررسی و ساخت سرور تست در دیتاسنتر ${dcConfig.name}...`);

    const hasUsed = await hasUsedFreeTestServer(userId, dcConfig.key);
    if (hasUsed) {
        return sendMessage(chatId, `❌ شما قبلاً از سرور تست رایگان در دیتاسنتر ${dcConfig.name} استفاده کرده‌اید.`);
    }

    try {
        const tok = await openstackApi.getToken(dcConfig);
        const flavorId = dcConfig.OS_TEST_FLAVOR_ID;
        const imageId = dcConfig.OS_TEST_IMAGE_ID;

        const allFlavors = await openstackApi.listFlavors(dcConfig);
        const allImages = await openstackApi.listImages(dcConfig, tok);

        const flavor = allFlavors.find(f => f.id === flavorId);
        const image = allImages.find(i => i.id === imageId);

        if (!flavor || !image) {
            return sendMessage(chatId, "❌ پلن یا ایمیج تست برای این دیتاسنتر تعریف نشده است.");
        }

        const keyName = `test-${userId}-${crypto.randomBytes(4).toString('hex')}`;
        const kp = await openstackApi.createKeyPair(dcConfig, tok, keyName);
        const testServerName = `Test-${dcConfig.key.substring(0, 3).toUpperCase()}-${crypto.randomBytes(2).toString('hex')}`;

        const srv = await openstackApi.createServer(dcConfig, tok, testServerName, flavor.id, image.id, keyName, { user: userId, type: 'test', datacenter: dcConfig.key }, flavor.disk, 'image');

        const rawPrivateKey = String(kp.private_key || '')
            .replace(/-----BEGIN RSA PRIVATE KEY-----/g, '')
            .replace(/-----END RSA PRIVATE KEY-----/g, '')
            .trim();

        await storeKeyPair(userId, srv.id, keyName, rawPrivateKey);
        await recordTestServer(userId, dcConfig.key, srv.id, null);

        let ip = await pollForIp(dcConfig, tok, srv.id);
        let rootPassword = srv.adminPass;


        const privateKeyText = `-----BEGIN RSA PRIVATE KEY-----\n${rawPrivateKey}\n-----END RSA PRIVATE KEY-----`;

        const messageText = `✅ سرور تست شما در ${dcConfig.name} ساخته شد\\!\n` +
            `🔹 نام: ${escapeMarkdownV2(testServerName)}\n` +
            (ip ? `🔹 IP: \`${escapeMarkdownV2(ip)}\`\n` : '🔹 IP: در حال تخصیص...\n') +
            `🔹 مشخصات: ${escapeMarkdownV2(flavor.label)}\n` +
            `🔹 سیستم عامل: ${escapeMarkdownV2(image.label)}\n\n` +
            (rootPassword ? `🔑 **رمز عبور روت:**\n\`\`\`\n${escapeMarkdownV2(rootPassword)}\n\`\`\`\n\n` : '') +
            `🔑 **کلید خصوصی شما \\(برای اتصال SSH\\):**\n\`\`\`\n${escapeMarkdownV2(privateKeyText)}\n\`\`\``;


        sendMessage(chatId, messageText, { parse_mode: 'MarkdownV2', reply_markup: { inline_keyboard: [[{ text: '❌ حذف', callback_data: makeShortCb(userId, { action: 'ASK_DELETE', dcKey: dcConfig.key, serverId: srv.id }) }]] } });
        logServerEvent({ type: 'test_server_created', server_id: srv.id, user_id: userId, datacenter: dcConfig.key });

    } catch (e) {
        console.error(`Free Trial Error in ${dcConfig.name}:`, e);
        sendMessage(chatId, `❌ خطا در ساخت سرور تست: ${escapeMarkdownV2(e.message)}`);
    }
}

async function handleCycleSelection(chatId, userId, messageId, selectedCycle, dcConfig) {
    const allowedCycles = getAllowedCycles(dcConfig);
    if (!allowedCycles.includes(selectedCycle)) {
      return showBillingCycleSelection(chatId, userId, messageId, dcConfig);
    }

    state[userId].selectedCycle = selectedCycle;
    state[userId].step = 'SELECT_FLAVOR';

    const flavors = await openstackApi.listFlavors(dcConfig);
    const keyboard = flavors.map(f => {
        const totalCyclePrice = getFlavorCyclePrice(f, selectedCycle);
        return [{ text: `${f.label} — ${formatToman(totalCyclePrice)} تومان`, callback_data: `FLAVOR_${f.id}` }];
    });
    keyboard.push([{ text: '❌ انصراف', callback_data: 'CANCEL' }]);
    bot.editMessageText('🔹 نوع سرور را انتخاب کنید:', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } });
}

async function handleFlavorSelection(chatId, userId, messageId, selectedFlavorId, dcConfig) {
  try {
    const flavors = await openstackApi.listFlavors(dcConfig);
    const selectedFlavor = flavors.find(f => f.id === selectedFlavorId);
    if (!selectedFlavor) return sendMessage(chatId, '❌ پلن نامعتبر.');

    state[userId].selectedFlavor = selectedFlavor;
    state[userId].step = 'SELECT_IMAGE';

    const tok = await openstackApi.getToken(dcConfig);

    // 📸 گرفتن همزمان ایمیج‌ها و اسنپ‌شات‌ها
    console.log(`🟢 [handleFlavorSelection] Fetching images & snapshots for ${dcConfig.name}`);
    const [images, snapshots] = await Promise.all([
      openstackApi.listImages(dcConfig, tok).catch(err => {
        console.error(`⚠️ [${dcConfig.name}] listImages error:`, err.message);
        return [];
      }),
      hasCapability(dcConfig, 'listSnapshots') ? openstackApi.listSnapshots(dcConfig, tok, userId).catch(err => {
        console.error(`⚠️ [${dcConfig.name}] listSnapshots error:`, err.message);
        return [];
      }) : Promise.resolve([])
    ]);

    console.log(`🟡 [DEBUG] ${dcConfig.name}: ${images.length} base images, ${snapshots.length} snap   shots received`);

    // ✅ ادغام داده‌ها در یک لیست
    const allImages = [
      ...images.map(i => ({ id: i.id, label: i.label || i.name || i.id, type: 'image' })),
      ...snapshots
        .filter(s => s.status === 'active' || !s.status) // فقط فعال‌ها
        .map(s => ({ id: s.id, label: `📸 Snapshot: ${s.name || s.id}`, type: 'snapshot' }))
    ];

    console.log(`🟡 [DEBUG] Combined image+snapshot list → ${allImages.length} items total`);
    allImages.forEach(i => console.log(`   → ${i.type}: ${i.label} (${i.id})`));

    // 🧩 ساخت منوی انتخاب
    const isAfra = dcConfig.provider === 'afracloud';
const visibleImages = allImages.slice(0, 20);

console.log('🧩 [IMAGE_MENU] visibleImages =', visibleImages.map(i => i.label));
const keyboard = visibleImages.map(i => ([{
  text: String(i.label).substring(0, 45),
  callback_data: makeShortCb(userId, {
    action: 'SELECT_IMAGE',
    imageId: i.id,
    dcKey: dcConfig.key
  })
}]));

keyboard.push([{ text: '❌ انصراف', callback_data: 'CANCEL' }]);

try {
  await bot.editMessageText('🔹 سیستم عامل یا Snapshot را انتخاب کنید:', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: keyboard }
  });
} catch (e) {
  console.error('❌ edit image menu failed:', e.response?.body || e.message);
  await sendMessage(chatId, '🔹 سیستم عامل یا Snapshot را انتخاب کنید:', {
    reply_markup: { inline_keyboard: keyboard }
  });
}
    console.log(`✅ [handleFlavorSelection] ${allImages.length} images/snapshots shown for ${dcConfig.name}`);
  } catch (err) {
    console.error('❌ handleFlavorSelection error:', err);
    sendMessage(chatId, '❌ خطایی در بارگذاری سیستم‌عامل‌ها و Snapshotها رخ داد.');
  }
}




async function handleImageSelection(chatId, userId, messageId, selectedImageId, dcConfig) {
  try {
    console.log(`🟢 [handleImageSelection] Triggered for user ${userId} in ${dcConfig.name}`);
    const tok = await openstackApi.getToken(dcConfig);

    // دریافت ایمیج‌ها و اسنپ‌شات‌های مخصوص همین کاربر
    const [images, snapshots] = await Promise.all([
      openstackApi.listImages(dcConfig, tok).catch(err => {
        console.error(`⚠️ [${dcConfig.name}] listImages error:`, err.message);
        return [];
      }),
      hasCapability(dcConfig, 'listSnapshots') ? openstackApi.listSnapshots(dcConfig, tok, userId).catch(err => {
        console.error(`⚠️ [${dcConfig.name}] listSnapshots error:`, err.message);
        return [];
      }) : Promise.resolve([])
    ]);

    console.log(`🟡 [DEBUG] ${dcConfig.name}: ${images.length} base images, ${snapshots.length} snap   shots for user ${userId}`);

    // ادغام و استانداردسازی داده‌ها
    const allImages = [
      ...images.map(i => ({
        id: i.id,
        label: i.label || i.name || i.id,
        type: 'image'
      })),
      ...snapshots
        .filter(s => s.status === 'active')
        .map(s => ({
          id: s.id,
          label: `📸 Snapshot: ${s.name || s.id}`,
          type: 'snapshot'
        }))
    ];

    console.log(`🟡 [DEBUG] Combined image+snapshot list → ${allImages.length} items total`);
    allImages.forEach(i => console.log(`   → ${i.type}: ${i.label} (${i.id})`));

    const selectedImage = allImages.find(i => i.id === selectedImageId);
    if (!selectedImage) {
      console.warn(`❌ [WARN] No image/snapshot found with id: ${selectedImageId}`);
      return sendMessage(chatId, '❌ سیستم‌عامل یا Snapshot نامعتبر است.');
    }

    // ذخیره در state
    state[userId].selectedImage = selectedImage;
    state[userId].step = 'CONFIRM_PURCHASE';

    const { selectedFlavor, selectedCycle } = state[userId];
    const finalPrice = getFlavorCyclePrice(selectedFlavor, selectedCycle);
    state[userId].finalPrice = finalPrice;

    const messageText =
      `لطفاً موارد زیر را تأیید کنید:\n` +
      `🔹 دیتاسنتر: ${escapeMarkdownV2(dcConfig.name)}\n` +
      `🔹 پلن: ${escapeMarkdownV2(selectedFlavor.label)}\n` +
      `🔹 سیستم‌عامل / Snapshot: ${escapeMarkdownV2(selectedImage.label)}\n` +
      `🔹 سیکل پرداخت: ${escapeMarkdownV2(getCycleLabel(selectedCycle))}\n` +
      `🔹 هزینه دوره: ${escapeMarkdownV2(formatToman(finalPrice))} تومان\n`;

    await bot.editMessageText(messageText, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ تایید نهایی', callback_data: 'CONFIRM_PURCHASE' },
            { text: '❌ لغو', callback_data: 'CANCEL' }
          ]
        ]
      }
    });

    console.log(`✅ [handleImageSelection] Confirm screen shown for ${selectedImage.label}`);
  } catch (err) {
    console.error('❌ handleImageSelection error:', err);
    sendMessage(chatId, '❌ خطایی در بارگذاری سیستم‌عامل‌ها یا Snapshotها رخ داد.');
  }
}




async function handlePurchaseConfirmation(chatId, userId, messageId, dcConfig) {
  if (state[userId]?.purchaseInProgress) return sendMessage(chatId, '⏳ در حال پردازش خرید قبلی هستیم...');
  state[userId] = { ...(state[userId] || {}), purchaseInProgress: true };
  await editOrSendMessage(chatId, messageId, '🚀 در حال ساخت سرور شما...').catch(() => {});

  let srv = null;
  let purchaseRecorded = false;
  let effectiveDc = dcConfig || state[userId]?.selectedDatacenterConfig;

  try {
    const { selectedFlavor, selectedImage, selectedCycle } = state[userId];
    if (!effectiveDc) return sendMessage(chatId, '❌ دیتاسنتر از state پیدا نشد. دوباره خرید را شروع کنید.');
    const allowedCycles = getAllowedCycles(effectiveDc);
    if (!selectedFlavor || !selectedImage) return sendMessage(chatId, '❌ اطلاعات خرید منقضی شده است. دوباره خرید را شروع کنید.');
    if (!allowedCycles.includes(selectedCycle)) return sendMessage(chatId, '❌ سیکل پرداخت انتخاب‌شده برای این دیتاسنتر مجاز نیست.');

    const finalPrice = getFlavorCyclePrice(selectedFlavor, selectedCycle);
    const amountForDb = finalPrice;
    const isHetzner = isHetznerDc(effectiveDc);
    const isAfra = effectiveDc.provider === 'afracloud' || effectiveDc.apiType === 'afracloud';
    const isTebyan = effectiveDc.key === 'tebyan';

    console.log('[PURCHASE]', { dcKey: effectiveDc.key, provider: effectiveDc.provider, apiType: effectiveDc.apiType, selectedFlavor: selectedFlavor?.id || selectedFlavor?.name, selectedCycle, finalPrice });

    const balance = await getUserWallet(userId);
    if (balance < finalPrice) {
      return sendMessage(chatId, `❌ موجودی شما برای خرید این سرور کافی نیست. حداقل موجودی مورد نیاز: ${formatToman(finalPrice)} تومان\n💰 لطفاً از منوی «افزایش اعتبار» کیف پول خود را شارژ کنید.`, mainMenu);
    }

    const serverName = `Srv-${getServerNamePrefix(effectiveDc)}-${crypto.randomBytes(3).toString('hex')}`;
    let rawPrivateKey = null, rootPassword = null, tok = null;
    let generatedRootPassword = null;
    let hetznerKeyId = null;

    if (!isHetzner) {
      tok = await openstackApi.getToken(effectiveDc);
      let keyName = null, kp = null;
      if (!isAfra) {
        keyName = `user-${userId}-${crypto.randomBytes(4).toString('hex')}`;
        kp = await openstackApi.createKeyPair(effectiveDc, tok, keyName);
      }
      const isSnapshot = selectedImage.type === 'snapshot';
      const serverMeta = { user: userId, type: 'purchased', datacenter: effectiveDc.key };
      let createOptions = {};
      let bootMethod = 'volume';
      if (isAfra || isTebyan) {
        generatedRootPassword = generateStrongPassword();
        serverMeta.passwordManagedByBot = true;
      }
      if (isAfra) serverMeta.rootPassword = generatedRootPassword;
      if (isTebyan) {
        bootMethod = effectiveDc.TEBYAN_ENABLE_BOOT_FROM_VOLUME === true ? 'volume' : 'image';
        const sgName = await openstackApi.ensureSshSecurityGroup(effectiveDc, tok);
        createOptions = { security_groups: [sgName], user_data: buildTebyanRootPasswordCloudInit(generatedRootPassword) };
      }
      srv = await openstackApi.createServer(effectiveDc, tok, serverName, selectedFlavor.id, selectedImage.id, keyName, serverMeta, selectedFlavor.disk, bootMethod, isSnapshot, createOptions);
      rawPrivateKey = kp?.private_key ? String(kp.private_key || '').replace(/-----BEGIN RSA PRIVATE KEY-----/g, '').replace(/-----END RSA PRIVATE KEY-----/g, '').trim() : null;
      rootPassword = (isAfra || isTebyan) ? generatedRootPassword : srv.adminPass;
    } else {
      const passwordOnly = !!effectiveDc.HETZNER_PASSWORD_ONLY;
      if (!passwordOnly) {
        const kp = await openstackApi.createKeyPair(effectiveDc, null, `user-${userId}`);
        hetznerKeyId = kp.key_id || null;
      }
      const userData = `#cloud-config
ssh_pwauth: true
disable_root: false
write_files:
  - path: /etc/ssh/sshd_config.d/99-hamoon.conf
    permissions: '0644'
    content: |
      PasswordAuthentication yes
      PermitRootLogin yes
runcmd:
  - systemctl reload ssh || systemctl restart ssh
`;
      srv = await openstackApi.createServer(effectiveDc, null, {
        name: serverName,
        serverType: selectedFlavor?.hetzner_type || selectedFlavor?.id,
        image: selectedImage?.name || selectedImage?.id,
        location: effectiveDc.HETZNER_LOCATION,
        key_id: passwordOnly ? null : hetznerKeyId,
        userLabel: userId,
        user_data: userData
      });
      rootPassword = srv.root_password || null;
    }

    if (!srv?.id) throw new Error('شناسه سرور از Provider دریافت نشد.');

    if ((isAfra || isTebyan) && generatedRootPassword) {
      try {
        await upsertServerSecret({ telegramId: userId, serverId: srv.id, datacenter: effectiveDc.key, secretType: 'root_password', secretValue: generatedRootPassword });
      } catch (secretErr) {
        logServerEvent({ type: 'server_secret_store_failed', user_id: userId, server_id: srv.id, datacenter: effectiveDc.key, message: secretErr.code || secretErr.message });
        if (SUPPORT_ID) await sendMessage(SUPPORT_ID, `🚨 Secret store failed\nuser_id=${userId}\nserver_id=${srv.id}\ndc=${effectiveDc.key}\nerror=${secretErr.code || secretErr.message}`).catch(() => null);
        return sendMessage(chatId, 'سرور ساخته شد اما ذخیره امن رمز عبور با خطا مواجه شد. لطفاً با پشتیبانی تماس بگیرید.', mainMenu);
      }
    }

    await debitUser(userId, finalPrice);
    const initialStatus = (isHetzner || isTebyan) ? 'provisioning' : 'active';
    const purchaseBootMethod = isTebyan ? (effectiveDc.TEBYAN_ENABLE_BOOT_FROM_VOLUME === true ? 'volume' : 'image') : 'volume';
    await recordPurchase(
      userId, srv.id, effectiveDc.key, serverName, selectedFlavor.id, amountForDb, selectedCycle,
      DEFAULT_PRICE_PER_GB, DEFAULT_DOWNLOAD_ONLY,
      purchaseBootMethod === 'volume' ? srv.id : null, purchaseBootMethod, selectedImage.label,
      0, 0, 0, 0, 0,
      isHetzner ? hetznerKeyId : null,
      initialStatus,
      isHetzner ? 2 : 1,
      { providerActionId: isHetzner ? (srv.action?.id || null) : null }
    );
    await recordWalletLog(userId, -finalPrice, `خرید سرور ${serverName} (${effectiveDc.name})`, 'purchase');
    purchaseRecorded = true;

    let ip = extractServerIp(srv);

    if (isHetzner) {
      if (!rootPassword) {
        await require('./db').updateScopedStatus(userId, srv.id, effectiveDc.key, 'manual_review').catch(() => null);
        logServerEvent({ type: 'hetzner_original_password_missing', user_id: userId, server_id: srv.id, datacenter: effectiveDc.key });
        if (SUPPORT_ID) await sendMessage(SUPPORT_ID, `🚨 Hetzner original password missing; no reset performed\nuser_id=${userId}\nserver_id=${srv.id}\ndc=${effectiveDc.key}`).catch(() => null);
        return sendMessage(chatId, '⏳ سرور ساخته شده اما رمز اولیه از Provider دریافت نشد. برای جلوگیری از تحویل رمز نامعتبر، سرور فعلاً تحویل نمی‌شود و پشتیبانی آن را بررسی می‌کند.', mainMenu);
      }
      try {
        await upsertServerSecret({ telegramId: userId, serverId: srv.id, datacenter: effectiveDc.key, secretType: 'root_password', secretValue: rootPassword });
      } catch (secretErr) {
        await require('./db').updateScopedStatus(userId, srv.id, effectiveDc.key, 'manual_review').catch(() => null);
        logServerEvent({ type: 'hetzner_password_store_failed', user_id: userId, server_id: srv.id, datacenter: effectiveDc.key, message: secretErr.code || secretErr.message });
        if (SUPPORT_ID) await sendMessage(SUPPORT_ID, `🚨 Hetzner password secure-store failed\nuser_id=${userId}\nserver_id=${srv.id}\ndc=${effectiveDc.key}\nerror=${secretErr.code || secretErr.message}`).catch(() => null);
        return sendMessage(chatId, '⏳ سرور ساخته شده اما ذخیره امن رمز اولیه کامل نشد؛ برای امنیت، اطلاعات ورود فعلاً تحویل داده نمی‌شود.', mainMenu);
      }

      const readiness = await hetznerLifecycle.waitForReadiness(effectiveDc, srv.id, {
        waitActionId: srv.action?.id,
        timeoutMs: Number(process.env.HETZNER_INITIAL_READY_TIMEOUT_MS || 45000)
      });
      ip = readiness.ip || ip;
      await require('./db').updateScopedStatus(userId, srv.id, effectiveDc.key, readiness.status);
      if (readiness.quality) {
        await require('./db').updateIpQualityResult(userId, srv.id, effectiveDc.key, hetznerLifecycle.qualitySummary(readiness.quality), false).catch(() => null);
      }
      if (!readiness.ready) {
        logServerEvent({ type: 'hetzner_delivery_pending', user_id: userId, server_id: srv.id, datacenter: effectiveDc.key, status: readiness.status, quality_reason: readiness.quality?.reason || null });
        return sendMessage(chatId, '⏳ سرور ساخته شد، اما قبل از تحویل نهایی باید روشن‌بودن، SSH و دسترسی IP از ایران و چند نقطه خارجی تأیید شود. اگر IP مناسب نباشد، سیستم آن را خودکار تعویض می‌کند. تا تأیید کامل، IP و رمز نمایش داده نمی‌شود.', mainMenu);
      }
      const newlyDelivered = await require('./db').markDelivered(userId, srv.id, effectiveDc.key, ip);
      if (!newlyDelivered) return;
    } else {
      if (!ip) ip = await pollForIp(effectiveDc, tok || await openstackApi.getToken(effectiveDc), srv.id, isAfra ? 3 : 24, isAfra ? 3000 : 5000);
      if (isTebyan) {
        const sshReady = ip ? await tcpCheck(ip, 22, 180000).catch(() => ({ reachable: false })) : { reachable: false };
        await updatePurchaseStatus(srv.id, sshReady.reachable ? 'active' : 'pending_ssh');
      }
    }

    const privateKeyText = rawPrivateKey ? `-----BEGIN RSA PRIVATE KEY-----\n${rawPrivateKey}\n-----END RSA PRIVATE KEY-----` : null;
    const planLabel = selectedFlavor.label || selectedFlavor.name || selectedFlavor.id;
    let msgHtml = [
      `✅ سرور شما در ${htmlEscape(effectiveDc.name)} با موفقیت ساخته و آماده شد!`,
      `🔹 نام: ${htmlEscape(serverName)}`,
      ip ? `🔹 IP: <code>${htmlEscape(ip)}</code>` : '🔹 IP: در حال تخصیص...',
      `🔹 سیستم‌عامل: ${htmlEscape(selectedImage.label || selectedImage.name || selectedImage.id)}`,
      `🔹 پلن: ${htmlEscape(planLabel)}`,
      `🔹 ${htmlEscape(formatBillingAmountLabel(finalPrice, selectedCycle))}`
    ].join('\n');
    if (isHetzner) msgHtml += '\n✅ دسترسی SSH و تست IP از ایران/چند نقطه خارجی تأیید شد.';
    if (rootPassword && isTebyan && ip) {
      msgHtml += '\n' + `IP: <code>${htmlEscape(ip)}</code>` + '\nSSH user: root' + '\nRoot password: ' + htmlCodeBlock(rootPassword) + '\nLogin command:' + `\n<code>ssh root@${htmlEscape(ip)}</code>` + '\nFallback:' + `\n<code>ssh ubuntu@${htmlEscape(ip)}</code>`;
    } else if (rootPassword) {
      msgHtml += '\n' + `🔑 <b>رمز عبور روت:</b>\n` + htmlCodeBlock(rootPassword) + '\nلطفاً رمز را در جای امن ذخیره کنید.';
    } else if (isAfra) {
      msgHtml += '\n' + serverSecretNotConfiguredMessage();
    }
    if (privateKeyText) msgHtml += '\n' + `🔑 <b>کلید خصوصی شما (SSH):</b>\n` + htmlCodeBlock(privateKeyText);

    const notifyResult = await notifyPurchaseSuccess(chatId, messageId, msgHtml, { inline_keyboard: [[{ text: '⚙️ مدیریت سرور', callback_data: makeShortCb(userId, { action: 'M', dcKey: effectiveDc.key, serverId: srv.id }) }]] });
    if (!notifyResult) logServerEvent({ type: 'purchase_notification_failed', user_id: userId, server_id: srv.id, datacenter: effectiveDc.key, message: 'sendMessage returned null' });
    logServerEvent({ type: 'server_created', server_id: srv.id, user_id: userId, datacenter: effectiveDc.key, password_provided: !!rootPassword, guarded_delivery: isHetzner });
  } catch (e) {
    const dcKey = effectiveDc?.key || dcConfig?.key || 'unknown';
    console.error(`Purchase Error in ${effectiveDc?.name || dcKey}:`, { message: e.message, server_id: srv?.id, purchaseRecorded });
    if (srv?.id && !purchaseRecorded) {
      logServerEvent({ type: 'CRITICAL_orphan_server_after_provider_create', user_id: userId, server_id: srv.id, datacenter: dcKey, message: e.message });
      if (SUPPORT_ID) await sendMessage(SUPPORT_ID, `🚨 CRITICAL: provider orphan server\nuser_id=${userId}\nserver_id=${srv.id}\ndc=${dcKey}\nerror=${e.message}`).catch(() => null);
      return sendMessage(chatId, '⚠️ سرور ساخته شد اما ثبت خرید با مشکل مواجه شد. لطفاً با پشتیبانی تماس بگیرید.', mainMenu);
    }
    if (srv?.id && purchaseRecorded) {
      logServerEvent({ type: 'purchase_post_create_warning', user_id: userId, server_id: srv.id, datacenter: dcKey, message: e.message });
      return sendMessage(chatId, '⚠️ سرور ساخته شد ولی هنوز تحویل نهایی نشده است. سیستم بررسی خودکار را ادامه می‌دهد؛ در صورت نیاز پشتیبانی بررسی می‌کند.', mainMenu);
    }
    return sendMessage(chatId, `❌ خطا در خرید سرور: ${escapeMarkdownV2(e.message)}`, mainMenu);
  } finally {
    if (state[userId]) { state[userId].purchaseInProgress = false; state[userId].step = 'READY'; }
  }
}



async function handleStartMySuspendedServers(chatId, userId) {
  try {
    const wallet = Number(await getUserWallet(userId).catch(() => 0) || 0);

    if (wallet <= 0) {
      return sendMessage(
        chatId,
        'کیف پول شما موجودی کافی ندارد. لطفاً ابتدا کیف پول را شارژ کنید و بعد دوباره گزینه «⚡ روشن‌کردن سرورها» را بزنید.'
      );
    }

    const purchases = await getUserRestartablePurchases(userId);

    if (!purchases || purchases.length === 0) {
      return sendMessage(
        chatId,
        'در حال حاضر سرور خاموش/معلق قابل روشن‌کردن برای حساب شما پیدا نشد.'
      );
    }

    const userDCs = getUserEffectiveDCs(String(userId)) || {};
    const results = [];

    await sendMessage(
      chatId,
      `در حال روشن‌کردن ${purchases.length} سرور خاموش/معلق شما... لطفاً چند لحظه صبر کنید.`
    );

    for (const purchase of purchases) {
      const dcKey = String(purchase.datacenter || '').trim();
      const dcConfig = userDCs[dcKey];

      if (!dcConfig) {
        results.push({
          name: purchase.server_name || purchase.server_id,
          ok: false,
          error: `دیتاسنتر ${dcKey} در تنظیمات فعلی کاربر پیدا نشد`
        });
        continue;
      }

      try {
        let token = null;
        const providerText = String(dcConfig.provider || dcConfig.apiType || dcConfig.key || '').toLowerCase();
        const isHetzner = providerText.includes('hetzner') || String(dcConfig.key || '').toLowerCase().includes('hetzner');

        if (!isHetzner) {
          token = await openstackApi.getToken(dcConfig);
        }

        await openstackApi.resumeServer(dcConfig, token, purchase.server_id);

        await updatePurchaseStatus(purchase.server_id, 'active').catch(err => {
          console.error('[START_MY_SERVERS] updatePurchaseStatus failed:', purchase.server_id, err.message);
        });

        results.push({ name: purchase.server_name || purchase.server_id, ok: true });
      } catch (e) {
        console.error('[START_MY_SERVERS] failed:', {
          userId,
          server_id: purchase.server_id,
          server_name: purchase.server_name,
          dcKey,
          error: e.message
        });
        results.push({ name: purchase.server_name || purchase.server_id, ok: false, error: e.message });
      }
    }

    const ok = results.filter(r => r.ok);
    const failed = results.filter(r => !r.ok);
    let text = '';

    if (ok.length > 0) {
      text += '✅ سرورهای زیر برای روشن‌شدن ارسال شدند:\n';
      text += ok.map(r => `• ${r.name}`).join('\n');
      text += '\n\n';
    }

    if (failed.length > 0) {
      text += '⚠️ روشن‌کردن این سرورها ناموفق بود:\n';
      text += failed.map(r => `• ${r.name}: ${String(r.error || 'خطای نامشخص').slice(0, 120)}`).join('\n');
      text += '\n\nاگر موجودی کیف پول کافی است ولی خطا ادامه داشت، پشتیبانی بررسی می‌کند.';
    }

    if (!text.trim()) {
      text = 'سروری برای روشن‌کردن پیدا نشد.';
    }

    return sendMessage(chatId, text.trim());
  } catch (e) {
    console.error('[START_MY_SERVERS] fatal:', e);
    return sendMessage(chatId, '❌ خطایی در روشن‌کردن سرورها رخ داد. لطفاً چند دقیقه بعد دوباره تلاش کنید یا به پشتیبانی پیام دهید.');
  }
}

const HETZNER_UPGRADE_ALLOWED_STATUSES = new Set(['active', 'suspended', 'stopped', 'shutoff', 'pending_ssh']);
const HETZNER_UPGRADE_BLOCKED_STATUSES = new Set(['deleted', 'deletion_pending', 'provider_missing', 'provisioning_failed', 'manual_review', 'upgrading']);

function isHetznerDc(dcConfigOrKey) {
  if (!dcConfigOrKey) return false;
  if (typeof dcConfigOrKey === 'string') {
    const dc = baseDatacenters[dcConfigOrKey];
    return isHetznerDc(dc || { key: dcConfigOrKey });
  }
  const provider = String(dcConfigOrKey.provider || '').toLowerCase();
  const apiType = String(dcConfigOrKey.apiType || dcConfigOrKey.type || '').toLowerCase();
  const key = String(dcConfigOrKey.key || dcConfigOrKey.__baseKey || '').split('__')[0].toLowerCase();
  return provider === 'hetzner' || apiType === 'hetzner' || key === 'hetzner' || key.startsWith('hetzner-') || !!dcConfigOrKey.HETZNER_LOCATION;
}

function getServerNamePrefix(dcConfig) {
  return dcConfig?.namePrefix || (
    dcConfig?.key === 'hetzner-finland' ? 'FIN' :
    dcConfig?.key === 'hetzner-us-east' ? 'USE' :
    dcConfig?.key === 'hetzner-us-west' ? 'USW' :
    dcConfig?.key === 'hetzner-singapore' ? 'SIN' :
    isHetznerDc(dcConfig) ? 'HET' :
    String(dcConfig?.key || 'SRV').substring(0, 3).toUpperCase()
  );
}

function normalizeHetznerFlavorId(value) {
  return String(value || '').trim().toLowerCase();
}

function hetznerFlavorType(flavor) {
  return normalizeHetznerFlavorId(flavor?.hetzner_type || flavor?.server_type || flavor?.name || flavor?.id);
}

function getFlavorRam(flavor) { return Number(flavor?.ram ?? flavor?.memory ?? 0); }
function getFlavorCpu(flavor) { return Number(flavor?.cpu ?? flavor?.cores ?? flavor?.vcpus ?? 0); }
function getFlavorDisk(flavor) { return Number(flavor?.disk ?? 0); }

function findHetznerFlavor(dcConfig, flavorIdOrType) {
  const key = normalizeHetznerFlavorId(flavorIdOrType);
  return (dcConfig?.flavors || []).find(f => normalizeHetznerFlavorId(f.id) === key || hetznerFlavorType(f) === key);
}

function getSellableHetznerFlavors(dcConfig) {
  return (dcConfig?.flavors || []).filter(f => f && !f.deprecated && f.available !== false && hetznerFlavorType(f));
}

function getHigherHetznerFlavors(dcConfig, currentFlavor, duration) {
  const currentPrice = currentFlavor ? getFlavorCyclePrice(currentFlavor, duration) : 0;
  return getSellableHetznerFlavors(dcConfig).filter(f => {
    if (currentFlavor && normalizeHetznerFlavorId(f.id) === normalizeHetznerFlavorId(currentFlavor.id)) return false;
    const price = getFlavorCyclePrice(f, duration);
    if (currentFlavor && price <= currentPrice) return false;
    if (!currentFlavor) return true;
    return price > currentPrice || getFlavorCpu(f) > getFlavorCpu(currentFlavor) || getFlavorRam(f) > getFlavorRam(currentFlavor) || getFlavorDisk(f) > getFlavorDisk(currentFlavor);
  }).sort((a, b) => getFlavorCyclePrice(a, duration) - getFlavorCyclePrice(b, duration));
}

async function resolveCurrentHetznerFlavor(dcConfig, purchase) {
  let current = findHetznerFlavor(dcConfig, purchase?.flavor_id);
  if (current) return { current, unknown: false };
  try {
    const providerServer = await openstackApi.getServer(dcConfig, null, purchase.server_id);
    current = findHetznerFlavor(dcConfig, providerServer?.server_type?.name || providerServer?.server_type || providerServer?.type);
  } catch (_) {}
  return { current: current || null, unknown: !current };
}

async function handleHetznerUpgradeMenu(chatId, userId, serverId, dcConfig) {
  const purchase = await getPurchaseForUserServer(userId, serverId, dcConfig.key);
  if (!purchase) return sendMessage(chatId, '❌ سرور موردنظر برای شما پیدا نشد.');
  if (HETZNER_UPGRADE_BLOCKED_STATUSES.has(String(purchase.status || '').toLowerCase())) return sendMessage(chatId, '❌ این سرور در وضعیت قابل ارتقا نیست.');
  const liveDc = { ...dcConfig, flavors: await openstackApi.listFlavors(dcConfig).catch(() => dcConfig.flavors || []) };
  const { current, unknown } = await resolveCurrentHetznerFlavor(liveDc, purchase);
  const plans = getHigherHetznerFlavors(liveDc, current, purchase.duration || 'monthly');
  if (!plans.length) return sendMessage(chatId, 'پلن بالاتری برای ارتقای این سرور موجود نیست.');
  const keyboard = plans.map(f => ([{ text: `${f.label || f.id} - ${formatToman(getFlavorCyclePrice(f, purchase.duration || 'monthly'))} تومان`, callback_data: makeShortCb(userId, { action: 'HUS', serverId, dcKey: dcConfig.key, targetFlavor: f.id }) }]));
  keyboard.push([{ text: '❌ انصراف', callback_data: makeShortCb(userId, { action: 'HUCANCEL', serverId, dcKey: dcConfig.key }) }]);
  const warning = unknown ? '\n⚠️ پلن فعلی دقیقاً تشخیص داده نشد؛ لطفاً با دقت انتخاب کنید.' : '';
  return sendMessage(chatId, `پلن جدید را برای ارتقای سرور انتخاب کنید:${warning}`, { reply_markup: { inline_keyboard: keyboard } });
}

async function handleHetznerUpgradeSelect(chatId, userId, serverId, dcConfig, targetFlavorId) {
  const purchase = await getPurchaseForUserServer(userId, serverId, dcConfig.key);
  if (!purchase) return sendMessage(chatId, '❌ سرور موردنظر برای شما پیدا نشد.');
  const liveDc = { ...dcConfig, flavors: await openstackApi.listFlavors(dcConfig).catch(() => dcConfig.flavors || []) };
  const target = findHetznerFlavor(liveDc, targetFlavorId);
  const { current } = await resolveCurrentHetznerFlavor(liveDc, purchase);
  if (!target) return sendMessage(chatId, '❌ پلن انتخاب‌شده معتبر نیست.');
  if (current && !getHigherHetznerFlavors(liveDc, current, purchase.duration || 'monthly').some(f => f.id === target.id)) return sendMessage(chatId, '❌ پلن انتخاب‌شده بالاتر از پلن فعلی نیست.');
  const oldAmount = normalizeStoredCycleAmount(purchase, liveDc) || (current ? getFlavorCyclePrice(current, purchase.duration || 'monthly') : 0);
  const newAmount = getFlavorCyclePrice(target, purchase.duration || 'monthly');
  const text = `شما در حال ارتقای سرور زیر هستید:\nسرور: ${purchase.server_name || serverId}\nپلن فعلی: ${current?.label || purchase.flavor_id || 'نامشخص'}\nپلن جدید: ${target.label || target.id}\nهزینه فعلی: ${formatToman(oldAmount)} تومان\nهزینه جدید: ${formatToman(newAmount)} تومان\nدوره پرداخت: ${getCycleLabel(purchase.duration || 'monthly')}\n\nتوجه: در زمان ارتقا ممکن است سرور برای چند دقیقه خاموش یا از دسترس خارج شود.\nارتقا ممکن است چند دقیقه زمان ببرد.\nافزایش دیسک اختیاری است و مسیر پیشنهادی، ارتقا بدون افزایش دیسک است.`;
  return sendMessage(chatId, text, { reply_markup: { inline_keyboard: [
    [{ text: '✅ ارتقا بدون افزایش دیسک', callback_data: makeShortCb(userId, { action: 'HUC', serverId, dcKey: dcConfig.key, targetFlavor: target.id, upgradeDisk: false }) }],
    [{ text: '⚠️ ارتقا همراه افزایش دیسک', callback_data: makeShortCb(userId, { action: 'HUC', serverId, dcKey: dcConfig.key, targetFlavor: target.id, upgradeDisk: true }) }],
    [{ text: '❌ انصراف', callback_data: makeShortCb(userId, { action: 'HUCANCEL', serverId, dcKey: dcConfig.key }) }]
  ] } });
}

async function handleHetznerUpgradeConfirm(chatId, userId, serverId, dcConfig, targetFlavorId, upgradeDisk) {
  const lockKey = `${userId}:${serverId}`;
  if (hetznerUpgradeLocks.has(lockKey)) return sendMessage(chatId, 'این سرور در حال ارتقا است...');
  hetznerUpgradeLocks.set(lockKey, true);
  let previousStatus = 'active';
  let changeSucceeded = false;
  try {
    const purchase = await getPurchaseForUserServer(userId, serverId, dcConfig.key);
    if (!purchase) return sendMessage(chatId, '❌ سرور موردنظر برای شما پیدا نشد.');
    previousStatus = purchase.status || 'active';
    const status = String(previousStatus).toLowerCase();
    if (!HETZNER_UPGRADE_ALLOWED_STATUSES.has(status) || HETZNER_UPGRADE_BLOCKED_STATUSES.has(status)) return sendMessage(chatId, '❌ این سرور در وضعیت قابل ارتقا نیست.');
    const wallet = Number(await getUserWallet(userId).catch(() => 0) || 0);
    const minWallet = Number(process.env.HETZNER_UPGRADE_MIN_WALLET || 0);
    if (wallet <= 0 || wallet < minWallet) return sendMessage(chatId, 'موجودی کیف پول برای ادامه سرویس کافی نیست. لطفاً ابتدا کیف پول را شارژ کنید.');
    const liveDc = { ...dcConfig, flavors: await openstackApi.listFlavors(dcConfig).catch(() => dcConfig.flavors || []) };
    const target = findHetznerFlavor(liveDc, targetFlavorId);
    const { current } = await resolveCurrentHetznerFlavor(liveDc, purchase);
    if (!target || (current && !getHigherHetznerFlavors(liveDc, current, purchase.duration || 'monthly').some(f => f.id === target.id))) return sendMessage(chatId, '❌ پلن انتخاب‌شده معتبر نیست.');

    await setPurchaseStatusForUser(userId, serverId, dcConfig.key, 'upgrading');
    console.log('[HETZNER_UPGRADE]', { user: userId, server_id: serverId, old_flavor: purchase.flavor_id, new_flavor: target.id, upgrade_disk: !!upgradeDisk, status: 'started' });
    let providerServer;
    try { providerServer = await openstackApi.getServer(dcConfig, null, serverId); } catch (e) {
      if (e.response?.status === 404 || e.status === 404) {
        await setPurchaseStatusForUser(userId, serverId, dcConfig.key, 'provider_missing');
        return sendMessage(chatId, '❌ سرور در Hetzner پیدا نشد و ارتقا انجام نشد.');
      }
      throw e;
    }
    if (!['off', 'stopped'].includes(String(providerServer?.status || '').toLowerCase())) {
      try { const a = await openstackApi.powerOffHetznerServer(dcConfig, serverId); await openstackApi.waitHetznerAction(dcConfig, a?.id); } catch (e) { if (!/already|offline|off/i.test(e.message)) throw e; }
    }
    const action = await openstackApi.changeHetznerServerType(dcConfig, serverId, hetznerFlavorType(target), !!upgradeDisk);
    await openstackApi.waitHetznerAction(dcConfig, action?.id);
    changeSucceeded = true;
    const newAmount = getFlavorCyclePrice(target, purchase.duration || 'monthly');
    await updatePurchasePlan(userId, serverId, dcConfig.key, target.id, newAmount);
    await recordServerUpgradeLog(userId, serverId, purchase.flavor_id, target.id, purchase.amount, newAmount).catch(() => {});
    let powerMsg = '';
    try { const p = await openstackApi.powerOnHetznerServer(dcConfig, serverId); await openstackApi.waitHetznerAction(dcConfig, p?.id, 180000); } catch (e) { powerMsg = '\n⚠️ ارتقا انجام شد اما روشن‌کردن خودکار نیاز به بررسی پشتیبانی دارد.'; console.warn('[HETZNER_UPGRADE] poweron failed', { user: userId, server_id: serverId, message: e.message }); }
    console.log('[HETZNER_UPGRADE]', { user: userId, server_id: serverId, old_flavor: purchase.flavor_id, new_flavor: target.id, upgrade_disk: !!upgradeDisk, status: 'success' });
    return sendMessage(chatId, `✅ درخواست ارتقای سرور با موفقیت انجام شد.\nپلن جدید در پنل ثبت شد و سرور در حال روشن‌شدن/آماده‌سازی است.${powerMsg}`);
  } catch (e) {
    console.error('[HETZNER_UPGRADE]', { user: userId, server_id: serverId, target_flavor: targetFlavorId, upgrade_disk: !!upgradeDisk, status: 'failed', message: e.message });
    if (!changeSucceeded) await setPurchaseStatusForUser(userId, serverId, dcConfig.key, previousStatus).catch(() => {});
    return sendMessage(chatId, '❌ ارتقای سرور انجام نشد.\nهیچ تغییری در پلن و هزینه سرور شما ثبت نشد.');
  } finally {
    hetznerUpgradeLocks.delete(lockKey);
  }
}


async function handlePurchaseAutoRenewEnable(chatId, userId, serverId, dcConfig) {
  const purchase = await getPurchaseForUserServer(userId, serverId, dcConfig.key).catch(() => null) || await getPurchaseByServerId(serverId);
  if (!purchase || String(purchase.telegram_id) !== String(userId) || String(purchase.datacenter) !== String(dcConfig.key)) {
    return sendMessage(chatId, '❌ خرید مربوط به این سرور پیدا نشد.');
  }

  if (purchase.status === 'suspended' && purchase.suspend_reason === 'auto_renew_disabled') {
    const cycleAmount = normalizeStoredCycleAmount(purchase, dcConfig);
    const wallet = await getUserWallet(userId);
    if (wallet < cycleAmount) {
      return sendMessage(chatId, 'برای فعال‌سازی مجدد، کیف پول شما باید حداقل به اندازه هزینه یک دوره شارژ داشته باشد.');
    }
    await debitUser(userId, cycleAmount);
    await recordWalletLog(userId, -cycleAmount, `تمدید و فعال‌سازی مجدد سرور ${purchase.server_name || serverId}`, 'billing');
    await setPurchaseAutoRenew(userId, serverId, dcConfig.key, true);
    await updatePurchaseStatus(serverId, 'active', purchase.last_billed_traffic_gb, new Date());
    const tok = await openstackApi.getToken(dcConfig);
    await openstackApi.resumeServer(dcConfig, tok, serverId);
    await sendMessage(chatId, '✅ تمدید خودکار فعال شد و سرور مجدداً فعال شد.');
    return handleServerManagement(chatId, userId, serverId, dcConfig);
  }

  await setPurchaseAutoRenew(userId, serverId, dcConfig.key, true);
  await sendMessage(chatId, '✅ تمدید خودکار فعال شد. از این به بعد هزینه سرور در موعد تمدید از کیف پول شما کسر می‌شود.');
  return handleServerManagement(chatId, userId, serverId, dcConfig);
}

async function handleServerManagement(chatId, userId, serverId, dcConfig) {
  try {
    ensureUserState(userId);

    const tok = await openstackApi.getToken(dcConfig);
    const srv = await openstackApi.getServer(dcConfig, tok, serverId);
    const purchase = isHetznerDc(dcConfig)
      ? (await getPurchaseForUserServer(userId, serverId, dcConfig.key).catch(() => null) || await getPurchaseByServerId(serverId))
      : await getPurchaseByServerId(serverId);

    let ip = extractServerIp(srv) || '–';

    const osLabel = purchase?.os_label || srv.image?.name || 'N/A';
    const isProjectDC = dcConfig.sharedProject === false;
    const hasTrafficApi = !!dcConfig.TRAFFIC_API_BASE_URL;
    const stateText = String(srv.status || srv.state || '').toLowerCase();
    const keyPair = hasCapability(dcConfig, 'privateKey') ? await getKeyPair(serverId).catch(() => null) : null;

    let messageText =
      `*مدیریت سرور: ${escapeMarkdownV2(srv.name || srv.id)}*\n` +
      `دیتاسنتر: ${escapeMarkdownV2(dcConfig.name)}\n` +
      `IP: ${escapeMarkdownV2(ip)}\n` +
      `وضعیت: ${escapeMarkdownV2(srv.status || srv.state || 'N/A')}\n` +
      `سیستم عامل: ${escapeMarkdownV2(osLabel)}\n`;

    if (purchase) {
      messageText += Number(purchase.auto_renew ?? 1) === 1
        ? '🔁 تمدید خودکار: روشن\n'
        : '⏸ تمدید خودکار: خاموش\n';
    }

    const keyboard = [];
    const short = (action, extra = {}) => makeShortCb(userId, { action, dcKey: dcConfig.key, serverId: srv.id, ...extra });

    if (isProjectDC && hasCapability(dcConfig, 'projectTraffic') && hasTrafficApi) {
      keyboard.push([{ text: '📈 ترافیک کل پروژه + باقیمانده', callback_data: short('PROJECT_SUM', { projectId: dcConfig.OS_PROJECT_ID }) }]);
    }
    if (hasCapability(dcConfig, 'traffic') && hasTrafficApi) {
      keyboard.push([{ text: '📊 مشاهده ترافیک', callback_data: short(isProjectDC ? 'GET_TRAFFIC_RAW' : 'GET_TRAFFIC') }]);
    }
    if (isAfraDc(dcConfig)) {
      keyboard.push([{ text: '🔑 دریافت رمز عبور', callback_data: short('GET_STORED_PASSWORD') }]);
      keyboard.push([{ text: '♻️ ریست رمز عبور', callback_data: short('RESET_PASSWORD_SSH_ASK') }]);
    } else if (hasCapability(dcConfig, 'resetPassword')) {
      keyboard.push([{ text: getCapabilityLabel(dcConfig, 'resetPassword', '🔑 ریست پسورد'), callback_data: short('ASK_RESETPW') }]);
    }
    if (keyPair) {
      keyboard.push([{ text: '🔑 دریافت کلید خصوصی', callback_data: short('GET_KEY') }]);
    }
    if (hasCapability(dcConfig, 'snapshot')) {
      keyboard.push([{ text: '📸 Snapshot', callback_data: short('SNAPSHOT_ASK') }]);
    }
    if (purchase) {
      const renewEnabled = Number(purchase.auto_renew ?? 1) === 1;
      keyboard.push([{ text: renewEnabled ? '❌ غیرفعال کردن تمدید خودکار' : '✅ فعال کردن تمدید خودکار', callback_data: short(renewEnabled ? 'RENEW_OFF' : 'RENEW_ON') }]);
    }
    if (hasCapability(dcConfig, 'changeCycle') && purchase && getAllowedCycles(dcConfig).length > 1) {
      keyboard.push([{ text: '🔄 تغییر دوره پرداخت', callback_data: short('CHANGECYCLE_ASK') }]);
    }
    if (hasCapability(dcConfig, 'rebuild')) {
      keyboard.push([{ text: '🔄 ریبیلد سرور', callback_data: short('REBUILD_ASK') }]);
    }
    if (hasCapability(dcConfig, 'suspendServer') && ['active', 'running', 'started'].some(x => stateText.includes(x))) {
      keyboard.push([{ text: '⏸ خاموش کردن', callback_data: short('SUSPEND') }]);
    }
    if (hasCapability(dcConfig, 'resumeServer') && ['shutoff', 'stopped', 'suspended'].some(x => stateText.includes(x))) {
      keyboard.push([{ text: '▶️ روشن کردن', callback_data: short('RESUME') }]);
    }
    if (isHetznerDc(dcConfig) && purchase && String(purchase.telegram_id) === String(userId) && !HETZNER_UPGRADE_BLOCKED_STATUSES.has(String(purchase.status || '').toLowerCase())) {
      keyboard.push([{ text: '⬆️ ارتقای سرور', callback_data: makeShortCb(userId, { action: 'HU', serverId: srv.id, dcKey: dcConfig.key }) }]);
    }
    if (hasCapability(dcConfig, 'deleteServer')) {
      keyboard.push([{ text: '❌ حذف سرور', callback_data: makeShortCb(userId, { action: 'ASK_DELETE', dcKey: dcConfig.key, serverId: srv.id }) }]);
    }
    keyboard.push([{ text: '🔙 بازگشت', callback_data: 'CANCEL' }]);

    await sendMessage(chatId, messageText, {
      parse_mode: 'MarkdownV2',
      reply_markup: { inline_keyboard: keyboard }
    });

    console.log('[handleServerManagement] Buttons created for user', userId, 'DC:', dcConfig.key, 'srv:', srv.id);
  } catch (e) {
    console.error(`Manage Server Error for ${serverId} in ${dcConfig.name}:`, e);
    sendMessage(chatId, `❌ خطا در دریافت اطلاعات سرور: ${escapeMarkdownV2(e.message)}`);
  }
}




async function getProjectTrafficSummary(chatId, userId, dcConfig, projectId) {
  try {
    if (!dcConfig?.TRAFFIC_API_BASE_URL) {
      return sendMessage(chatId, '📊 سرویس ترافیک برای این دیتاسنتر فعال نیست.');
    }

    const baseKey = dcConfig.__baseKey || (dcConfig.key?.split('__')[0]) || dcConfig.key;

    const endTs   = Math.floor(Date.now() / 1000);
    const startTs = 0;

    const url = `${dcConfig.TRAFFIC_API_BASE_URL}project/${encodeURIComponent(projectId)}?start_time=${startTs}&end_time=${endTs}`;
    const headers = { Authorization: dcConfig.TRAFFIC_API_KEY };

    const controller = new AbortController();
    const tmo = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(tmo);

    if (!resp?.ok) {
      const txt = await resp.text().catch(() => '(no body)');
      console.error('[TrafficAPI error body]', txt);
      return sendMessage(chatId, `❌ خطا در دریافت ترافیک پروژه: ${resp.status} ${resp.statusText}`);
    }

    const data = await resp.json().catch(() => ({}));

    let rx = 0, tx = 0;
    if (data && data.servers && typeof data.servers === 'object') {
      for (const s of Object.values(data.servers)) {
        rx += Number(s?.receive || 0);
        tx += Number(s?.transmit || 0);
      }
    } else {
      rx = Number(data?.received_gb || 0);
      tx = Number(data?.transmitted_gb || 0);
    }

    const projects = getUserProjects(String(userId)) || [];
    const proj = projects.find(p =>
      p.dcKey === baseKey &&
      (p.auth?.OS_PROJECT_ID === projectId || p.projectId === projectId)
    );

    const pricePerGb   = Number(proj?.pricePerGbToman ?? DEFAULT_PRICE_PER_GB);
    const downloadOnly = !!proj?.downloadOnly;

    const billableGb = downloadOnly ? rx : (rx + tx);
    const totalCost  = Math.floor(billableGb * pricePerGb);

    // 👇 اینجا تفکیک کردیم
    const topupsTotal         = await getUserTopupTotal(userId);
    const { cost: globalCost } = await getUserProjectTrafficCost(userId);
    const remainingTotal      = Math.max(0, topupsTotal - globalCost);

    const msgHtml =
      `📈 <b>ترافیک کل پروژه</b>\n` +
      `پروژه: <code>${htmlEscape(projectId)}</code>\n\n` +
      `📥 RX: ${htmlEscape(rx.toFixed(2))} GB\n` +
      `📤 TX: ${htmlEscape(tx.toFixed(2))} GB\n` +
      `📉 قابل محاسبه: ${htmlEscape(billableGb.toFixed(2))} GB` +
      (downloadOnly ? ` <i>(دانلود فقط)</i>` : ``) + `\n` +
      `💵 قیمت/GB: ${htmlEscape(pricePerGb.toString())} تومان\n` +
      `💰 مجموع مصرف ریالی (این پروژه): ${htmlEscape(totalCost.toString())} تومان\n` +
      `🟢 شارژ کل ثبت‌شده: ${htmlEscape(topupsTotal.toString())} تومان\n\n` +
      `🌐 باقی‌مانده کل اعتبار همه پروژه‌ها: ${htmlEscape(remainingTotal.toString())} تومان`;

    return sendMessage(chatId, msgHtml, { parse_mode: 'HTML' });

  } catch (err) {
    console.error('[ProjectTrafficSummary fatal]', err?.response?.data || err?.message || err);
    return sendMessage(chatId, '❌ خطا در دریافت خلاصه ترافیک پروژه.');
  }
}




async function askForDeletionConfirmation(chatId, userId, serverId, dcConfig) {
    const purchase = isHetznerDc(dcConfig)
      ? (await getPurchaseForUserServer(userId, serverId, dcConfig.key).catch(() => null) || await getPurchaseByServerId(serverId))
      : await getPurchaseByServerId(serverId);
    const serverName = purchase?.server_name || serverId;
    const messageText = `⚠️ آیا از حذف سرور *${escapeMarkdownV2(serverName)}* در دیتاسنتر *${escapeMarkdownV2(dcConfig.name)}* مطمئن هستید؟\nاین عملیات غیرقابل بازگشت است\\.`;
    const keyboard = [
        [{ text: '✅ بله، حذف کن', callback_data: makeShortCb(userId, { action: 'CONFIRM_DELETE', dcKey: dcConfig.key, serverId }) }],
        [{ text: ' خیر', callback_data: 'CANCEL' }]
    ];
    sendMessage(chatId, messageText, { parse_mode: 'MarkdownV2', reply_markup: { inline_keyboard: keyboard } });
}

async function handleServerDeletion(chatId, userId, serverId, dcConfig) {
    sendMessage(chatId, `🗑️ در حال حذف سرور از ${dcConfig.name}...`);
    try {
        const tok = await openstackApi.getToken(dcConfig);
        const purchase = isHetznerDc(dcConfig)
      ? (await getPurchaseForUserServer(userId, serverId, dcConfig.key).catch(() => null) || await getPurchaseByServerId(serverId))
      : await getPurchaseByServerId(serverId);
        const isTestServer = !purchase;

        await openstackApi.deleteServer(dcConfig, tok, serverId).catch(e => {
            if (e.response?.status !== 404) throw e;
            console.warn(`Server ${serverId} not found on OpenStack ${dcConfig.name}, proceeding with DB cleanup.`);
        });
const isHetzner = isHetznerDc(dcConfig);
        const kp = await getKeyPair(serverId);
        if (!isHetzner && kp) {
            await openstackApi.deleteKeyPair(dcConfig, tok, kp.key_name).catch(e => console.warn(`Could not delete keypair ${kp.key_name} from ${dcConfig.name}: ${e.message}`));
            await deleteKeyPairFromDb(serverId);
        }else {
  // Hetzner: پرایوت‌کی‌ای نزد ما نیست که پاک شود
  await deleteKeyPairFromDb(serverId).catch(()=>{});
}

        if (isTestServer) {
            await deleteTestServer(serverId);
        } else {
            await updatePurchaseStatus(serverId, 'deleted');
        }

        sendMessage(chatId, '✅ سرور با موفقیت حذف شد.');
        logServerEvent({ type: 'server_deleted', server_id: serverId, user_id: userId, datacenter: dcConfig.key });
    } catch (e) {
        console.error(`Deletion Error for ${serverId} in ${dcConfig.name}:`, e);
        sendMessage(chatId, `❌ خطا در حذف سرور: ${escapeMarkdownV2(e.message)}`);
    }
}

async function getPrivateKey(chatId, serverId) {


const p  = await getPurchaseByServerId(serverId);
if (!p) return sendMessage(chatId, '❌ رکورد خرید یافت نشد.');

const dcs = getUserEffectiveDCs(String(p.telegram_id));
const dc  = dcs?.[p.datacenter];

if (dc?.apiType === 'hetzner') {
  return sendMessage(chatId, 'در Hetzner کلید خصوصی نزد ما ذخیره نمی‌شود. باید با همان SSH key عمومی که موقع ساخت معرفی کرده‌اید وصل شوید.');
}

    const keyPair = await getKeyPair(serverId);
    if (keyPair && keyPair.private_key) {
        const rawKey = String(keyPair.private_key)
            .replace(/-----BEGIN RSA PRIVATE KEY-----/g, '')
            .replace(/-----END RSA PRIVATE KEY-----/g, '')
            .trim();

        const fullKey = `-----BEGIN RSA PRIVATE KEY-----\n${rawKey}\n-----END RSA PRIVATE KEY-----`;
        const serverName = (await getPurchaseByServerId(serverId))?.server_name || serverId;
        sendMessage(chatId, `🔑 کلید خصوصی سرور ${escapeMarkdownV2(serverName)}:\n\`\`\`\n${escapeMarkdownV2(fullKey)}\n\`\`\``, { parse_mode: 'MarkdownV2' });
    } else {
        sendMessage(chatId, '❌ کلید خصوصی برای این سرور یافت نشد.');
    }
}

async function getTrafficInfoRaw(chatId, serverId, dcConfig) {
  try {
    if (dcConfig.apiType === 'hetzner') {
      return sendMessage(chatId, '📊 ترافیک برای Hetzner در این ربات پشتیبانی نشده است.');
    }
    if (!dcConfig.TRAFFIC_API_BASE_URL) {
      return sendMessage(chatId, '📊 سرویس ترافیک برای این دیتاسنتر فعال نیست.');
    }

    const tok = await openstackApi.getToken(dcConfig);
    const srv = await openstackApi.getServer(dcConfig, tok, serverId);

    // تاریخ شروع = زمان ساخت سرور، با fallback امن
    let sinceIso = (srv && (srv.created || srv['created_at'])) || null;

    // اگر به هر دلیلی تاریخ معتبر نبود، fallback به “الان”
    let sinceDate = sinceIso ? new Date(sinceIso) : new Date();
    if (isNaN(sinceDate.getTime())) sinceDate = new Date();

    const startTimeUnix = Math.floor(sinceDate.getTime() / 1000);
    const endTimeUnix = Math.floor(Date.now() / 1000);

    // ===== Helper: fetch traffic for a given window =====
    async function fetchTrafficWindow(startUnix, endUnix) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const apiUrl =
        `${dcConfig.TRAFFIC_API_BASE_URL}${encodeURIComponent(serverId)}` +
        `?start_time=${startUnix}&end_time=${endUnix}`;

      const resp = await fetch(apiUrl, {
        headers: { Authorization: dcConfig.TRAFFIC_API_KEY },
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`Traffic API ${resp.status} ${resp.statusText} ${body ? `| ${body.slice(0, 200)}` : ''}`.trim());
      }

      const data = await resp.json();
      const rx = Number(data?.received_gb || 0);
      const tx = Number(data?.transmitted_gb || 0);
      return { rx, tx };
    }

    // ===== Only for Tebyan: split calculation due to outage window =====
    // این شرط را مطابق کانفیگ خودت تنظیم کن:
    const isTebyan = (dcConfig.key === 'tebyan') || (dcConfig.provider === 'tebyan') || (dcConfig.apiType === 'tebyan');

    // بازه حذف‌شده (اختلال): 25 Dec 00:00:00Z تا 27 Dec 00:00:00Z
    const CUT_START_UNIX = Math.floor(Date.parse('2025-12-25T00:00:00Z') / 1000);
    const CUT_END_UNIX   = Math.floor(Date.parse('2025-12-27T00:00:00Z') / 1000);

    let rxTotal = 0;
    let txTotal = 0;

    let details = [];

    if (isTebyan) {
      // Window A: from server created time -> start of cut (25 Dec)
      const aStart = startTimeUnix;
      const aEnd   = Math.min(endTimeUnix, CUT_START_UNIX);

      if (aStart < aEnd) {
        const a = await fetchTrafficWindow(aStart, aEnd);
        rxTotal += a.rx;
        txTotal += a.tx;
        details.push({ label: 'بازه ۱', rx: a.rx, tx: a.tx });
      } else {
        details.push({ label: 'بازه ۱', rx: 0, tx: 0 });
      }

      // Window B: from end of cut (27 Dec) -> now
      const bStart = Math.max(startTimeUnix, CUT_END_UNIX);
      const bEnd   = endTimeUnix;

      if (bStart < bEnd) {
        const b = await fetchTrafficWindow(bStart, bEnd);
        rxTotal += b.rx;
        txTotal += b.tx;
        details.push({ label: 'بازه ۲', rx: b.rx, tx: b.tx });
      } else {
        details.push({ label: 'بازه ۲', rx: 0, tx: 0 });
      }
    } else {
      // Default behavior: single window
      const one = await fetchTrafficWindow(startTimeUnix, endTimeUnix);
      rxTotal = one.rx;
      txTotal = one.tx;
    }

    const total = rxTotal + txTotal;
    const name = srv?.name || serverId;

    let msg =
      `📊 *ترافیک مصرفی*\n` +
      `سرور: *${escapeMarkdownV2(name)}*\n\n`;

    if (isTebyan) {
      msg +=
        `🔧 *محاسبه دو‌تکه (فقط تبیان)*\n` +
        `حذف بازه اختلال: 2025\\-12\\-25 00:00Z تا 2025\\-12\\-27 00:00Z\n\n`;

      // جزئیات هر بازه
      for (const d of details) {
        const dTotal = d.rx + d.tx;
        msg +=
          `• *${escapeMarkdownV2(d.label)}*\n` +
          `  📥 ${escapeMarkdownV2(d.rx.toFixed(2))} GB\n` +
          `  📤 ${escapeMarkdownV2(d.tx.toFixed(2))} GB\n` +
          `  📉 ${escapeMarkdownV2(dTotal.toFixed(2))} GB\n\n`;
      }
    } else {
      msg += `از ابتدای ساخت\n\n`;
    }

    msg +=
      `✅ *جمع کل*\n` +
      `📥 دانلود: ${escapeMarkdownV2(rxTotal.toFixed(2))} GB\n` +
      `📤 آپلود: ${escapeMarkdownV2(txTotal.toFixed(2))} GB\n` +
      `📉 مجموع: ${escapeMarkdownV2(total.toFixed(2))} GB`;

    return sendMessage(chatId, msg, { parse_mode: 'MarkdownV2' });
  } catch (e) {
    console.error('[GET_TRAFFIC_RAW]', e);
    return sendMessage(chatId, `❌ خطا: ${escapeMarkdownV2(String(e.message))}`, { parse_mode: 'MarkdownV2' });
  }
}



async function getTrafficInfo(chatId, serverId, dcConfig) {
  sendMessage(chatId, `📊 در حال دریافت اطلاعات ترافیک از ${dcConfig.name}...`);
  try {
    const purchase = isHetznerDc(dcConfig)
      ? (await getPurchaseForUserServer(userId, serverId, dcConfig.key).catch(() => null) || await getPurchaseByServerId(serverId))
      : await getPurchaseByServerId(serverId);
    if (!purchase) {
      return sendMessage(chatId, 'اطلاعات خرید یافت نشد. این ممکن است یک سرور تست باشد.');
    }

    const now = new Date();
    const trafficData = await calculateTrafficCost(purchase, purchase.created_at, now, dcConfig);

    const n = (v) => Number(v ?? 0);
    const fmt = (v) => escapeMarkdownV2(n(v).toFixed(2));

    const received = n(trafficData?.received_gb);
    const transmitted = n(trafficData?.transmitted_gb);
    const totalRaw = n(trafficData?.totalRawTrafficGb ?? (received + transmitted));
    const free = n(trafficData?.totalFreeTrafficForPeriod);
    const billableAfterFree = Math.max(0, n(trafficData?.billableTraffic ?? totalRaw) - free);

    const messageText =
      `📊 *ترافیک مصرفی سرور ${escapeMarkdownV2(purchase.server_name)}*\n` +
      `_\\(از زمان ساخت\\)_\n\n` +
      `📥 *دانلود \\(دریافتی\\):* ${fmt(received)} GB\n` +
      `📤 *آپلود \\(ارسالی\\):* ${fmt(transmitted)} GB\n` +
      `📉 *مجموع:* ${fmt(totalRaw)} GB\n\n` +
      `*اطلاعات صورتحساب:*\n` +
      `🎁 ترافیک رایگان دوره \\(${escapeMarkdownV2(purchase.duration)}\\): ${fmt(free)} GB\n` +
      `💰 ترافیک قابل محاسبه: ${fmt(billableAfterFree)} GB`;

    sendMessage(chatId, messageText, { parse_mode: 'MarkdownV2', disable_web_page_preview: true });
  } catch (e) {
    console.error(`Get Traffic Error for ${serverId} in ${dcConfig.name}:`, e);
    sendMessage(
      chatId,
      `❌ خطا در دریافت اطلاعات ترافیک: ${escapeMarkdownV2(String(e.message))}`,
      { parse_mode: 'MarkdownV2' }
    );
  }
}


async function handleDownloadWalletHistory(chatId, userId) {
    sendMessage(chatId, '⏳ در حال آماده‌سازی سابقه کیف پول شما...');
    try {
        const allLogs = await getWalletLogs(userId, null);
        if (!allLogs || allLogs.length === 0) {
            return sendMessage(chatId, '❌ سابقه کیف پول شما خالی است.');
        }

        const csvHeader = 'تاریخ,نوع,مبلغ,توضیحات\n';
        const csvRows = allLogs.map(log => {
            const timestamp = new Date(log.timestamp).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' });
            const type = log.type || 'N/A';
            const amount = parseFloat(log.amount).toFixed(2);
            const description = log.description ? `"${log.description.replace(/"/g, '""')}"` : '';
            return [timestamp, type, amount, description].join(',');
        }).join('\n');

        const csvContent = csvHeader + csvRows;
        const fileName = `wallet_history_${userId}.csv`;

        bot.sendDocument(chatId, Buffer.from(csvContent, 'utf8'), {
            caption: `✅ سابقه کامل کیف پول شما.`,
            filename: fileName
        }, { contentType: 'text/csv' });

    } catch (e) {
        console.error('Error generating wallet history CSV:', e);
        sendMessage(chatId, `❌ خطا در ایجاد فایل سابقه: ${escapeMarkdownV2(e.message)}`);
    }
}


async function pollForIp(dcConfig, tok, serverId, retries = 24, delay = 5000) {
    for (let i = 0; i < retries; i++) {
        await new Promise(r => setTimeout(r, delay));
        try {
            const sd = await openstackApi.getServer(dcConfig, tok, serverId);
            const ip = extractServerIp(sd);
            if (ip) return ip;
        } catch (e) {
            console.warn(`Polling for IP for server ${serverId} failed on attempt ${i+1}: ${e.message}`);
        }
    }
    return null;
}

// --- Hourly Billing ---
async function calculateTrafficCost(purchase, periodStart, periodEnd, dcConfig) {
  const { server_id, duration } = purchase || {};
if (!dcConfig || dcConfig.apiType === 'hetzner' || !dcConfig.TRAFFIC_API_BASE_URL) {
  return {
    received_gb: 0,
    transmitted_gb: 0,
    totalRawTrafficGb: 0,
    billableTraffic: 0,
    totalFreeTrafficForPeriod: 0
  };
}

  if (!dcConfig || !dcConfig.TRAFFIC_API_BASE_URL) {
    console.error(`TRAFFIC_API_BASE_URL is not defined for datacenter: ${purchase?.datacenter}`);
    return {
      received_gb: 0,
      transmitted_gb: 0,
      totalRawTrafficGb: 0,
      billableTraffic: 0,
      totalFreeTrafficForPeriod: 0
    };
  }

  const startTimeUnix = Math.floor(new Date(periodStart).getTime() / 1000);
  const endTimeUnix = Math.floor(new Date(periodEnd).getTime() / 1000);

  let received_gb = 0;
  let transmitted_gb = 0;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const apiUrl = `${dcConfig.TRAFFIC_API_BASE_URL}${encodeURIComponent(server_id)}?start_time=${startTimeUnix}&end_time=${endTimeUnix}`;
    const response = await fetch(apiUrl, {
      headers: { Authorization: dcConfig.TRAFFIC_API_KEY },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.error(`Traffic API failed for ${server_id} in ${dcConfig.name}: ${response.status} ${response.statusText}`);
    } else {
      const trafficData = await response.json();
      received_gb = Number(trafficData?.received_gb) || 0;
      transmitted_gb = Number(trafficData?.transmitted_gb) || 0;
    }
  } catch (e) {
    console.error(`Error in calculateTrafficCost for ${server_id}:`, e);
    return {
      received_gb: 0,
      transmitted_gb: 0,
      totalRawTrafficGb: 0,
      billableTraffic: 0,
      totalFreeTrafficForPeriod: 0
    };
  }

  const totalRawTrafficGb = Number(received_gb) + Number(transmitted_gb);

  // اگر دانلود-تنها باشد، فقط received محاسبه می‌شود
  const isDownloadOnly = purchase?.download_only == 1 || purchase?.download_only === true || purchase?.download_only === '1';
  const billableTraffic = isDownloadOnly ? Number(received_gb) : totalRawTrafficGb;

  // سهمیه رایگان دوره (fallback به free_traffic_gb)
  const freeTrafficGb = Number(purchase?.[`free_traffic_${duration}_gb`]) || Number(purchase?.free_traffic_gb) || 0;

  return {
    received_gb: Number(received_gb) || 0,
    transmitted_gb: Number(transmitted_gb) || 0,
    totalRawTrafficGb,
    billableTraffic,
    totalFreeTrafficForPeriod: freeTrafficGb
  };
}

const DEFAULT_MIN_ALERT_TOMAN = 100000;

async function runHourlyBilling() {
  console.log('--- Starting hourly billing process ---');
  const allPurchases = await getAllPurchases();

  // ✅ گردآوری یوزرهای کاندید
  const usersWithPurchases = new Map(); // userId -> { hasActive: bool, chatId: userId }
  for (const p of allPurchases) {
    const uid = String(p.telegram_id);
    if (!usersWithPurchases.has(uid)) usersWithPurchases.set(uid, { hasActive: false, chatId: uid });
    if (p.status === 'active') usersWithPurchases.get(uid).hasActive = true;
  }
  // 🔔 هشدار کمبود موجودی برای کاربران عادی (بدون پروژه)
  for (const [uid, meta] of usersWithPurchases) {
    const userId = String(uid);

    const projects = getUserProjects(userId) || [];
    if (projects.length > 0) continue; // فقط کاربران غیرپروژه‌ای

    // فقط اگر کاربر سرور active دارد هشدار بده
    if (!meta.hasActive) continue;

    const minAlert = DEFAULT_MIN_ALERT_TOMAN; // یا از تنظیمات/یوزر بخوان
    const balance = await getUserWallet(userId);

    if (balance < minAlert) {
      await sendLowBalanceAlertIfNeeded(
        userId,
        Number(userId),                 // chatId
        Math.max(0, Math.floor(balance)),
        `active server (wallet-based)`
      );
    }
  }

  // ✅ اضافه کردن کاربران پروژه‌محور (ممکنه خریدی نداشته باشن)
  const { getAllProjectUserIds } = require('./user_projects');
  for (const uid of getAllProjectUserIds()) {
    if (!usersWithPurchases.has(uid)) usersWithPurchases.set(uid, { hasActive: false, chatId: uid });
  }

  // 🔔 هشدار کمبود اعتبار پروژه‌ها
  for (const [uid, meta] of usersWithPurchases) {
    const userId = String(uid);
    const projects = getUserProjects(userId) || [];
    if (!projects.length) continue;

    const topupsTotal = await getUserTopupTotal(userId);
    const effectiveDCs = getUserEffectiveDCs(userId);

    for (const proj of projects) {
      const alias = proj.alias || proj.auth?.OS_PROJECT_ID || `u_${userId}`;
      const dc =
        effectiveDCs[`${proj.dcKey}__${alias}`] ||
        effectiveDCs[proj.dcKey];
      if (!dc || !dc.TRAFFIC_API_BASE_URL) continue;

      const pricePerGb   = Number(proj.pricePerGbToman ?? DEFAULT_PRICE_PER_GB);
      const downloadOnly = !!proj.downloadOnly;
      const minAlert     = Number(proj.minAlertToman ?? DEFAULT_MIN_ALERT_TOMAN);

      const { cost } = await getProjectCost(userId, dc, proj.auth?.OS_PROJECT_ID, downloadOnly, pricePerGb);
      const remainingForThisProject = Math.max(0, topupsTotal - cost);

      // فقط اگر کاربر مرتبط است هشدار بده: 1) سرور active دارد یا 2) مصرف پروژه > 0
      const isRelevant = meta.hasActive || cost > 0;
      if (!isRelevant) continue;

      if (remainingForThisProject < minAlert) {
        const key = `${proj.dcKey}:${proj.auth?.OS_PROJECT_ID}`;
        const label = proj.label || `${dc.name} / ${proj.auth?.OS_PROJECT_ID}`;
        // reason را یک رشته بده، آرگومان اضافه نفرست
        await sendLowBalanceAlertIfNeeded(userId, Number(userId), remainingForThisProject, `${label} (${key})`);
      }
    }
  }

  console.log('Billing candidates:',
    allPurchases.map(p => ({
      id: p.server_id,
      st: p.status,
      last: p.last_billed_at,
      traf: p.last_billed_traffic_gb,
      dc: p.datacenter
    }))
  );

  // 💳 حلقه‌ی صورتحساب سرورها
  for (const purchase of allPurchases) {
    if (!hetznerLifecycle.isBillablePurchase(purchase)) continue;

    const dcsForUser = getUserEffectiveDCs(String(purchase.telegram_id));
    const dcConfig = dcsForUser?.[purchase.datacenter];
    if (!dcConfig) {
      console.warn('[Billing] skipping missing datacenter', { datacenter: purchase.datacenter, server_id: purchase.server_id, user_id: purchase.telegram_id });
      continue;
    }

    const {
      telegram_id, server_id, server_name, amount, duration,
      status, last_billed_at, price_per_gb, last_billed_traffic_gb, created_at,
      auto_renew, renewal_stopped_at, suspend_reason
    } = purchase;

    if (!server_id) {
      console.warn('[Billing] skipping purchase with null server_id', { datacenter: purchase.datacenter, user_id: telegram_id });
      continue;
    }

    const userId = String(telegram_id);
    if (status === 'suspended' && suspend_reason === 'auto_renew_disabled' && renewal_stopped_at) {
      continue;
    }

    let currentBalance = await getUserWallet(userId);

    const now = new Date();
    const lastBilledDate = last_billed_at ? new Date(last_billed_at) : new Date(created_at || now);
    const cycleHours = HOURS_IN_CYCLE[duration];
    if (!cycleHours) {
      console.error(`Billing Error: invalid duration '${duration}' for ${server_id}`);
      continue;
    }
    const hoursSinceLastBill = (now - lastBilledDate) / 3600000;

    // 🔢 ترافیک از زمان ساخت تا الان
    const t = await calculateTrafficCost(purchase, created_at, now, dcConfig);

    // ✅ اعمال سهمیه رایگان به‌صورت تجمعی بر اساس تعداد سیکل‌های سپری‌شده
    const createdAtDate = created_at ? new Date(created_at) : now;
    const elapsedHoursSinceCreation = Math.max(0, (now - createdAtDate) / 3600000);
    const cyclesElapsed = Math.max(1, Math.floor(elapsedHoursSinceCreation / cycleHours) + 1); // سیکل جاری هم شمرده می‌شود
    const freePerCycleGb = Number(t?.totalFreeTrafficForPeriod || 0);
    const cumulativeFreeGb = freePerCycleGb * cyclesElapsed;

    // billableTraffic خودش دانلود-تنها را لحاظ کرده
    const rawBillableGbFromCreation = Number(t?.billableTraffic || 0);
    const billableFromCreationGb = Math.max(0, rawBillableGbFromCreation - cumulativeFreeGb);

    // last_billed_traffic_gb = ترافیک قابل‌صورتحساب *تجمیعی* که قبلاً صورت‌حساب شده
    const alreadyBilledGb = Number(last_billed_traffic_gb || 0);
    const newTrafficToBillGb = Math.max(0, billableFromCreationGb - alreadyBilledGb);
    const trafficCost = newTrafficToBillGb * Number(price_per_gb || 0);

    // 💻 هزینهٔ خود سرور فقط در مرز سیکل
    let instanceCost = 0;
    const cycleDue = hoursSinceLastBill >= cycleHours;
    const autoRenewEnabled = Number(auto_renew ?? 1) === 1;
    if (cycleDue && autoRenewEnabled) {
      instanceCost = normalizeStoredCycleAmount(purchase); // مبلغ کامل دوره؛ رکوردهای ساعتی قدیمی نیز نرمال می‌شوند
    }

    if (cycleDue && !autoRenewEnabled) {
      if (trafficCost > 0 && currentBalance >= trafficCost) {
        await debitUser(userId, trafficCost);
        await recordWalletLog(userId, -trafficCost, `کسر هزینه ترافیک سرور ${server_name}`, 'billing');
        await updatePurchaseStatus(server_id, status || 'active', billableFromCreationGb, lastBilledDate);
        currentBalance -= trafficCost;
      }
      if (status === 'active') {
        try {
          const tok = await openstackApi.getToken(dcConfig);
          await openstackApi.suspendServer(dcConfig, tok, server_id);
        } catch (e) {
          if (e.response?.status === 409) console.warn('[Billing] auto-renew-off suspend conflict ignored', { status: 409, server_id, datacenter: purchase.datacenter, message: e.message });
          else console.warn('[Billing] auto-renew-off suspend failed', { status: e.response?.status, server_id, datacenter: purchase.datacenter, message: e.message });
        }
      }
      await setPurchaseRenewalStopped(server_id, 'auto_renew_disabled');
      const unpaidTrafficNote = trafficCost > 0 && currentBalance < trafficCost
        ? '\n⚠️ همچنین موجودی کیف پول برای پرداخت هزینه ترافیک مصرف‌شده کافی نبود.'
        : '';
      await sendMessage(userId, `⏸ سرور شما به‌دلیل غیرفعال بودن تمدید خودکار، در پایان دوره متوقف شد. برای فعال‌سازی مجدد، تمدید خودکار را روشن کنید و کیف پول کافی داشته باشید.${unpaidTrafficNote}`);
      continue;
    }

    const totalCost = trafficCost + instanceCost;
    if (totalCost <= 0) {
      // حتی اگر هزینه صفره ولی سیکل رد شده، last_billed_at را به‌روز کنیم تا مرز سیکل جابه‌جا شود
      if (hoursSinceLastBill >= cycleHours) {
        await updatePurchaseStatus(server_id, status || 'active', billableFromCreationGb, now);
      }
      continue;
    }

    if (currentBalance >= totalCost) {
      await debitUser(userId, totalCost);
      await recordWalletLog(userId, -totalCost, `کسر هزینه سرور ${server_name}`, 'billing');

      const newLastBilledAt = hoursSinceLastBill >= cycleHours ? now : lastBilledDate;
      await updatePurchaseStatus(server_id, 'active', billableFromCreationGb, newLastBilledAt);

      if (status === 'suspended') {
        try {
          const tok = await openstackApi.getToken(dcConfig);
          await openstackApi.resumeServer(dcConfig, tok, server_id);
          sendMessage(userId, `✅ سرور ${escapeMarkdownV2(server_name)} مجددا فعال شد.`);
        } catch (e) {
          console.warn('[Billing] resume failed', { status: e.response?.status, server_id, datacenter: purchase.datacenter, message: e.message });
        }
      }
    } else {
      if (status === 'active') {
        try {
          const tok = await openstackApi.getToken(dcConfig);
          await openstackApi.suspendServer(dcConfig, tok, server_id);
          await updatePurchaseStatus(server_id, 'suspended');
          await updatePurchaseSuspendReason(server_id, 'insufficient_balance');
          sendMessage(userId, `⚠️ موجودی شما برای پرداخت هزینه سرور ${escapeMarkdownV2(server_name)} کافی نیست و سرور معلق شد.`);
        } catch (e) {
          if (e.response?.status === 409) console.warn('[Billing] suspend conflict ignored', { status: 409, server_id, datacenter: purchase.datacenter, message: e.message });
          else console.warn('[Billing] suspend failed', { status: e.response?.status, server_id, datacenter: purchase.datacenter, message: e.message });
        }
      }
    }
  }

  console.log('--- Hourly billing process completed ---');
}


// اجرای صورتحساب هر ساعت
cron.schedule('0 * * * *', async () => {
  console.log('[CRON] Running hourly billing...');
  try {
    await runHourlyBilling();
    console.log('[CRON] Billing done.');
  } catch (e) {
    console.error('[CRON] Billing error:', e);
  }
});


// Hetzner delivery reconciler: never deliver credentials before SSH + Iran/global reachability pass.
cron.schedule('* * * * *', async () => {
  try {
    const db = require('./db');
    const results = await hetznerLifecycle.reconcileProvisioning({
      db,
      resolveDatacenter: datacenter => {
        const dc = baseDatacenters[datacenter];
        return dc ? { ...dc, key: datacenter } : null;
      },
      timeoutMs: Number(process.env.HETZNER_RECONCILE_READY_TIMEOUT_MS || 12000)
    });
    const changed = results.filter(item => item.ready || item.ip_rotated || item.status === 'manual_review' || item.status === 'provider_missing');
    if (changed.length) {
      console.log('[HETZNER_PROVISIONING_RECONCILE]', changed.map(x => ({ server_id: x.server_id, status: x.status, ready: !!x.ready, ip_rotated: !!x.ip_rotated, reason: x.reason || null })));
    }

    for (const item of results.filter(result => result.newly_delivered)) {
      const purchase = await getPurchaseByServerId(item.server_id).catch(() => null);
      const password = await getServerSecret(item.server_id, 'root_password').catch(() => null);
      if (!purchase || !password) {
        await db.updateScopedStatus(item.telegram_id, item.server_id, item.datacenter, 'manual_review').catch(() => null);
        continue;
      }
      const msgHtml = [
        `✅ سرور ${htmlEscape(purchase.server_name || item.server_id)} اکنون کاملاً آماده و قابل تحویل است.`,
        `🔹 IP: <code>${htmlEscape(item.ip || purchase.public_ip || '')}</code>`,
        '✅ SSH در دسترس است.',
        '✅ تست دسترسی IP از ایران و چند نقطه خارجی تأیید شد.',
        `🔑 <b>رمز عبور روت:</b>\n${htmlCodeBlock(password)}`
      ].join('\n');
      await sendMessage(item.telegram_id, msgHtml, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '⚙️ مدیریت سرور', callback_data: makeShortCb(item.telegram_id, { action: 'M', dcKey: item.datacenter, serverId: item.server_id }) }]] }
      }).catch(error => console.error('[HETZNER_DELIVERY_NOTIFY_FAILED]', { server_id: item.server_id, message: error.message }));
    }

    for (const item of results.filter(result => result.status === 'manual_review')) {
      await sendMessage(item.telegram_id, '⚠️ سرور هنوز شرایط تحویل امن را پاس نکرده و برای بررسی دستی نگه داشته شده است. IP و رمز تا رفع مشکل نمایش داده نمی‌شود.').catch(() => null);
      if (SUPPORT_ID) {
        await sendMessage(SUPPORT_ID, `🚨 Hetzner delivery manual review\nuser_id=${item.telegram_id}\nserver_id=${item.server_id}\ndc=${item.datacenter}\nreason=${item.reason || 'unknown'}`).catch(() => null);
      }
    }
  } catch (error) {
    console.error('[HETZNER_PROVISIONING_RECONCILE_FAILED]', error);
  }
});


// --- Cleanup expired test servers every 15 minutes ---
const mysql = require('mysql2/promise');
const datacenters = require('./datacenters');
//const { deleteTestServer } = require('./db');
const TEST_LIFETIME_HOURS = 1;

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'hamooncloud_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

async function cleanupExpiredTestServers() {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.execute(`
      SELECT telegram_id, datacenter, server_id, used_at
      FROM test_servers
      WHERE server_id IS NOT NULL AND used_at < (NOW() - INTERVAL ${TEST_LIFETIME_HOURS} HOUR)
    `);

    if (rows.length === 0) {
      console.log('[CRON] ✅ هیچ سرور تست منقضی‌شده‌ای یافت نشد.');
      return;
    }

    console.log(`[CRON] ⚠️ ${rows.length} سرور تست منقضی‌شده پیدا شد.`);
    const missingDcWarned = new Set();

    for (const row of rows) {
      const { telegram_id, datacenter, server_id } = row;
     // const dcConfig = datacenters.find(dc => dc.key === datacenter);
const dcConfig = Array.isArray(datacenters)
  ? datacenters.find(dc => dc.key === datacenter)
  : Object.values(datacenters).find(dc => dc.key === datacenter);

if (!dcConfig) {
        missingDcWarned.add(datacenter);
        continue;
      }

      try {
        console.log(`[CRON] 🧹 حذف سرور تست ${server_id} (${datacenter}) متعلق به ${telegram_id}...`   );
        const tok = await openstackApi.getToken(dcConfig);
        await openstackApi.deleteServer(dcConfig, tok, server_id);
  //      await deleteTestServer(server_id);
await conn.execute(
  'UPDATE test_servers SET server_id = NULL, boot_volume_id = NULL WHERE server_id = ?',
  [server_id]
);
    console.log(`[CRON] ✅ سرور ${server_id} حذف شد.`);
      }catch (err) {
  if (err.response && err.response.status === 404) {
    console.warn(`[CRON] ⚠️ سرور ${server_id} در OpenStack وجود ندارد. حذف رکورد DB...`);
await conn.execute(
  'UPDATE test_servers SET server_id = NULL, boot_volume_id = NULL WHERE server_id = ?',
  [server_id]
);
 //await deleteTestServer(server_id);
  } else {
    console.error(`[CRON] ❌ خطا در حذف ${server_id}:`, err.message);
  }
}
    }
    for (const dc of missingDcWarned) console.warn(`[CRON] ⚠️ دیتاسنتر ${dc} در فایل datacenters پیدا نشد.`);
  } catch (err) {
    console.error('[CRON] ❌ خطا در پاک‌سازی تست‌ها:', err.message);
  } finally {
    conn.release();
  }
}

// اجرای کرون هر ۱۵ دقیقه
cron.schedule('*/15 * * * *', async () => {
  console.log('[CRON] Running test-server cleanup...');
  await cleanupExpiredTestServers();
});

