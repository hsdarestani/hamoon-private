'use strict';

const { hetznerRequest } = require('./Hetzner/hetzner-api');

const VALID_RANGES = new Set(['current', '24h', '7d', '30d']);
const HOURS_BY_RANGE = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30 };
const STEP_BY_RANGE = { '24h': 60, '7d': 300, '30d': 1800 };

function integrateHetznerBandwidthSeries(values = [], fallbackStep = 60) {
  let total = 0;
  const rows = Array.isArray(values) ? values : [];

  for (let i = 0; i < rows.length; i += 1) {
    const timestamp = Number(rows[i]?.[0]);
    const bandwidth = Math.max(0, Number(rows[i]?.[1] || 0));
    const nextTimestamp = Number(rows[i + 1]?.[0]);
    let seconds = Number.isFinite(nextTimestamp) && nextTimestamp > timestamp
      ? nextTimestamp - timestamp
      : fallbackStep;

    seconds = Math.max(1, Math.min(seconds, fallbackStep * 4));
    total += bandwidth * seconds;
  }

  return Math.max(0, total);
}

function sumHetznerMetricDirection(timeSeries, direction, step) {
  let total = 0;

  for (const [key, value] of Object.entries(timeSeries || {})) {
    if (!String(key).endsWith(`.bandwidth.${direction}`)) continue;
    total += integrateHetznerBandwidthSeries(value?.values, step);
  }

  return Math.max(0, total);
}

function selectedTrafficRange(range) {
  const value = String(range || 'current');
  return VALID_RANGES.has(value) ? value : 'current';
}

function currentHetznerTrafficPeriod(now = new Date()) {
  const value = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(value.getTime())) throw new Error('INVALID_TRAFFIC_PERIOD_DATE');
  const start = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1, 0, 0, 0));
  const reset = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 1, 0, 0, 0));
  return {
    basis: 'calendar_month',
    start: start.toISOString(),
    reset: reset.toISOString()
  };
}

function buildMetricsPath(serverId, range, now = new Date()) {
  const selected = selectedTrafficRange(range);
  if (selected === 'current') return null;

  const hours = HOURS_BY_RANGE[selected];
  const step = STEP_BY_RANGE[selected];
  const end = now instanceof Date ? now : new Date(now);
  const start = new Date(end.getTime() - hours * 3600000);
  const params = new URLSearchParams({
    type: 'network',
    start: start.toISOString(),
    end: end.toISOString(),
    step: String(step)
  });

  return {
    path: `/servers/${encodeURIComponent(serverId)}/metrics?${params.toString()}`,
    step
  };
}

function normalizeLocation(value) {
  return String(value?.name || value || '').trim().toLowerCase();
}

function getServerTrafficPricing(server, dcConfig = {}) {
  const prices = Array.isArray(server?.server_type?.prices) ? server.server_type.prices : [];
  const wanted = [
    normalizeLocation(server?.datacenter?.location?.name),
    normalizeLocation(server?.datacenter?.location),
    normalizeLocation(dcConfig?.HETZNER_LOCATION),
    normalizeLocation(dcConfig?.location)
  ].filter(Boolean);

  let price = null;
  for (const location of wanted) {
    price = prices.find(item => normalizeLocation(item?.location) === location) || null;
    if (price) break;
  }
  if (!price && prices.length === 1) price = prices[0];

  const includedTraffic = Math.max(0, Number(
    price?.included_traffic ??
    server?.included_traffic ??
    0
  ));
  const pricePerTbTraffic = Number(
    price?.price_per_tb_traffic?.gross ??
    price?.price_per_tb_traffic?.net ??
    process.env.HETZNER_TRAFFIC_EUR_PER_TB ??
    0
  );

  return {
    included_traffic: includedTraffic,
    price_per_tb_traffic: Math.max(0, pricePerTbTraffic),
    currency: String(process.env.HETZNER_TRAFFIC_CURRENCY || 'EUR'),
    pricing_location: price?.location || wanted[0] || null
  };
}

async function getServerTraffic(dcConfig, serverId, range = 'current') {
  const selectedRange = selectedTrafficRange(range);
  const generatedAt = new Date();
  const currentPeriod = currentHetznerTrafficPeriod(generatedAt);
  const serverData = await hetznerRequest(
    dcConfig,
    'GET',
    `/servers/${encodeURIComponent(serverId)}`
  );
  const server = serverData?.server;

  if (!server) {
    const error = new Error('HETZNER_SERVER_NOT_FOUND');
    error.code = 'HETZNER_SERVER_NOT_FOUND';
    error.status = 404;
    throw error;
  }

  const pricing = getServerTrafficPricing(server, dcConfig);
  const result = {
    server_id: String(server.id),
    server_name: server.name || String(server.id),
    status: server.status || 'unknown',
    range: selectedRange,
    incoming_traffic: Math.max(0, Number(server.ingoing_traffic || 0)),
    outgoing_traffic: Math.max(0, Number(server.outgoing_traffic || 0)),
    included_traffic: pricing.included_traffic,
    price_per_tb_traffic: pricing.price_per_tb_traffic,
    traffic_price_currency: pricing.currency,
    pricing_location: pricing.pricing_location,
    period_incoming_traffic: null,
    period_outgoing_traffic: null,
    period_available: selectedRange === 'current',
    traffic_period_basis: currentPeriod.basis,
    traffic_period_start: currentPeriod.start,
    traffic_period_reset: currentPeriod.reset,
    generated_at: generatedAt.toISOString()
  };

  if (selectedRange === 'current') {
    // Hetzner's server counters are provider-authoritative for the current
    // calendar-month allowance. Billing is based on outgoing traffic only.
    result.period_incoming_traffic = result.incoming_traffic;
    result.period_outgoing_traffic = result.outgoing_traffic;
    return result;
  }

  const metrics = buildMetricsPath(serverId, selectedRange, generatedAt);
  try {
    const metricData = await hetznerRequest(dcConfig, 'GET', metrics.path);
    const timeSeries = metricData?.metrics?.time_series || {};
    result.period_incoming_traffic = sumHetznerMetricDirection(timeSeries, 'in', metrics.step);
    result.period_outgoing_traffic = sumHetznerMetricDirection(timeSeries, 'out', metrics.step);
    result.period_available = true;
  } catch (error) {
    const status = Number(error?.response?.status || error?.status || 0);
    if (status === 404) throw error;
    result.period_available = false;
    result.metric_error = String(error?.code || error?.message || 'metrics unavailable').slice(0, 180);
  }

  return result;
}

module.exports = {
  VALID_RANGES,
  HOURS_BY_RANGE,
  STEP_BY_RANGE,
  integrateHetznerBandwidthSeries,
  sumHetznerMetricDirection,
  selectedTrafficRange,
  currentHetznerTrafficPeriod,
  buildMetricsPath,
  getServerTrafficPricing,
  getServerTraffic
};
