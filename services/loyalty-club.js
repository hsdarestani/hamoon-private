'use strict';

const { pool } = require('../db');

const DEFAULT_XP_TOMAN_STEP = Math.max(1, Number(process.env.LOYALTY_XP_TOMAN_STEP || 1000));
const ROLLING_DAYS = Math.max(1, Number(process.env.LOYALTY_ROLLING_DAYS || 90));
const CREDIT_EXPIRY_DAYS = Math.max(1, Number(process.env.LOYALTY_CREDIT_EXPIRY_DAYS || 60));
const MAX_REDEMPTION_PERCENT = Math.max(0, Math.min(100, Number(process.env.LOYALTY_MAX_REDEMPTION_PERCENT || 30)));
const LAUNCH_AT = String(process.env.LOYALTY_LAUNCH_AT || '2026-09-03T00:00:00Z');

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const LEVELS = [
  { key: 'bronze', name: 'Bronze', icon: '🥉', minSpend90d: 0, cashback: envNumber('LOYALTY_BRONZE_CASHBACK', 0) },
  { key: 'silver', name: 'Silver', icon: '🥈', minSpend90d: envNumber('LOYALTY_SILVER_SPEND_90D', 1500000), cashback: envNumber('LOYALTY_SILVER_CASHBACK', 1) },
  { key: 'gold', name: 'Gold', icon: '🥇', minSpend90d: envNumber('LOYALTY_GOLD_SPEND_90D', 5000000), cashback: envNumber('LOYALTY_GOLD_CASHBACK', 1.5) },
  { key: 'black', name: 'Black', icon: '🖤', minSpend90d: envNumber('LOYALTY_BLACK_SPEND_90D', 15000000), cashback: envNumber('LOYALTY_BLACK_CASHBACK', 2) }
].sort((a, b) => a.minSpend90d - b.minSpend90d);

const MILESTONES = [
  { spend90d: envNumber('LOYALTY_MILESTONE_1_SPEND', 2000000), rewardToman: envNumber('LOYALTY_MILESTONE_1_REWARD', 30000) },
  { spend90d: envNumber('LOYALTY_MILESTONE_2_SPEND', 5000000), rewardToman: envNumber('LOYALTY_MILESTONE_2_REWARD', 100000) },
  { spend90d: envNumber('LOYALTY_MILESTONE_3_SPEND', 10000000), rewardToman: envNumber('LOYALTY_MILESTONE_3_REWARD', 250000) },
  { spend90d: envNumber('LOYALTY_MILESTONE_4_SPEND', 20000000), rewardToman: envNumber('LOYALTY_MILESTONE_4_REWARD', 600000) }
].filter(x => x.spend90d > 0 && x.rewardToman > 0).sort((a, b) => a.spend90d - b.spend90d);

let schemaPromise = null;

async function columnExists(conn, tableName, columnName) {
  const [rows] = await conn.execute(
    `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [tableName, columnName]
  );
  return rows.length > 0;
}

async function ensureColumn(conn, tableName, columnName, definition) {
  if (!(await columnExists(conn, tableName, columnName))) {
    await conn.execute(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${definition}`);
  }
}

