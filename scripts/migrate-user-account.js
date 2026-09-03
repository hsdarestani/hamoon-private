#!/usr/bin/env node
'use strict';

require('dotenv').config();
const mysql = require('mysql2/promise');
const TelegramBot = require('node-telegram-bot-api');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const execute = args.includes('--execute');
const ids = args.filter(arg => !arg.startsWith('--'));
const sourceId = String(ids[0] || '').trim();
const targetId = String(ids[1] || '').trim();

if (!/^\d+$/.test(sourceId) || !/^\d+$/.test(targetId) || sourceId === targetId) {
  throw new Error('Usage: node scripts/migrate-user-account.js (--dry-run|--execute) <source_telegram_id> <target_telegram_id>');
}
if (dryRun === execute) {
  throw new Error('Choose exactly one mode: --dry-run or --execute');
}
if (execute && process.env.ACCOUNT_MIGRATION_CONFIRM !== 'YES') {
  throw new Error('ACCOUNT_MIGRATION_CONFIRM=YES is required for --execute');
}

function qi(value) {
  return `\`${String(value).replace(/`/g, '``')}\``;
}

async function getTelegramTables(db) {
  const [rows] = await db.execute(`
    SELECT c.TABLE_NAME, t.ENGINE
    FROM INFORMATION_SCHEMA.COLUMNS c
    JOIN INFORMATION_SCHEMA.TABLES t
      ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
    WHERE c.TABLE_SCHEMA = DATABASE()
      AND c.COLUMN_NAME = 'telegram_id'
      AND t.TABLE_TYPE = 'BASE TABLE'
    ORDER BY c.TABLE_NAME
  `);
  return rows.map(row => ({ table: String(row.TABLE_NAME), engine: String(row.ENGINE || '') }));
}

async function getUniqueIndexes(db, table) {
  const [rows] = await db.execute(`
    SELECT INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
      AND NON_UNIQUE = 0
    ORDER BY INDEX_NAME, SEQ_IN_INDEX
  `, [table]);
  const grouped = new Map();
  for (const row of rows) {
    const name = String(row.INDEX_NAME);
    if (!grouped.has(name)) grouped.set(name, []);
    grouped.get(name).push(String(row.COLUMN_NAME));
  }
  return [...grouped.entries()].map(([name, columns]) => ({ name, columns }));
}

function sameColumnsPredicate(columns, leftAlias = 'tgt', rightAlias = 'src') {
  if (!columns.length) return '1=1';
  return columns.map(column => `${leftAlias}.${qi(column)} <=> ${rightAlias}.${qi(column)}`).join(' AND ');
}

async function countUniqueConflicts(db, table, indexes) {
  let total = 0;
  for (const index of indexes) {
    if (!index.columns.includes('telegram_id')) continue;
    const otherColumns = index.columns.filter(column => column !== 'telegram_id');
    let sql;
    if (!otherColumns.length) {
      sql = `SELECT CASE WHEN EXISTS(SELECT 1 FROM ${qi(table)} WHERE telegram_id=?) AND EXISTS(SELECT 1 FROM ${qi(table)} WHERE telegram_id=?) THEN 1 ELSE 0 END AS c`;
      const [rows] = await db.execute(sql, [sourceId, targetId]);
      total += Number(rows[0]?.c || 0);
    } else {
      sql = `SELECT COUNT(*) AS c FROM ${qi(table)} tgt JOIN ${qi(table)} src ON src.telegram_id=? AND tgt.telegram_id=? AND ${sameColumnsPredicate(otherColumns)} `;
      const [rows] = await db.execute(sql, [sourceId, targetId]);
      total += Number(rows[0]?.c || 0);
    }
  }
  return total;
}

async function inspect(db) {
  const [sourceRows] = await db.execute('SELECT telegram_id, wallet, created_at, updated_at FROM users WHERE telegram_id=? LIMIT 1', [sourceId]);
  const [targetRows] = await db.execute('SELECT telegram_id, wallet, created_at, updated_at FROM users WHERE telegram_id=? LIMIT 1', [targetId]);
  const source = sourceRows[0] || null;
  const target = targetRows[0] || null;
  const tables = await getTelegramTables(db);
  const details = [];

  for (const { table, engine } of tables) {
    const [rows] = await db.execute(
      `SELECT SUM(telegram_id=?) AS source_count, SUM(telegram_id=?) AS target_count FROM ${qi(table)}`,
      [sourceId, targetId]
    );
    const indexes = await getUniqueIndexes(db, table);
    const conflicts = table === 'users' ? 0 : await countUniqueConflicts(db, table, indexes);
    details.push({
      table,
      engine,
      sourceCount: Number(rows[0]?.source_count || 0),
      targetCount: Number(rows[0]?.target_count || 0),
      conflicts
    });
  }

  return { source, target, details };
}

