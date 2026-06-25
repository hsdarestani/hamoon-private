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
  if (!dcConfig?.TRAFFIC_API_BASE_URL) throw new Error('TRAFFIC_API_BASE_URL_MISSING');
  const base = String(dcConfig.TRAFFIC_API_BASE_URL).replace(/\/?$/, '/');
  const url = `${base}${encodeURIComponent(serverId)}?start_time=${Number(startUnix)}&end_time=${Number(endUnix)}`;
  const headers = {};
  if (dcConfig.TRAFFIC_API_KEY) headers.Authorization = `Bearer ${dcConfig.TRAFFIC_API_KEY}`;
  if (dcConfig.TRAFFIC_API_KEY) headers['X-API-Key'] = dcConfig.TRAFFIC_API_KEY;
  const res = await axios.get(url, { headers, timeout: 20000 });
  const data = res.data || {};
  if (!Object.prototype.hasOwnProperty.call(data, 'received_gb') || !Object.prototype.hasOwnProperty.call(data, 'transmitted_gb')) {
    throw new Error('INVALID_TRAFFIC_RESPONSE_SHAPE');
  }
  return { instance_id: data.instance_id || serverId, received_gb: Number(data.received_gb) || 0, transmitted_gb: Number(data.transmitted_gb) || 0 };
}

async function calculateTrafficCost(purchase, periodStart, periodEnd, dcConfig) {
  const startUnix = Math.floor(new Date(periodStart || purchase.created_at || Date.now()).getTime() / 1000);
  const endUnix = Math.floor(new Date(periodEnd || Date.now()).getTime() / 1000);
  const traffic = await fetchServerTraffic(dcConfig, purchase.server_id, startUnix, endUnix);
  const rawBillableGb = Number(purchase.download_only) === 1 ? traffic.received_gb : traffic.received_gb + traffic.transmitted_gb;
  const freeAllowanceGb = freeAllowanceForDuration(purchase);
  const cumulativeBillableAfterFreeGb = Math.max(0, rawBillableGb - freeAllowanceGb);
  const alreadyBilledGb = Number(purchase.last_billed_traffic_gb || 0);
  const newBillableGb = Math.max(0, cumulativeBillableAfterFreeGb - alreadyBilledGb);
  const pricePerGb = Number(purchase.price_per_gb || 0);
  const trafficCost = Math.round(newBillableGb * pricePerGb);
  return { traffic, received_gb: traffic.received_gb, transmitted_gb: traffic.transmitted_gb, rawBillableGb, freeAllowanceGb, cumulativeBillableAfterFreeGb, alreadyBilledGb, newBillableGb, pricePerGb, trafficCost, startUnix, endUnix };
}

module.exports = { formatBillingCycleFa, formatBillingAmountLabel, fetchServerTraffic, calculateTrafficCost, freeAllowanceForDuration };
