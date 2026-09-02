'use strict';
require('dotenv').config();
const path = require('path');
const express = require('express');
const axios = require('axios');
const db = require('./db');
const { createDashboardApiRouter, requireAuth } = require('./dashboard-api');
const { createCustomerApiRouter } = require('./customer-api');
const { consumeConsoleSession } = require('./console-session');
const { mountExternalPayments } = require('./external-payments');
const app = express();
const port = Number(process.env.DASHBOARD_PORT || process.env.PORT || 3000);
let dbStatus = 'unknown';
const consoleAttempts = new Map();

async function checkDb() {
  try {
    await db.pingDatabase();
    dbStatus = 'ok';
  } catch (e) {
    dbStatus = 'down';
    console.warn('[DASHBOARD_DB] database unavailable:', e.code || e.message);
  }
}
setInterval(checkDb, 30000).unref();
checkDb();

app.disable('x-powered-by');
app.get('/health', async (_req, res) => {
  await checkDb();
  res.json({ ok: true, app: 'dashboard-server', db: dbStatus, time: new Date().toISOString() });
});
app.get('/admin', (_req, res) => res.redirect(302, '/dashboard'));
app.use('/dashboard/api', createDashboardApiRouter());
app.use('/api/v1', createCustomerApiRouter());
mountExternalPayments(app, { db, axios });

const dashboardDir = path.join(__dirname, 'public', 'dashboard');
const consoleDir = path.join(__dirname, 'public', 'console');
const noVncDir = path.join(__dirname, 'node_modules', '@novnc', 'novnc');

app.use('/dashboard', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

function requireDashboardPage(req, res, next) {
  return requireAuth(req, {
    ...res,
    status(code) {
      if (code === 401) {
        res.redirect(302, '/dashboard/login');
        return { json() {} };
      }
      return res.status(code);
    }
  }, next);
}

function setConsoleSecurityHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  );
}

function allowConsoleExchange(req) {
  const key = String(req.ip || req.socket?.remoteAddress || 'unknown');
  const now = Date.now();
  const recent = (consoleAttempts.get(key) || []).filter(t => now - t < 10 * 60 * 1000);
  if (recent.length >= 60) return false;
  recent.push(now);
  consoleAttempts.set(key, recent);
  return true;
}

app.post('/console/session', express.json({ limit: '2kb' }), async (req, res) => {
  setConsoleSecurityHeaders(res);
  if (req.headers['x-console-request'] !== 'true') {
    return res.status(403).json({ ok: false, error: 'CONSOLE_HEADER_REQUIRED', message: 'درخواست کنسول معتبر نیست.' });
  }
  if (!allowConsoleExchange(req)) {
    return res.status(429).json({ ok: false, error: 'CONSOLE_RATE_LIMITED', message: 'تعداد درخواست‌ها بیش از حد مجاز است.' });
  }

  const token = String(req.body?.token || '').trim();
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) {
    return res.status(400).json({ ok: false, error: 'CONSOLE_TOKEN_INVALID', message: 'لینک کنسول معتبر نیست.' });
  }

  try {
    const data = await consumeConsoleSession(token);
    if (!data) {
      return res.status(410).json({ ok: false, error: 'CONSOLE_SESSION_EXPIRED', message: 'این لینک استفاده شده یا منقضی شده است. از ربات لینک جدید بسازید.' });
    }
    return res.json({ ok: true, data });
  } catch (error) {
    console.error('[CONSOLE_SESSION_EXCHANGE]', { code: error.code || error.message });
    return res.status(500).json({ ok: false, error: 'CONSOLE_SESSION_FAILED', message: 'باز کردن کنسول انجام نشد. از ربات لینک جدید بسازید.' });
  }
});

app.get(['/console', '/console/', '/console/index.html'], (_req, res) => {
  setConsoleSecurityHeaders(res);
  res.sendFile(path.join(consoleDir, 'index.html'));
});
app.use('/console/vendor', express.static(noVncDir, {
  index: false,
  fallthrough: true,
  immutable: true,
  maxAge: '1d'
}));
app.use('/console', express.static(consoleDir, { index: false, extensions: ['html'], maxAge: 0 }));

