'use strict';

const CHECK_HOST_ORIGIN = 'https://check-host.net';
const INSTALL_MARK = Symbol.for('hamoon.strictCheckHostFetchInstalled');
const syntheticRequests = new Map();
let sequence = 0;

function jsonResponse(payload, status = 200) {
  if (typeof Response === 'function') {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' }
    });
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; }
  };
}

async function readJson(response) {
  if (!response || typeof response.json !== 'function') throw new Error('STRICT_CHECK_HOST_BAD_RESPONSE');
  return await response.json();
}

function flattenPingStatuses(value, out = []) {
  if (typeof value === 'string') {
    const state = value.toUpperCase();
    if (state === 'OK') out.push(true);
    else if (state.includes('TIMEOUT') || state.includes('MALFORMED') || state.includes('ERROR') || state.includes('FAIL')) out.push(false);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenPingStatuses(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) flattenPingStatuses(item, out);
  }
  return out;
}

function strictPingState(value) {
  if (value === null || value === undefined) return null;
  const statuses = flattenPingStatuses(value);
  // Check-Host normally returns four ICMP attempts. Do not call a node healthy
  // because a single packet slipped through; wait for at least 3 observations.
  if (statuses.length < 3) return null;
  const ok = statuses.filter(Boolean).length;
  const required = Math.max(3, Math.ceil(statuses.length * 0.75));
  return ok >= required;
}

function tcpNodeState(value) {
  if (value === null || value === undefined) return null;
  let sawSuccess = false;
  let sawFailure = false;
  const visit = v => {
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (!v || typeof v !== 'object') return;
    if (v.error) sawFailure = true;
    if ((Number.isFinite(Number(v.time)) && Number(v.time) >= 0) || v.address) sawSuccess = true;
    for (const item of Object.values(v)) {
      if (item && typeof item === 'object') visit(item);
    }
  };
  visit(value);
  if (sawSuccess) return true;
  if (sawFailure) return false;
  return null;
}

function nodeResultForOriginalParser(state) {
  if (state === null) return null;
  return state ? [[['OK', 0.01]]] : [[['TIMEOUT', 3.0]]];
}

function copySelectedNodes(fromUrl, toUrl) {
  for (const node of fromUrl.searchParams.getAll('node')) toUrl.searchParams.append('node', node);
}

async function dispatchStrictProbe(originalFetch, requestUrl, init) {
  const ip = requestUrl.searchParams.get('host');
  if (!ip) return originalFetch(requestUrl, init);

  const pingUrl = new URL(requestUrl.toString());
  const tcpUrl = new URL(`${CHECK_HOST_ORIGIN}/check-tcp`);
  tcpUrl.searchParams.set('host', `${ip}:22`);
  copySelectedNodes(requestUrl, tcpUrl);

  const [pingResponse, tcpResponse] = await Promise.all([
    originalFetch(pingUrl, init),
    originalFetch(tcpUrl, init)
  ]);
  if (!pingResponse?.ok) return pingResponse;
  if (!tcpResponse?.ok) return tcpResponse;

  const [pingPayload, tcpPayload] = await Promise.all([readJson(pingResponse), readJson(tcpResponse)]);
  if (!pingPayload?.ok || !pingPayload?.request_id || !tcpPayload?.ok || !tcpPayload?.request_id) {
    return jsonResponse({ ok: 0, error: 'STRICT_CHECK_HOST_DISPATCH_FAILED' }, 502);
  }

  const syntheticId = `hamoon-strict-${Date.now()}-${++sequence}`;
  syntheticRequests.set(syntheticId, {
    pingId: String(pingPayload.request_id),
    tcpId: String(tcpPayload.request_id),
    nodes: requestUrl.searchParams.getAll('node'),
    createdAt: Date.now()
  });
  return jsonResponse({
    ok: 1,
    request_id: syntheticId,
    permanent_link: pingPayload.permanent_link || null,
    nodes: pingPayload.nodes || tcpPayload.nodes || {}
  });
}

async function readStrictResult(originalFetch, syntheticId, init) {
  const pending = syntheticRequests.get(syntheticId);
  if (!pending) return originalFetch(`${CHECK_HOST_ORIGIN}/check-result/${encodeURIComponent(syntheticId)}`, init);

  const [pingResponse, tcpResponse] = await Promise.all([
    originalFetch(`${CHECK_HOST_ORIGIN}/check-result/${encodeURIComponent(pending.pingId)}`, init),
    originalFetch(`${CHECK_HOST_ORIGIN}/check-result/${encodeURIComponent(pending.tcpId)}`, init)
  ]);
  if (!pingResponse?.ok) return pingResponse;
  if (!tcpResponse?.ok) return tcpResponse;

  const [pingResult, tcpResult] = await Promise.all([readJson(pingResponse), readJson(tcpResponse)]);
  const merged = {};
  for (const node of pending.nodes) {
    const ping = strictPingState(pingResult?.[node]);
    const tcp = tcpNodeState(tcpResult?.[node]);
    const state = ping === null || tcp === null ? null : (ping && tcp);
    merged[node] = nodeResultForOriginalParser(state);
  }

  if (Date.now() - pending.createdAt > 120000) syntheticRequests.delete(syntheticId);
  return jsonResponse(merged);
}

function installStrictCheckHostFetch() {
  if (global[INSTALL_MARK]) return false;
  if (typeof global.fetch !== 'function') throw new Error('FETCH_UNAVAILABLE');

  const originalFetch = global.fetch.bind(global);
  global.fetch = async function strictCheckHostFetch(input, init) {
    let url;
    try {
      url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input?.url);
    } catch {
      return originalFetch(input, init);
    }

    if (url.origin !== CHECK_HOST_ORIGIN) return originalFetch(input, init);
    if (url.pathname === '/check-ping') return dispatchStrictProbe(originalFetch, url, init);
    if (url.pathname.startsWith('/check-result/')) {
      const id = decodeURIComponent(url.pathname.slice('/check-result/'.length));
      if (id.startsWith('hamoon-strict-')) return readStrictResult(originalFetch, id, init);
    }
    return originalFetch(input, init);
  };
  global[INSTALL_MARK] = true;
  return true;
}

module.exports = {
  installStrictCheckHostFetch,
  strictPingState,
  tcpNodeState,
  flattenPingStatuses
};
