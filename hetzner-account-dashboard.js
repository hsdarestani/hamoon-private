'use strict';

const axios = require('axios');
const datacenters = require('./datacenters');

const BASE = 'https://api.hetzner.cloud/v1';
const CACHE_MS = Number(process.env.HETZNER_ACCOUNT_USAGE_CACHE_MS || 60 * 1000);
let cache = null;

function getConfig() {
  return datacenters.hetzner ||
    Object.values(datacenters).find(dc => String(dc?.provider || dc?.apiType || '').toLowerCase().includes('hetzner')) ||
    {};
}

function getToken(config = {}) {
  return config.HETZNER_API_TOKEN || config.HETZNER_TOKEN || config.token ||
    process.env.HETZNER_API_TOKEN || process.env.HETZNER_TOKEN || process.env.HCLOUD_TOKEN || null;
}

function envNumber(name) {
  const raw = process.env[name];
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function percent(used, limit) {
  if (!Number.isFinite(limit) || limit <= 0) return null;
  return Math.round((Number(used || 0) / limit) * 1000) / 10;
}

function remaining(used, limit) {
  if (!Number.isFinite(limit)) return null;
  return Math.max(0, limit - Number(used || 0));
}

function resourceRow({ key, label, used, limit = null, source = 'Hetzner API usage', note = '' }) {
  return {
    key,
    label,
    used: Number(used || 0),
    limit: Number.isFinite(limit) ? Number(limit) : null,
    remaining: remaining(used, limit),
    usage_percent: percent(used, limit),
    limit_source: Number.isFinite(limit) ? source : 'سقف اختصاصی از API عمومی Hetzner قابل دریافت نیست',
    note
  };
}

async function request(http, path) {
  const response = await http.get(path);
  return response;
}

async function totalFor(http, path) {
  const response = await request(http, path + (path.includes('?') ? '&' : '?') + 'per_page=1');
  return {
    total: Number(response.data?.meta?.pagination?.total_entries || 0),
    headers: response.headers || {}
  };
}

async function fetchAllServers(http) {
  const first = await request(http, '/servers?per_page=50&page=1');
  const servers = [...(first.data?.servers || [])];
  const lastPage = Number(first.data?.meta?.pagination?.last_page || 1);
  for (let page = 2; page <= lastPage; page += 1) {
    const response = await request(http, `/servers?per_page=50&page=${page}`);
    servers.push(...(response.data?.servers || []));
  }
  return { servers, headers: first.headers || {} };
}

async function fetchAllPrimaryIps(http) {
  const first = await request(http, '/primary_ips?per_page=50&page=1');
  const primaryIps = [...(first.data?.primary_ips || [])];
  const lastPage = Number(first.data?.meta?.pagination?.last_page || 1);
  for (let page = 2; page <= lastPage; page += 1) {
    const response = await request(http, `/primary_ips?per_page=50&page=${page}`);
    primaryIps.push(...(response.data?.primary_ips || []));
  }
  return { primaryIps, headers: first.headers || {} };
}

function serverCpuStats(servers) {
  let sharedServers = 0;
  let dedicatedServers = 0;
  let sharedCores = 0;
  let dedicatedCores = 0;
  for (const server of servers || []) {
    const cpuType = String(server?.server_type?.cpu_type || '').toLowerCase();
    const cores = Number(server?.server_type?.cores || 0);
    if (cpuType === 'dedicated') {
      dedicatedServers += 1;
      dedicatedCores += cores;
    } else {
      sharedServers += 1;
      sharedCores += cores;
    }
  }
  return { sharedServers, dedicatedServers, sharedCores, dedicatedCores };
}

async function getHetznerAccountUsage({ force = false } = {}) {
  if (!force && cache && cache.expires > Date.now()) return cache.value;

  const config = getConfig();
  const token = getToken(config);
  if (!token) {
    const error = new Error('Hetzner API token is missing');
    error.code = 'HETZNER_TOKEN_MISSING';
    throw error;
  }

  const http = axios.create({
    baseURL: BASE,
    headers: { Authorization: `Bearer ${token}` },
    timeout: 20000
  });

  const [
    serverResult,
    primaryIpResult,
    floatingResult,
    volumeResult,
    networkResult,
    firewallResult,
    loadBalancerResult,
    placementResult,
    sshKeyResult
  ] = await Promise.all([
    fetchAllServers(http),
    fetchAllPrimaryIps(http),
    totalFor(http, '/floating_ips'),
    totalFor(http, '/volumes'),
    totalFor(http, '/networks'),
    totalFor(http, '/firewalls'),
    totalFor(http, '/load_balancers'),
    totalFor(http, '/placement_groups'),
    totalFor(http, '/ssh_keys')
  ]);

  const primaryIps = primaryIpResult.primaryIps || [];
  const ipv4 = primaryIps.filter(ip => String(ip?.type || '').toLowerCase() === 'ipv4').length;
  const ipv6 = primaryIps.filter(ip => String(ip?.type || '').toLowerCase() === 'ipv6').length;
  const assignedPrimaryIps = primaryIps.filter(ip => ip?.assignee_id != null).length;
  const unassignedPrimaryIps = primaryIps.length - assignedPrimaryIps;
  const autoDeletePrimaryIps = primaryIps.filter(ip => ip?.auto_delete === true).length;

  const servers = serverResult.servers || [];
  const cpu = serverCpuStats(servers);
  const serverLimit = envNumber('HETZNER_SERVER_LIMIT');
  const dedicatedCoreLimit = envNumber('HETZNER_DEDICATED_CORE_LIMIT');
  const primaryIpLimit = serverLimit == null ? null : serverLimit * 2;
  const floatingLimit = envNumber('HETZNER_FLOATING_IP_LIMIT');
  const volumeLimit = envNumber('HETZNER_VOLUME_LIMIT');
  const networkLimit = envNumber('HETZNER_NETWORK_LIMIT');
  const firewallLimit = envNumber('HETZNER_FIREWALL_LIMIT');
  const loadBalancerLimit = envNumber('HETZNER_LOAD_BALANCER_LIMIT');
  const placementLimit = envNumber('HETZNER_PLACEMENT_GROUP_LIMIT');

  const rateProbe = await totalFor(http, '/servers');
  const rateHeaders = rateProbe.headers || serverResult.headers || {};
  const apiRateLimit = Number(rateHeaders['ratelimit-limit'] || 0) || null;
  const apiRateRemaining = Number(rateHeaders['ratelimit-remaining'] || 0);
  const apiRateReset = Number(rateHeaders['ratelimit-reset'] || 0) || null;

  const resources = [
    resourceRow({
      key: 'servers',
      label: 'Cloud Servers',
      used: servers.length,
      limit: serverLimit,
      source: 'HETZNER_SERVER_LIMIT',
      note: 'Hetzner این سقف سفارشی پروژه را از Public API برنمی‌گرداند.'
    }),
    resourceRow({
      key: 'primary_ips',
      label: 'Primary IPs',
      used: primaryIps.length,
      limit: primaryIpLimit,
      source: '۲ × Server limit (قاعده رسمی Hetzner)',
      note: serverLimit == null ? 'برای محاسبه عدد دقیق، Server limit پروژه باید در config ثبت شود.' : ''
    }),
    resourceRow({
      key: 'primary_ipv4',
      label: 'Primary IPv4',
      used: ipv4 == null ? 0 : ipv4,
      limit: null,
      note: 'Hetzner سقف جداگانه IPv4 پروژه را در Public API اعلام نمی‌کند.'
    }),
    resourceRow({
      key: 'primary_ipv6',
      label: 'Primary IPv6',
      used: ipv6 == null ? 0 : ipv6,
      limit: null,
      note: 'Hetzner سقف جداگانه IPv6 پروژه را در Public API اعلام نمی‌کند.'
    }),
    resourceRow({
      key: 'dedicated_cores',
      label: 'Dedicated CPU Cores',
      used: cpu.dedicatedCores,
      limit: dedicatedCoreLimit,
      source: 'HETZNER_DEDICATED_CORE_LIMIT',
      note: process.env.HETZNER_ALLOW_DEDICATED_CORE === 'true'
        ? 'فروش Dedicated Core فعال است.'
        : 'فروش Dedicated Core فعلاً غیرفعال است؛ اخیراً quota این منبع پر شده بود.'
    }),
    resourceRow({ key: 'floating_ips', label: 'Floating IPs', used: floatingResult.total, limit: floatingLimit, source: 'HETZNER_FLOATING_IP_LIMIT' }),
    resourceRow({ key: 'volumes', label: 'Volumes', used: volumeResult.total, limit: volumeLimit, source: 'HETZNER_VOLUME_LIMIT' }),
    resourceRow({ key: 'networks', label: 'Networks', used: networkResult.total, limit: networkLimit, source: 'HETZNER_NETWORK_LIMIT' }),
    resourceRow({ key: 'firewalls', label: 'Firewalls', used: firewallResult.total, limit: firewallLimit, source: 'HETZNER_FIREWALL_LIMIT' }),
    resourceRow({ key: 'load_balancers', label: 'Load Balancers', used: loadBalancerResult.total, limit: loadBalancerLimit, source: 'HETZNER_LOAD_BALANCER_LIMIT' }),
    resourceRow({ key: 'placement_groups', label: 'Placement Groups', used: placementResult.total, limit: placementLimit, source: 'HETZNER_PLACEMENT_GROUP_LIMIT' }),
    resourceRow({ key: 'ssh_keys', label: 'SSH Keys', used: sshKeyResult.total, limit: null })
  ];

  const value = {
    updated_at: new Date().toISOString(),
    cache_seconds: Math.round(CACHE_MS / 1000),
    resources,
    server_breakdown: {
      total: servers.length,
      shared_servers: cpu.sharedServers,
      dedicated_servers: cpu.dedicatedServers,
      shared_cores: cpu.sharedCores,
      dedicated_cores: cpu.dedicatedCores
    },
    primary_ips: {
      total: primaryIps.length,
      ipv4,
      ipv6,
      assigned: assignedPrimaryIps,
      unassigned: unassignedPrimaryIps,
      auto_delete: autoDeletePrimaryIps,
      derived_limit: primaryIpLimit,
      server_limit: serverLimit,
      formula: 'Primary IP limit = Server limit × 2'
    },
    api_rate_limit: {
      limit_per_hour: apiRateLimit,
      remaining: apiRateRemaining,
      reset_unix: apiRateReset
    },
    configured_limits: {
      server_limit: serverLimit,
      dedicated_core_limit: dedicatedCoreLimit,
      primary_ip_limit: primaryIpLimit,
      floating_ip_limit: floatingLimit,
      volume_limit: volumeLimit,
      network_limit: networkLimit,
      firewall_limit: firewallLimit,
      load_balancer_limit: loadBalancerLimit,
      placement_group_limit: placementLimit
    },
    platform_rules: [
      { label: 'Primary IP کل پروژه', value: 'Server limit × 2', source: 'Hetzner Docs' },
      { label: 'Primary IPv4 برای هر Server', value: 'حداکثر ۱', source: 'Hetzner Docs' },
      { label: 'Primary IPv6 برای هر Server', value: 'حداکثر ۱', source: 'Hetzner Docs' },
      { label: 'Floating IP برای هر Server', value: 'حداکثر ۲۰', source: 'Hetzner Docs' },
      { label: 'Network برای هر Server', value: 'حداکثر ۳', source: 'Hetzner Docs' },
      { label: 'Firewall برای هر Server', value: 'حداکثر ۵', source: 'Hetzner Docs' },
      { label: 'Volume برای هر Server', value: 'حداکثر ۱۶', source: 'Hetzner Docs' },
      { label: 'Placement Group برای هر Server', value: 'حداکثر ۱', source: 'Hetzner Docs' }
    ],
    limitations: [
      'Hetzner Cloud Public API مصرف منابع را می‌دهد ولی سقف‌های سفارشی پروژه را expose نمی‌کند.',
      'برای نمایش سقف دقیق قابل افزایش، مقدار limit مربوطه را در env سرور تنظیم کنید.',
      'عدد مصرف منابع از API واقعی همین پروژه خوانده می‌شود.'
    ]
  };

  cache = { value, expires: Date.now() + CACHE_MS };
  return value;
}

module.exports = { getHetznerAccountUsage };