app.get(['/dashboard', '/dashboard/', '/dashboard/index.html'], requireDashboardPage, (_req, res) => res.sendFile(path.join(dashboardDir, 'index.html')));
app.get('/dashboard/login', (_req, res) => res.sendFile(path.join(dashboardDir, 'index.html')));
app.use('/dashboard', express.static(dashboardDir, { index: false, extensions: ['html'] }));
app.get(/^\/dashboard\/(?!api).*/, requireDashboardPage, (_req, res) => res.sendFile(path.join(dashboardDir, 'index.html')));

// Shaparak/Zibal intermediary page.
// The browser first loads this document on the registered HamoonCloud domain and
// then performs a document-originated navigation to Zibal. A plain server-side
// 302 is intentionally avoided because it can preserve an empty upstream Referer.
app.get('/payment/start/:trackId', (req, res) => {
  const trackId = String(req.params.trackId || '').trim();
  if (!/^\d{1,32}$/.test(trackId)) {
    return res.status(400).type('html').send('<!doctype html><meta charset="utf-8"><title>پرداخت نامعتبر</title><p>شناسه پرداخت معتبر نیست.</p>');
  }

  const gatewayUrl = `https://gateway.zibal.ir/start/${encodeURIComponent(trackId)}`;
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action https://gateway.zibal.ir");
  return res.status(200).type('html').send(`<!doctype html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="origin">
  <title>انتقال به درگاه پرداخت</title>
  <style>
    body{font-family:tahoma,Arial,sans-serif;background:#0f172a;color:#e5e7eb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
    .card{max-width:520px;background:#111827;border:1px solid #334155;border-radius:18px;padding:28px;line-height:2;text-align:center}
    a{color:#93c5fd}
  </style>
</head>
<body>
  <div class="card">
    <p>در حال انتقال امن به درگاه پرداخت...</p>
    <p><a id="continue-payment" href="${gatewayUrl}" rel="noreferrer-unsafe-url">اگر منتقل نشدید اینجا بزنید</a></p>
  </div>
  <script>
    window.setTimeout(function () {
      window.location.assign(${JSON.stringify(gatewayUrl)});
    }, 150);
  </script>
</body>
</html>`);
});

