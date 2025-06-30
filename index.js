require('dotenv').config({ path: __dirname + '/.env' });
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const {
  upsertUser,
  getUserWallet,
  debitUser,
  creditUser, // Import new function
  recordPurchase,
  recordTestServer,
  storeKeyPair,     // Import new function
  getKeyPair,       // Import new function
  deleteKeyPairFromDb // Import new function
} = require('./db');
const crypto = require('crypto');

// Telegram Bot Token
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN not set');
  process.exit(1);
}
const bot = new TelegramBot(token, { webHook: false });

// Initialize bot with optional proxy
//const bot = new TelegramBot(token, {
  //polling: true,
//  ...(process.env.HTTPS_PROXY && { request: { agent: new (require('https-proxy-agent'))(process.env.HTTPS_PROXY) } })
//});

// OpenStack Auth and URL helpers
async function getToken() {
  const body = {
    auth: {
      identity: {
        methods: ['password'],
        password: {
          user: {
            name: process.env.OS_USERNAME,
            domain: { name: process.env.OS_USER_DOMAIN_NAME },
            password: process.env.OS_PASSWORD
          }
        }
      },
      scope: {
        project: {
          id: process.env.OS_PROJECT_ID,
          domain: { name: process.env.OS_PROJECT_DOMAIN_ID }
        }
      }
    }
  };
  try {
    const r = await axios.post(`${process.env.OS_AUTH_URL}/v3/auth/tokens`, body, { headers: { 'Content-Type': 'application/json' } });
    return r.headers['x-subject-token'];
  } catch (error) {
    console.error('Error getting OpenStack token:', error.response ? error.response.data : error.message);
    throw new Error('Failed to authenticate with OpenStack.');
  }
}

const computeUrl = () => process.env.OS_COMPUTE_URL || process.env.OS_AUTH_URL.replace(':5000', ':8774') + '/v2.1';
const imageUrl = () => process.env.OS_IMAGE_URL || process.env.OS_AUTH_URL.replace(':5000', ':9292') + '/v2/images';

// List flavors and images with labels
async function listFlavors(tok) {
  try {
    const r = await axios.get(`${computeUrl()}/flavors/detail`, { headers: { 'X-Auth-Token': tok } }); // Use /detail for more info if needed
    return r.data.flavors
      .filter(f => /^\d+-\d+-\d+$/.test(f.name)) // Filter flavors with specific naming convention
      .map(f => {
        const [cpu, ram, disk] = f.name.split('-').map(Number);
        // Calculate price based on CPU, RAM, and Disk. Adjust coefficients as needed.
        const price = (cpu * 10) + (ram * 5) + (disk * 0.1);
        return { id: f.id, label: `${cpu} هسته، ${ram}GB رم، ${disk}GB SSD`, price: price };
      });
  } catch (error) {
    console.error('Error listing flavors:', error.response ? error.response.data : error.message);
    throw new Error('Failed to retrieve server flavors.');
  }
}

async function listImages(tok) {
  try {
    const r = await axios.get(imageUrl(), { headers: { 'X-Auth-Token': tok } });
    // Filter for active images that are public or shared with the project
    return r.data.images
      .filter(i => i.status === 'active' && (i.visibility === 'public' || i.visibility === 'shared'))
      .map(i => ({ id: i.id, label: i.name }));
  } catch (error) {
    console.error('Error listing images:', error.response ? error.response.data : error.message);
    throw new Error('Failed to retrieve images.');
  }
}

// Key pair operations - NEW FUNCTIONS
async function createKeyPair(tok, keyName) {
  try {
    const body = { keypair: { name: keyName, type: 'ssh' } };
    const r = await axios.post(`${computeUrl()}/os-keypairs`, body, { headers: { 'X-Auth-Token': tok, 'Content-Type': 'application/json' } });
    return r.data.keypair; // Returns name, public_key, private_key, fingerprint
  } catch (error) {
    console.error('Error creating key pair:', error.response ? error.response.data : error.message);
    throw new Error('Failed to create SSH key pair.');
  }
}

