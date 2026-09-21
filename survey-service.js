'use strict';

const db = require('./db');

const SURVEY_VERSION = 'services_2026_09';
const REWARD_AMOUNT = 50000;
const BROADCAST_BATCH_SIZE = 250;
const BROADCAST_DELAY_MS = 90;

let runtime = null;
let schemaPromise = null;
let broadcastScheduled = false;

const QUESTIONS = {
  1: {
    title: 'سؤال ۱ از ۵\n\nبیشتر از سرورهای HamoonCloud برای چه کارهایی استفاده می‌کنید؟\n\nمی‌توانید چند گزینه را انتخاب کنید:',
    mode: 'multi',
    options: [
      ['vpn', '🌐 VPN / Proxy'],
      ['telegram_bot', '🤖 ربات تلگرام'],
      ['website', '💻 وب‌سایت / فروشگاه'],
      ['api_backend', '🔌 API / Backend'],
      ['trading', '📊 ترید و بازار مالی'],
      ['automation', '⚙️ اتوماسیون / اسکریپت'],
      ['scraping', '🕷 Scraping / Crawler'],
      ['rdp', '🖥 Remote Desktop'],
      ['ai', '🧠 AI / هوش مصنوعی'],
      ['game', '🎮 Game Server'],
      ['storage', '💾 Storage / Backup'],
      ['resale', '🛒 فروش سرویس به مشتری'],
      ['company', '🏢 استفاده شرکتی'],
      ['other', '➕ سایر موارد']
    ]
  },
  2: {
    title: 'سؤال ۲ از ۵\n\nکدام گزینه بیشتر شما را توصیف می‌کند؟',
    mode: 'single',
    options: [
      ['personal', '👤 مصرف شخصی'],
      ['developer', '👨‍💻 برنامه‌نویس / متخصص فنی'],
      ['freelancer', '💼 فریلنسر'],
      ['startup', '🚀 صاحب کسب‌وکار / استارتاپ'],
      ['company', '🏢 شرکت / سازمان'],
      ['reseller', '🛒 فروشنده / Reseller'],
      ['trader', '📈 فعال بازارهای مالی'],
      ['marketing', '📣 آژانس / تیم مارکتینگ'],
      ['other', '🎯 مورد دیگر']
    ]
  },
  3: {
    title: 'سؤال ۳ از ۵\n\nدر حال حاضر برای کدام سرویس‌های دیجیتال هزینه می‌کنید یا احتمال دارد در آینده هزینه کنید؟\n\nمی‌توانید چند گزینه را انتخاب کنید:',
    mode: 'multi',
    options: [
      ['security', '🛡 امنیت سایبری'],
      ['monitoring', '📡 Monitoring'],
      ['apis', '🔌 APIها'],
      ['api_marketplace', '🛒 API Marketplace'],
      ['ai_tools', '🤖 ابزارهای AI'],
      ['automation', '⚙️ Automation'],
      ['backup', '💾 Backup / Cloud Storage'],
      ['webinfra', '🌐 Domain / DNS / CDN'],
      ['email', '📧 Email'],
      ['messaging', '📱 SMS / OTP / Notification'],
      ['secrets', '🔐 Password / Secret Management'],
      ['analytics', '📊 Analytics / Reporting'],
      ['devtools', '🧑‍💻 Developer Tools'],
      ['payments', '💳 پرداخت و سرویس‌های مالی'],
      ['business', '🏢 ابزارهای کسب‌وکار'],
      ['crm', '👥 CRM'],
      ['marketing', '📣 ابزارهای مارکتینگ'],
      ['none', '🚫 هیچ‌کدام'],
      ['other', '➕ سایر موارد']
    ]
  },
  4: {
    title: 'سؤال ۴ از ۵\n\nاگر HamoonCloud سرویس‌های جدیدی ارائه کند، کدام دسته‌ها برایتان جذاب‌تر هستند؟\n\nحداکثر ۵ گزینه را انتخاب کنید:',
    mode: 'multi',
    max: 5,
    options: [
      ['security', '🛡 Security'],
      ['monitoring', '📡 Monitoring'],
      ['api_marketplace', '🔌 API Marketplace'],
      ['ai_services', '🤖 AI Services'],
      ['automation', '⚙️ Automation'],
      ['backup', '💾 Cloud Backup & Storage'],
      ['messaging', '📱 Messaging Services'],
      ['webinfra', '🌐 Web Infrastructure'],
      ['devtools', '👨‍💻 Developer Tools'],
      ['business', '🏢 Business Tools'],
      ['reseller', '🛒 Reseller Services'],
      ['payments', '💳 Payment & Financial APIs'],
      ['privacy', '🔐 Privacy & Identity'],
      ['other', '➕ حوزه دیگر']
    ]
  },
  5: {
    title: 'سؤال ۵ از ۵\n\nچه سرویس یا ابزاری الان برای کارتان نیاز دارید ولی پیدا کردن یک سرویس خوب، مطمئن یا با قیمت مناسب برای آن سخت است؟\n\n✍️ پاسخ شما اختیاری است؛ می‌توانید متن بنویسید یا «رد کردن» را بزنید.',
    mode: 'text'
  }
};

