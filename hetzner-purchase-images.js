'use strict';

const axios = require('axios');

const BASE = 'https://api.hetzner.cloud/v1';
const CACHE_TTL_MS = Math.max(1000, Number(process.env.HETZNER_IMAGE_CACHE_MS || 10 * 60 * 1000));
const STALE_CACHE_MS = Math.max(CACHE_TTL_MS, Number(process.env.HETZNER_IMAGE_STALE_CACHE_MS || 24 * 60 * 60 * 1000));
const imageCache = new Map();

function architectureForServerType(serverType) {
  return String(serverType || '').trim().toLowerCase().startsWith('cax') ? 'arm' : 'x86';
}

function getToken(dcConfig = {}) {
  return dcConfig.api_token || dcConfig.HETZNER_API_TOKEN || dcConfig.HETZNER_TOKEN || dcConfig.apiToken || dcConfig.token ||
    process.env.HETZNER_API_TOKEN || process.env.HETZNER_TOKEN || process.env.HCLOUD_TOKEN || null;
}

function imageArchitecture(image = {}) {
  const explicit = image.architecture || image.arch || image.labels?.architecture;
  if (explicit) return String(explicit).toLowerCase();
  return String(image.name || image.label || image.id || '').toLowerCase().includes('arm') ? 'arm' : 'x86';
}

function imageErrorStatus(error) {
  const value = Number(error?.response?.status ?? error?.status ?? error?.statusCode);
  return Number.isFinite(value) ? value : null;
}

function isRetryableImageError(error) {
  const status = imageErrorStatus(error);
  if (status === 429 || (status != null && status >= 500 && status <= 599)) return true;
  const code = String(error?.code || '').toUpperCase();
  if (['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code)) return true;
  const message = String(error?.message || '').toLowerCase();
  return message.includes('timeout') || message.includes('network error') || message.includes('socket hang up');
}

function retryDelays() {
  const parsed = String(process.env.HETZNER_IMAGE_RETRY_MS || '400,900')
    .split(',')
    .map(value => Number(value.trim()))
    .filter(value => Number.isFinite(value) && value >= 0)
    .map(value => Math.min(value, 5000));
  return parsed.length ? parsed : [400, 900];
}

function cacheKey(architecture) {
  return String(architecture || 'x86').toLowerCase();
}

async function fetchImagesWithRetry(token, architecture, options = {}) {
  const delays = Array.isArray(options.delays) ? options.delays : retryDelays();
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const request = options.request || (() => axios.get(`${BASE}/images`, {
    timeout: 20000,
    headers: { Authorization: `Bearer ${token}` },
    params: {
      type: 'system',
      status: 'available',
      architecture,
      per_page: 200,
    },
  }));

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      if (!isRetryableImageError(error) || attempt >= delays.length) throw error;
      const delayMs = Math.max(0, Number(delays[attempt]) || 0);
      console.warn('[HETZNER_IMAGE_RETRY]', {
        architecture,
        attempt: attempt + 1,
        delay_ms: delayMs,
        status: imageErrorStatus(error),
        code: error?.code || null,
      });
      if (delayMs > 0) await sleep(delayMs);
    }
  }
}

function normalizeImages(response, dcConfig, architecture) {
  const byName = new Map();
  for (const image of Array.isArray(response?.data?.images) ? response.data.images : []) {
    if (!image || image.deprecated) continue;
    if (!imageArchitecture(image).startsWith(architecture)) continue;

    const key = String(image.name || image.id).toLowerCase().trim();
    const previous = byName.get(key);
    const isNewer = !previous || new Date(image.created || 0) > new Date(previous.created || 0);
    if (isNewer) byName.set(key, image);
  }

  const dynamic = [...byName.values()].map(image => ({
    id: String(image.id),
    label: image.description || image.name || String(image.id),
    name: image.name || String(image.id),
    architecture: image.architecture || architecture,
    deprecated: !!image.deprecated,
  }));

  const fixed = (dcConfig.images || [])
    .map(image => ({
      id: String(image.id ?? image.name ?? image.label ?? image),
      label: image.label || image.name || String(image.id ?? image),
      name: image.name || String(image.id ?? image),
      architecture: image.architecture || image.arch || architecture,
      deprecated: !!image.deprecated,
    }))
    .filter(image => !image.deprecated && imageArchitecture(image).startsWith(architecture));

  const unique = new Map();
  for (const image of [...fixed, ...dynamic]) unique.set(String(image.name || image.id).toLowerCase(), image);
  return [...unique.values()].sort((a, b) => String(a.label).localeCompare(String(b.label)));
}

async function listCompatibleImages(dcConfig = {}, serverType) {
  const token = getToken(dcConfig);
  if (!token) throw new Error('Hetzner API token is missing');

  const architecture = architectureForServerType(serverType);
  const key = cacheKey(architecture);
  const now = Date.now();
  const cached = imageCache.get(key);
  if (cached?.images?.length && now - cached.savedAt <= CACHE_TTL_MS) return cached.images;

  try {
    const response = await fetchImagesWithRetry(token, architecture);
    const images = normalizeImages(response, dcConfig, architecture);
    if (!images.length) {
      const err = new Error(`No ${architecture} Hetzner images are currently available`);
      err.code = 'HETZNER_IMAGE_CATALOG_EMPTY';
      throw err;
    }
    imageCache.set(key, { images, savedAt: now });
    return images;
  } catch (error) {
    if (cached?.images?.length && now - cached.savedAt <= STALE_CACHE_MS && isRetryableImageError(error)) {
      console.warn('[HETZNER_IMAGE_STALE_CACHE]', {
        architecture,
        age_ms: now - cached.savedAt,
        status: imageErrorStatus(error),
        code: error?.code || null,
      });
      return cached.images;
    }
    throw error;
  }
}

module.exports = {
  architectureForServerType,
  getToken,
  imageArchitecture,
  imageErrorStatus,
  isRetryableImageError,
  retryDelays,
  fetchImagesWithRetry,
  normalizeImages,
  listCompatibleImages,
};