async function deleteKeyPair(tok, keyName) {
  try {
    await axios.delete(`${computeUrl()}/os-keypairs/${keyName}`, { headers: { 'X-Auth-Token': tok } });
    return true;
  } catch (error) {
    console.error('Error deleting key pair:', error.response ? error.response.data : error.message);
    // Do not throw error if key pair doesn't exist, just log it.
    return false;
  }
}

// Server ops - MODIFIED createServer to include key_name
async function createServer(tok, name, flavorRef, imageRef, key_name, meta = {}) {
  const body = {
    server: {
      name,
      flavorRef,
      imageRef,
      networks: [{ uuid: process.env.OS_NETWORK_ID }],
      metadata: meta,
      key_name: key_name // Include the key name
      // You can also add user_data here for cloud-init scripts, e.g., to set a root password
      // user_data: Buffer.from('#cloud-config\npassword: YOUR_ROOT_PASSWORD\nchpasswd: { expire: False }').toString('base64')
    }
  };
  try {
    const r = await axios.post(`${computeUrl()}/servers`, body, { headers: { 'X-Auth-Token': tok, 'Content-Type': 'application/json' } });
    return r.data.server;
  } catch (error) {
    console.error('Error creating server:', error.response ? error.response.data : error.message);
    throw new Error('Failed to create server.');
  }
}

async function getServer(tok, id) {
  try {
    const r = await axios.get(`${computeUrl()}/servers/${id}`, { headers: { 'X-Auth-Token': tok } });
    return r.data.server;
  } catch (error) {
    console.error('Error getting server:', error.response ? error.response.data : error.message);
    throw new Error('Failed to retrieve server details.');
  }
}

async function suspendServer(tok, id) {
  try {
    await axios.post(`${computeUrl()}/servers/${id}/action`, { 'os-suspend': null }, { headers: { 'X-Auth-Token': tok } });
    return true;
  } catch (error) {
    console.error('Error suspending server:', error.response ? error.response.data : error.message);
    throw new Error('Failed to suspend server.');
  }
}

async function startServer(tok, id) {
  try {
    await axios.post(`${computeUrl()}/servers/${id}/action`, { 'os-start': null }, { headers: { 'X-Auth-Token': tok } });
    return true;
  } catch (error) {
    console.error('Error starting server:', error.response ? error.response.data : error.message);
    throw new Error('Failed to start server.');
  }
}

async function deleteServer(tok, id) {
  try {
    await axios.delete(`${computeUrl()}/servers/${id}`, { headers: { 'X-Auth-Token': tok } });
    return true;
  } catch (error) {
    console.error('Error deleting server:', error.response ? error.response.data : error.message);
    throw new Error('Failed to delete server.');
  }
}

async function listServers(tok) {
  try {
    const r = await axios.get(`${computeUrl()}/servers/detail`, { headers: { 'X-Auth-Token': tok } });
    return r.data.servers;
  } catch (error) {
    console.error('Error listing servers:', error.response ? error.response.data : error.message);
    throw new Error('Failed to list servers.');
  }
}


// State and menus
const CHANNEL = 'hamooncloud';
const state = {}; // To manage multi-step conversations
const mainMenu = { reply_markup: { resize_keyboard: true, keyboard: [['🆓 تست رایگان'], ['🛒 خرید سرور', '💰 افزایش اعتبار'], ['⚙️ مدیریت سرورها'], ['📞 پشتیبانی']] } };

// Helper to send messages and handle errors
async function sendMessage(chatId, text, options) {
  try {
    await bot.sendMessage(chatId, text, options);
  } catch (error) {
    console.error(`Error sending message to ${chatId}:`, error.message);
  }
}

