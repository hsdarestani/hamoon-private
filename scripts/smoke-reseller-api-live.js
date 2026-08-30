'use strict';

const baseUrl = String(process.env.RESELLER_API_SMOKE_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const apiKey = String(process.env.HAMOON_RESELLER_TEST_KEY || '').trim();

async function request(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${baseUrl}${path}`, { ...options, signal: controller.signal });
    let body = null;
    try { body = await response.json(); } catch (_) {}
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const unauth = await request('/api/v1/me');
  if (unauth.response.status !== 401) {
    throw new Error(`Expected 401 from unauthenticated /api/v1/me, got ${unauth.response.status}`);
  }
  if (!unauth.response.headers.get('x-request-id')) {
    throw new Error('Missing X-Request-Id on reseller API response');
  }
  if (unauth.body?.error?.code !== 'AUTH_REQUIRED') {
    throw new Error(`Unexpected auth error payload: ${JSON.stringify(unauth.body)}`);
  }
  console.log('PASS unauthenticated route guard');

  if (!apiKey) {
    console.log('SKIP authenticated read-only checks: HAMOON_RESELLER_TEST_KEY is not configured');
    return;
  }

  const headers = { Authorization: `Bearer ${apiKey}` };
  for (const path of ['/api/v1/me', '/api/v1/wallet', '/api/v1/prices', '/api/v1/servers']) {
    const out = await request(path, { headers });
    if (out.response.status !== 200 || !out.body?.ok) {
      throw new Error(`${path} failed: HTTP ${out.response.status} ${JSON.stringify(out.body)}`);
    }
    console.log(`PASS ${path}`);
  }
}

main().catch(error => {
  console.error('[RESELLER_API_SMOKE_FAILED]', error.message || error);
  process.exit(1);
});
