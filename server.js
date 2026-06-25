'use strict';
require('dotenv').config();
const path = require('path');
const express = require('express');
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
app.use((_req,res)=>res.status(404).json({ ok:false, error:'NOT_FOUND', message:'مسیر پیدا نشد.' }));
app.listen(port, () => console.log(`[dashboard-server] listening on ${port}; /dashboard route enabled`));