// /start
bot.onText(/\/start/, async msg => {
  const u = msg.from.id, ch = msg.chat.id;
  try {
    const m = await bot.getChatMember(`@${CHANNEL}`, u);
    if (['left', 'kicked'].includes(m.status)) throw 0;
  } catch (e) {
    return sendMessage(ch, `🌐 لطفاً در کانال @${CHANNEL} عضو شوید.`, { reply_markup: { inline_keyboard: [[{ text: '➡️ عضویت', url: `https://t.me/${CHANNEL}` }]] } });
  }
  state[u] = { step: 'WAIT_CONTACT' };
  sendMessage(ch, '📲 شماره خود را ارسال کنید:', { reply_markup: { keyboard: [[{ text: 'ارسال شماره', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } });
});

bot.on('contact', async msg => {
  const u = msg.from.id, ch = msg.chat.id;
  if (state[u]?.step !== 'WAIT_CONTACT' || msg.contact.user_id !== u) {
    return sendMessage(ch, '⚠️ شماره ارسال شده متعلق به شما نیست یا در انتظار شماره شما نیستم.');
  }
  await upsertUser({ telegram_id: u, phone: msg.contact.phone_number, step: 'READY' });
  state[u] = { step: 'READY' };
  sendMessage(ch, '✅ ثبت شد!', mainMenu);
});

bot.on('message', msg => {
  const u = msg.from.id, ch = msg.chat.id;
  // Handle messages when expecting contact
  if (state[u]?.step === 'WAIT_CONTACT' && !msg.contact) {
    sendMessage(ch, '⚠️ لطفا با دکمه "ارسال شماره" اقدام به ارسال شماره خود کنید.');
    return;
  }

  // Handle messages for "Buy Server" flow
  if (state[u]?.step === 'WAIT_SERVER_NAME' && msg.text) {
    handleServerNameInput(u, ch, msg.text);
    return;
  }

  // Handle messages for "Increase Credit" flow
  if (state[u]?.step === 'WAIT_DEPOSIT_AMOUNT' && msg.text) {
    handleDepositAmountInput(u, ch, msg.text);
    return;
  }
});


// Free test
bot.onText(/🆓 تست رایگان/, async msg => {
  const u = msg.from.id, ch = msg.chat.id;
  try {
    if (await recordTestServer(u)) {
      return sendMessage(ch, '❌ تست رایگان قبلا توسط شما استفاده شده است.');
    }
    sendMessage(ch, '🚀 در حال ساخت سرور تست رایگان شما... لطفا صبر کنید.');

    const tok = await getToken();
    const imgs = await listImages(tok);
    // Use a specific flavor for free test, e.g., the smallest one or a predefined ID
    // Ensure this flavor ID exists in your OpenStack environment
    const testFlavorId = process.env.OS_TEST_FLAVOR_ID || '1264712d-50b7-4323-ac5c-c4f942518f57'; // Example ID
    const img = imgs[0]; // Take the first available image, or specify one
    if (!img) {
      throw new Error('No images available for test server.');
    }

    const keyName = `test-key-${u}-${crypto.randomBytes(4).toString('hex')}`;
    const keyPair = await createKeyPair(tok, keyName);

    const name = 'test-' + crypto.randomBytes(3).toString('hex');
    const srv = await createServer(tok, name, testFlavorId, img.id, keyName, { user: String(u), type: 'test' });

    // Store key pair in DB
    await storeKeyPair(u, srv.id, keyName, keyPair.private_key);

    await recordTestServer(u, srv.id);

    // Fetch flavor label
    const fl = (await listFlavors(tok)).find(x => x.id === testFlavorId);
    // Wait for server to get an IP address
    let serverDetails = await getServer(tok, srv.id);
    let ipAddress = null;
    let attempts = 0;
    while (!ipAddress && attempts < 10) { // Try up to 10 times with delay
      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
      serverDetails = await getServer(tok, srv.id);
      if (serverDetails.addresses && Object.values(serverDetails.addresses).length > 0) {
        const network = Object.values(serverDetails.addresses)[0];
        if (network.length > 0 && network[0].addr) {
          ipAddress = network[0].addr;
        }
      }
      attempts++;
    }

    if (!ipAddress) {
      throw new Error('Could not get IP address for the test server.');
    }

    const details = `✅ سرور تست رایگان شما ساخته شد:\n` +
      `🔹 نام: ${srv.name}\n` +
      `🔹 IP: ${ipAddress}\n` +
      `🔹 Flavor: ${fl ? fl.label : 'N/A'}\n` +
      `🔹 سیستم عامل: ${img.label}\n\n` +
      `🔑 کلید SSH خصوصی شما: \n\`\`\`\n${keyPair.private_key}\n\`\`\`\n` +
      `برای اتصال از طریق SSH:\n\`ssh -i ${keyName}.pem ubuntu@${ipAddress}\``; // Assuming 'ubuntu' user for common images

    sendMessage(ch, details, {
      reply_markup: {
        inline_keyboard: [[
          { text: '▶️ شروع', callback_data: `A_start_${srv.id}` },
          { text: '⏸️ تعلیق', callback_data: `A_suspend_${srv.id}` }
        ]]
      },
      parse_mode: 'Markdown'
    });

    // Schedule suspension after 1 hour (3600 seconds)
    setTimeout(async () => {
      try {
        const t = await getToken();
        await suspendServer(t, srv.id);
        sendMessage(ch, `⏸️ سرور تست ${srv.name} شما به طور خودکار معلق شد.`);
      } catch (suspendError) {
        console.error(`Error suspending test server ${srv.id}:`, suspendError.message);
        sendMessage(ch, `⚠️ خطا در تعلیق خودکار سرور تست ${srv.name}. لطفا به صورت دستی اقدام کنید.`);
      }
    }, 3600 * 1000); // 1 hour in milliseconds

  } catch (e) {
    console.error('Error in free test creation:', e);
    sendMessage(ch, `❌ خطا در ساخت سرور تست رایگان: ${e.message || 'خطای ناشناخته'}`);
  }
});

// Buy Server Flow - NEW FEATURE
bot.onText(/🛒 خرید سرور/, async msg => {
  const u = msg.from.id, ch = msg.chat.id;
  try {
    const tok = await getToken();
    const flavors = await listFlavors(tok);
    if (!flavors.length) {
      return sendMessage(ch, '🚫 در حال حاضر هیچ نوع سروری برای خرید موجود نیست.');
    }

    state[u] = { step: 'SELECT_FLAVOR', flavors: flavors };
    const flavorKeyboard = flavors.map(f => [{ text: `${f.label} (${f.price} تومان)`, callback_data: `FLAVOR_${f.id}` }]);
    sendMessage(ch, 'انتخاب نوع سرور:', { reply_markup: { inline_keyboard: flavorKeyboard } });
  } catch (e) {
    console.error('Error initiating buy server:', e);
    sendMessage(ch, `❌ خطا در شروع فرآیند خرید سرور: ${e.message || 'خطای ناشناخته'}`);
  }
});

// Increase Credit Flow - NEW FEATURE
bot.onText(/💰 افزایش اعتبار/, async msg => {
  const u = msg.from.id, ch = msg.chat.id;
  state[u] = { step: 'WAIT_DEPOSIT_AMOUNT' };
  sendMessage(ch, 'لطفا مبلغ مورد نظر برای افزایش اعتبار را به تومان وارد کنید (مثال: 10000):');
});

async function handleDepositAmountInput(u, ch, amountText) {
  const amount = parseFloat(amountText);
  if (isNaN(amount) || amount <= 0) {
    sendMessage(ch, '⚠️ مبلغ وارد شده نامعتبر است. لطفا یک عدد مثبت وارد کنید.');
    return;
  }
  try {
    await creditUser(u, amount);
    const currentBalance = await getUserWallet(u);
    sendMessage(ch, `✅ ${amount} تومان به اعتبار شما اضافه شد. موجودی فعلی: ${currentBalance} تومان.`, mainMenu);
  } catch (e) {
    console.error('Error crediting user:', e);
    sendMessage(ch, `❌ خطا در افزایش اعتبار: ${e.message || 'خطای ناشناخته'}`);
  } finally {
    state[u] = { step: 'READY' }; // Reset state
  }
}


// Callback query handler for buy server and manage server actions
bot.on('callback_query', async q => {
  const d = q.data, u = q.from.id, ch = q.message.chat.id;
  await bot.answerCallbackQuery(q.id); // Acknowledge the callback query

  // Handle Buy Server Flow Callbacks
  if (d.startsWith('FLAVOR_')) {
    const flavorId = d.slice(7);
    const selectedFlavor = state[u]?.flavors?.find(f => f.id === flavorId);
    if (!selectedFlavor) {
      return sendMessage(ch, '⚠️ نوع سرور انتخاب شده نامعتبر است. لطفا دوباره تلاش کنید.');
    }
    state[u].selectedFlavor = selectedFlavor;

    try {
      const tok = await getToken();
      const images = await listImages(tok);
      if (!images.length) {
        return sendMessage(ch, '🚫 در حال حاضر هیچ سیستم عاملی برای نصب موجود نیست.');
      }
      state[u].images = images;
      state[u].step = 'SELECT_IMAGE';
      const imageKeyboard = images.map(img => [{ text: img.label, callback_data: `IMAGE_${img.id}` }]);
      sendMessage(ch, 'انتخاب سیستم عامل:', { reply_markup: { inline_keyboard: imageKeyboard } });
    } catch (e) {
      console.error('Error listing images for buy server:', e);
      sendMessage(ch, `❌ خطا در دریافت لیست سیستم عامل‌ها: ${e.message || 'خطای ناشناخته'}`);
      state[u] = { step: 'READY' }; // Reset state
    }

  } else if (d.startsWith('IMAGE_')) {
    const imageId = d.slice(6);
    const selectedImage = state[u]?.images?.find(img => img.id === imageId);
    if (!selectedImage) {
      return sendMessage(ch, '⚠️ سیستم عامل انتخاب شده نامعتبر است. لطفا دوباره تلاش کنید.');
    }
    state[u].selectedImage = selectedImage;
    state[u].step = 'WAIT_SERVER_NAME';
    sendMessage(ch, 'لطفا یک نام برای سرور خود وارد کنید (مثال: my-web-server):');

  } else if (d === 'CONFIRM_PURCHASE') {
    const { selectedFlavor, selectedImage, serverName } = state[u];
    if (!selectedFlavor || !selectedImage || !serverName) {
      sendMessage(ch, '⚠️ اطلاعات خرید ناقص است. لطفا دوباره از ابتدا شروع کنید.');
      state[u] = { step: 'READY' };
      return;
    }

    try {
      const userBalance = await getUserWallet(u);
      if (userBalance < selectedFlavor.price) {
        sendMessage(ch, `❌ موجودی شما کافی نیست. (موجودی: ${userBalance} تومان، هزینه: ${selectedFlavor.price} تومان) \nلطفا ابتدا اعتبار خود را افزایش دهید.`, mainMenu);
        state[u] = { step: 'READY' };
        return;
      }

      sendMessage(ch, '🚀 در حال ساخت سرور شما... لطفا صبر کنید.');
      const tok = await getToken();

      const keyName = `user-${u}-server-${crypto.randomBytes(4).toString('hex')}`;
      const keyPair = await createKeyPair(tok, keyName);

      const srv = await createServer(tok, serverName, selectedFlavor.id, selectedImage.id, keyName, { user: String(u), type: 'purchased' });

      // Store key pair in DB
      await storeKeyPair(u, srv.id, keyName, keyPair.private_key);

      await debitUser(u, selectedFlavor.price);
      await recordPurchase(u, srv.id, selectedFlavor.price, 'monthly'); // Assuming monthly for now

      // Wait for server to get an IP address
      let serverDetails = await getServer(tok, srv.id);
      let ipAddress = null;
      let attempts = 0;
      while (!ipAddress && attempts < 10) { // Try up to 10 times with delay
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
        serverDetails = await getServer(tok, srv.id);
        if (serverDetails.addresses && Object.values(serverDetails.addresses).length > 0) {
          const network = Object.values(serverDetails.addresses)[0];
          if (network.length > 0 && network[0].addr) {
            ipAddress = network[0].addr;
          }
        }
        attempts++;
      }

      if (!ipAddress) {
        throw new Error('Could not get IP address for the new server.');
      }

      const details = `✅ سرور شما با موفقیت ساخته شد:\n` +
        `🔹 نام: ${srv.name}\n` +
        `🔹 IP: ${ipAddress}\n` +
        `🔹 Flavor: ${selectedFlavor.label}\n` +
        `🔹 سیستم عامل: ${selectedImage.label}\n\n` +
        `🔑 کلید SSH خصوصی شما: \n\`\`\`\n${keyPair.private_key}\n\`\`\`\n` +
        `برای اتصال از طریق SSH:\n\`ssh -i ${keyName}.pem ubuntu@${ipAddress}\``; // Assuming 'ubuntu' user

      sendMessage(ch, details, { parse_mode: 'Markdown' });
      sendMessage(ch, 'موجودی جدید شما: ' + (userBalance - selectedFlavor.price) + ' تومان.', mainMenu);
      state[u] = { step: 'READY' }; // Reset state

    } catch (e) {
      console.error('Error during server purchase:', e);
      sendMessage(ch, `❌ خطا در فرآیند خرید سرور: ${e.message || 'خطای ناشناخته'}`);
      state[u] = { step: 'READY' }; // Reset state
    }

  } else if (d === 'CANCEL_PURCHASE') {
    sendMessage(ch, '🚫 فرآیند خرید سرور لغو شد.', mainMenu);
    state[u] = { step: 'READY' }; // Reset state
  }

  // Handle Manage Servers Callbacks
  else if (d.startsWith('M_')) {
    const id = d.slice(2);
    try {
      const tok = await getToken();
      const srv = await getServer(tok, id);
      const fl = (await listFlavors(tok)).find(f => f.id === srv.flavor.id);
      const img = (await listImages(tok)).find(i => i.id === srv.image.id);
      const ip = Object.values(srv.addresses)[0][0].addr;
      const keyPairInfo = await getKeyPair(srv.id); // Get key pair from DB

      let info = `📍 نام: ${srv.name}\n🌐 IP: ${ip}\n🔹 Flavor: ${fl.label}\n🔹 سیستم عامل: ${img.label}\n📈 وضعیت: ${srv.status}`;
      if (keyPairInfo && keyPairInfo.private_key) {
        info += `\n\n🔑 کلید SSH خصوصی شما: \n\`\`\`\n${keyPairInfo.private_key}\n\`\`\`\n`;
        info += `برای اتصال از طریق SSH:\n\`ssh -i ${keyPairInfo.key_name}.pem ubuntu@${ip}\``;
      }

      sendMessage(ch, info, {
        reply_markup: {
          inline_keyboard: [[
            { text: '▶️ شروع', callback_data: `A_start_${id}` },
            { text: '⏸️ تعلیق', callback_data: `A_suspend_${id}` },
            { text: '❌ حذف', callback_data: `A_delete_${id}` }
          ]]
        },
        parse_mode: 'Markdown'
      });
    } catch (e) {
      console.error('Error getting server details for management:', e);
      sendMessage(ch, `❌ خطا در دریافت جزئیات سرور: ${e.message || 'خطای ناشناخته'}`);
    }
  } else if (d.startsWith('A_')) {
    const [_, act, id] = d.split('_');
    try {
      const tok = await getToken();
      let success = false;
      let actionText = '';
      switch (act) {
        case 'start':
          success = await startServer(tok, id);
          actionText = 'شروع';
          break;
        case 'suspend':
          success = await suspendServer(tok, id);
          actionText = 'تعلیق';
          break;
        case 'delete':
          success = await deleteServer(tok, id);
          actionText = 'حذف';
          // Also delete key pair from OpenStack and DB
          if (success) {
            const keyPairInfo = await getKeyPair(id);
            if (keyPairInfo) {
              await deleteKeyPair(tok, keyPairInfo.key_name);
              await deleteKeyPairFromDb(id);
            }
          }
          break;
        default:
          sendMessage(ch, '⚠️ عملیات نامعتبر.');
          return;
      }
      if (success) {
        sendMessage(ch, `✅ عملیات ${actionText} برای سرور با موفقیت ارسال شد.`);
      } else {
        sendMessage(ch, `❌ خطا در انجام عملیات ${actionText} برای سرور.`);
      }
    } catch (e) {
      console.error(`Error performing action ${act} on server ${id}:`, e);
      sendMessage(ch, `❌ خطا در انجام عملیات ${act} برای سرور: ${e.message || 'خطای ناشناخته'}`);
    }
  }
});

// Handler for server name input
async function handleServerNameInput(u, ch, serverName) {
  state[u].serverName = serverName;
  state[u].step = 'CONFIRM_PURCHASE'; // Set step to confirmation

  const { selectedFlavor, selectedImage } = state[u];
  if (!selectedFlavor || !selectedImage) {
    sendMessage(ch, '⚠️ اطلاعات خرید ناقص است. لطفا دوباره از ابتدا شروع کنید.');
    state[u] = { step: 'READY' };
    return;
  }

  const confirmationMessage = `تایید خرید سرور:\n` +
    `🔹 نام سرور: ${serverName}\n` +
    `🔹 نوع سرور: ${selectedFlavor.label}\n` +
    `🔹 سیستم عامل: ${selectedImage.label}\n` +
    `💰 هزینه: ${selectedFlavor.price} تومان\n\n` +
    `آیا از خرید خود مطمئن هستید؟`;

  sendMessage(ch, confirmationMessage, {
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ تایید و خرید', callback_data: 'CONFIRM_PURCHASE' },
        { text: '❌ لغو', callback_data: 'CANCEL_PURCHASE' }
      ]]
    }
  });
}


