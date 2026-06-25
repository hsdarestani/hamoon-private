const axios = require('axios');

function formatBillingCycleFa(duration) {
  return ({ hourly: 'ساعتی', daily: 'روزانه', weekly: 'هفتگی', monthly: 'ماهانه' })[duration] || String(duration || 'نامشخص');
}

function formatBillingAmountLabel(amount, duration) {
  const n = Number(amount || 0).toLocaleString('en-US');
  const labels = { hourly: 'مبلغ ساعتی', daily: 'مبلغ روزانه', weekly: 'مبلغ هفتگی', monthly: 'مبلغ ماهانه' };
  return `${labels[duration] || 'مبلغ'}: ${n} تومان`;
}

function freeAllowanceForDuration(purchase) {
  const d = String(purchase?.duration || 'hourly');
  const field = {
    hourly: 'free_traffic_hourly_gb',
    daily: 'free_traffic_daily_gb',
    weekly: 'free_traffic_weekly_gb',
    monthly: 'free_traffic_monthly_gb',
  }[d] || 'free_traffic_hourly_gb';
  return Number(purchase?.[field] || 0);
}

async function fetchServerTraffic(dcConfig, serverId, startUnix, endUnix) {
  if (!dcConfig?.TRAFFIC_API_BASE_URL) {
    throw new Error('TRAFFIC_API_BASE_URL_MISSING');
  }
  if (!dcConfig?.TRAFFIC_API_KEY) {
    throw new Error('TRAFFIC_API_KEY_MISSING');
  }

  const url =
    `${dcConfig.TRAFFIC_API_BASE_URL}${encodeURIComponent(serverId)}` +
    `?start_time=${startUnix}&end_time=${endUnix}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const resp = await fetch(url, {
      headers: {
        Authorization: dcConfig.TRAFFIC_API_KEY
      },
      signal: controller.signal
    });

    const text = await resp.text();

    if (!resp.ok) {
      throw new Error(`Traffic API ${resp.status} ${resp.statusText}: ${text.slice(0, 300)}`);
    }

    const data = text ? JSON.parse(text) : {};

    if (
      !Object.prototype.hasOwnProperty.call(data, 'received_gb') ||
      !Object.prototype.hasOwnProperty.call(data, 'transmitted_gb')
    ) {
      throw new Error(`Traffic API invalid response shape: ${text.slice(0, 300)}`);
    }

    return {
      instance_id: data.instance_id || serverId,
      received_gb: Number(data.received_gb) || 0,
      transmitted_gb: Number(data.transmitted_gb) || 0
    };
  } finally {
    clearTimeout(timeout);
  }
}


async function calculateTrafficCost(purchase, periodStart, periodEnd, dcConfig) {
  const startUnix = Math.floor(new Date(periodStart || purchase.created_at || Date.now()).getTime() / 1000);
  const endUnix = Math.floor(new Date(periodEnd || Date.now()).getTime() / 1000);
  const traffic = await fetchServerTraffic(dcConfig, purchase.server_id, startUnix, endUnix);
  const normalizedTraffic = normalizeTrafficDirection(dcConfig, traffic);
  const rawBillableGb = Number(purchase.download_only) === 1
    ? normalizedTraffic.download_gb
    : normalizedTraffic.download_gb + normalizedTraffic.upload_gb;
  const freeAllowanceGb = freeAllowanceForDuration(purchase);
  const cumulativeBillableAfterFreeGb = Math.max(0, rawBillableGb - freeAllowanceGb);
  const alreadyBilledGb = Number(purchase.last_billed_traffic_gb || 0);
  const newBillableGb = Math.max(0, cumulativeBillableAfterFreeGb - alreadyBilledGb);
  const pricePerGb = Number(purchase.price_per_gb || 0);
  const trafficCost = Math.round(newBillableGb * pricePerGb);
  return {
    traffic,
    provider_received_gb: traffic.received_gb,
    provider_transmitted_gb: traffic.transmitted_gb,
    received_gb: normalizedTraffic.download_gb,
    transmitted_gb: normalizedTraffic.upload_gb,
    download_gb: normalizedTraffic.download_gb,
    upload_gb: normalizedTraffic.upload_gb,
    rawBillableGb,
    freeAllowanceGb,
    cumulativeBillableAfterFreeGb,
    alreadyBilledGb,
    newBillableGb,
    pricePerGb,
    trafficCost,
    startUnix,
    endUnix
  };
}

module.exports = {
  normalizeTrafficDirection, formatBillingCycleFa, formatBillingAmountLabel, fetchServerTraffic, calculateTrafficCost, freeAllowanceForDuration };


function normalizeTrafficDirection(dcConfig, traffic) {
  const dcKey = String(dcConfig?.key || dcConfig?.datacenter || '').toLowerCase();

  const received = Number(traffic?.received_gb || 0);
  const transmitted = Number(traffic?.transmitted_gb || 0);

  // Tebyan NetBill fields are reversed from the customer-facing meaning:
  // customer download = transmitted_gb
  // customer upload   = received_gb
  if (dcKey === 'tebyan') {
    return {
      download_gb: transmitted,
      upload_gb: received,
      received_gb: received,
      transmitted_gb: transmitted
    };
  }

  return {
    download_gb: received,
    upload_gb: transmitted,
    received_gb: received,
    transmitted_gb: transmitted
  };
}