function configure(ctx) {
  runtime = ctx || null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseAnswers(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

async function ensureSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    await db.pool.execute(`
      CREATE TABLE IF NOT EXISTS user_surveys (
        telegram_id VARCHAR(255) NOT NULL,
        survey_version VARCHAR(64) NOT NULL,
        current_step TINYINT NOT NULL DEFAULT 1,
        answers_json JSON NULL,
        started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        completed_at DATETIME NULL,
        reward_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
        rewarded_at DATETIME NULL,
        PRIMARY KEY (telegram_id, survey_version),
        INDEX idx_survey_completed (survey_version, completed_at)
      )
    `);
    await db.pool.execute(`
      CREATE TABLE IF NOT EXISTS survey_invites (
        telegram_id VARCHAR(255) NOT NULL,
        survey_version VARCHAR(64) NOT NULL,
        invite_status VARCHAR(24) NOT NULL DEFAULT 'sending',
        attempted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        sent_at DATETIME NULL,
        error_text VARCHAR(255) NULL,
        PRIMARY KEY (telegram_id, survey_version),
        INDEX idx_survey_invite_status (survey_version, invite_status)
      )
    `);
  })().catch(error => {
    schemaPromise = null;
    throw error;
  });
  return schemaPromise;
}

async function getProgress(userId) {
  await ensureSchema();
  const [rows] = await db.pool.execute(
    'SELECT * FROM user_surveys WHERE telegram_id = ? AND survey_version = ? LIMIT 1',
    [String(userId), SURVEY_VERSION]
  );
  return rows[0] || null;
}

async function hasInvite(userId) {
  await ensureSchema();
  const [rows] = await db.pool.execute(
    'SELECT invite_status FROM survey_invites WHERE telegram_id = ? AND survey_version = ? LIMIT 1',
    [String(userId), SURVEY_VERSION]
  );
  return rows.length > 0;
}

async function ensureProgress(userId) {
  await ensureSchema();
  await db.pool.execute(
    `INSERT IGNORE INTO user_surveys
      (telegram_id, survey_version, current_step, answers_json, reward_amount)
     VALUES (?, ?, 1, JSON_OBJECT(), ?)`,
    [String(userId), SURVEY_VERSION, REWARD_AMOUNT]
  );
  return getProgress(userId);
}

async function saveProgress(userId, step, answers) {
  await db.pool.execute(
    `UPDATE user_surveys
     SET current_step = ?, answers_json = ?, updated_at = CURRENT_TIMESTAMP
     WHERE telegram_id = ? AND survey_version = ? AND completed_at IS NULL`,
    [Number(step), JSON.stringify(answers || {}), String(userId), SURVEY_VERSION]
  );
}

