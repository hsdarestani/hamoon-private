'use strict';
require('dotenv').config();
const path = require('path');
const express = require('express');
const axios = require('axios');
const db = require('./db');
const { createDashboardApiRouter, requireAuth } = require('./dashboard-api');
const app = express();
const port = Number(process.env.DASHBOARD_PORT || process.env.PORT || 3000);
let dbStatus = 'unknown';
async function checkDb() { try { await db.pingDatabase(); dbStatus = 'ok'; } catch (e) { dbStatus = 'down'; console.warn('[DASHBOARD_DB] database unavailable:', e.code || e.message); } }
setInterval(checkDb, 30000).unref(); checkDb();
app.disable('x-powered-by');
app.get('/health', async (_req,res)=>{ await checkDb(); res.json({ ok:true, app:'dashboard-server', db:dbStatus, time:new Date().toISOString() }); });
app.get('/admin', (_req,res)=>res.redirect(302,'/dashboard'));
app.use('/dashboard/api', createDashboardApiRouter());
const dashboardDir = path.join(__dirname, 'public', 'dashboard');
function requireDashboardPage(req, res, next) {
  return requireAuth(req, { ...res, status(code) { if (code === 401) { res.redirect(302, '/dashboard/login'); return { json() {} }; } return res.status(code); } }, next);
}
app.get(['/dashboard','/dashboard/','/dashboard/index.html'], requireDashboardPage, (_req,res)=>res.sendFile(path.join(dashboardDir,'index.html')));
app.get('/dashboard/login', (_req,res)=>res.sendFile(path.join(dashboardDir,'index.html')));
app.use('/dashboard', express.static(dashboardDir, { index: false, extensions: ['html'] }));
app.get(/^\/dashboard\/(?!api).*/, requireDashboardPage, (_req,res)=>res.sendFile(path.join(dashboardDir,'index.html')));
// Zibal payment callback for wallet top-up.
// Payment links are created in index.js with orderId: telegramId-orderCounter-originalAmount
app.get('/zibal/callback', async (req, res) => {
  const trackId = String(req.query.trackId || req.query.track_id || '').trim();
  const queryOrderId = String(req.query.orderId || req.query.order_id || '').trim();
  const callbackSuccess = String(req.query.success || '').trim();

  const merchant =
    process.env.ZIBAL_MERCHANT ||
    process.env.ZIBAL_MERCHANT_ID ||
    '68985f4ba45c72000bcfd5a2';

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
      {
        merchant,
        trackId: Number(trackId)
      },
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
        [
          trackId,
          orderId,
          telegramId,
          originalAmountToman,
          paidRial || expectedPayableRial,
          Number(v.result),
          JSON.stringify(v)
        ]
      );

      if (insert.affectedRows === 0) {
        await conn.rollback();
        return res.send(html('پرداخت قبلاً ثبت شده', 'این پرداخت قبلاً بررسی و ثبت شده است.'));
      }

      await conn.execute(
        `UPDATE users
         SET wallet = COALESCE(wallet,0) + ?
         WHERE telegram_id = ?`,
        [originalAmountToman, telegramId]
      );

      await conn.execute(
        `INSERT INTO wallet_logs (telegram_id, amount, description, type)
         VALUES (?, ?, ?, ?)`,
        [
          telegramId,
          originalAmountToman,
          `شارژ کیف پول از طریق زیبال - trackId: ${trackId}`,
          'payment'
        ]
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


app.use((_req,res)=>res.status(404).json({ ok:false, error:'NOT_FOUND', message:'مسیر پیدا نشد.' }));



app.listen(port, () => console.log(`[dashboard-server] listening on ${port}; /dashboard route enabled`));
