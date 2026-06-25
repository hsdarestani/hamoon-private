'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const datacenters = require('./datacenters');
const cloud = require('./cloud-api');

const sessions = new Map();
const loginAttempts = new Map();
const writeAttempts = new Map();
const SESSION_COOKIE = 'hamoon_admin_session';

function jsonOk(res, data) { return res.json({ ok: true, data }); }
function jsonError(res, status, error, message) { return res.status(status).json({ ok: false, error, message }); }
function adminConfigured() { return !!(process.env.ADMIN_DASHBOARD_USER && process.env.ADMIN_DASHBOARD_PASSWORD && process.env.ADMIN_DASHBOARD_SESSION_SECRET); }
function maxAgeMs() { return Number(process.env.ADMIN_DASHBOARD_SESSION_MAX_AGE_MS || 12 * 60 * 60 * 1000); }
function safeEqual(a, b) { const ab = Buffer.from(String(a || '')); const bb = Buffer.from(String(b || '')); return ab.length === bb.length && crypto.timingSafeEqual(ab, bb); }
function parseCookies(req) { return Object.fromEntries(String(req.headers.cookie || '').split(';').filter(Boolean).map(p => { const i = p.indexOf('='); return [decodeURIComponent(p.slice(0, i).trim()), decodeURIComponent(p.slice(i + 1).trim())]; })); }
function sign(id) { return crypto.createHmac('sha256', process.env.ADMIN_DASHBOARD_SESSION_SECRET || 'missing').update(id).digest('base64url'); }
function createSession(res, actor) { const id = crypto.randomBytes(32).toString('base64url'); sessions.set(id, { actor, expires: Date.now() + maxAgeMs() }); const cookie = `${SESSION_COOKIE}=${encodeURIComponent(id + '.' + sign(id))}; Path=/dashboard; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs()/1000)}${process.env.DASHBOARD_SECURE_COOKIE === 'true' ? '; Secure' : ''}`; res.setHeader('Set-Cookie', cookie); }
function clearSession(req, res) { const c = parseCookies(req)[SESSION_COOKIE]; if (c) sessions.delete(String(c).split('.')[0]); res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/dashboard; HttpOnly; SameSite=Lax; Max-Age=0`); }
function getSession(req) { const auth = String(req.headers.authorization || ''); if (process.env.ADMIN_DASHBOARD_TOKEN && auth.startsWith('Bearer ') && safeEqual(auth.slice(7), process.env.ADMIN_DASHBOARD_TOKEN)) return { actor: 'token' };
  const raw = parseCookies(req)[SESSION_COOKIE]; if (!raw) return null; const [id, sig] = String(raw).split('.'); if (!id || !sig || !safeEqual(sig, sign(id))) return null; const s = sessions.get(id); if (!s || s.expires < Date.now()) { sessions.delete(id); return null; } s.expires = Date.now() + maxAgeMs(); return s; }
function requireAuth(req, res, next) { const s = getSession(req); if (!s) return jsonError(res, 401, 'AUTH_REQUIRED', 'برای دسترسی ابتدا وارد داشبورد شوید.'); req.admin = s; next(); }
function requireAdminAction(req, res, next) { if (req.method !== 'POST') return next(); if (req.path === '/login' || req.path === '/logout') return next(); const key = req.ip || 'unknown'; const now = Date.now(); const list = (writeAttempts.get(key) || []).filter(t => now - t < 60000); if (list.length > 120) return jsonError(res, 429, 'RATE_LIMITED', 'درخواست‌های مدیریتی بیش از حد مجاز است.'); list.push(now); writeAttempts.set(key, list); if (req.headers['x-admin-action'] !== 'true') return jsonError(res, 403, 'ADMIN_HEADER_REQUIRED', 'هدر امنیتی عملیات ادمین ارسال نشده است.'); next(); }
function safeDc(dc) { return { key: dc.key, name: dc.name, provider: dc.provider || dc.apiType || 'openstack', buyEnabled: dc.buyEnabled !== false, manageEnabled: dc.manageEnabled !== false, allowedCycles: dc.allowedCycles || ['hourly','daily','weekly','monthly'], capabilities: dc.capabilities || {}, priceSource: dc.priceSource || (dc.flavors ? 'static' : 'provider'), trafficSupport: !!dc.BILL_TRAFFIC }; }
function csv(rows) { const arr = Array.isArray(rows) ? rows : (rows.rows || []); const cols = Array.from(arr.reduce((s,r)=>{Object.keys(r||{}).forEach(k=>s.add(k)); return s;}, new Set())); return [cols.join(','), ...arr.map(r => cols.map(c => '"' + String(r[c] ?? '').replace(/"/g,'""') + '"').join(','))].join('\n'); }
async function audit(req, action, target, metadata) { try { await db.adminAuditLog(action, req.admin?.actor, target, metadata, req.ip); } catch (e) { console.warn('[AUDIT_FAILED]', action, e.message); } }
async function providerAction(req, res, action) { const serverId = req.params.serverId; const detail = await db.getAdminServerDetail(serverId); if (!detail) return jsonError(res, 404, 'SERVER_NOT_FOUND', 'سرور پیدا نشد.'); const dc = datacenters[detail.purchase.datacenter]; if (!dc) return jsonError(res, 400, 'DATACENTER_NOT_FOUND', 'دیتاسنتر تعریف نشده است.'); try { const tok = await cloud.getToken(dc); let result = null; if (action === 'refresh') result = await cloud.getServer(dc, tok, serverId); if (action === 'suspend') { result = await cloud.suspendServer(dc, tok, serverId); await db.adminUpdatePurchaseStatus(serverId, 'suspended'); } if (action === 'resume') { result = await cloud.resumeServer(dc, tok, serverId); await db.adminUpdatePurchaseStatus(serverId, 'active'); } if (action === 'delete') { if (!req.body.confirm) return jsonError(res, 400, 'CONFIRM_REQUIRED', 'تأیید حذف الزامی است.'); result = await cloud.deleteServer(dc, tok, serverId); await db.adminUpdatePurchaseStatus(serverId, 'deleted'); } await audit(req, `server_${action}`, { type:'server', id:serverId }, { datacenter: dc.key, success:true }); return jsonOk(res, { result }); } catch (e) { await audit(req, `server_${action}_failed`, { type:'server', id:serverId }, { datacenter: dc.key, error:e.message }); return jsonError(res, 502, 'PROVIDER_ACTION_FAILED', 'عملیات روی ارائه‌دهنده ناموفق بود.'); } }

function createDashboardApiRouter() {
  if (!adminConfigured()) console.warn('[DASHBOARD_SECURITY] ADMIN_DASHBOARD_USER/PASSWORD/SESSION_SECRET must be set; dashboard login will be disabled.');
  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));
  router.post('/login', (req,res) => { const key=req.ip||'unknown'; const now=Date.now(); const list=(loginAttempts.get(key)||[]).filter(t=>now-t<15*60*1000); if(list.length>=20) return jsonError(res,429,'LOGIN_RATE_LIMITED','تلاش ورود بیش از حد مجاز است.'); list.push(now); loginAttempts.set(key,list); if(!adminConfigured()) return jsonError(res,503,'ADMIN_AUTH_NOT_CONFIGURED','ورود ادمین روی سرور تنظیم نشده است.'); const {username,password}=req.body||{}; if(!safeEqual(username,process.env.ADMIN_DASHBOARD_USER)||!safeEqual(password,process.env.ADMIN_DASHBOARD_PASSWORD)) return jsonError(res,401,'INVALID_LOGIN','نام کاربری یا رمز عبور نادرست است.'); createSession(res, username); jsonOk(res,{user:username}); });
  router.post('/logout', (req,res)=>{ clearSession(req,res); jsonOk(res,{loggedOut:true}); });
  router.use(requireAuth, requireAdminAction);
  router.get('/me', (req,res)=>jsonOk(res,{user:req.admin.actor, configured:adminConfigured()}));
  router.get('/overview', async (_req,res,next)=>{ try{jsonOk(res, await db.getAdminOverviewStats());}catch(e){next(e);} });
  router.get('/stats/revenue', async (req,res,next)=>{ try{jsonOk(res, await db.getAdminRevenueStats(req.query.days));}catch(e){next(e);} });
  router.get('/stats/purchases', async (req,res,next)=>{ try{jsonOk(res, await db.getAdminPurchaseStats(req.query.days));}catch(e){next(e);} });
  router.get('/stats/datacenters', async (_req,res,next)=>{ try{jsonOk(res, await db.getAdminDatacenterStats());}catch(e){next(e);} });
  router.get('/users', async (req,res,next)=>{ try{jsonOk(res, await db.listAdminUsers(req.query));}catch(e){next(e);} });
  router.get('/users/:telegramId', async (req,res,next)=>{ try{const d=await db.getAdminUserDetail(req.params.telegramId); d?jsonOk(res,d):jsonError(res,404,'USER_NOT_FOUND','کاربر پیدا نشد.');}catch(e){next(e);} });
  router.get('/users/:telegramId/wallet', async (req,res,next)=>{ try{jsonOk(res,{balance:await db.getUserWallet(req.params.telegramId)});}catch(e){next(e);} });
  router.get('/users/:telegramId/wallet-logs', async (req,res,next)=>{ try{jsonOk(res, await db.listAdminWalletLogs({...req.query,search:req.params.telegramId}));}catch(e){next(e);} });
  router.get('/users/:telegramId/purchases', async (req,res,next)=>{ try{jsonOk(res, await db.listAdminPurchases({...req.query,userId:req.params.telegramId}));}catch(e){next(e);} });
  router.get('/users/:telegramId/servers', async (req,res,next)=>{ try{jsonOk(res, await db.listAdminServers({...req.query,userId:req.params.telegramId}));}catch(e){next(e);} });
  router.post('/users/:telegramId/credit', async (req,res,next)=>{ try{const b=await db.adminCreditUser(req.params.telegramId, req.body.amount, req.body.description); await audit(req,'credit_user',{type:'user',id:req.params.telegramId},{amount:req.body.amount}); jsonOk(res,{balance:b});}catch(e){next(e);} });
  router.post('/users/:telegramId/debit', async (req,res,next)=>{ try{const b=await db.adminDebitUser(req.params.telegramId, req.body.amount, req.body.description); await audit(req,'debit_user',{type:'user',id:req.params.telegramId},{amount:req.body.amount}); jsonOk(res,{balance:b});}catch(e){next(e);} });
  router.post('/users/:telegramId/message', async (req,res)=>{ audit(req,'send_message',{type:'user',id:req.params.telegramId},{queued:false}); jsonOk(res,{queued:false,message:'ارسال مستقیم پیام از داشبورد در این فرایند فعال نیست.'}); });
  router.post('/users/:telegramId/shahkar/verify', async (req,res,next)=>{ try{await db.updateUserShahkar(req.params.telegramId, req.body.national_code || '', {admin_override:true}); await audit(req,'shahkar_verify',{type:'user',id:req.params.telegramId},{}); jsonOk(res,{verified:true});}catch(e){next(e);} });
  router.post('/users/:telegramId/shahkar/clear', async (req,res,next)=>{ try{if(!req.body.confirm)return jsonError(res,400,'CONFIRM_REQUIRED','تأیید الزامی است.'); await db.pool.execute('UPDATE users SET shahkar_verified=0, shahkar_verified_at=NULL, shahkar_last_response=NULL WHERE telegram_id=?',[String(req.params.telegramId)]); await audit(req,'shahkar_clear',{type:'user',id:req.params.telegramId},{}); jsonOk(res,{verified:false});}catch(e){next(e);} });
  router.get('/servers', async (req,res,next)=>{ try{jsonOk(res, await db.listAdminServers(req.query));}catch(e){next(e);} });
  router.get('/servers/:serverId', async (req,res,next)=>{ try{const d=await db.getAdminServerDetail(req.params.serverId); d?jsonOk(res,d):jsonError(res,404,'SERVER_NOT_FOUND','سرور پیدا نشد.');}catch(e){next(e);} });
  ['refresh','suspend','resume','delete'].forEach(a=>router.post(`/servers/:serverId/${a}`, (req,res)=>providerAction(req,res,a)));
  router.post('/servers/:serverId/check-ssh', async (req,res)=>{ await audit(req,'check_ssh',{type:'server',id:req.params.serverId},{}); jsonOk(res,{supported:false,message:'بررسی SSH در داشبورد به سرویس موجود متصل نشده است.'}); });
  router.post('/servers/:serverId/reset-password-ssh', async (req,res)=>{ if(!req.body.confirm)return jsonError(res,400,'CONFIRM_REQUIRED','تأیید الزامی است.'); await audit(req,'reset_password_ssh',{type:'server',id:req.params.serverId},{}); jsonOk(res,{supported:false}); });
  router.post('/servers/:serverId/set-password', async (req,res,next)=>{ try{if(!req.body.confirm||!req.body.password)return jsonError(res,400,'CONFIRM_REQUIRED','رمز و تأیید الزامی است.'); const d=await db.getAdminServerDetail(req.params.serverId); if(!d)return jsonError(res,404,'SERVER_NOT_FOUND','سرور پیدا نشد.'); await db.upsertServerSecret({telegramId:d.purchase.telegram_id,serverId:req.params.serverId,datacenter:d.purchase.datacenter,secretValue:req.body.password}); await audit(req,'set_password',{type:'server',id:req.params.serverId},{stored:true}); jsonOk(res,{stored:true});}catch(e){next(e);} });
  router.post('/servers/:serverId/update-status', async (req,res,next)=>{ try{const d=await db.adminUpdatePurchaseStatus(req.params.serverId, req.body.status); await audit(req,'purchase_status_update',{type:'server',id:req.params.serverId},{status:req.body.status}); jsonOk(res,d);}catch(e){next(e);} });
  router.post('/servers/attach-afra', async (req,res)=>{ audit(req,'attach_afra',{type:'server',id:req.body.server_id},{telegram_id:req.body.telegram_id}); jsonOk(res,{supported:false,message:'اتصال دستی نیازمند تطبیق اسکیمای خرید است.'}); });
  router.get('/wallet/logs', async (req,res,next)=>{ try{jsonOk(res, await db.listAdminWalletLogs(req.query));}catch(e){next(e);} });
  router.post('/wallet/adjust', async (req,res,next)=>{ try{const amount=Number(req.body.amount); const b=amount>=0?await db.adminCreditUser(req.body.telegram_id,amount,req.body.description):await db.adminDebitUser(req.body.telegram_id,Math.abs(amount),req.body.description); await audit(req,'wallet_adjust',{type:'user',id:req.body.telegram_id},{amount}); jsonOk(res,{balance:b});}catch(e){next(e);} });
  router.get('/purchases', async (req,res,next)=>{ try{jsonOk(res, await db.listAdminPurchases(req.query));}catch(e){next(e);} });
  router.get('/purchases/:id', async (req,res,next)=>{ try{const d=await db.getAdminServerDetail(req.params.id); d?jsonOk(res,d.purchase):jsonError(res,404,'PURCHASE_NOT_FOUND','خرید پیدا نشد.');}catch(e){next(e);} });
  router.post('/purchases/:id/status', async (req,res,next)=>{ try{const d=await db.adminUpdatePurchaseStatus(req.params.id, req.body.status); await audit(req,'purchase_status_update',{type:'purchase',id:req.params.id},{status:req.body.status}); jsonOk(res,d);}catch(e){next(e);} });
  router.post('/purchases/:id/billing', async (req,res)=>{ audit(req,'purchase_billing_update',{type:'purchase',id:req.params.id},{}); jsonOk(res,{updated:false}); });
  router.get('/datacenters', (_req,res)=>jsonOk(res,Object.values(datacenters).filter(dc=>dc&&dc.key).map(safeDc)));
  router.get('/datacenters/:key/health', async (req,res)=>{ const dc=datacenters[req.params.key]; if(!dc)return jsonError(res,404,'DATACENTER_NOT_FOUND','دیتاسنتر پیدا نشد.'); const health={token:false,listFlavors:false,listServers:false}; try{const tok=await cloud.getToken(dc); health.token=true; try{await cloud.listFlavors(dc,tok); health.listFlavors=true;}catch{} try{await cloud.listServers(dc,tok); health.listServers=true;}catch{} jsonOk(res,health);}catch{jsonOk(res,health);} });
  router.get('/logs/server-events', (req,res)=>{ const file=path.join(__dirname,'server_events.log'); const limit=Math.min(parseInt(req.query.limit,10)||200,500); if(!fs.existsSync(file))return jsonOk(res,[]); const lines=fs.readFileSync(file,'utf8').split('\n').filter(Boolean).slice(-limit).map(l=>l.replace(/(password|token|secret)[^,}]*/ig,'$1:[redacted]')); jsonOk(res,lines); });
  router.get('/logs/app', (_req,res)=>jsonOk(res,{message:'PM2 log reading is disabled for safety; use pm2 logs on server.'}));
  router.get('/logs/audit', async (req,res,next)=>{ try{jsonOk(res, await db.listAdminAuditLogs(req.query.limit));}catch(e){next(e);} });
  router.get('/export/users.csv', async (req,res,next)=>{ try{res.type('text/csv').send(csv(await db.listAdminUsers({...req.query,limit:200})));}catch(e){next(e);} });
  router.get('/export/servers.csv', async (req,res,next)=>{ try{res.type('text/csv').send(csv(await db.listAdminServers({...req.query,limit:200})));}catch(e){next(e);} });
  router.get('/export/wallet.csv', async (req,res,next)=>{ try{res.type('text/csv').send(csv(await db.listAdminWalletLogs({...req.query,limit:200})));}catch(e){next(e);} });
  router.get('/export/purchases.csv', async (req,res,next)=>{ try{res.type('text/csv').send(csv(await db.listAdminPurchases({...req.query,limit:200})));}catch(e){next(e);} });
  router.use((err,_req,res,_next)=>{ console.error('[DASHBOARD_API_ERROR]', err.code || err.message); jsonError(res,500,'DASHBOARD_API_ERROR','خطای داخلی داشبورد رخ داد.'); });
  return router;
}
module.exports = { createDashboardApiRouter, requireAuth, getSession, adminConfigured };
