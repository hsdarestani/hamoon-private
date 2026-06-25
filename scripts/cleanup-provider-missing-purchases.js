#!/usr/bin/env node
'use strict';

require('dotenv').config();

const db = require('../db');
const datacenters = require('../datacenters');
const openstackApi = require('../openstack-api');

const APPLY = process.argv.includes('--apply');
const DC_FILTER = (() => {
  const arg = process.argv.find(x => x.startsWith('--dc='));
  return arg ? arg.split('=')[1] : null;
})();

const VISIBLE_STATUSES = [
  'active',
  'pending_ssh',
  'pending_ip',
  'provisioning',
  'building',
  'deletion_pending',
  'manual_review',
  'provider_missing',
  'provisioning_failed'
];

function isOpenstackDc(dc) {
  return dc && (
    dc.provider === 'openstack' ||
    dc.apiType === 'openstack' ||
    dc.OS_AUTH_URL ||
    dc.OS_USERNAME
  );
}

async function providerServerExistsOpenstack(dc, serverId) {
  const token = await openstackApi.getToken(dc);
  await openstackApi.getServer(dc, token, serverId);
  return true;
}

async function main() {
  console.log('MODE:', APPLY ? 'APPLY' : 'DRY_RUN');
  if (DC_FILTER) console.log('DC_FILTER:', DC_FILTER);

  const conn = await db.pool.getConnection();

  try {
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS purchases_cleanup_backup AS
      SELECT * FROM purchases WHERE 1=0
    `);

    const where = [
      `status IN (${VISIBLE_STATUSES.map(() => '?').join(',')})`
    ];
    const params = [...VISIBLE_STATUSES];

    if (DC_FILTER) {
      where.push(`datacenter = ?`);
      params.push(DC_FILTER);
    }

    const [rows] = await conn.execute(
      `
      SELECT
        server_id,
        telegram_id,
        datacenter,
        server_name,
        status,
        created_at,
        updated_at
      FROM purchases
      WHERE ${where.join(' AND ')}
      ORDER BY datacenter, created_at DESC
      `,
      params
    );

    console.log('DB candidates:', rows.length);

    const missing = [];
    const exists = [];
    const skipped = [];
    const errors = [];

    const tokenCache = new Map();

    for (const p of rows) {
      const dc = datacenters[p.datacenter];

      if (!dc) {
        skipped.push({ ...p, reason: 'DATACENTER_CONFIG_NOT_FOUND' });
        continue;
      }

      if (!isOpenstackDc(dc)) {
        skipped.push({ ...p, reason: 'NON_OPENSTACK_SKIPPED' });
        continue;
      }

      try {
        if (!tokenCache.has(p.datacenter)) {
          tokenCache.set(p.datacenter, await openstackApi.getToken(dc));
        }

        const token = tokenCache.get(p.datacenter);
        await openstackApi.getServer(dc, token, p.server_id);

        exists.push(p);
        console.log('EXISTS  ', p.datacenter, p.server_name, p.server_id, p.status);
      } catch (e) {
        const statusCode = e?.response?.status;

        if (statusCode === 404) {
          missing.push(p);
          console.log('MISSING ', p.datacenter, p.server_name, p.server_id, p.status);
        } else {
          errors.push({
            ...p,
            error: e.message,
            statusCode,
            data: e?.response?.data
          });
          console.log('ERROR   ', p.datacenter, p.server_name, p.server_id, statusCode || '', e.message);
        }
      }
    }

    console.log('\nSUMMARY');
    console.log('exists :', exists.length);
    console.log('missing:', missing.length);
    console.log('skipped:', skipped.length);
    console.log('errors :', errors.length);

    if (skipped.length) {
      console.log('\nSKIPPED');
      for (const s of skipped) {
        console.log('-', s.datacenter, s.server_name, s.server_id, s.status, s.reason);
      }
    }

    if (errors.length) {
      console.log('\nERRORS');
      for (const e of errors) {
        console.log('-', e.datacenter, e.server_name, e.server_id, e.statusCode || '', e.error);
      }
    }

    if (!missing.length) {
      console.log('\nNothing to clean.');
      return;
    }

    console.log('\nMISSING SERVERS');
    for (const m of missing) {
      console.log('-', m.datacenter, m.server_name, m.server_id, 'status=' + m.status, 'user=' + m.telegram_id);
    }

    if (!APPLY) {
      console.log('\nDRY_RUN only. To mark missing records deleted, run:');
      console.log('node scripts/cleanup-provider-missing-purchases.js --apply');
      if (DC_FILTER) console.log(`node scripts/cleanup-provider-missing-purchases.js --dc=${DC_FILTER} --apply`);
      return;
    }

    console.log('\nApplying cleanup...');

    for (const m of missing) {
      await conn.execute(
        `
        INSERT INTO purchases_cleanup_backup
        SELECT * FROM purchases
        WHERE server_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM purchases_cleanup_backup b WHERE b.server_id = purchases.server_id
          )
        `,
        [m.server_id]
      );

      await conn.execute(
        `
        UPDATE purchases
        SET status = 'deleted',
            updated_at = CURRENT_TIMESTAMP
        WHERE server_id = ?
        `,
        [m.server_id]
      );

      console.log('MARKED_DELETED', m.datacenter, m.server_name, m.server_id);
    }

    console.log('\nDONE. Backup table: purchases_cleanup_backup');
  } finally {
    conn.release();
    await db.pool.end();
  }
}

main().catch(async err => {
  console.error('FATAL:', err.message);
  if (err?.response?.data) console.error(JSON.stringify(err.response.data, null, 2));
  try { await db.pool.end(); } catch {}
  process.exit(1);
});
