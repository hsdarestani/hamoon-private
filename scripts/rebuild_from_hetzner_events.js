require('dotenv').config();

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const mysql = require('mysql2/promise');

const HETZNER_TOKEN =
  process.env.HETZNER_API_TOKEN ||
  process.env.HETZNER_TOKEN ||
  process.env.HCLOUD_TOKEN;

if (!HETZNER_TOKEN) {
  console.error('NO_HETZNER_TOKEN_FOUND');
  process.exit(1);
}

const DB = {
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || process.env.MYSQL_USER || 'hamoon_user',
  password: process.env.DB_PASSWORD || process.env.DB_PASS || process.env.MYSQL_PASSWORD,
  database: process.env.DB_NAME || process.env.DB_DATABASE || 'hamooncloud_db',
};

const hcloud = axios.create({
  baseURL: 'https://api.hetzner.cloud/v1',
  headers: { Authorization: `Bearer ${HETZNER_TOKEN}` },
  timeout: 20000,
});

async function getCurrentHetznerInstanceId() {
  try {
    const { data } = await axios.get('http://169.254.169.254/hetzner/v1/metadata', {
      timeout: 3000,
    });

    const m = String(data).match(/^instance-id:\s*(\S+)/m);
    return m ? String(m[1]) : null;
  } catch {
    return null;
  }
}

async function getAll(pathName, key) {
  let page = 1;
  const all = [];

  while (true) {
    const { data } = await hcloud.get(pathName, {
      params: { page, per_page: 50 },
    });

    all.push(...(data[key] || []));

    if (!data.meta?.pagination?.next_page) break;
    page = data.meta.pagination.next_page;
  }

  return all;
}

function readEvents() {
  const file = path.join(process.cwd(), 'server_events.log');
  if (!fs.existsSync(file)) return [];

  const events = [];

  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\[([^\]]+)\]\s+(.+)$/);
    if (!m) continue;

    try {
      const obj = JSON.parse(m[2]);
      events.push({
        ts: m[1],
        ...obj,
        server_id: String(obj.server_id || ''),
        user_id: String(obj.user_id || obj.telegram_id || ''),
      });
    } catch {}
  }

  return events;
}

function buildActiveServerMap(events) {
  const byServer = new Map();

  for (const ev of events) {
    if (!ev.server_id) continue;

    const prev = byServer.get(ev.server_id);
    if (!prev || String(ev.ts) > String(prev.ts)) {
      byServer.set(ev.server_id, ev);
    }
  }

  const active = new Map();

  for (const [serverId, ev] of byServer.entries()) {
    if (String(ev.type || '').includes('deleted')) continue;
    if (!ev.user_id) continue;
    active.set(serverId, ev);
  }

  return active;
}

function ownerFromServer(server, eventMap) {
  const labels = server.labels || {};

  return String(
    labels.user ||
    labels.telegram_id ||
    labels.telegramId ||
    labels.user_id ||
    labels.owner ||
    eventMap.get(String(server.id))?.user_id ||
    ''
  );
}

function dcFromServer(server, eventDc) {
  const loc = server.datacenter?.location?.name || server.location?.name || '';
  const name = String(server.name || '').toLowerCase();

  if (name.startsWith('srv-fin') || loc === 'hel1') return 'hetzner-finland';
  if (name.startsWith('srv-sin') || loc === 'sin') return 'hetzner-singapore';
  if (name.startsWith('srv-use') || loc === 'ash') return 'hetzner-us-east';
  if (name.startsWith('srv-usw') || loc === 'hil') return 'hetzner-us-west';

  if (eventDc && String(eventDc).startsWith('hetzner')) return eventDc;

  return 'hetzner';
}

function hourlyPriceFallback(type) {
  const t = String(type || '').toLowerCase();

  const monthly = {
    cax11: 360000,
    cax21: 660000,
    cax31: 1200000,
    cax41: 2200000,
    cx22: 632000,
    cx23: 632000,
    cx33: 977000,
    cx43: 1684000,
    cx53: 3392000,
    ccx13: 5002000,
    ccx23: 9500000,
    ccx33: 18000000,
  };

  return monthly[t] ? Math.round(monthly[t] / 720) : 0;
}

async function columns(conn, table) {
  const [rows] = await conn.query(
    `
    SELECT COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
    `,
    [table]
  );

  return rows.map(r => r.COLUMN_NAME);
}

async function tableExists(conn, table) {
  const [rows] = await conn.query(
    `
    SELECT TABLE_NAME
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
    `,
    [table]
  );

  return rows.length > 0;
}

