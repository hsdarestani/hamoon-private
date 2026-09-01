'use strict';
const crypto = require('crypto');

const PLANS = Object.freeze({
  '1m': { amountToman: 490000, label: 'اشتراک یک‌ماهه وستالند' },
  '3m': { amountToman: 1290000, label: 'اشتراک سه‌ماهه وستالند' },
  '6m': { amountToman: 2190000, label: 'اشتراک شش‌ماهه وستالند' }
});
const START_BUCKETS = new Map();

function validIntent(value) {
  return /^[A-Za-z0-9_-]{20,128}$/.test(String(value || ''));
}
function validReceipt(value) {
  return /^[a-f0-9]{24,64}$/.test(String(value || ''));
}
function allowStart(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.ip || 'unknown').split(',')[0].trim();
  const bucket = `${ip}:${Math.floor(Date.now() / 600000)}`;
  const n = (START_BUCKETS.get(bucket) || 0) + 1;
  START_BUCKETS.set(bucket, n);
  if (START_BUCKETS.size > 3000) {
    const current = Math.floor(Date.now() / 600000);
    for (const key of START_BUCKETS.keys()) if (!key.endsWith(`:${current}`)) START_BUCKETS.delete(key);
  }
  return n <= 20;
}
function returnUrl(status, row) {
  const base = process.env.VESTALAND_RETURN_URL || 'https://vestaland.smarbiz.sbs/';
  const u = new URL(base);
  u.searchParams.set('payment', status);
  if (row?.receipt) u.searchParams.set('receipt', row.receipt);
  if (row?.external_ref) u.searchParams.set('intent', row.external_ref);
  return u.toString();
}
function errorPage(title, message) {
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:tahoma,Arial,sans-serif;background:#f7f7f8;color:#222;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.card{width:min(88vw,440px);background:#fff;border:1px solid #eee;border-radius:18px;padding:26px;text-align:center;line-height:2}h1{font-size:20px;margin:0 0 8px}p{color:#666;margin:0}</style></head><body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}
async function ensureTable(db) {
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS external_payments (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      receipt VARCHAR(64) NOT NULL UNIQUE,
      app VARCHAR(32) NOT NULL,
      external_ref VARCHAR(160) NOT NULL,
      plan VARCHAR(16) NOT NULL,
      amount_toman BIGINT NOT NULL,
      amount_rial BIGINT NOT NULL,
      order_id VARCHAR(128) NOT NULL UNIQUE,
      track_id VARCHAR(64) NULL UNIQUE,
      status VARCHAR(24) NOT NULL DEFAULT 'pending',
      verify_payload LONGTEXT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      paid_at DATETIME NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_external_payments_ref (app, external_ref),
      INDEX idx_external_payments_status (status, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

function mountExternalPayments(app, { db, axios }) {
  app.get('/payments/vestaland/start', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!allowStart(req)) return res.status(429).send(errorPage('درخواست زیاد بود', 'چند دقیقه دیگه دوباره امتحان کن.'));
    const intent = String(req.query.intent || '').trim();
    const plan = String(req.query.plan || '').trim();
    const selected = PLANS[plan];
    if (!validIntent(intent) || !selected) return res.status(400).send(errorPage('لینک پرداخت معتبر نیست', 'لطفاً از داخل وستالند دوباره روی پرداخت بزن.'));

    const receipt = crypto.randomBytes(18).toString('hex');
    const amountToman = selected.amountToman;
    const amountRial = amountToman * 10;
    const orderId = `vl-${receipt}`;
    const merchant = process.env.ZIBAL_MERCHANT_ID || '68985f4ba45c72000bcfd5a2';
    const callbackUrl = `https://pay.hamooncloud.ir/payments/vestaland/callback?receipt=${encodeURIComponent(receipt)}`;
    try {
      await ensureTable(db);
      await db.pool.execute(
        `INSERT INTO external_payments(receipt,app,external_ref,plan,amount_toman,amount_rial,order_id,status)
         VALUES(?,?,?,?,?,?,?,'pending')`,
        [receipt, 'vestaland', intent, plan, amountToman, amountRial, orderId]
      );
      const gateway = await axios.post('https://gateway.zibal.ir/v1/request', {
        merchant,
        amount: amountRial,
        callbackUrl,
        orderId,
        description: selected.label
      }, { timeout: 20000 });
      const data = gateway.data || {};
      if (Number(data.result) !== 100 || !data.trackId) {
        await db.pool.execute('UPDATE external_payments SET status=? WHERE receipt=?', ['gateway_error', receipt]);
        console.error('[EXTERNAL_PAYMENT_START] Zibal request failed:', data);
        return res.status(502).send(errorPage('درگاه در دسترس نیست', 'شروع پرداخت انجام نشد. لطفاً دوباره امتحان کن.'));
      }
      await db.pool.execute('UPDATE external_payments SET track_id=? WHERE receipt=?', [String(data.trackId), receipt]);
      return res.redirect(302, `https://gateway.zibal.ir/start/${encodeURIComponent(String(data.trackId))}`);
    } catch (error) {
      console.error('[EXTERNAL_PAYMENT_START]', error.response?.data || error.code || error.message);
      try { await db.pool.execute('UPDATE external_payments SET status=? WHERE receipt=?', ['error', receipt]); } catch {}
      return res.status(500).send(errorPage('خطای پرداخت', 'شروع پرداخت با خطا روبه‌رو شد. لطفاً دوباره امتحان کن.'));
    }
  });

  app.get('/payments/vestaland/callback', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const receipt = String(req.query.receipt || '').trim();
    const trackId = String(req.query.trackId || req.query.track_id || '').trim();
    const callbackSuccess = String(req.query.success || '').trim();
    if (!validReceipt(receipt)) return res.status(400).send(errorPage('پرداخت نامعتبر', 'رسید پرداخت معتبر نیست.'));
    try {
      await ensureTable(db);
      const [rows] = await db.pool.execute('SELECT * FROM external_payments WHERE receipt=? AND app=? LIMIT 1', [receipt, 'vestaland']);
      const row = rows[0];
      if (!row) return res.status(404).send(errorPage('پرداخت پیدا نشد', 'از داخل وستالند دوباره پرداخت رو شروع کن.'));
      if (row.status === 'paid') return res.redirect(302, returnUrl('success', row));
      if (callbackSuccess && !['1', 'true', '100'].includes(callbackSuccess.toLowerCase())) {
        await db.pool.execute('UPDATE external_payments SET status=? WHERE receipt=?', ['cancelled', receipt]);
        return res.redirect(302, returnUrl('failed', row));
      }
      const effectiveTrackId = trackId || String(row.track_id || '');
      if (!effectiveTrackId) return res.redirect(302, returnUrl('failed', row));
      const merchant = process.env.ZIBAL_MERCHANT_ID || '68985f4ba45c72000bcfd5a2';
      const verify = await axios.post('https://gateway.zibal.ir/v1/verify', {
        merchant,
        trackId: Number(effectiveTrackId)
      }, { timeout: 20000 });
      const v = verify.data || {};
      if (Number(v.result) !== 100) {
        console.warn('[EXTERNAL_PAYMENT_VERIFY] failed:', v);
        await db.pool.execute('UPDATE external_payments SET status=?, verify_payload=? WHERE receipt=?', ['verify_failed', JSON.stringify(v), receipt]);
        return res.redirect(302, returnUrl('failed', row));
      }
      const paidRial = Number(v.amount || 0);
      if (paidRial && paidRial !== Number(row.amount_rial)) {
        console.error('[EXTERNAL_PAYMENT_VERIFY] amount mismatch:', { receipt, paidRial, expected: row.amount_rial });
        await db.pool.execute('UPDATE external_payments SET status=?, verify_payload=? WHERE receipt=?', ['amount_mismatch', JSON.stringify(v), receipt]);
        return res.redirect(302, returnUrl('failed', row));
      }
      await db.pool.execute(
        `UPDATE external_payments
         SET status='paid', track_id=?, verify_payload=?, paid_at=COALESCE(paid_at,NOW())
         WHERE receipt=? AND status<>'paid'`,
        [effectiveTrackId, JSON.stringify(v), receipt]
      );
      const [freshRows] = await db.pool.execute('SELECT * FROM external_payments WHERE receipt=? LIMIT 1', [receipt]);
      return res.redirect(302, returnUrl('success', freshRows[0] || row));
    } catch (error) {
      console.error('[EXTERNAL_PAYMENT_CALLBACK]', error.response?.data || error.code || error.message);
      return res.status(500).send(errorPage('خطای بررسی پرداخت', 'امکان بررسی پرداخت وجود ندارد. اگر مبلغ کسر شده، چند دقیقه بعد دوباره وارد وستالند شو.'));
    }
  });

  app.get('/payments/vestaland/status', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const receipt = String(req.query.receipt || '').trim();
    if (!validReceipt(receipt)) return res.status(400).json({ ok: false, error: 'INVALID_RECEIPT' });
    try {
      await ensureTable(db);
      const [rows] = await db.pool.execute(
        `SELECT receipt,external_ref,plan,amount_toman,status,paid_at
         FROM external_payments WHERE receipt=? AND app=? LIMIT 1`,
        [receipt, 'vestaland']
      );
      if (!rows[0]) return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
      const row = rows[0];
      return res.json({
        ok: true,
        receipt: row.receipt,
        intent: row.external_ref,
        plan: row.plan,
        amount_toman: Number(row.amount_toman),
        status: row.status,
        paid_at: row.paid_at || null
      });
    } catch (error) {
      console.error('[EXTERNAL_PAYMENT_STATUS]', error.code || error.message);
      return res.status(500).json({ ok: false, error: 'STATUS_FAILED' });
    }
  });
}

module.exports = { mountExternalPayments, PLANS };