function selectedForStep(answers, step) {
  const value = answers[String(step)];
  return Array.isArray(value) ? value : [];
}

function keyboardForStep(step, answers) {
  const q = QUESTIONS[step];
  if (!q) return [];
  if (q.mode === 'text') {
    return [[{ text: '⏭ رد کردن این سؤال', callback_data: 'SV:SKIP' }]];
  }

  const selected = new Set(
    q.mode === 'multi'
      ? selectedForStep(answers, step)
      : (answers[String(step)] ? [answers[String(step)]] : [])
  );

  const buttons = q.options.map(([code, label]) => ({
    text: `${selected.has(code) ? '✅ ' : ''}${label}`,
    callback_data: `SV:${q.mode === 'multi' ? 'T' : 'S'}:${step}:${code}`
  }));

  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  if (q.mode === 'multi') rows.push([{ text: 'ادامه ➡️', callback_data: `SV:N:${step}` }]);
  return rows;
}

async function sendOrEdit(chatId, messageId, text, replyMarkup) {
  if (!runtime?.bot) throw new Error('SURVEY_RUNTIME_NOT_CONFIGURED');
  const options = { reply_markup: { inline_keyboard: replyMarkup } };
  if (messageId) {
    try {
      return await runtime.bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        ...options
      });
    } catch (error) {
      const desc = String(error?.response?.body?.description || error?.message || '');
      if (/message is not modified/i.test(desc)) return null;
      console.warn('[SURVEY_EDIT_FALLBACK]', { chat_id: String(chatId), message: desc });
    }
  }
  return runtime.bot.sendMessage(chatId, text, options);
}

async function renderStep(userId, chatId, messageId = null) {
  const progress = await ensureProgress(userId);
  if (progress.completed_at) return false;
  const step = Math.min(5, Math.max(1, Number(progress.current_step || 1)));
  const answers = parseAnswers(progress.answers_json);
  await sendOrEdit(chatId, messageId, QUESTIONS[step].title, keyboardForStep(step, answers));
  return true;
}

async function finalizeReward(userId, freeText, chatId) {
  await ensureSchema();
  const conn = await db.pool.getConnection();
  let rewarded = false;
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      'SELECT * FROM user_surveys WHERE telegram_id = ? AND survey_version = ? LIMIT 1 FOR UPDATE',
      [String(userId), SURVEY_VERSION]
    );
    if (!rows.length) throw new Error('SURVEY_PROGRESS_NOT_FOUND');

    const row = rows[0];
    if (!row.completed_at) {
      const answers = parseAnswers(row.answers_json);
      answers['5'] = freeText ? String(freeText).slice(0, 1500) : null;

      const [walletUpdate] = await conn.execute(
        'UPDATE users SET wallet = wallet + ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?',
        [REWARD_AMOUNT, String(userId)]
      );
      if (!walletUpdate.affectedRows) throw new Error('SURVEY_USER_NOT_FOUND');

      await conn.execute(
        'INSERT INTO wallet_logs (telegram_id, amount, description, type) VALUES (?, ?, ?, ?)',
        [
          String(userId),
          REWARD_AMOUNT,
          `هدیه تکمیل نظرسنجی HamoonCloud - ${SURVEY_VERSION}`,
          'survey_reward'
        ]
      );

      await conn.execute(
        `UPDATE user_surveys
         SET answers_json = ?, current_step = 5, completed_at = CURRENT_TIMESTAMP,
             reward_amount = ?, rewarded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE telegram_id = ? AND survey_version = ?`,
        [JSON.stringify(answers), REWARD_AMOUNT, String(userId), SURVEY_VERSION]
      );
      rewarded = true;
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }

  if (rewarded) {
    await runtime.bot.sendMessage(
      chatId,
      '🎉 ممنون از مشارکت شما!\n\n✅ نظرسنجی با موفقیت ثبت شد.\n🎁 ۵۰,۰۰۰ تومان اعتبار هدیه به کیف پول شما اضافه شد.\n\nپاسخ‌های شما مستقیماً در انتخاب سرویس‌های جدید HamoonCloud استفاده می‌شود.'
    );
  } else {
    await runtime.bot.sendMessage(chatId, '✅ این نظرسنجی قبلاً توسط شما تکمیل شده و اعتبار آن دریافت شده است.');
  }

  if (typeof runtime?.showMainMenu === 'function') {
    await runtime.showMainMenu(chatId, String(userId));
  }
  return rewarded;
}

