'use strict';
require('dotenv').config();
const path = require('path');
const express = require('express');
const db = require('./db');
const { createDashboardApiRouter, requireAuth } = require('./dashboard-api');
const { createCustomerApiRouter } = require('./customer-api');
const { consumeConsoleSession } = require('./console-session');
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

const dashboardDir = path.join(__dirname, 'public', 'dashboard');
const consoleDir = path.join(__dirname, 'public', 'console');
const noVncDir = path.join(__dirname, 'node_modules', '@novnc', 'novnc');

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
app.use((_req, res) => res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'مسیر پیدا نشد.' }));

app.listen(port, () => console.log(`[dashboard-server] listening on ${port}; /dashboard and /console routes enabled`));