async function ensureAuditTable(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS account_migrations (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      source_telegram_id VARCHAR(255) NOT NULL,
      target_telegram_id VARCHAR(255) NOT NULL,
      status VARCHAR(32) NOT NULL,
      summary_json JSON NULL,
      completed_at DATETIME NULL,
      message_sent_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_account_migration (source_telegram_id, target_telegram_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function cloneSourceUserToTarget(db, sourceWallet) {
  const [columns] = await db.execute(`
    SELECT COLUMN_NAME, EXTRA, IS_GENERATED
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users'
    ORDER BY ORDINAL_POSITION
  `);
  const insertColumns = [];
  const selectExpressions = [];
  const params = [];

  for (const columnRow of columns) {
    const column = String(columnRow.COLUMN_NAME);
    const extra = String(columnRow.EXTRA || '').toLowerCase();
    const generated = String(columnRow.IS_GENERATED || '').toUpperCase();
    if (extra.includes('auto_increment') || generated !== 'NEVER') continue;
    insertColumns.push(qi(column));
    if (column === 'telegram_id') {
      selectExpressions.push('?');
      params.push(targetId);
    } else if (column === 'wallet') {
      selectExpressions.push('?');
      params.push('0.00');
    } else if (column === 'updated_at') {
      selectExpressions.push('CURRENT_TIMESTAMP');
    } else {
      selectExpressions.push(qi(column));
    }
  }

  params.push(sourceId);
  const sql = `INSERT INTO users (${insertColumns.join(', ')}) SELECT ${selectExpressions.join(', ')} FROM users WHERE telegram_id=?`;
  const [result] = await db.execute(sql, params);
  if (result.affectedRows !== 1) throw new Error('TARGET_USER_CREATE_FAILED');
  return Number(sourceWallet || 0);
}

async function replaceTargetProfileFromSource(db) {
  const [columns] = await db.execute(`
    SELECT COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users'
    ORDER BY ORDINAL_POSITION
  `);
  const transferable = columns
    .map(row => String(row.COLUMN_NAME))
    .filter(column => !['telegram_id', 'wallet', 'created_at', 'updated_at'].includes(column));

  if (transferable.length) {
    const assignments = transferable.map(column => `tgt.${qi(column)} = src.${qi(column)}`).join(', ');
    await db.execute(
      `UPDATE users tgt JOIN users src ON src.telegram_id=? SET ${assignments}, tgt.updated_at=CURRENT_TIMESTAMP WHERE tgt.telegram_id=?`,
      [sourceId, targetId]
    );
  }
  await db.execute(`
    UPDATE users tgt
    JOIN users src ON src.telegram_id=?
    SET tgt.created_at = LEAST(tgt.created_at, src.created_at), tgt.updated_at=CURRENT_TIMESTAMP
    WHERE tgt.telegram_id=?
  `, [sourceId, targetId]);
}

async function deleteUniqueTargetConflicts(db, table, indexes) {
  let deleted = 0;
  for (const index of indexes) {
    if (!index.columns.includes('telegram_id')) continue;
    const otherColumns = index.columns.filter(column => column !== 'telegram_id');
    if (!otherColumns.length) {
      const [sourceRows] = await db.execute(`SELECT 1 FROM ${qi(table)} WHERE telegram_id=? LIMIT 1`, [sourceId]);
      if (sourceRows.length) {
        const [result] = await db.execute(`DELETE FROM ${qi(table)} WHERE telegram_id=?`, [targetId]);
        deleted += Number(result.affectedRows || 0);
      }
      continue;
    }
    const sql = `DELETE tgt FROM ${qi(table)} tgt JOIN ${qi(table)} src ON src.telegram_id=? AND tgt.telegram_id=? AND ${sameColumnsPredicate(otherColumns)}`;
    const [result] = await db.execute(sql, [sourceId, targetId]);
    deleted += Number(result.affectedRows || 0);
  }
  return deleted;
}

async function migrate(db, preflight) {
  await ensureAuditTable(db);
  const [existing] = await db.execute(
    'SELECT status, completed_at, message_sent_at FROM account_migrations WHERE source_telegram_id=? AND target_telegram_id=? LIMIT 1',
    [sourceId, targetId]
  );
  if (existing[0]?.status === 'completed') {
    return { alreadyCompleted: true, messageSent: Boolean(existing[0].message_sent_at), summary: null };
  }

  const lockName = `account-migration:${sourceId}:${targetId}`;
  const [lockRows] = await db.execute('SELECT GET_LOCK(?, 20) AS acquired', [lockName]);
  if (Number(lockRows[0]?.acquired) !== 1) throw new Error('ACCOUNT_MIGRATION_LOCK_TIMEOUT');

  let summary = null;
  try {
    await db.beginTransaction();
    const [sourceRows] = await db.execute('SELECT * FROM users WHERE telegram_id=? FOR UPDATE', [sourceId]);
    const [targetRows] = await db.execute('SELECT * FROM users WHERE telegram_id=? FOR UPDATE', [targetId]);
    if (!sourceRows.length) throw new Error('SOURCE_USER_NOT_FOUND');

    const sourceWallet = Number(sourceRows[0].wallet || 0);
    const targetWallet = Number(targetRows[0]?.wallet || 0);
    if (!targetRows.length) {
      await cloneSourceUserToTarget(db, sourceWallet);
    }
    await replaceTargetProfileFromSource(db);
    await db.execute('UPDATE users SET wallet=?, updated_at=CURRENT_TIMESTAMP WHERE telegram_id=?', [sourceWallet + targetWallet, targetId]);

    const tables = await getTelegramTables(db);
    const moved = {};
    const replacedTargetConflicts = {};

    for (const { table } of tables) {
      if (table === 'users') continue;
      const indexes = await getUniqueIndexes(db, table);
      const deleted = await deleteUniqueTargetConflicts(db, table, indexes);
      if (deleted) replacedTargetConflicts[table] = deleted;
      const [result] = await db.execute(`UPDATE ${qi(table)} SET telegram_id=? WHERE telegram_id=?`, [targetId, sourceId]);
      if (result.affectedRows) moved[table] = Number(result.affectedRows);
    }

    const [deleteSource] = await db.execute('DELETE FROM users WHERE telegram_id=?', [sourceId]);
    if (deleteSource.affectedRows !== 1) throw new Error('SOURCE_USER_DELETE_FAILED');

    summary = {
      moved,
      replacedTargetConflicts,
      sourceWallet,
      targetWalletBefore: targetWallet,
      targetWalletAfter: sourceWallet + targetWallet
    };

    await db.execute(`
      INSERT INTO account_migrations
        (source_telegram_id, target_telegram_id, status, summary_json, completed_at)
      VALUES (?, ?, 'completed', ?, NOW())
      ON DUPLICATE KEY UPDATE status='completed', summary_json=VALUES(summary_json), completed_at=NOW(), updated_at=NOW()
    `, [sourceId, targetId, JSON.stringify(summary)]);

    await db.commit();
    return { alreadyCompleted: false, messageSent: false, summary };
  } catch (error) {
    await db.rollback().catch(() => {});
    throw error;
  } finally {
    await db.execute('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => {});
  }
}

async function sendCompletionMessage(db) {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN_MISSING');
  const bot = new TelegramBot(token, { polling: false });
  const message = [
    'سلام 👋',
    '',
    'انتقال اکانت شما با موفقیت انجام شد ✅',
    '',
    'تمام سرورها، موجودی و سوابق کیف پول و اطلاعات مرتبط با اکانت قبلی به این اکانت منتقل شدند.',
    'از این به بعد می‌توانید با همین اکانت جدید از ربات استفاده کنید. 🌹'
  ].join('\n');
  try {
    await bot.sendMessage(targetId, message);
    await db.execute(
      'UPDATE account_migrations SET message_sent_at=NOW(), updated_at=NOW() WHERE source_telegram_id=? AND target_telegram_id=?',
      [sourceId, targetId]
    );
  } finally {
    await bot.stopPolling?.().catch?.(() => {});
  }
}

async function main() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'hamooncloud_db',
    multipleStatements: false
  });

  try {
    const inspection = await inspect(db);
    console.log(`mode=${dryRun ? 'dry-run' : 'execute'}`);
    console.log(`source_user_exists=${Boolean(inspection.source)}`);
    console.log(`target_user_exists=${Boolean(inspection.target)}`);
    console.log(`source_wallet=${inspection.source ? inspection.source.wallet : 'n/a'}`);
    console.log(`target_wallet=${inspection.target ? inspection.target.wallet : 'n/a'}`);
    for (const item of inspection.details) {
      if (item.sourceCount || item.targetCount || item.conflicts) {
        console.log(`table=${item.table} engine=${item.engine || 'unknown'} source=${item.sourceCount} target=${item.targetCount} unique_conflicts=${item.conflicts}`);
      }
    }

    if (dryRun) {
      if (!inspection.source) throw new Error('SOURCE_USER_NOT_FOUND');
      console.log('dry_run_ok=true');
      return;
    }

    const result = await migrate(db, inspection);
    if (!result.messageSent) await sendCompletionMessage(db);

    const verification = await inspect(db);
    const remainingSourceRows = verification.details.reduce((sum, item) => sum + item.sourceCount, 0);
    const [auditRows] = await db.execute(
      'SELECT status, completed_at, message_sent_at FROM account_migrations WHERE source_telegram_id=? AND target_telegram_id=? LIMIT 1',
      [sourceId, targetId]
    );
    const audit = auditRows[0] || {};
    console.log(`migration_completed=${audit.status === 'completed'}`);
    console.log(`notification_sent=${Boolean(audit.message_sent_at)}`);
    console.log(`source_rows_remaining=${remainingSourceRows}`);
    console.log(`target_user_exists_after=${Boolean(verification.target)}`);
    if (remainingSourceRows !== 0 || !verification.target || audit.status !== 'completed' || !audit.message_sent_at) {
      throw new Error('POST_MIGRATION_VERIFICATION_FAILED');
    }
  } finally {
    await db.end().catch(() => {});
  }
}

main().catch(error => {
  console.error('ACCOUNT_MIGRATION_FAILED', error.code || error.message);
  process.exit(1);
});
