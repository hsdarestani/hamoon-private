'use strict';

const { pool } = require('../db');

const DEFAULT_XP_TOMAN_STEP = Math.max(1, Number(process.env.LOYALTY_XP_TOMAN_STEP || 10000));

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const LEVELS = [
  { key: 'bronze', name: 'Bronze', icon: '🥉', minXp: 0, cashback: envNumber('LOYALTY_BRONZE_CASHBACK', 0) },
  { key: 'silver', name: 'Silver', icon: '🥈', minXp: envNumber('LOYALTY_SILVER_XP', 5000), cashback: envNumber('LOYALTY_SILVER_CASHBACK', 0) },
  { key: 'gold', name: 'Gold', icon: '🥇', minXp: envNumber('LOYALTY_GOLD_XP', 15000), cashback: envNumber('LOYALTY_GOLD_CASHBACK', 0) },
  { key: 'black', name: 'Black', icon: '💎', minXp: envNumber('LOYALTY_BLACK_XP', 40000), cashback: envNumber('LOYALTY_BLACK_CASHBACK', 0) }
].sort((a, b) => a.minXp - b.minXp);

let schemaPromise = null;

async function ensureSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS loyalty_profiles (
        telegram_id VARCHAR(255) PRIMARY KEY,
        xp BIGINT NOT NULL DEFAULT 0,
        lifetime_eligible_spend DECIMAL(18,2) NOT NULL DEFAULT 0,
        reward_balance DECIMAL(18,2) NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT fk_loyalty_profile_user FOREIGN KEY (telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
      )
    `);
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS loyalty_events (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        telegram_id VARCHAR(255) NOT NULL,
        event_key VARCHAR(191) NOT NULL,
        event_type VARCHAR(64) NOT NULL,
        xp_delta BIGINT NOT NULL DEFAULT 0,
        spend_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
        reward_delta DECIMAL(18,2) NOT NULL DEFAULT 0,
        metadata JSON NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_loyalty_event_key (event_key),
        INDEX idx_loyalty_events_user_created (telegram_id, created_at),
        CONSTRAINT fk_loyalty_event_user FOREIGN KEY (telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
      )
    `);
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

function resolveLevel(xp) {
  const value = Math.max(0, Number(xp || 0));
  let current = LEVELS[0];
  for (const level of LEVELS) {
    if (value >= level.minXp) current = level;
  }
  const index = LEVELS.findIndex(level => level.key === current.key);
  const next = LEVELS[index + 1] || null;
  return { current, next };
}

async function ensureProfile(telegramId) {
  await ensureSchema();
  await pool.execute(
    `INSERT INTO loyalty_profiles (telegram_id) VALUES (?)
     ON DUPLICATE KEY UPDATE telegram_id = VALUES(telegram_id)`,
    [String(telegramId)]
  );
}

async function recordEvent({ telegramId, eventKey, eventType, xpDelta = 0, spendAmount = 0, rewardDelta = 0, metadata = null }) {
  await ensureProfile(telegramId);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.execute(
      `INSERT IGNORE INTO loyalty_events
       (telegram_id, event_key, event_type, xp_delta, spend_amount, reward_delta, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        String(telegramId),
        String(eventKey),
        String(eventType),
        Math.trunc(Number(xpDelta || 0)),
        Number(spendAmount || 0),
        Number(rewardDelta || 0),
        metadata ? JSON.stringify(metadata) : null
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
      xpDelta: xp,
      spendAmount: amount,
      metadata: {
        server_id: purchase.server_id,
        datacenter: purchase.datacenter,
        duration: purchase.duration,
        source: 'purchase_backfill_v1'
      }
    });
    if (inserted) addedXp += xp;
  }
  return { purchases: rows.length, addedXp };
}

async function getSummary(telegramId) {
  await syncPurchases(telegramId);
  const [[profile]] = await pool.execute(
    `SELECT telegram_id, xp, lifetime_eligible_spend, reward_balance, updated_at
     FROM loyalty_profiles WHERE telegram_id = ? LIMIT 1`,
    [String(telegramId)]
  );
  const [[stats]] = await pool.execute(
    `SELECT
       SUM(event_type = 'purchase') AS purchase_count,
       COALESCE(SUM(reward_delta), 0) AS total_rewards
     FROM loyalty_events WHERE telegram_id = ?`,
    [String(telegramId)]
  );
  const xp = Math.max(0, Number(profile?.xp || 0));
  const { current, next } = resolveLevel(xp);
  const range = next ? Math.max(1, next.minXp - current.minXp) : 1;
  const progress = next ? Math.max(0, Math.min(100, Math.floor(((xp - current.minXp) / range) * 100))) : 100;
  return {
    xp,
    level: current,
    nextLevel: next,
    progress,
    xpToNext: next ? Math.max(0, next.minXp - xp) : 0,
    lifetimeEligibleSpend: Number(profile?.lifetime_eligible_spend || 0),
    rewardBalance: Number(profile?.reward_balance || 0),
    purchaseCount: Number(stats?.purchase_count || 0),
    activeOpportunity: String(process.env.LOYALTY_ACTIVE_OPPORTUNITY || '').trim() || null,
    xpTomanStep: DEFAULT_XP_TOMAN_STEP
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

function renderSummary(summary) {
  const lines = [
    '🏆 باشگاه هامون',
    '',
    `${summary.level.icon} سطح شما: ${summary.level.name}`,
    `⭐️ ${Number(summary.xp).toLocaleString('fa-IR')} XP`,
  ];

  if (summary.nextLevel) {
    lines.push(`${progressBar(summary.progress)} ${summary.progress}% تا ${summary.nextLevel.name}`);
  } else {
    lines.push(`${progressBar(100)} بالاترین سطح باشگاه`);
  }

  lines.push('', '💰 پاداش فعلی');
  if (summary.rewardBalance > 0) lines.push(`${formatToman(summary.rewardBalance)} تومان اعتبار باشگاه`);
  else if (summary.level.cashback > 0) lines.push(`کش‌بک سطح: ${summary.level.cashback}%`);
  else lines.push('در حال حاضر اعتبار نقدی قابل دریافت ندارید.');

  lines.push('', '🎯 نزدیک‌ترین هدف');
  if (summary.nextLevel) lines.push(`${Number(summary.xpToNext).toLocaleString('fa-IR')} XP تا ${summary.nextLevel.name}`);
  else lines.push('شما به بالاترین سطح رسیده‌اید 💎');

  lines.push('', '📊 وضعیت شما');
  lines.push(`${Number(summary.purchaseCount).toLocaleString('fa-IR')} خرید ثبت‌شده`);
  lines.push(`${formatToman(summary.lifetimeEligibleSpend)} تومان خرید واجد امتیاز`);

  if (summary.activeOpportunity) {
    lines.push('', '🔥 فرصت فعال', summary.activeOpportunity);
  }

  lines.push('', `هر ${formatToman(summary.xpTomanStep)} تومان خرید = ۱ XP`);
  return lines.join('\n');
}

module.exports = {
  ensureSchema,
  recordEvent,
  syncPurchases,
  getSummary,
  renderSummary,
  resolveLevel,
  xpForSpend
};
