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

async function getServerTraffic(dcConfig, serverId, range = 'current') {
  const selectedRange = selectedTrafficRange(range);
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

  const result = {
    server_id: String(server.id),
    server_name: server.name || String(server.id),
    status: server.status || 'unknown',
    range: selectedRange,
    incoming_traffic: Math.max(0, Number(server.ingoing_traffic || 0)),
    outgoing_traffic: Math.max(0, Number(server.outgoing_traffic || 0)),
    included_traffic: Math.max(0, Number(server.included_traffic || 0)),
    period_incoming_traffic: null,
    period_outgoing_traffic: null,
    period_available: selectedRange === 'current',
    generated_at: new Date().toISOString()
  };

  if (selectedRange === 'current') {
    result.period_incoming_traffic = result.incoming_traffic;
    result.period_outgoing_traffic = result.outgoing_traffic;
    return result;
  }

  const metrics = buildMetricsPath(serverId, selectedRange);
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
  buildMetricsPath,
  getServerTraffic
};
