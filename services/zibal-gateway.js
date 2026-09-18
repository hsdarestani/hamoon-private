'use strict';

const dns = require('dns');
const https = require('https');
const net = require('net');

const GATEWAY_HOST = 'gateway.zibal.ir';
const CONNECT_PROBE_TIMEOUT_MS = 1500;
const REQUEST_TIMEOUT_MS = 15000;

function resolve4(hostname = GATEWAY_HOST) {
  return new Promise((resolve, reject) => {
    dns.resolve4(hostname, (error, addresses) => {
      if (error) return reject(error);
      const unique = [...new Set((addresses || []).map(String).filter(Boolean))];
      if (!unique.length) return reject(Object.assign(new Error('ZIBAL_DNS_EMPTY'), { code: 'ZIBAL_DNS_EMPTY' }));
      resolve(unique);
    });
  });
}

function probeTcp(ip, port = 443, timeoutMs = CONNECT_PROBE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const socket = net.createConnection({ host: ip, port });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve({ ip, latencyMs: Date.now() - started });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(null));
    socket.once('timeout', () => finish(Object.assign(new Error('ZIBAL_TCP_TIMEOUT'), { code: 'ETIMEDOUT', ip })));
    socket.once('error', finish);
  });
}

async function selectReachableIp(excluded = new Set(), options = {}) {
  const resolver = options.resolve4 || resolve4;
  const probe = options.probeTcp || probeTcp;
  const addresses = (await resolver(GATEWAY_HOST)).filter(ip => !excluded.has(ip));
  if (!addresses.length) throw Object.assign(new Error('ZIBAL_NO_GATEWAY_IP_LEFT'), { code: 'ZIBAL_NO_GATEWAY_IP_LEFT' });

  try {
    // Do not wait for a dead A record. Use the first IP that can actually establish
    // a TCP connection to 443, then keep TLS/SNI on gateway.zibal.ir.
    return await Promise.any(addresses.map(ip => probe(ip, 443, options.probeTimeoutMs || CONNECT_PROBE_TIMEOUT_MS)));
  } catch (aggregate) {
    const error = new Error('ZIBAL_GATEWAY_UNREACHABLE');
    error.code = 'ZIBAL_GATEWAY_UNREACHABLE';
    error.addresses = addresses;
    error.cause = aggregate;
    throw error;
  }
}

function httpsAgentForIp(ip) {
  return new https.Agent({
    keepAlive: false,
    lookup(hostname, options, callback) {
      if (String(hostname).toLowerCase() === GATEWAY_HOST) {
        return callback(null, ip, 4);
      }
      return dns.lookup(hostname, options, callback);
    }
  });
}

function isSafeConnectRetry(error) {
  if (!error || error.response) return false;
  const code = String(error.code || '').toUpperCase();
  const message = String(error.message || '');
  if (['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN'].includes(code)) return true;
  if (code === 'ETIMEDOUT' && /^connect\s/i.test(message)) return true;
  return false;
}

async function postToZibal(axios, path, body, options = {}) {
  if (!axios || typeof axios.post !== 'function') throw new Error('ZIBAL_AXIOS_REQUIRED');
  const endpoint = String(path || '').startsWith('/') ? String(path) : '/' + String(path || '');
  const url = 'https://' + GATEWAY_HOST + endpoint;
  const excluded = new Set();
  const maxAttempts = Math.max(1, Math.min(4, Number(options.maxAttempts || 3)));
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let selected;
    try {
      selected = await selectReachableIp(excluded, options);
    } catch (selectError) {
      if (lastError) throw lastError;
      throw selectError;
    }

    const ip = selected.ip;
    const agent = httpsAgentForIp(ip);
    try {
      const response = await axios.post(url, body, {
        timeout: Number(options.timeoutMs || REQUEST_TIMEOUT_MS),
        httpsAgent: agent,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'HamoonCloud-Zibal/2.0',
          ...(options.headers || {})
        }
      });
      response.zibalGatewayIp = ip;
      return response;
    } catch (error) {
      error.zibalGatewayIp = ip;
      lastError = error;
      excluded.add(ip);
      if (!isSafeConnectRetry(error) || attempt >= maxAttempts) throw error;
    } finally {
      agent.destroy();
    }
  }

  throw lastError || Object.assign(new Error('ZIBAL_REQUEST_FAILED'), { code: 'ZIBAL_REQUEST_FAILED' });
}

module.exports = {
  GATEWAY_HOST,
  resolve4,
  probeTcp,
  selectReachableIp,
  httpsAgentForIp,
  isSafeConnectRetry,
  postToZibal
};