async function handleCallback({ query, userId, chatId }) {
  if (!runtime?.bot) return false;
  const progress = await getProgress(userId);
  const invited = progress || await hasInvite(userId);
  if (!invited) return false;
  if (progress?.completed_at) return false;

  const data = String(query?.data || '');
  const messageId = query?.message?.message_id || null;

  if (!data.startsWith('SV:')) {
    await renderStep(userId, chatId, null);
    return true;
  }

  const row = await ensureProgress(userId);
  const answers = parseAnswers(row.answers_json);

  if (data === 'SV:START') {
    await renderStep(userId, chatId, messageId);
    return true;
  }

  if (data === 'SV:SKIP') {
    if (Number(row.current_step || 1) !== 5) {
      await renderStep(userId, chatId, messageId);
      return true;
    }
    await finalizeReward(userId, null, chatId);
    return true;
  }

  const parts = data.split(':');
  const action = parts[1];
  const step = Number(parts[2]);
  const code = parts[3] || '';
  const q = QUESTIONS[step];
  if (!q || Number(row.current_step || 1) !== step) {
    await renderStep(userId, chatId, messageId);
    return true;
  }

  const validCodes = new Set((q.options || []).map(([optionCode]) => optionCode));

  if (action === 'T' && q.mode === 'multi' && validCodes.has(code)) {
    let selected = selectedForStep(answers, step);
    if (selected.includes(code)) {
      selected = selected.filter(x => x !== code);
    } else {
      if (q.max && selected.length >= q.max) {
        await runtime.bot.sendMessage(chatId, `⚠️ برای این سؤال حداکثر ${q.max} گزینه می‌توانید انتخاب کنید.`);
        return true;
      }
      if (code === 'none') selected = ['none'];
      else {
        selected = selected.filter(x => x !== 'none');
        selected.push(code);
      }
    }
    answers[String(step)] = selected;
    await saveProgress(userId, step, answers);
    await sendOrEdit(chatId, messageId, q.title, keyboardForStep(step, answers));
    return true;
  }

  if (action === 'N' && q.mode === 'multi') {
    const selected = selectedForStep(answers, step);
    if (!selected.length) {
      await runtime.bot.sendMessage(chatId, '⚠️ لطفاً حداقل یک گزینه را انتخاب کنید.');
      return true;
    }
    const nextStep = step + 1;
    await saveProgress(userId, nextStep, answers);
    await renderStep(userId, chatId, messageId);
    return true;
  }

  if (action === 'S' && q.mode === 'single' && validCodes.has(code)) {
    answers[String(step)] = code;
    await saveProgress(userId, step + 1, answers);
    await renderStep(userId, chatId, messageId);
    return true;
  }

  await renderStep(userId, chatId, messageId);
  return true;
}

async function handleMessage({ msg, userId, chatId }) {
  if (!runtime?.bot) return false;
  const progress = await getProgress(userId);
  const invited = progress || await hasInvite(userId);
  if (!invited || progress?.completed_at) return false;

  const row = progress || await ensureProgress(userId);
  const step = Number(row.current_step || 1);
  const text = String(msg?.text || '').trim();

  if (step === 5 && text && !text.startsWith('/')) {
    await finalizeReward(userId, text, chatId);
    return true;
  }

  await renderStep(userId, chatId, null);
  return true;
}