async function ensureSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    const conn = await pool.getConnection();
    try {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS loyalty_profiles (
          telegram_id VARCHAR(255) PRIMARY KEY,
          xp BIGINT NOT NULL DEFAULT 0,
          lifetime_eligible_spend DECIMAL(18,2) NOT NULL DEFAULT 0,
          reward_balance DECIMAL(18,2) NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `);
      await ensureColumn(conn, 'loyalty_profiles', 'xp', 'BIGINT NOT NULL DEFAULT 0');
      await ensureColumn(conn, 'loyalty_profiles', 'lifetime_eligible_spend', 'DECIMAL(18,2) NOT NULL DEFAULT 0');
      await ensureColumn(conn, 'loyalty_profiles', 'reward_balance', 'DECIMAL(18,2) NOT NULL DEFAULT 0');

      if (await columnExists(conn, 'loyalty_profiles', 'xp_total')) {
        await conn.execute(`UPDATE loyalty_profiles SET xp = GREATEST(xp, COALESCE(xp_total, 0))`);
      }
      if (await columnExists(conn, 'loyalty_profiles', 'lifetime_spend')) {
        await conn.execute(`UPDATE loyalty_profiles SET lifetime_eligible_spend = GREATEST(lifetime_eligible_spend, COALESCE(lifetime_spend, 0))`);
      }

      await conn.execute(`
        CREATE TABLE IF NOT EXISTS loyalty_events (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          telegram_id VARCHAR(255) NOT NULL,
          event_key VARCHAR(191) NOT NULL,
          event_type VARCHAR(64) NOT NULL,
          reference_id VARCHAR(191) NULL,
          xp_delta BIGINT NOT NULL DEFAULT 0,
          spend_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
          reward_delta DECIMAL(18,2) NOT NULL DEFAULT 0,
          metadata JSON NULL,
          occurred_at DATETIME NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_loyalty_event_key (event_key),
          INDEX idx_loyalty_events_user_created (telegram_id, created_at)
        )
      `);
      await ensureColumn(conn, 'loyalty_events', 'reference_id', 'VARCHAR(191) NULL');
      await ensureColumn(conn, 'loyalty_events', 'metadata', 'JSON NULL');
      await ensureColumn(conn, 'loyalty_events', 'occurred_at', 'DATETIME NULL');
      await conn.execute(`UPDATE loyalty_events SET occurred_at = created_at WHERE occurred_at IS NULL`);
      await conn.execute(`
        UPDATE loyalty_events e
        JOIN purchases p
          ON e.telegram_id = p.telegram_id
         AND e.event_key = CONCAT('purchase:', p.server_id)
           SET e.occurred_at = p.created_at,
               e.reference_id = COALESCE(e.reference_id, p.server_id)
         WHERE e.event_type = 'purchase'
      `).catch(() => {});

      await conn.execute(`
        CREATE TABLE IF NOT EXISTS loyalty_credits (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          telegram_id VARCHAR(255) NOT NULL,
          source_event_key VARCHAR(191) NOT NULL,
          amount DECIMAL(18,2) NOT NULL,
          remaining_amount DECIMAL(18,2) NOT NULL,
          expires_at DATETIME NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_loyalty_credit_source (source_event_key),
          INDEX idx_loyalty_credit_user_expiry (telegram_id, expires_at)
        )
      `);

      await conn.execute(`
        CREATE TABLE IF NOT EXISTS loyalty_milestones_awarded (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          telegram_id VARCHAR(255) NOT NULL,
          milestone_spend DECIMAL(18,2) NOT NULL,
          reward_toman DECIMAL(18,2) NOT NULL,
          source_event_key VARCHAR(191) NOT NULL,
          awarded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_loyalty_user_milestone (telegram_id, milestone_spend)
        )
      `);

      await conn.execute(`CREATE INDEX idx_loyalty_events_user_occurred ON loyalty_events (telegram_id, occurred_at)`).catch(() => {});
    } finally {
      conn.release();
    }
  })().catch(err => {
    schemaPromise = null;
    throw err;
  });
  return schemaPromise;
}

function xpForSpend(amount) {
  const spend = Math.max(0, Number(amount || 0));
  return Math.floor(spend / DEFAULT_XP_TOMAN_STEP);
}

function resolveLevelBySpend(spend90d) {
  const value = Math.max(0, Number(spend90d || 0));
  let current = LEVELS[0];
  for (const level of LEVELS) {
    if (value >= level.minSpend90d) current = level;
  }
  const index = LEVELS.findIndex(level => level.key === current.key);
  return { current, next: LEVELS[index + 1] || null };
}

function resolveLevel(value) {
  return resolveLevelBySpend(Number(value || 0) * DEFAULT_XP_TOMAN_STEP);
}

function monthKey(date) {
  const d = new Date(date || Date.now());
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function previousMonthKey(key) {
  const [year, month] = String(key).split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 2, 1));
  return monthKey(d);
}

function streakFromMonthKeys(keys, referenceDate = new Date()) {
  const set = new Set((keys || []).filter(Boolean));
  const current = monthKey(referenceDate);
  const previous = previousMonthKey(current);
  let cursor = set.has(current) ? current : (set.has(previous) ? previous : null);
  if (!cursor) return 0;
  let streak = 0;
  while (cursor && set.has(cursor)) {
    streak += 1;
    cursor = previousMonthKey(cursor);
  }
  return streak;
}

function streakMultiplier(streak) {
  if (streak >= 6) return 1.30;
  if (streak >= 3) return 1.20;
  if (streak >= 2) return 1.10;
  return 1;
}

async function ensureProfile(telegramId, conn = pool) {
  await ensureSchema();
  await conn.execute(
    `INSERT INTO loyalty_profiles (telegram_id) VALUES (?)
     ON DUPLICATE KEY UPDATE telegram_id = VALUES(telegram_id)`,
    [String(telegramId)]
  );
}

async function recordEvent({
  telegramId,
  eventKey,
  eventType,
  referenceId = null,
  xpDelta = 0,
  spendAmount = 0,
  rewardDelta = 0,
  metadata = null,
  occurredAt = null
}) {
  await ensureProfile(telegramId);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.execute(
      `INSERT IGNORE INTO loyalty_events
       (telegram_id, event_key, event_type, reference_id, xp_delta, spend_amount, reward_delta, metadata, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(telegramId),
        String(eventKey),
        String(eventType),
        referenceId == null ? null : String(referenceId),
        Math.trunc(Number(xpDelta || 0)),
        Number(spendAmount || 0),
        Number(rewardDelta || 0),
        metadata ? JSON.stringify(metadata) : null,
        occurredAt ? new Date(occurredAt) : new Date()
      ]
    );
    if (result.affectedRows === 1) {
      await conn.execute(
        `UPDATE loyalty_profiles
         SET xp = xp + ?,
             lifetime_eligible_spend = lifetime_eligible_spend + ?,
             reward_balance = reward_balance + ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE telegram_id = ?`,
        [Math.trunc(Number(xpDelta || 0)), Number(spendAmount || 0), Number(rewardDelta || 0), String(telegramId)]
      );
    }
    await conn.commit();
    return result.affectedRows === 1;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function syncPurchases(telegramId) {
  await ensureProfile(telegramId);
  const [rows] = await pool.execute(
    `SELECT server_id, datacenter, amount, duration, status, created_at
       FROM purchases
      WHERE telegram_id = ?
      ORDER BY created_at ASC`,
    [String(telegramId)]
  );
  let addedXp = 0;
  for (const purchase of rows) {
    const amount = Math.max(0, Number(purchase.amount || 0));
    const xp = xpForSpend(amount);
    const inserted = await recordEvent({
      telegramId,
      eventKey: `purchase:${purchase.server_id}`,
      eventType: 'purchase',
      referenceId: purchase.server_id,
      xpDelta: xp,
      spendAmount: amount,
      occurredAt: purchase.created_at,
      metadata: {
        server_id: purchase.server_id,
        datacenter: purchase.datacenter,
        duration: purchase.duration,
        source: 'purchase_backfill_v2'
      }
    });
    if (inserted) addedXp += xp;
  }
  return { purchases: rows.length, addedXp };
}

async function syncHistoricalRenewals(telegramId) {
  const launch = new Date(LAUNCH_AT);
  if (Number.isNaN(launch.getTime())) return { renewals: 0, addedXp: 0 };
  const [rows] = await pool.execute(
    `SELECT id, amount, description, timestamp
       FROM wallet_logs
      WHERE telegram_id = ?
        AND amount < 0
        AND LOWER(type) IN ('billing','upgrade','server_upgrade')
        AND timestamp < ?
      ORDER BY timestamp ASC`,
    [String(telegramId), launch]
  );
  let addedXp = 0;
  for (const row of rows) {
    const amount = Math.max(0, -Number(row.amount || 0));
    const xp = xpForSpend(amount);
    const inserted = await recordEvent({
      telegramId,
      eventKey: `history:wallet:${row.id}`,
      eventType: 'renewal',
      referenceId: String(row.id),
      xpDelta: xp,
      spendAmount: amount,
      occurredAt: row.timestamp,
      metadata: { source: 'billing_history_backfill_v1', description: row.description || null }
    });
    if (inserted) addedXp += xp;
  }
  return { renewals: rows.length, addedXp };
}

async function syncHistory(telegramId) {
  const purchases = await syncPurchases(telegramId);
  const renewals = await syncHistoricalRenewals(telegramId);
  return { purchases, renewals };
}

async function rollingSpend(telegramId, conn = pool, referenceDate = new Date()) {
  const end = new Date(referenceDate || Date.now());
  const start = new Date(end.getTime() - ROLLING_DAYS * 86400000);
  const [[row]] = await conn.execute(
    `SELECT COALESCE(SUM(spend_amount), 0) AS spend
       FROM loyalty_events
      WHERE telegram_id = ?
        AND event_type IN ('purchase','renewal','upgrade')
        AND occurred_at >= ?
        AND occurred_at <= ?`,
    [String(telegramId), start, end]
  );
  return Math.max(0, Number(row?.spend || 0));
}

async function getStreak(telegramId, conn = pool, referenceDate = new Date(), includeDate = null) {
  const [rows] = await conn.execute(
    `SELECT DISTINCT DATE_FORMAT(occurred_at, '%Y-%m') AS month_key
       FROM loyalty_events
      WHERE telegram_id = ?
        AND event_type IN ('purchase','renewal','upgrade')
        AND spend_amount > 0
        AND occurred_at <= ?
      ORDER BY month_key DESC
      LIMIT 24`,
    [String(telegramId), new Date(referenceDate || Date.now())]
  );
  const keys = rows.map(r => r.month_key);
  if (includeDate) keys.push(monthKey(includeDate));
  return streakFromMonthKeys(keys, referenceDate);
}

async function activeCreditBalance(telegramId, conn = pool, lock = false) {
  const suffix = lock ? ' FOR UPDATE' : '';
  const [rows] = await conn.execute(
    `SELECT id, amount, remaining_amount, expires_at, source_event_key
       FROM loyalty_credits
      WHERE telegram_id = ?
        AND remaining_amount > 0
        AND expires_at > NOW()
      ORDER BY expires_at ASC, id ASC${suffix}`,
    [String(telegramId)]
  );
  return {
    rows,
    balance: rows.reduce((sum, row) => sum + Number(row.remaining_amount || 0), 0)
  };
}

async function refreshRewardBalance(telegramId, conn = pool) {
  const { balance } = await activeCreditBalance(telegramId, conn, false);
  await conn.execute(
    `UPDATE loyalty_profiles SET reward_balance = ?, updated_at = CURRENT_TIMESTAMP WHERE telegram_id = ?`,
    [balance, String(telegramId)]
  );
  return balance;
}

async function addCredit(conn, { telegramId, sourceEventKey, amount, expiresAt = null }) {
  const value = Math.max(0, Math.floor(Number(amount || 0)));
  if (value <= 0) return false;
  const expiry = expiresAt ? new Date(expiresAt) : new Date(Date.now() + CREDIT_EXPIRY_DAYS * 86400000);
  const [result] = await conn.execute(
    `INSERT IGNORE INTO loyalty_credits
      (telegram_id, source_event_key, amount, remaining_amount, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [String(telegramId), String(sourceEventKey), value, value, expiry]
  );
  if (result.affectedRows === 1) {
    await conn.execute(
      `UPDATE loyalty_profiles
          SET reward_balance = reward_balance + ?, updated_at = CURRENT_TIMESTAMP
        WHERE telegram_id = ?`,
      [value, String(telegramId)]
    );
    return true;
  }
  return false;
}

async function awardedMilestones(telegramId, conn = pool) {
  const [rows] = await conn.execute(
    `SELECT milestone_spend FROM loyalty_milestones_awarded WHERE telegram_id = ?`,
    [String(telegramId)]
  );
  return new Set(rows.map(r => Number(r.milestone_spend)));
}

async function recordEligibleSpend({
  telegramId,
  eventKey,
  eventType = 'purchase',
  referenceId = null,
  amountToman,
  grossAmountToman = null,
  occurredAt = new Date(),
  metadata = null
}) {
  const uid = String(telegramId);
  const eligibleSpend = Math.max(0, Math.floor(Number(amountToman || 0)));
  if (!uid || !eventKey || eligibleSpend <= 0) return { awarded: false, reason: 'invalid_input' };

  await ensureSchema();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await ensureProfile(uid, conn);

    const [existing] = await conn.execute(
      `SELECT id, xp_delta, reward_delta FROM loyalty_events WHERE event_key = ? LIMIT 1 FOR UPDATE`,
      [String(eventKey)]
    );
    if (existing.length) {
      await conn.rollback();
      return { awarded: false, reason: 'duplicate' };
    }

    const eventDate = new Date(occurredAt || Date.now());
    const oldRolling = await rollingSpend(uid, conn, eventDate);
    const streak = await getStreak(uid, conn, eventDate, eventDate);
    const multiplier = streakMultiplier(streak);
    const baseXp = xpForSpend(eligibleSpend);
    const xpDelta = Math.floor(baseXp * multiplier);
    const newRolling = oldRolling + eligibleSpend;
    const { current: level } = resolveLevelBySpend(newRolling);
    const cashback = Math.floor(eligibleSpend * Number(level.cashback || 0) / 100);

    await conn.execute(
      `INSERT INTO loyalty_events
       (telegram_id, event_key, event_type, reference_id, xp_delta, spend_amount, reward_delta, metadata, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uid,
        String(eventKey),
        String(eventType),
        referenceId == null ? null : String(referenceId),
        xpDelta,
        eligibleSpend,
        cashback,
        JSON.stringify({
          ...(metadata || {}),
          gross_amount: grossAmountToman == null ? eligibleSpend : Number(grossAmountToman || 0),
          streak,
          xp_multiplier: multiplier,
          level_after: level.key,
          cashback_percent: level.cashback
        }),
        eventDate
      ]
    );

    await conn.execute(
      `UPDATE loyalty_profiles
          SET xp = xp + ?,
              lifetime_eligible_spend = lifetime_eligible_spend + ?,
              updated_at = CURRENT_TIMESTAMP
        WHERE telegram_id = ?`,
      [xpDelta, eligibleSpend, uid]
    );

    let rewardDelta = 0;
    if (cashback > 0) {
      const inserted = await addCredit(conn, {
        telegramId: uid,
        sourceEventKey: `cashback:${uid}:${eventKey}`,
        amount: cashback
      });
      if (inserted) rewardDelta += cashback;
    }

    const already = await awardedMilestones(uid, conn);
    const crossedMilestones = [];
    for (const milestone of MILESTONES) {
      if (already.has(Number(milestone.spend90d))) continue;
      if (!(oldRolling < milestone.spend90d && newRolling >= milestone.spend90d)) continue;
      const sourceKey = `milestone:${uid}:${milestone.spend90d}`;
      const [milestoneInsert] = await conn.execute(
        `INSERT IGNORE INTO loyalty_milestones_awarded
          (telegram_id, milestone_spend, reward_toman, source_event_key)
         VALUES (?, ?, ?, ?)`,
        [uid, milestone.spend90d, milestone.rewardToman, sourceKey]
      );
      if (milestoneInsert.affectedRows === 1) {
        await conn.execute(
          `INSERT IGNORE INTO loyalty_events
           (telegram_id, event_key, event_type, reference_id, xp_delta, spend_amount, reward_delta, metadata, occurred_at)
           VALUES (?, ?, 'milestone', ?, 0, 0, ?, ?, ?)`,
          [
            uid,
            sourceKey,
            String(milestone.spend90d),
            milestone.rewardToman,
            JSON.stringify({ threshold_spend_90d: milestone.spend90d }),
            eventDate
          ]
        );
        const credited = await addCredit(conn, {
          telegramId: uid,
          sourceEventKey: sourceKey,
          amount: milestone.rewardToman
        });
        if (credited) {
          rewardDelta += milestone.rewardToman;
          crossedMilestones.push(milestone);
        }
      }
    }

    await conn.commit();
    return {
      awarded: true,
      eligibleSpend,
      xpBase: baseXp,
      xpDelta,
      streak,
      multiplier,
      level,
      cashback,
      rewardDelta,
      crossedMilestones,
      rollingSpend90d: newRolling
    };
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }
}

