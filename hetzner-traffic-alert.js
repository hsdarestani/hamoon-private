'use strict';

require('dotenv').config();
const mysql = require('mysql2/promise');
const { ensureBillingSettlementSchema } = require('./billing-settlement');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'hamooncloud_db',
  waitForConnections: true,
  connectionLimit: 2,
  queueLimit: 0
});

function mysqlDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error('INVALID_TRAFFIC_ALERT_PERIOD');
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function buildTrafficAllowanceAlertKey(serverId, periodStart, includedBytes) {
  return `hetzner-traffic-allowance-exhausted:${String(serverId)}:${mysqlDate(periodStart)}:${Math.max(0, Math.floor(Number(includedBytes || 0)))}`;
}

async function claimTrafficAllowanceExhausted({
  telegramId,
  serverId,
  datacenter,
  periodStart,
  outgoingBytes,
  includedBytes
}) {
  const outgoing = Math.max(0, Math.floor(Number(outgoingBytes || 0)));
  const included = Math.max(0, Math.floor(Number(includedBytes || 0)));
  if (!(included > 0) || outgoing < included) {
    return { status: 'not_exhausted', eventKey: null };
  }

  await ensureBillingSettlementSchema();
  const period = mysqlDate(periodStart);
  const eventKey = buildTrafficAllowanceAlertKey(serverId, periodStart, included);
  const [result] = await pool.execute(
    `INSERT IGNORE INTO billing_events
     (event_key, telegram_id, server_id, datacenter, event_type, amount_toman, period_start, period_end, metadata)
     VALUES (?, ?, ?, ?, 'hetzner_traffic_allowance_exhausted', 0, ?, NULL, ?)`,
    [
      eventKey,
      String(telegramId),
      String(serverId),
      String(datacenter),
      period,
      JSON.stringify({ outgoingBytes: outgoing, includedBytes: included })
    ]
  );

  return {
    status: Number(result?.affectedRows || 0) === 1 ? 'claimed' : 'already_claimed',
    eventKey,
    outgoingBytes: outgoing,
    includedBytes: included
  };
}

async function releaseTrafficAllowanceExhausted(eventKey) {
  if (!eventKey) return false;
  await ensureBillingSettlementSchema();
  const [result] = await pool.execute(
    `DELETE FROM billing_events
     WHERE event_key = ? AND event_type = 'hetzner_traffic_allowance_exhausted' AND amount_toman = 0`,
    [String(eventKey)]
  );
  return Number(result?.affectedRows || 0) > 0;
}

module.exports = {
  buildTrafficAllowanceAlertKey,
  claimTrafficAllowanceExhausted,
  releaseTrafficAllowanceExhausted
};
