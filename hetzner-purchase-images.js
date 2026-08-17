'use strict';

const axios = require('axios');

const BASE = 'https://api.hetzner.cloud/v1';

function architectureForServerType(serverType) {
  return String(serverType || '').trim().toLowerCase().startsWith('cax') ? 'arm' : 'x86';
}

function getToken(dcConfig = {}) {
  return dcConfig.HETZNER_API_TOKEN || dcConfig.HETZNER_TOKEN || dcConfig.token ||
    process.env.HETZNER_API_TOKEN || process.env.HETZNER_TOKEN || process.env.HCLOUD_TOKEN || null;
}

function imageArchitecture(image = {}) {
  const explicit = image.architecture || image.arch || image.labels?.architecture;
  if (explicit) return String(explicit).toLowerCase();
  return String(image.name || image.label || image.id || '').toLowerCase().includes('arm') ? 'arm' : 'x86';
}

async function listCompatibleImages(dcConfig = {}, serverType) {
  const token = getToken(dcConfig);
  if (!token) throw new Error('Hetzner API token is missing');

  const architecture = architectureForServerType(serverType);
  const response = await axios.get(`${BASE}/images`, {
    timeout: 20000,
    headers: { Authorization: `Bearer ${token}` },
    params: {
      type: 'system',
      status: 'available',
      architecture,
      per_page: 200,
    },
  });

  const byName = new Map();
  for (const image of Array.isArray(response.data?.images) ? response.data.images : []) {
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

  const images = [...unique.values()].sort((a, b) => String(a.label).localeCompare(String(b.label)));
  if (!images.length) {
    const err = new Error(`No ${architecture} Hetzner images are currently available`);
    err.code = 'HETZNER_IMAGE_CATALOG_EMPTY';
    throw err;
  }

  return images;
}

module.exports = {
  architectureForServerType,
  imageArchitecture,
  listCompatibleImages,
};
