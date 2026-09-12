'use strict';
const crypto = require('crypto');

const PLANS = Object.freeze({
  '1m': { amountToman: 490000, label: 'اشتراک یک‌ماهه وستالند' },
  '3m': { amountToman: 1290000, label: 'اشتراک سه‌ماهه وستالند' },
  '6m': { amountToman: 2190000, label: 'اشتراک شش‌ماهه وستالند' }
});
const START_BUCKETS = new Map();
const MERCHANT_FALLBACK = '68985f4ba45c72000bcfd5a2';
const PAYMENT_PUBLIC_ORIGIN = 'https://pay.hamooncloud.ir';

function validIntent(value) { return /^[A-Za-z0-9_-]{20,128}$/.test(String(value || '')); }
function validReceipt(value) { return /^[a-f0-9]{24,64}$/.test(String(value || '')); }
function validMetadataHash(value) { return /^[a-f0-9]{64}$/.test(String(value || '')); }
function allowStart(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.ip || 'unknown').split(',')[0].trim();
  const bucket = `${ip}:${Math.floor(Date.now() / 600000)}`;
  const n = (START_BUCKETS.get(bucket) || 0) + 1;
  START_BUCKETS.set(bucket, n);
  if (START_BUCKETS.size > 3000) {
    const current = Math.floor(Date.now() / 600000);
    for (const key of START_BUCKETS.keys()) if (!key.endsWith(`:${current}`)) START_BUCKETS.delete(key);
  }
  return n <= 30;
}
function subscriptionReturnUrl(status, row) {
  const u = new URL(process.env.VESTALAND_RETURN_URL || 'https://vestaland.smarbiz.sbs/');
  u.searchParams.set('payment', status);
  if (row?.receipt) u.searchParams.set('receipt', row.receipt);
  if (row?.external_ref) u.searchParams.set('intent', row.external_ref);
  return u.toString();
}
function marketReturnUrl(status, row) {
  const u = new URL(process.env.VESTALAND_MARKET_RETURN_URL || 'https://vestaland.smarbiz.sbs/');
  u.searchParams.set('market_payment', status);
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
      plan VARCHAR(32) NOT NULL,
      amount_toman BIGINT NOT NULL,
      amount_rial BIGINT NOT NULL,
      order_id VARCHAR(128) NOT NULL UNIQUE,
      track_id VARCHAR(64) NULL UNIQUE,
      metadata_hash VARCHAR(64) NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'pending',
      verify_payload LONGTEXT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      paid_at DATETIME NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_external_payments_ref (app, external_ref),
      INDEX idx_external_payments_status (status, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  try { await db.pool.query('ALTER TABLE external_payments MODIFY plan VARCHAR(32) NOT NULL'); } catch (_) {}
  try { await db.pool.query('ALTER TABLE external_payments ADD COLUMN metadata_hash VARCHAR(64) NULL AFTER track_id'); } catch (_) {}
}

async function createGatewayPayment({ db, axios, appName, intent, plan, amountToman, label, orderPrefix, callbackPath, metadataHash='' }) {
  const receipt = crypto.randomBytes(18).toString('hex');
  const amountRial = Number(amountToman) * 10;
  const orderId = `${orderPrefix}-${receipt}`;
  const merchant = process.env.ZIBAL_MERCHANT_ID || MERCHANT_FALLBACK;
  const callbackUrl = `${PAYMENT_PUBLIC_ORIGIN}${callbackPath}?receipt=${encodeURIComponent(receipt)}`;
  await ensureTable(db);
  await db.pool.execute(
    `INSERT INTO external_payments(receipt,app,external_ref,plan,amount_toman,amount_rial,order_id,metadata_hash,status)
     VALUES(?,?,?,?,?,?,?,?,'pending')`,
    [receipt, appName, intent, plan, amountToman, amountRial, orderId, metadataHash || null]
  );
  try {
    const gateway = await axios.post('https://gateway.zibal.ir/v1/request', {
      merchant, amount: amountRial, callbackUrl, orderId, description: label
    }, { timeout: 20000 });
    const data = gateway.data || {};
    if (Number(data.result) !== 100 || !data.trackId) {
      await db.pool.execute('UPDATE external_payments SET status=? WHERE receipt=?', ['gateway_error', receipt]);
      const err = new Error('ZIBAL_REQUEST_FAILED'); err.gatewayData = data; throw err;
    }
    await db.pool.execute('UPDATE external_payments SET track_id=? WHERE receipt=?', [String(data.trackId), receipt]);
    return { receipt, trackId: String(data.trackId) };
  } catch (error) {
    try { await db.pool.execute('UPDATE external_payments SET status=? WHERE receipt=? AND status=?', ['error', receipt, 'pending']); } catch (_) {}
    throw error;
  }
}

async function verifyCallback({ req, res, db, axios, appName, returnUrl }) {
  res.setHeader('Cache-Control', 'no-store');
  const receipt = String(req.query.receipt || '').trim();
  const trackId = String(req.query.trackId || req.query.track_id || '').trim();
  const callbackSuccess = String(req.query.success || '').trim();
  if (!validReceipt(receipt)) return res.status(400).send(errorPage('پرداخت نامعتبر', 'رسید پرداخت معتبر نیست.'));
  try {
    await ensureTable(db);
    const [rows] = await db.pool.execute('SELECT * FROM external_payments WHERE receipt=? AND app=? LIMIT 1', [receipt, appName]);
    const row = rows[0];
    if (!row) return res.status(404).send(errorPage('پرداخت پیدا نشد', 'لطفاً دوباره از داخل وستالند پرداخت رو شروع کن.'));
    if (row.status === 'paid') return res.redirect(302, returnUrl('success', row));
    if (callbackSuccess && !['1','true','100'].includes(callbackSuccess.toLowerCase())) {
      await db.pool.execute('UPDATE external_payments SET status=? WHERE receipt=?', ['cancelled', receipt]);
      return res.redirect(302, returnUrl('failed', row));
    }
    const effectiveTrackId = trackId || String(row.track_id || '');
    if (!effectiveTrackId) return res.redirect(302, returnUrl('failed', row));
    const merchant = process.env.ZIBAL_MERCHANT_ID || MERCHANT_FALLBACK;
    const verify = await axios.post('https://gateway.zibal.ir/v1/verify', { merchant, trackId: Number(effectiveTrackId) }, { timeout: 20000 });
    const v = verify.data || {};
    if (Number(v.result) !== 100) {
      await db.pool.execute('UPDATE external_payments SET status=?,verify_payload=? WHERE receipt=?', ['verify_failed', JSON.stringify(v), receipt]);
      return res.redirect(302, returnUrl('failed', row));
    }
    const paidRial = Number(v.amount || 0);
    if (paidRial && paidRial !== Number(row.amount_rial)) {
      await db.pool.execute('UPDATE external_payments SET status=?,verify_payload=? WHERE receipt=?', ['amount_mismatch', JSON.stringify(v), receipt]);
      return res.redirect(302, returnUrl('failed', row));
    }
    await db.pool.execute(
      `UPDATE external_payments SET status='paid',track_id=?,verify_payload=?,paid_at=COALESCE(paid_at,NOW()) WHERE receipt=? AND status<>'paid'`,
      [effectiveTrackId, JSON.stringify(v), receipt]
    );
    const [fresh] = await db.pool.execute('SELECT * FROM external_payments WHERE receipt=? LIMIT 1', [receipt]);
    return res.redirect(302, returnUrl('success', fresh[0] || row));
  } catch (error) {
    console.error(`[${appName}_CALLBACK]`, error.response?.data || error.code || error.message);
    return res.status(500).send(errorPage('خطای بررسی پرداخت', 'اگر مبلغ کسر شده، رسید محفوظ است. چند دقیقه بعد دوباره وارد وستالند شو.'));
  }
}

async function paymentStatus(req, res, db, appName) {
  res.setHeader('Cache-Control', 'no-store');
  const receipt = String(req.query.receipt || '').trim();
  if (!validReceipt(receipt)) return res.status(400).json({ ok:false,error:'INVALID_RECEIPT' });
  try {
    await ensureTable(db);
    const [rows] = await db.pool.execute(
      `SELECT receipt,external_ref,plan,amount_toman,metadata_hash,status,paid_at FROM external_payments WHERE receipt=? AND app=? LIMIT 1`,
      [receipt, appName]
    );
    if (!rows[0]) return res.status(404).json({ ok:false,error:'NOT_FOUND' });
    const row = rows[0];
    return res.json({
      ok:true,
      receipt:row.receipt,
      intent:row.external_ref,
      plan:row.plan,
      amount_toman:Number(row.amount_toman),
      metadata_hash:row.metadata_hash||null,
      status:row.status,
      paid_at:row.paid_at||null
    });
  } catch (error) {
    console.error(`[${appName}_STATUS]`, error.code || error.message);
    return res.status(500).json({ ok:false,error:'STATUS_FAILED' });
  }
}

function mountExternalPayments(app, { db, axios }) {
  // CamCam uses the shared Iranian payment origin because the Zibal merchant
  // is domain-bound. Verification and subscription activation remain inside
  // CamCam; this route only relays Zibal's signed callback parameters.
  app.get('/payments/camcam/callback', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const target = new URL(process.env.CAMCAM_PAYMENT_CALLBACK_URL || 'https://camcam.smarbiz.sbs/api/billing/zibal/callback');
    for (const key of ['trackId', 'track_id', 'success', 'status', 'orderId']) {
      const value = String(req.query[key] || '').trim();
      if (value && value.length <= 160) target.searchParams.set(key, value);
    }
    return res.redirect(302, target.toString());
  });

  app.get('/payments/vestaland/start', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!allowStart(req)) return res.status(429).send(errorPage('درخواست زیاد بود', 'چند دقیقه دیگه دوباره امتحان کن.'));
    const intent=String(req.query.intent||'').trim(), plan=String(req.query.plan||'').trim(), selected=PLANS[plan];
    if (!validIntent(intent)||!selected) return res.status(400).send(errorPage('لینک پرداخت معتبر نیست','لطفاً از داخل وستالند دوباره روی پرداخت بزن.'));
    try {
      const p=await createGatewayPayment({db,axios,appName:'vestaland',intent,plan,amountToman:selected.amountToman,label:selected.label,orderPrefix:'vl',callbackPath:'/payments/vestaland/callback'});
      return res.redirect(302,`${PAYMENT_PUBLIC_ORIGIN}/payment/start/${encodeURIComponent(p.trackId)}`);
    } catch (error) {
      console.error('[VESTALAND_PAYMENT_START]',error.gatewayData||error.response?.data||error.code||error.message);
      return res.status(502).send(errorPage('درگاه در دسترس نیست','شروع پرداخت انجام نشد. لطفاً دوباره امتحان کن.'));
    }
  });
  app.get('/payments/vestaland/callback',(req,res)=>verifyCallback({req,res,db,axios,appName:'vestaland',returnUrl:subscriptionReturnUrl}));
  app.get('/payments/vestaland/status',(req,res)=>paymentStatus(req,res,db,'vestaland'));

  app.get('/payments/vestaland-market/start', async (req, res) => {
    res.setHeader('Cache-Control','no-store');
    if (!allowStart(req)) return res.status(429).send(errorPage('درخواست زیاد بود','چند دقیقه دیگه دوباره امتحان کن.'));
    const intent=String(req.query.intent||'').trim();
    if (!validIntent(intent)) return res.status(400).send(errorPage('لینک پرداخت معتبر نیست','از سبد خرید وستالند دوباره پرداخت رو شروع کن.'));
    try {
      const resolver=process.env.VESTALAND_MARKET_INTENT_URL||'https://vestaland.smarbiz.sbs/api/market-payment/intent';
      const answer=await axios.get(resolver,{params:{intent},timeout:15000,headers:{Accept:'application/json','User-Agent':'HamoonVestalandMarket/1.1'}});
      const d=answer.data||{};
      const amountToman=Number(d.amount_toman||0), store=String(d.store||''), metadataHash=String(d.payload_hash||'').toLowerCase();
      if (!d.ok||d.status!=='pending'||d.intent!==intent||!['vesta','cutella'].includes(store)||!Number.isSafeInteger(amountToman)||amountToman<1000||amountToman>500000000||!validMetadataHash(metadataHash)) {
        return res.status(409).send(errorPage('سفارش قابل پرداخت نیست','سبد یا مبلغ تغییر کرده؛ از داخل وستالند دوباره پرداخت رو شروع کن.'));
      }
      const p=await createGatewayPayment({db,axios,appName:'vestaland-market',intent,plan:store,amountToman,label:String(d.label||'خرید بازار وستالند').slice(0,180),orderPrefix:'vlm',callbackPath:'/payments/vestaland-market/callback',metadataHash});
      return res.redirect(302,`${PAYMENT_PUBLIC_ORIGIN}/payment/start/${encodeURIComponent(p.trackId)}`);
    } catch (error) {
      console.error('[VESTALAND_MARKET_START]',error.gatewayData||error.response?.data||error.code||error.message);
      return res.status(502).send(errorPage('شروع پرداخت انجام نشد','اتصال امن هامون‌کلود به سفارش برقرار نشد. لطفاً دوباره امتحان کن.'));
    }
  });
  app.get('/payments/vestaland-market/callback',(req,res)=>verifyCallback({req,res,db,axios,appName:'vestaland-market',returnUrl:marketReturnUrl}));
  app.get('/payments/vestaland-market/status',(req,res)=>paymentStatus(req,res,db,'vestaland-market'));
}

module.exports={mountExternalPayments,PLANS};
