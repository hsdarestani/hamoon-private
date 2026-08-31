'use strict';

const hetznerApi = require('../Hetzner/hetzner-api');

function normalizeServer(server = {}) {
  return {
    id: String(server.id),
    name: server.name,
    status: server.status,
    server_type: server.server_type?.name || server.server_type?.id || null,
    image: { name: server.image?.name || String(server.image?.id || '') },
    metadata: {
      user: server.labels?.user,
      type: server.labels?.type,
    },
    addresses: server.public_net?.ipv4?.ip
      ? { public: [{ version: 4, addr: server.public_net.ipv4.ip }] }
      : {},
  };
}

async function listAllHetznerServers(dcConfig, options = {}) {
  const perPage = Math.max(1, Math.min(50, Number(options.perPage || 50)));
  const maxPages = Math.max(1, Math.min(200, Number(options.maxPages || 100)));
  const rawById = new Map();
  let page = 1;

  for (let requestNo = 0; requestNo < maxPages; requestNo += 1) {
    const data = await hetznerApi.hetznerRequest(
      dcConfig,
      'GET',
      `/servers?page=${page}&per_page=${perPage}`
    );

    const servers = Array.isArray(data?.servers) ? data.servers : [];
    for (const server of servers) {
      if (server?.id == null) continue;
      rawById.set(String(server.id), server);
    }

    const nextRaw = data?.meta?.pagination?.next_page;
    const nextPage = Number(nextRaw);

    if (Number.isFinite(nextPage) && nextPage > page) {
      page = nextPage;
      continue;
    }

    // Backward-compatible fallback if pagination metadata is unavailable.
    // An extra empty page request is harmless when the last page is exactly full.
    if (nextRaw == null && servers.length === perPage) {
      page += 1;
      continue;
    }

    return [...rawById.values()].map(normalizeServer);
  }

  const error = new Error('HETZNER_SERVER_PAGINATION_LIMIT_REACHED');
  error.code = 'HETZNER_SERVER_PAGINATION_LIMIT_REACHED';
  throw error;
}

module.exports = {
  normalizeServer,
  listAllHetznerServers,
};