function invitationText() {
  return [
    '🎁 ۵۰,۰۰۰ تومان اعتبار هدیه دریافت کنید',
    '',
    'ما در حال توسعه سرویس‌ها و محصولات جدید HamoonCloud هستیم و می‌خواهیم آن‌ها را بر اساس نیاز واقعی کاربران بسازیم.',
    '',
    'برای ادامه استفاده از ربات، لطفاً این نظرسنجی کوتاه را تکمیل کنید.',
    '⏱ زمان تکمیل: کمتر از یک دقیقه',
    '',
    'بعد از ثبت پاسخ‌ها، ۵۰ هزار تومان اعتبار به کیف پول شما اضافه می‌شود.'
  ].join('\n');
}

async function claimInvite(userId) {
  try {
    const [result] = await db.pool.execute(
      `INSERT INTO survey_invites
       (telegram_id, survey_version, invite_status, attempted_at)
       VALUES (?, ?, 'sending', CURRENT_TIMESTAMP)`,
      [String(userId), SURVEY_VERSION]
    );
    return result.affectedRows > 0;
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') return false;
    throw error;
  }
}

async function sendInvitation(userId) {
  if (!await claimInvite(userId)) return { status: 'duplicate' };
  try {
    await runtime.bot.sendMessage(String(userId), invitationText(), {
      reply_markup: {
        inline_keyboard: [[{ text: 'شروع نظرسنجی 🚀', callback_data: 'SV:START' }]]
      }
    });
    await db.pool.execute(
      `UPDATE survey_invites
       SET invite_status = 'sent', sent_at = CURRENT_TIMESTAMP, error_text = NULL
       WHERE telegram_id = ? AND survey_version = ?`,
      [String(userId), SURVEY_VERSION]
    );
    return { status: 'sent' };
  } catch (error) {
    const description = String(error?.response?.body?.description || error?.message || 'send_failed').slice(0, 255);
    await db.pool.execute(
      `UPDATE survey_invites
       SET invite_status = 'failed', error_text = ?
       WHERE telegram_id = ? AND survey_version = ?`,
      [description, String(userId), SURVEY_VERSION]
    ).catch(() => {});
    return { status: 'failed', error: description };
  }
}

async function broadcastInvites() {
  if (!runtime?.bot) throw new Error('SURVEY_RUNTIME_NOT_CONFIGURED');
  await ensureSchema();

  const summary = { eligible: 0, sent: 0, failed: 0, skipped: 0 };
  for (;;) {
    const [users] = await db.pool.query(
      `SELECT u.telegram_id
       FROM users u
       LEFT JOIN survey_invites i
         ON i.telegram_id = u.telegram_id AND i.survey_version = ?
       WHERE i.telegram_id IS NULL
       ORDER BY u.created_at ASC
       LIMIT ${BROADCAST_BATCH_SIZE}`,
      [SURVEY_VERSION]
    );

    if (!users.length) break;
    summary.eligible += users.length;

    for (const user of users) {
      const result = await sendInvitation(user.telegram_id);
      if (result.status === 'sent') summary.sent += 1;
      else if (result.status === 'failed') summary.failed += 1;
      else summary.skipped += 1;
      await sleep(BROADCAST_DELAY_MS);
    }

    console.log('[SURVEY_BROADCAST_PROGRESS]', { ...summary, version: SURVEY_VERSION });
    if (users.length < BROADCAST_BATCH_SIZE) break;
  }

  console.log('[SURVEY_BROADCAST_DONE]', { ...summary, version: SURVEY_VERSION });
  return summary;
}

function startBroadcast() {
  if (broadcastScheduled) return false;
  broadcastScheduled = true;
  const timer = setTimeout(() => {
    broadcastInvites().catch(error => {
      console.error('[SURVEY_BROADCAST_FAILED]', {
        version: SURVEY_VERSION,
        message: error?.message || String(error)
      });
    });
  }, 8000);
  timer.unref();
  return true;
}

module.exports = {
  SURVEY_VERSION,
  REWARD_AMOUNT,
  configure,
  ensureSchema,
  startBroadcast,
  broadcastInvites,
  handleCallback,
  handleMessage,
  renderStep,
  finalizeReward
};