// Manage servers
bot.onText(/⚙️ مدیریت سرورها/, async msg => {
  const u = msg.from.id, ch = msg.chat.id;
  try {
    const tok = await getToken();
    const all = await listServers(tok);
    const mine = all.filter(s => s.metadata && s.metadata.user === String(u)); // Filter by user metadata
    if (!mine.length) {
      return sendMessage(ch, '🚫 شما هیچ سروری ندارید.');
    }
    const kb = mine.map(s => [{ text: s.name, callback_data: `M_${s.id}` }]);
    sendMessage(ch, '📋 سرور خود را انتخاب کنید:', { reply_markup: { inline_keyboard: kb } });
  } catch (e) {
    console.error('Error listing servers for management:', e);
    sendMessage(ch, `❌ خطا در دریافت لیست سرورها: ${e.message || 'خطای ناشناخته'}`);
  }
});

// Support
bot.onText(/📞 پشتیبانی/, msg => sendMessage(msg.chat.id, '✉️ @HamoonCloudSupport'));

// Fallback for unrecognized messages
bot.on('message', msg => {
  const ch = msg.chat.id, txt = msg.text || '';
  const recognizedCommands = ['🆓 تست رایگان', '🛒 خرید سرور', '💰 افزایش اعتبار', '⚙️ مدیریت سرورها', '📞 پشتیبانی'];
  if (!recognizedCommands.includes(txt) && !msg.contact && !state[msg.from.id]?.step) {
    sendMessage(ch, '❓ لطفاً از منو انتخاب کنید.', mainMenu);
  }
});

// Error handling for polling
bot.on('polling_error', (error) => {
  console.error('Polling error:', error.code, error.message);
});