async function getRedemptionPreview(telegramId, grossAmountToman) {
  await ensureProfile(telegramId);
  const gross = Math.max(0, Math.floor(Number(grossAmountToman || 0)));
  const { balance } = await activeCreditBalance(telegramId);
  const cap = Math.floor(gross * MAX_REDEMPTION_PERCENT / 100);
  const creditUsable = Math.max(0, Math.min(balance, cap));
  return {
    grossAmount: gross,
    availableCredit: balance,
    maxPercent: MAX_REDEMPTION_PERCENT,
    creditUsable,
    walletCharge: Math.max(0, gross - creditUsable)
  };
}

async function consumeCredit({ telegramId, referenceId, grossAmountToman }) {
  const uid = String(telegramId);
  const ref = String(referenceId || '').trim();
  const gross = Math.max(0, Math.floor(Number(grossAmountToman || 0)));
  if (!uid || !ref || gross <= 0) return { creditUsed: 0, walletCharge: gross };

  await ensureSchema();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await ensureProfile(uid, conn);
    const redeemKey = `redeem:${uid}:${ref}`;
    const [existing] = await conn.execute(
      `SELECT reward_delta FROM loyalty_events WHERE event_key = ? LIMIT 1 FOR UPDATE`,
      [redeemKey]
    );
    if (existing.length) {
      const used = Math.max(0, -Number(existing[0].reward_delta || 0));
      await conn.rollback();
      return { creditUsed: used, walletCharge: Math.max(0, gross - used), duplicate: true };
    }

    const { rows, balance } = await activeCreditBalance(uid, conn, true);
    const cap = Math.floor(gross * MAX_REDEMPTION_PERCENT / 100);
    let remainingToUse = Math.max(0, Math.min(balance, cap));
    const creditUsed = remainingToUse;

    for (const credit of rows) {
      if (remainingToUse <= 0) break;
      const available = Math.max(0, Number(credit.remaining_amount || 0));
      const take = Math.min(available, remainingToUse);
      if (take <= 0) continue;
      await conn.execute(
        `UPDATE loyalty_credits SET remaining_amount = remaining_amount - ? WHERE id = ?`,
        [take, credit.id]
      );
      remainingToUse -= take;
    }

    await conn.execute(
      `INSERT INTO loyalty_events
       (telegram_id, event_key, event_type, reference_id, xp_delta, spend_amount, reward_delta, metadata, occurred_at)
       VALUES (?, ?, 'credit_redeem', ?, 0, 0, ?, ?, NOW())`,
      [
        uid,
        redeemKey,
        ref,
        -creditUsed,
        JSON.stringify({ gross_amount: gross, max_percent: MAX_REDEMPTION_PERCENT })
      ]
    );
    await conn.execute(
      `UPDATE loyalty_profiles
          SET reward_balance = GREATEST(0, reward_balance - ?), updated_at = CURRENT_TIMESTAMP
        WHERE telegram_id = ?`,
      [creditUsed, uid]
    );
    await conn.commit();
    return { creditUsed, walletCharge: Math.max(0, gross - creditUsed) };
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }
}

