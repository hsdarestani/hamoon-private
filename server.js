'use strict';
require('dotenv').config();
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const db = require('./db');
const { createDashboardApiRouter, requireAuth } = require('./dashboard-api');
const { createCustomerApiRouter } = require('./customer-api');
const app = express();

// --- HAMOON MULTILAYER APP FIREWALL v1 ---
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

const hamoonLayerLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'تعداد تلاش بیش از حد مجاز است.' }
});

const hamoonLayerApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 180,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'درخواست‌های بیش از حد مجاز.' }
});

const hamoonLayerPaymentLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/dashboard/login', hamoonLayerLoginLimiter);
app.use('/dashboard/api/login', hamoonLayerLoginLimiter);
app.use('/dashboard/api', hamoonLayerApiLimiter);
app.use('/api/v1', hamoonLayerApiLimiter);
app.use('/zibal/callback', hamoonLayerPaymentLimiter);
// --- END HAMOON MULTILAYER APP FIREWALL ---


// --- HARDENED ZIBAL CALLBACK v2026-07-18 ---
function zibalSafeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function zibalPage(title, msg, ok = false) {
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${zibalSafeHtml(title)}</title><style>body{font-family:tahoma,Arial,sans-serif;background:#f8fafc;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}.card{background:#fff;border-radius:18px;box-shadow:0 10px 30px rgba(15,23,42,.12);padding:28px;max-width:560px;width:calc(100% - 32px);text-align:center}.icon{font-size:42px;margin-bottom:12px}h1{color:${ok ? '#16a34a' : '#dc2626'};font-size:22px;margin:0 0 12px}p{color:#334155;line-height:1.9;font-size:15px;white-space:pre-line}.muted{color:#64748b;font-size:13px;margin-top:18px}.btn{display:inline-block;margin-top:12px;background:#111827;color:white;text-decoration:none;padding:11px 18px;border-radius:12px}</style></head><body><div class="card"><div class="icon">${ok ? '✅' : '❌'}</div><h1>${zibalSafeHtml(title)}</h1><p>${zibalSafeHtml(msg)}</p><a class="btn" href="https://t.me/HamoonCloudBot">بازگشت به ربات</a><div class="muted">Hamoon Cloud</div></div></body></html>`;
}

async function ensureZibalTables() {
  await db.pool.execute(`
    CREATE TABLE IF NOT EXISTS payment_transactions (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      provider VARCHAR(32) NOT NULL,
      track_id VARCHAR(64) NOT NULL,
      order_id VARCHAR(191) NULL,
      telegram_id VARCHAR(64) NULL,
      amount DECIMAL(18,2) NOT NULL DEFAULT 0,
      payable_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      raw_response LONGTEXT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      paid_at DATETIME NULL,
      UNIQUE KEY uniq_payment_provider_track (provider, track_id)
    )
  `);

  const columns = [
    ['order_id', 'VARCHAR(191) NULL'],
    ['telegram_id', 'VARCHAR(64) NULL'],
    ['amount', 'DECIMAL(18,2) NOT NULL DEFAULT 0'],
    ['payable_amount', 'DECIMAL(18,2) NOT NULL DEFAULT 0'],
    ['status', "VARCHAR(32) NOT NULL DEFAULT 'pending'"],
    ['raw_response', 'LONGTEXT NULL'],
    ['paid_at', 'DATETIME NULL'],
    ['updated_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP']
  ];

  for (const [column, definition] of columns) {
    const [rows] = await db.pool.execute(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='payment_transactions' AND COLUMN_NAME=?`,
      [column]
    );
    if (!rows.length) {
      await db.pool.execute(`ALTER TABLE payment_transactions ADD COLUMN ${column} ${definition}`);
    }
  }

  const [indexes] = await db.pool.execute(
    `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='payment_transactions' AND INDEX_NAME='uniq_payment_provider_track'`
  );
  if (!indexes.length) {
    await db.pool.execute(`ALTER TABLE payment_transactions ADD UNIQUE KEY uniq_payment_provider_track (provider, track_id)`);
  }
}

async function notifyZibalPayment(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return;
  try {
    await require('axios').post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: String(chatId),
      text
    }, { timeout: 10000 });
  } catch (error) {
    console.warn('[ZIBAL_CALLBACK] telegram notify failed:', error.response?.status || error.code || error.message);
  }
}

app.all('/zibal/callback', async (req, res) => {
  const query = req.query || {};
  const trackIdText = String(query.trackId || query.track_id || '').trim();
  const callbackOrderId = String(query.orderId || query.order_id || '').trim();

  if (!/^\d+$/.test(trackIdText)) {
    return res.status(400).send(zibalPage('پرداخت نامعتبر', 'شناسه تراکنش معتبر دریافت نشد.'));
  }

  const trackId = Number(trackIdText);
  if (!Number.isSafeInteger(trackId) || trackId <= 0) {
    return res.status(400).send(zibalPage('پرداخت نامعتبر', 'شناسه تراکنش خارج از محدوده معتبر است.'));
  }

  const merchant = String(
    process.env.ZIBAL_MERCHANT ||
    process.env.ZIBAL_MERCHANT_ID ||
    process.env.ZIBAL_MERCHANT_KEY ||
    ''
  ).trim();

  if (!merchant) {
    console.error('[ZIBAL_CALLBACK] merchant is not configured');
    return res.status(500).send(zibalPage('خطای تنظیمات پرداخت', 'تنظیمات پذیرنده پرداخت روی سرور کامل نیست.'));
  }

  try {
    await ensureZibalTables();

    const verifyResponse = await require('axios').post('https://gateway.zibal.ir/v1/verify', {
      merchant,
      trackId
    }, {
      timeout: 20000,
      headers: { 'Content-Type': 'application/json' }
    });

    const data = verifyResponse.data || {};
    const resultCode = Number(data.result);
    const gatewayOrderId = String(data.orderId || '').trim();
    const gatewayAmountRial = Number(data.amount || 0);

    console.log('[ZIBAL_CALLBACK] verify', {
      trackId: trackIdText,
      result: resultCode,
      status: Number(data.status),
      refNumber: data.refNumber || null
    });

    if (![100, 201].includes(resultCode)) {
      await db.pool.execute(
        `INSERT INTO payment_transactions (provider, track_id, order_id, amount, payable_amount, status, raw_response)
         VALUES ('zibal', ?, ?, 0, 0, 'failed', ?)
         ON DUPLICATE KEY UPDATE status='failed', raw_response=VALUES(raw_response), updated_at=NOW()`,
        [trackIdText, gatewayOrderId || callbackOrderId || null, JSON.stringify(data)]
      );
      return res.status(400).send(zibalPage('پرداخت ناموفق', data.message || 'پرداخت توسط درگاه تأیید نشد.'));
    }

    if (!gatewayOrderId) {
      console.error('[ZIBAL_CALLBACK] successful verify without orderId', { trackId: trackIdText, resultCode });
      return res.status(400).send(zibalPage('خطای سفارش', 'درگاه شناسه سفارش معتبر برنگرداند. لطفاً با پشتیبانی تماس بگیرید.'));
    }

    if (callbackOrderId && callbackOrderId !== gatewayOrderId) {
      console.error('[ZIBAL_CALLBACK] orderId mismatch', { trackId: trackIdText });
      return res.status(400).send(zibalPage('خطای تطبیق پرداخت', 'شناسه سفارش با اطلاعات درگاه مطابقت ندارد.'));
    }

    const match = gatewayOrderId.match(/^(\d+)-([^-]+)-(\d+)$/);
    if (!match) {
      console.error('[ZIBAL_CALLBACK] invalid gateway orderId format', { trackId: trackIdText });
      return res.status(400).send(zibalPage('خطای سفارش', 'ساختار شناسه سفارش نامعتبر است. لطفاً با پشتیبانی تماس بگیرید.'));
    }

    const telegramId = String(match[1]);
    const creditToman = Number(match[3]);
    if (!Number.isSafeInteger(creditToman) || creditToman <= 0) {
      return res.status(400).send(zibalPage('خطای مبلغ', 'مبلغ کیف پول معتبر نیست.'));
    }

    const expectedPayableToman = Math.ceil(creditToman * 1.1);
    const expectedPayableRial = expectedPayableToman * 10;
    if (!Number.isSafeInteger(gatewayAmountRial) || gatewayAmountRial !== expectedPayableRial) {
      console.error('[ZIBAL_CALLBACK] amount mismatch', {
        trackId: trackIdText,
        expectedPayableRial,
        gatewayAmountRial
      });
      await db.pool.execute(
        `INSERT INTO payment_transactions (provider, track_id, order_id, telegram_id, amount, payable_amount, status, raw_response)
         VALUES ('zibal', ?, ?, ?, ?, ?, 'amount_mismatch', ?)
         ON DUPLICATE KEY UPDATE status='amount_mismatch', raw_response=VALUES(raw_response), updated_at=NOW()`,
        [trackIdText, gatewayOrderId, telegramId, creditToman, gatewayAmountRial / 10, JSON.stringify(data)]
      );
      return res.status(400).send(zibalPage('خطای تطبیق مبلغ', 'مبلغ پرداخت‌شده با مبلغ سفارش مطابقت ندارد.'));
    }

    const connection = await db.pool.getConnection();
    let alreadyPaid = false;
    try {
      await connection.beginTransaction();

      const [existing] = await connection.execute(
        `SELECT id, status FROM payment_transactions WHERE provider='zibal' AND track_id=? FOR UPDATE`,
        [trackIdText]
      );

      if (existing.length && existing[0].status === 'paid') {
        alreadyPaid = true;
      } else {
        await connection.execute(
          `INSERT INTO payment_transactions (provider, track_id, order_id, telegram_id, amount, payable_amount, status, raw_response, paid_at)
           VALUES ('zibal', ?, ?, ?, ?, ?, 'paid', ?, NOW())
           ON DUPLICATE KEY UPDATE
             order_id=VALUES(order_id),
             telegram_id=VALUES(telegram_id),
             amount=VALUES(amount),
             payable_amount=VALUES(payable_amount),
             status='paid',
             raw_response=VALUES(raw_response),
             paid_at=COALESCE(paid_at, NOW()),
             updated_at=NOW()`,
          [trackIdText, gatewayOrderId, telegramId, creditToman, expectedPayableToman, JSON.stringify(data)]
        );

        await connection.execute(
          `INSERT INTO users (telegram_id, wallet, step)
           VALUES (?, ?, 'READY')
           ON DUPLICATE KEY UPDATE wallet = wallet + VALUES(wallet), updated_at = CURRENT_TIMESTAMP`,
          [telegramId, creditToman]
        );

        await connection.execute(
          `INSERT INTO wallet_logs (telegram_id, amount, description, type)
           VALUES (?, ?, ?, 'deposit')`,
          [telegramId, creditToman, `شارژ کیف پول از زیبال - trackId ${trackIdText}`]
        );
      }

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    if (!alreadyPaid) {
      await notifyZibalPayment(
        telegramId,
        `✅ پرداخت شما تأیید شد.\n💰 مبلغ ${creditToman.toLocaleString('fa-IR')} تومان به کیف پول شما اضافه شد.`
      );
    }

    return res.send(zibalPage(
      alreadyPaid ? 'پرداخت قبلاً ثبت شده' : 'پرداخت موفق',
      alreadyPaid
        ? 'این تراکنش قبلاً تأیید و ثبت شده بود.'
        : `کیف پول شما به مبلغ ${creditToman.toLocaleString('fa-IR')} تومان شارژ شد.`,
      true
    ));
  } catch (error) {
    console.error('[ZIBAL_CALLBACK] fatal:', error.response?.status || error.code || error.message);
    return res.status(500).send(zibalPage('خطای ثبت پرداخت', 'پرداخت بررسی شد اما ثبت آن با خطا مواجه شد. لطفاً با پشتیبانی تماس بگیرید.'));
  }
});
// --- END HARDENED ZIBAL CALLBACK ---

const port = Number(process.env.DASHBOARD_PORT || process.env.PORT || 3000);
let dbStatus = 'unknown';
async function checkDb() { try { await db.pingDatabase(); dbStatus = 'ok'; } catch (e) { dbStatus = 'down'; console.warn('[DASHBOARD_DB] database unavailable:', e.code || e.message); } }
setInterval(checkDb, 30000).unref(); checkDb();
app.disable('x-powered-by');
app.get('/health', async (_req,res)=>{ await checkDb(); res.json({ ok:true, app:'dashboard-server', db:dbStatus, time:new Date().toISOString() }); });
app.get('/admin', (_req,res)=>res.redirect(302,'/dashboard'));
app.use('/dashboard/api', createDashboardApiRouter());
app.use('/api/v1', createCustomerApiRouter());
const dashboardDir = path.join(__dirname, 'public', 'dashboard');
function requireDashboardPage(req, res, next) {
  return requireAuth(req, { ...res, status(code) { if (code === 401) { res.redirect(302, '/dashboard/login'); return { json() {} }; } return res.status(code); } }, next);
}
app.get(['/dashboard','/dashboard/','/dashboard/index.html'], requireDashboardPage, (_req,res)=>res.sendFile(path.join(dashboardDir,'index.html')));
app.get('/dashboard/login', (_req,res)=>res.sendFile(path.join(dashboardDir,'index.html')));
app.use('/dashboard', express.static(dashboardDir, { index: false, extensions: ['html'] }));
app.get(/^\/dashboard\/(?!api).*/, requireDashboardPage, (_req,res)=>res.sendFile(path.join(dashboardDir,'index.html')));

// Duplicate Zibal callback removed; the hardened handler above is authoritative.

app.use((_req,res)=>res.status(404).json({ ok:false, error:'NOT_FOUND', message:'مسیر پیدا نشد.' }));
app.listen(port, '127.0.0.1', () => console.log(`[dashboard-server] listening on ${port}; /dashboard route enabled`));