// Zibal payment callback for wallet top-up.
// Payment links are created in index-core.js with orderId: telegramId-orderCounter-originalAmount.
app.get('/zibal/callback', async (req, res) => {
  const trackId = String(req.query.trackId || req.query.track_id || '').trim();
  const queryOrderId = String(req.query.orderId || req.query.order_id || '').trim();
  const callbackSuccess = String(req.query.success || '').trim();
  const merchant = process.env.ZIBAL_MERCHANT_ID || '68985f4ba45c72000bcfd5a2';

  function html(title, message) {
    return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <style>
    body{font-family:tahoma,Arial,sans-serif;background:#0f172a;color:#e5e7eb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
    .card{max-width:520px;background:#111827;border:1px solid #334155;border-radius:18px;padding:28px;line-height:2;text-align:center}
    h1{font-size:24px;margin:0 0 12px}
    p{font-size:16px;margin:0;color:#cbd5e1}
  </style>
</head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body>
</html>`;
  }

  if (!trackId) {
    return res.status(400).send(html('پرداخت نامعتبر', 'شناسه پرداخت دریافت نشد.'));
  }

  try {
    if (callbackSuccess && !['1', 'true', '100'].includes(callbackSuccess.toLowerCase())) {
      return res.status(400).send(html('پرداخت ناموفق', 'پرداخت توسط درگاه تأیید نشد یا توسط کاربر لغو شد.'));
    }

    const verifyRes = await axios.post(
      'https://gateway.zibal.ir/v1/verify',
      { merchant, trackId: Number(trackId) },
      { timeout: 20000 }
    );
    const v = verifyRes.data || {};
    if (Number(v.result) !== 100) {
      console.warn('[ZIBAL_CALLBACK] verify failed:', JSON.stringify(v));
      return res.status(400).send(html('پرداخت ناموفق', 'تراکنش توسط زیبال تأیید نشد.'));
    }

    const orderId = String(v.orderId || queryOrderId || '').trim();
    const match = orderId.match(/^(\d+)-(\d+)-(\d+)$/);
    if (!match) {
      console.error('[ZIBAL_CALLBACK] invalid orderId:', orderId, JSON.stringify(v));
      return res.status(400).send(html('خطای پرداخت', 'اطلاعات سفارش معتبر نیست. لطفاً با پشتیبانی تماس بگیرید.'));
    }

    const telegramId = match[1];
    const originalAmountToman = Number(match[3]);
    const expectedPayableToman = Math.ceil(originalAmountToman * 1.1);
    const expectedPayableRial = expectedPayableToman * 10;
    const paidRial = Number(v.amount || 0);

    if (!Number.isFinite(originalAmountToman) || originalAmountToman < 100) {
      return res.status(400).send(html('خطای پرداخت', 'مبلغ سفارش معتبر نیست.'));
    }
    if (paidRial && paidRial !== expectedPayableRial) {
      console.error('[ZIBAL_CALLBACK] amount mismatch:', { trackId, orderId, paidRial, expectedPayableRial });
      return res.status(400).send(html('خطای پرداخت', 'مبلغ پرداختی با سفارش مطابقت ندارد. لطفاً با پشتیبانی تماس بگیرید.'));
    }

    const conn = await db.pool.getConnection();
    try {
      await conn.query(`
        CREATE TABLE IF NOT EXISTS zibal_payments (
          id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
          track_id VARCHAR(64) NOT NULL UNIQUE,
          order_id VARCHAR(255) NOT NULL,
          telegram_id VARCHAR(64) NOT NULL,
          amount_toman BIGINT NOT NULL,
          paid_rial BIGINT NOT NULL DEFAULT 0,
          verify_result INT NULL,
          verify_payload LONGTEXT NULL,
          credited TINYINT(1) NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await conn.beginTransaction();
      const [insert] = await conn.execute(
        `INSERT IGNORE INTO zibal_payments
          (track_id, order_id, telegram_id, amount_toman, paid_rial, verify_result, verify_payload, credited)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        [trackId, orderId, telegramId, originalAmountToman, paidRial || expectedPayableRial, Number(v.result), JSON.stringify(v)]
      );
      if (insert.affectedRows === 0) {
        await conn.rollback();
        return res.send(html('پرداخت قبلاً ثبت شده', 'این پرداخت قبلاً بررسی و ثبت شده است.'));
      }
      const [walletUpdate] = await conn.execute(
        `UPDATE users SET wallet = COALESCE(wallet,0) + ? WHERE telegram_id = ?`,
        [originalAmountToman, telegramId]
      );
      if (walletUpdate.affectedRows !== 1) throw new Error(`ZIBAL_USER_NOT_FOUND:${telegramId}`);
      await conn.execute(
        `INSERT INTO wallet_logs (telegram_id, amount, description, type) VALUES (?, ?, ?, ?)`,
        [telegramId, originalAmountToman, `شارژ کیف پول از طریق زیبال - trackId: ${trackId}`, 'payment']
      );
      await conn.commit();
      console.log('[ZIBAL_CALLBACK] credited wallet:', { telegramId, originalAmountToman, trackId, orderId });
      return res.send(html('پرداخت موفق', `کیف پول شما به مبلغ ${originalAmountToman.toLocaleString('fa-IR')} تومان شارژ شد. می‌توانید به ربات برگردید.`));
    } catch (e) {
      try { await conn.rollback(); } catch {}
      console.error('[ZIBAL_CALLBACK] db error:', e.code || e.message);
      return res.status(500).send(html('خطای ثبت پرداخت', 'پرداخت تأیید شد اما ثبت آن با خطا مواجه شد. لطفاً با پشتیبانی تماس بگیرید.'));
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error('[ZIBAL_CALLBACK] fatal:', e.response?.data || e.message);
    return res.status(500).send(html('خطای بررسی پرداخت', 'امکان بررسی پرداخت وجود ندارد. لطفاً چند دقیقه بعد با پشتیبانی تماس بگیرید.'));
  }
});

app.use((_req, res) => res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'مسیر پیدا نشد.' }));
app.listen(port, () => console.log(`[dashboard-server] listening on ${port}; /dashboard and /console routes enabled`));