async function refundRedemption({ telegramId, referenceId }) {
  const uid = String(telegramId);
  const ref = String(referenceId || '').trim();
  if (!uid || !ref) return false;

  await ensureSchema();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await ensureProfile(uid, conn);
    const redeemKey = `redeem:${uid}:${ref}`;
    const refundKey = `refund:${uid}:${ref}`;
    const [existingRefund] = await conn.execute(`SELECT id FROM loyalty_events WHERE event_key = ? LIMIT 1`, [refundKey]);
    if (existingRefund.length) {
      await conn.rollback();
      return false;
    }
    const [redeem] = await conn.execute(
      `SELECT reward_delta FROM loyalty_events WHERE event_key = ? LIMIT 1 FOR UPDATE`,
      [redeemKey]
    );
    if (!redeem.length) {
      await conn.rollback();
      return false;
    }
    const amount = Math.max(0, -Number(redeem[0].reward_delta || 0));
    if (amount <= 0) {
      await conn.rollback();
      return false;
    }

    await conn.execute(
      `INSERT INTO loyalty_events
       (telegram_id, event_key, event_type, reference_id, xp_delta, spend_amount, reward_delta, metadata, occurred_at)
       VALUES (?, ?, 'credit_refund', ?, 0, 0, ?, ?, NOW())`,
      [uid, refundKey, ref, amount, JSON.stringify({ refund_of: redeemKey })]
    );
    await addCredit(conn, { telegramId: uid, sourceEventKey: refundKey, amount });
    await conn.commit();
    return true;
  } catch (error) {
    await conn.rollback().catch(() => {});
    throw error;
  } finally {
    conn.release();
  }
}

