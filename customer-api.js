'use strict';
const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const cloud = require('./cloud-api');
const datacenters = require('./datacenters');
const { getHetznerSellablePlans, createOrGetSshKey } = require('./Hetzner/hetzner-api');

const minuteBuckets = new Map();
function apiError(res, status, code, message) { return res.status(status).json({ ok:false, error:{ code, message } }); }
function csvAllowed(text) { return String(text || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean); }
function isAllowed(listText, value) { const list = csvAllowed(listText); return !list.length || list.includes(String(value || '').toLowerCase()); }
function clientIp(req) { return String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0,64); }
function checkRate(key, limit) { const now = Date.now(); const bucket = `${key}:${Math.floor(now / 60000)}`; const n = (minuteBuckets.get(bucket) || 0) + 1; minuteBuckets.set(bucket, n); if (minuteBuckets.size > 5000) for (const k of minuteBuckets.keys()) if (!k.endsWith(String(Math.floor(now/60000)))) minuteBuckets.delete(k); return n <= limit; }

function isHetznerDc(dcConfigOrKey) {
  if (!dcConfigOrKey) return false;
  if (typeof dcConfigOrKey === 'string') return isHetznerDc(datacenters[dcConfigOrKey] || { key: dcConfigOrKey });
  const provider = String(dcConfigOrKey.provider || '').toLowerCase();
  const apiType = String(dcConfigOrKey.apiType || dcConfigOrKey.type || '').toLowerCase();
  const key = String(dcConfigOrKey.key || '').toLowerCase();
  return provider === 'hetzner' || apiType === 'hetzner' || key === 'hetzner' || key.startsWith('hetzner-') || !!dcConfigOrKey.HETZNER_LOCATION;
}
function hetznerDcKeys() { return Object.keys(datacenters).filter(key => isHetznerDc(datacenters[key])); }
async function findUserHetznerPurchase(telegramId, serverId) {
  for (const dcKey of hetznerDcKeys()) {
    const p = await db.getPurchaseForUserServer(telegramId, serverId, dcKey);
    if (p) return p;
  }
  return null;
}

function publicIpFromServer(srv) { return srv?.public_net?.ipv4?.ip || srv?.addresses?.public?.find?.(a => a.version === 4)?.addr || srv?.public_ip || null; }

async function auth(req, res, next) {
  req.requestId = crypto.randomBytes(12).toString('hex');
  res.setHeader('X-Request-Id', req.requestId);
  const authz = String(req.headers.authorization || '');
  const token = authz.startsWith('Bearer ') ? authz.slice(7).trim() : '';
  if (!token || !token.startsWith('hm_live_')) return apiError(res, 401, 'AUTH_REQUIRED', 'کلید API معتبر ارسال نشده است.');
  const client = await db.authenticateApiKey(token);
  if (!client) return apiError(res, 401, 'INVALID_API_KEY', 'کلید API نامعتبر یا غیرفعال است.');
  if (!checkRate(client.key_prefix, ['POST','DELETE'].includes(req.method) ? 10 : 60)) return apiError(res, 429, 'RATE_LIMITED', 'تعداد درخواست‌ها بیش از حد مجاز است.');
  req.apiClient = client;
  res.on('finish', () => db.recordApiRequestLog({ clientId: client.id, telegramId: client.telegram_id, keyPrefix: client.key_prefix, method: req.method, path: req.originalUrl.slice(0,255), statusCode: res.statusCode, ip: clientIp(req), userAgent: req.headers['user-agent'], requestId: req.requestId, errorMessage: res.statusCode >= 400 ? res.statusMessage : null }).catch(()=>{}));
  next();
}
async function userPurchase(req, res, next) {
  const p = await findUserHetznerPurchase(req.apiClient.telegram_id, req.params.id);
  if (!p) return apiError(res, 404, 'SERVER_NOT_FOUND', 'سرور پیدا نشد.');
  req.purchase = p; next();
}

function createCustomerApiRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));
  router.use(auth);
  router.get('/me', (req,res)=>res.json({ ok:true, client:{ id:req.apiClient.id, telegram_id:req.apiClient.telegram_id, name:req.apiClient.name, max_servers:req.apiClient.max_servers, min_wallet_balance:req.apiClient.min_wallet_balance } }));
  router.get('/wallet', async (req,res,next)=>{ try{res.json({ ok:true, wallet:{ balance: await db.getUserWallet(req.apiClient.telegram_id) } });}catch(e){next(e);} });
  router.get('/prices', async (_req,res,next)=>{ try{res.json({ ok:true, plans: await getHetznerSellablePlans(datacenters.hetzner) });}catch(e){next(e);} });
  router.get('/usage', async (req,res,next)=>{ try{res.json({ ok:true, usage: await db.getApiClientUsageSummary(req.apiClient.id) });}catch(e){next(e);} });
  router.get('/servers', async (req,res,next)=>{ try{const data=await db.listAdminServers({ userId:req.apiClient.telegram_id, limit:200 }); res.json({ ok:true, servers:data.rows.filter(r=>isHetznerDc(r.datacenter)) });}catch(e){next(e);} });
  router.get('/servers/:id', userPurchase, (req,res)=>res.json({ ok:true, server:req.purchase }));
  router.post('/servers', async (req,res,next)=>{ try{
    const client=req.apiClient; const body=req.body||{}; const dcKey=String(body.datacenter||'hetzner').trim().toLowerCase(); const dc=datacenters[dcKey]; if(!dc || !isHetznerDc(dc)) return apiError(res,503,'HETZNER_UNAVAILABLE','دیتاسنتر هتزنر فعال نیست.');
    const duration=['hourly','monthly'].includes(body.duration)?body.duration:'hourly';
    const plans=await getHetznerSellablePlans(dc); const plan=plans.find(p=>p.id===String(body.server_type||'').toLowerCase() || p.hetzner_type===String(body.server_type||'').toLowerCase());
    if(!plan || plan.available===false) return apiError(res,400,'INVALID_PLAN','پلن انتخاب‌شده معتبر نیست.');
    const image=String(body.image||'ubuntu-24.04').trim(); const location=String(body.location||dc.HETZNER_LOCATION||'nbg1').trim().toLowerCase();
    if(!isAllowed(client.allowed_datacenters,dcKey)||!isAllowed(client.allowed_plans,plan.id)||!isAllowed(client.allowed_images,image)||!isAllowed(client.allowed_locations,location)) return apiError(res,403,'NOT_ALLOWED','این پلن، ایمیج یا لوکیشن برای این کلاینت مجاز نیست.');
    const wallet=Number(await db.getUserWallet(client.telegram_id)||0); if(wallet < Number(client.min_wallet_balance||0)) return apiError(res,402,'INSUFFICIENT_WALLET','موجودی کیف پول کافی نیست.');
    if(await db.getApiClientActiveServerCount(client.id) >= Number(client.max_servers||2)) return apiError(res,403,'SERVER_LIMIT_REACHED','سقف تعداد سرورهای مجاز پر شده است.');
    const price = duration==='monthly' ? plan.amount_monthly : plan.amount_hourly;
    const name=String(body.name||`api-${Date.now()}`).replace(/[^A-Za-z0-9._-]+/g,'-').slice(0,63);
    let key_id=null; if(body.ssh_key){ if(String(body.ssh_key).length>4096) return apiError(res,400,'SSH_KEY_TOO_LARGE','کلید SSH بیش از حد بزرگ است.'); const key=await createOrGetSshKey({ token: dc.HETZNER_API_TOKEN || dc.token || process.env.HETZNER_API_TOKEN, name:`api-${client.id}-${Date.now()}`.slice(0,63), publicKey:String(body.ssh_key) }); key_id=key?.id||null; }
    const srv=await cloud.createServer(dc,null,{ name, serverType:plan.hetzner_type, image, location, key_id, userLabel:client.telegram_id });
    const ip=publicIpFromServer(srv); await db.recordPurchase(client.telegram_id, String(srv.id), dcKey, srv.name||name, plan.id, price, duration, 0, 0, null, 'api', image, 0,0,0,0,0, key_id, ip ? 'active' : 'pending_ssh');
    await db.recordWalletLog(client.telegram_id, 0, `API server create ${srv.id}`, 'server_api_create').catch(()=>{});
    res.status(201).json({ ok:true, server:{ id:String(srv.id), name:srv.name||name, status:srv.status||'creating', public_ip:ip, server_type:plan.id, price } });
  }catch(e){next(e);} });
  router.delete('/servers/:id', userPurchase, async (req,res,next)=>{ try{try{await cloud.deleteServer(datacenters[req.purchase.datacenter],null,req.params.id); await db.updatePurchaseStatus(req.params.id,'deleted');}catch(e){ if(e.response?.status===404||e.status===404){ await db.updatePurchaseStatus(req.params.id,'provider_missing'); } else throw e;} res.json({ ok:true });}catch(e){next(e);} });
  for (const [path,fn] of [['poweron','resumeServer'],['poweroff','suspendServer'],['reboot','rebuildServer']]) router.post(`/servers/:id/${path}`, userPurchase, async (req,res,next)=>{ try{ if(path==='reboot') return apiError(res,400,'UNSUPPORTED_ACTION','ریبوت مستقیم در این نسخه فعال نیست.'); await cloud[fn](datacenters[req.purchase.datacenter],null,req.params.id); res.json({ ok:true }); }catch(e){next(e);} });
  router.post('/servers/:id/upgrade', userPurchase, async (req,res,next)=>{ try{const dc=datacenters[req.purchase.datacenter] || datacenters.hetzner; const plans=await getHetznerSellablePlans(dc); const target=plans.find(p=>p.id===String(req.body?.target_server_type||'').toLowerCase()); if(!target)return apiError(res,400,'INVALID_PLAN','پلن هدف معتبر نیست.'); await cloud.changeHetznerServerType(dc,req.params.id,target.hetzner_type,!!req.body?.upgrade_disk); await db.updatePurchasePlan(req.apiClient.telegram_id, req.params.id, req.purchase.datacenter, target.id, target.amount_monthly); res.json({ ok:true });}catch(e){next(e);} });
  router.use((err,_req,res,_next)=>{ console.error('[CUSTOMER_API_ERROR]', err.code || err.message); if (err.code === 'HETZNER_PLACEMENT_UNAVAILABLE') return apiError(res,409,'HETZNER_PLACEMENT_UNAVAILABLE',err.message); apiError(res,500,'INTERNAL_ERROR','خطای داخلی رخ داد.'); });
  return router;
}
module.exports = { createCustomerApiRouter };