async function insertOrUpdate(conn, table, data, uniqueKeys) {
  if (!(await tableExists(conn, table))) {
    return { skipped: true, reason: `${table} missing` };
  }

  const cols = await columns(conn, table);
  const filtered = {};

  for (const [k, v] of Object.entries(data)) {
    if (cols.includes(k)) filtered[k] = v;
  }

  const realUnique = uniqueKeys.filter(k => cols.includes(k));
  if (!realUnique.length) {
    return { skipped: true, reason: `no unique key columns in ${table}` };
  }

  const [exists] = await conn.query(
    `SELECT * FROM \`${table}\` WHERE ${realUnique.map(k => `\`${k}\` = ?`).join(' AND ')} LIMIT 1`,
    realUnique.map(k => filtered[k])
  );

  if (exists.length) {
    const updateKeys = Object.keys(filtered).filter(k => !realUnique.includes(k));
    if (!updateKeys.length) return { exists: true };

    await conn.query(
      `UPDATE \`${table}\` SET ${updateKeys.map(k => `\`${k}\` = ?`).join(', ')}
       WHERE ${realUnique.map(k => `\`${k}\` = ?`).join(' AND ')}
       LIMIT 1`,
      [...updateKeys.map(k => filtered[k]), ...realUnique.map(k => filtered[k])]
    );

    return { updated: true };
  }

  const keys = Object.keys(filtered);

  await conn.query(
    `INSERT INTO \`${table}\` (${keys.map(k => `\`${k}\``).join(', ')})
     VALUES (${keys.map(() => '?').join(', ')})`,
    keys.map(k => filtered[k])
  );

  return { inserted: true };
}

(async () => {
  const conn = await mysql.createConnection(DB);

  const currentInstanceId = await getCurrentHetznerInstanceId();
  const events = readEvents();
  const eventMap = buildActiveServerMap(events);
  const servers = await getAll('/servers', 'servers');

  console.log('events:', events.length);
  console.log('active server mappings from events:', eventMap.size);
  console.log('hetzner current servers:', servers.length);
  console.log('current host instance id:', currentInstanceId || 'unknown');

  const candidates = [];
  const skipped = [];

  for (const s of servers) {
    const serverId = String(s.id);
    const owner = ownerFromServer(s, eventMap);
    const ev = eventMap.get(serverId);

    if (currentInstanceId && serverId === currentInstanceId) {
      skipped.push({
        server_id: serverId,
        name: s.name,
        ip: s.public_net?.ipv4?.ip,
        reason: 'current hamoon host excluded',
      });
      continue;
    }

    if (!owner) {
      skipped.push({
        server_id: serverId,
        name: s.name,
        ip: s.public_net?.ipv4?.ip,
        reason: 'no owner label and no active event mapping',
      });
      continue;
    }

    const type = s.server_type?.name || null;
    const dc = dcFromServer(s, ev?.datacenter);

    candidates.push({
      telegram_id: owner,
      user_id: owner,
      server_id: serverId,
      datacenter: dc,
      server_name: s.name,
      name: s.name,
      public_ip: s.public_net?.ipv4?.ip || null,
      ip: s.public_net?.ipv4?.ip || null,
      flavor_id: type,
      plan_id: type,
      amount: hourlyPriceFallback(type),
      duration: 'hourly',
      price_per_gb: 0,
      download_only: 0,
      boot_method: 'image',
      boot_volume_id: null,
      os_label: s.image?.name || null,
      image_id: s.image?.id ? String(s.image.id) : null,
      image_name: s.image?.name || null,
      status: ['running', 'off'].includes(s.status) ? 'active' : s.status,
      created_at: s.created ? new Date(s.created) : new Date(),
      updated_at: new Date(),
      last_billed_at: new Date(),
      last_billed_traffic_gb: 0,
      free_traffic_hourly_gb: 0,
      free_traffic_daily_gb: 0,
      free_traffic_weekly_gb: 0,
      free_traffic_monthly_gb: 0,
    });
  }

  console.log('\nRECONSTRUCT_CANDIDATES');
  console.table(candidates.map(x => ({
    telegram_id: x.telegram_id,
    server_id: x.server_id,
    datacenter: x.datacenter,
    server_name: x.server_name,
    public_ip: x.public_ip,
    flavor_id: x.flavor_id,
    duration: x.duration,
    amount: x.amount,
    status: x.status,
  })));

  console.log('\nSKIPPED_COUNT:', skipped.length);
  console.table(skipped);

  if (process.env.APPLY !== '1') {
    console.log('\nDRY_RUN_ONLY');
    console.log('To apply: APPLY=1 node scripts/rebuild_from_hetzner_events.js');
    await conn.end();
    return;
  }

  let usersInserted = 0;
  let usersUpdated = 0;
  let purchasesInserted = 0;
  let purchasesUpdated = 0;

  for (const r of candidates) {
    const userRes = await insertOrUpdate(conn, 'users', {
      telegram_id: r.telegram_id,
      wallet: 0,
      step: 'READY',
      created_at: new Date(),
      updated_at: new Date(),
    }, ['telegram_id']);

    if (userRes.inserted) usersInserted++;
    if (userRes.updated) usersUpdated++;

    const purchaseRes = await insertOrUpdate(conn, 'purchases', r, ['server_id', 'datacenter']);

    if (purchaseRes.inserted) purchasesInserted++;
    if (purchaseRes.updated) purchasesUpdated++;
  }

  console.log('\nAPPLIED');
  console.table([{
    users_inserted: usersInserted,
    users_updated: usersUpdated,
    purchases_inserted: purchasesInserted,
    purchases_updated: purchasesUpdated,
    skipped: skipped.length,
  }]);

  await conn.end();
})();