async function getSummary(telegramId) {
  await syncHistory(telegramId);
  await ensureProfile(telegramId);

  const [[profile]] = await pool.execute(
    `SELECT telegram_id, xp, lifetime_eligible_spend, reward_balance, updated_at
       FROM loyalty_profiles WHERE telegram_id = ? LIMIT 1`,
    [String(telegramId)]
  );
  const rollingSpend90d = await rollingSpend(telegramId);
  const { current, next } = resolveLevelBySpend(rollingSpend90d);
  const range = next ? Math.max(1, next.minSpend90d - current.minSpend90d) : 1;
  const progress = next
    ? Math.max(0, Math.min(100, Math.floor(((rollingSpend90d - current.minSpend90d) / range) * 100)))
    : 100;
  const streak = await getStreak(telegramId);
  const multiplier = streakMultiplier(streak);
  const rewardBalance = await refreshRewardBalance(telegramId);
  const [[stats]] = await pool.execute(
    `SELECT
       SUM(event_type = 'purchase') AS purchase_count,
       SUM(event_type = 'renewal') AS renewal_count
       FROM loyalty_events WHERE telegram_id = ?`,
    [String(telegramId)]
  );
  const already = await awardedMilestones(telegramId);
  const nextMilestone = MILESTONES.find(m => m.spend90d > rollingSpend90d && !already.has(Number(m.spend90d))) || null;
  const [[expiryRow]] = await pool.execute(
    `SELECT MIN(expires_at) AS nearest_expiry
       FROM loyalty_credits
      WHERE telegram_id = ? AND remaining_amount > 0 AND expires_at > NOW()`,
    [String(telegramId)]
  );

  return {
    xp: Math.max(0, Number(profile?.xp || 0)),
    level: current,
    nextLevel: next,
    progress,
    spendToNext: next ? Math.max(0, next.minSpend90d - rollingSpend90d) : 0,
    rollingSpend90d,
    lifetimeEligibleSpend: Number(profile?.lifetime_eligible_spend || 0),
    rewardBalance,
    nearestExpiry: expiryRow?.nearest_expiry || null,
    purchaseCount: Number(stats?.purchase_count || 0),
    renewalCount: Number(stats?.renewal_count || 0),
    streak,
    xpMultiplier: multiplier,
    nextMilestone,
    activeOpportunity: String(process.env.LOYALTY_ACTIVE_OPPORTUNITY || '').trim() || null,
    xpTomanStep: DEFAULT_XP_TOMAN_STEP,
    rollingDays: ROLLING_DAYS,
    creditExpiryDays: CREDIT_EXPIRY_DAYS,
    maxRedemptionPercent: MAX_REDEMPTION_PERCENT
  };
}

