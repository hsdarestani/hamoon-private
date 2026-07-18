#!/usr/bin/env node
'use strict';

require('dotenv').config();

const mysql = require('mysql2/promise');

const HOURS = Object.freeze({
  hourly: 1,
  daily: 24,
  weekly: 168,
  monthly: 720
});

const apply = process.argv.includes('--apply');
const dryRun = !apply;

(async () => {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'hamooncloud_db'
  });

  try {
    const [columns] = await connection.execute(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'purchases'
    `);
    const columnNames = new Set(
      columns.map(row => row.COLUMN_NAME)
    );

    if (!columnNames.has('billing_amount_version')) {
      throw new Error(
        'billing_amount_version is missing; start the patched application once before running reconciliation'
      );
    }

    const [rows] = await connection.execute(`
      SELECT
        server_id,
        datacenter,
        duration,
        amount,
        COALESCE(billing_amount_version, 1) AS billing_amount_version,
        status
      FROM purchases
      WHERE (
          LOWER(datacenter) = 'hetzner'
          OR LOWER(datacenter) LIKE 'hetzner-%'
        )
        AND COALESCE(billing_amount_version, 1) < 2
      ORDER BY created_at ASC
    `);

    const changes = rows.map(row => {
      const hours = HOURS[row.duration];

      if (!hours) {
        return {
          ...row,
          error: 'INVALID_DURATION'
        };
      }

      return {
        server_id: row.server_id,
        datacenter: row.datacenter,
        duration: row.duration,
        status: row.status,
        old_amount: Number(row.amount || 0),
        new_amount: Number(row.amount || 0) * hours
      };
    });

    const invalid = changes.filter(item => item.error);
    const valid = changes.filter(item => !item.error);

    console.log(JSON.stringify({
      mode: dryRun ? 'dry-run' : 'apply',
      candidate_count: changes.length,
      valid_count: valid.length,
      invalid_count: invalid.length,
      totals: valid.reduce(
        (accumulator, item) => {
          accumulator.old_amount += item.old_amount;
          accumulator.new_amount += item.new_amount;
          return accumulator;
        },
        {
          old_amount: 0,
          new_amount: 0
        }
      ),
      sample: valid.slice(0, 30),
      invalid
    }, null, 2));

    if (dryRun) {
      console.log(
        'DRY_RUN_COMPLETE: no database rows were changed'
      );
      return;
    }

    if (invalid.length) {
      throw new Error(
        'Invalid billing durations exist; apply was aborted'
      );
    }

    await connection.beginTransaction();

    for (const item of valid) {
      const [result] = await connection.execute(
        `UPDATE purchases
         SET amount = ?,
             billing_amount_version = 2,
             lifecycle_updated_at = NOW(),
             updated_at = NOW()
         WHERE server_id = ?
           AND COALESCE(billing_amount_version, 1) < 2`,
        [item.new_amount, item.server_id]
      );

      if (result.affectedRows !== 1) {
        throw new Error(
          `Concurrent update detected for ${item.server_id}`
        );
      }
    }

    await connection.execute(`
      UPDATE purchases
      SET deleted_at = COALESCE(deleted_at, updated_at),
          auto_renew = 0,
          auto_renew_disabled_at = COALESCE(auto_renew_disabled_at, updated_at)
      WHERE status IN ('deleted','provider_missing')
        AND (
          LOWER(datacenter) = 'hetzner'
          OR LOWER(datacenter) LIKE 'hetzner-%'
        )
    `);

    await connection.commit();

    console.log(
      `APPLY_COMPLETE: ${valid.length} Hetzner purchase rows normalized`
    );
  } catch (error) {
    if (apply) {
      await connection.rollback().catch(() => {});
    }

    console.error(error);
    process.exitCode = 1;
  } finally {
    await connection.end();
  }
})();