function progressBar(percent, size = 10) {
  const p = Math.max(0, Math.min(100, Number(percent || 0)));
  const filled = Math.round((p / 100) * size);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, size - filled));
}

function formatToman(value) {
  return Math.round(Number(value || 0)).toLocaleString('fa-IR');
}

function formatPercent(value) {
  const n = Number(value || 0);
  return Number.isInteger(n) ? String(n) : n.toLocaleString('fa-IR', { maximumFractionDigits: 1 });
}

function renderSummary(summary) {
  const lines = [
    '🏆 باشگاه هامون',
    '',
    `${summary.level.icon} سطح شما: ${summary.level.name}`,
    `⭐️ امتیاز: ${Number(summary.xp).toLocaleString('fa-IR')} XP`,
    `📅 خرید و تمدید واجد امتیاز در ${summary.rollingDays} روز اخیر: ${formatToman(summary.rollingSpend90d)} تومان`
  ];

  if (summary.nextLevel) {
    lines.push(`${progressBar(summary.progress)} ${summary.progress}% تا ${summary.nextLevel.name}`);
    lines.push(`فقط ${formatToman(summary.spendToNext)} تومان خرید/تمدید تا سطح بعدی`);
  } else {
    lines.push(`${progressBar(100)} بالاترین سطح باشگاه`);
  }

  lines.push('', '🎁 اعتبار باشگاه');
  lines.push(`${formatToman(summary.rewardBalance)} تومان اعتبار قابل استفاده`);
  lines.push(`کش‌بک سطح شما: ${formatPercent(summary.level.cashback)}٪`);
  lines.push(`در هر خرید تا ${formatPercent(summary.maxRedemptionPercent)}٪ مبلغ می‌تواند از اعتبار باشگاه پرداخت شود.`);
  if (summary.nearestExpiry) {
    const date = new Date(summary.nearestExpiry).toLocaleDateString('fa-IR', { timeZone: 'Asia/Tehran' });
    lines.push(`⏳ نزدیک‌ترین انقضای اعتبار: ${date}`);
  }

  lines.push('', '🎯 جایزه بعدی');
  if (summary.nextMilestone) {
    lines.push(`${formatToman(summary.nextMilestone.spend90d - summary.rollingSpend90d)} تومان تا +${formatToman(summary.nextMilestone.rewardToman)} تومان اعتبار`);
  } else {
    lines.push('همه جایزه‌های فعلی را رد کرده‌اید ✨');
  }

  lines.push('', '🔥 تداوم خرید');
  if (summary.streak > 0) {
    const bonus = Math.round((summary.xpMultiplier - 1) * 100);
    lines.push(`${summary.streak.toLocaleString('fa-IR')} ماه متوالی فعال`);
    lines.push(bonus > 0 ? `ضریب XP فعلی: +${bonus.toLocaleString('fa-IR')}٪` : 'یک ماه دیگر ادامه بدهید تا ضریب XP فعال شود.');
  } else {
    lines.push('با خرید یا تمدید در ماه‌های متوالی، ضریب XP می‌گیرید.');
  }

  if (summary.activeOpportunity) {
    lines.push('', '⚡ فرصت فعال', summary.activeOpportunity);
  }

  lines.push(
    '',
    'ℹ️ چطور حساب می‌شود؟',
    `هر ${formatToman(summary.xpTomanStep)} تومان پرداخت واقعی = ۱ XP`,
    'بخشی که با اعتبار باشگاه پرداخت می‌شود دوباره XP یا کش‌بک نمی‌گیرد.',
    `اعتبارهای جدید ${summary.creditExpiryDays.toLocaleString('fa-IR')} روز اعتبار دارند.`
  );
  return lines.join('\n');
}

module.exports = {
  ensureSchema,
  recordEvent,
  recordEligibleSpend,
  syncPurchases,
  syncHistoricalRenewals,
  syncHistory,
  getSummary,
  renderSummary,
  resolveLevel,
  resolveLevelBySpend,
  xpForSpend,
  getRedemptionPreview,
  consumeCredit,
  refundRedemption,
  streakMultiplier,
  getStreak,
  LEVELS,
  MILESTONES
};