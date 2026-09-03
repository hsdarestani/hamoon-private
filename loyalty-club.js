'use strict';

require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'hamooncloud_db',
  waitForConnections: true,
  connectionLimit: 4,
  queueLimit: 0
});

const DEFAULT_LEVELS = [
  { key: 'bronze', name: 'Bronze', emoji: '🥉', minXp: 0 },
  { key: 'silver', name: 'Silver', emoji: '🥈', minXp: 1500 },
  { key: 'gold', name: 'Gold', emoji: '🥇', minXp: 5000 },
  { key: 'black', name: 'Black', emoji: '🖤', minXp: 12000 }
];

const DEFAULT_MILESTONES = [
  { xp: 1000, rewardToman: 50000 },
  { xp: 3000, rewardToman: 150000 },
  { xp: 7000, rewardToman: 400000 },
  { xp: 15000, rewardToman: 900000 }
];

const ELIGIBLE_HISTORICAL_TYPES = [
  'purchase',
  'purchase_recovery',
  'billing',
  'upgrade',
  'server_upgrade'
];

let schemaPromise = null;

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function parseJsonArrayEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed : fallback;
  } catch (error) {
    console.warn(`[LOYALTY] Invalid ${name}; defaults will be used:`, error.message);
    return fallback;
  }
}

function getConfig() {
  const xpTomanStep = positiveInt(process.env.LOYALTY_XP_TOMAN_STEP, 10000);
  const levels = parseJsonArrayEnv('LOYALTY_LEVELS_JSON', DEFAULT_LEVELS)
    .map(level => ({
      key: String(level.key || level.name || 'level').toLowerCase(),
      name: String(level.name || level.key || 'Level'),
      emoji: String(level.emoji || '🏆'),
      minXp: Math.max(0, Number(level.minXp || 0))
    }))
    .sort((a, b) => a.minXp - b.minXp);
  const milestones = parseJsonArrayEnv('LOYALTY_MILESTONES_JSON', DEFAULT_MILESTONES)
    .map(item => ({
      xp: Math.max(1, Number(item.xp || 0)),
      rewardToman: Math.max(0, Math.floor(Number(item.rewardToman || 0)))
    }))
    .filter(item => item.xp > 0 && item.rewardToman > 0)
    .sort((a, b) => a.xp - b.xp);

  return { xpTomanStep, levels, milestones };
}

async function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const conn = await pool.getConnection();
      try {
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS loyalty_profiles (
            telegram_id VARCHAR(255) PRIMARY KEY,
            xp_total BIGINT NOT NULL DEFAULT 0,
            lifetime_spend DECIMAL(18,2) NOT NULL DEFAULT 0,
            reward_total DECIMAL(18,2) NOT NULL DEFAULT 0,
            reward_floor_xp BIGINT NOT NULL DEFAULT 0,
            bootstrapped_at DATETIME NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
          )
        `);
        await conn.execute(`
          CREATE TABLE IF NOT EXISTS loyalty_events (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            telegram_id VARCHAR(255) NOT NULL,
            event_key VARCHAR(191) NOT NULL,
            event_type VARCHAR(64) NOT NULL,
            reference_id VARCHAR(191) NULL,
            spend_amount DECIMAL(18,2) NOT NULL DEFAULT 0,
            xp_delta BIGINT NOT NULL DEFAULT 0,
            reward_delta DECIMAL(18,2) NOT NULL DEFAULT 0,
            metadata_json JSON NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uniq_loyalty_event_key (event_key),
            INDEX idx_loyalty_events_user (telegram_id, created_at)
          )
        `);
      } finally {
        conn.release();
      }
    })().catch(error => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

async function getHistoricalEligibleSpend(conn, telegramId) {
  const placeholders = ELIGIBLE_HISTORICAL_TYPES.map(() => '?').join(',');
  const [rows] = await conn.execute(
    `SELECT COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) AS spend
       FROM wallet_logs
      WHERE telegram_id = ?
        AND LOWER(type) IN (${placeholders})`,
    [String(telegramId), ...ELIGIBLE_HISTORICAL_TYPES]
  );
  return Math.max(0, Number(rows?.[0]?.spend || 0));
}

async function ensureProfileWithConnection(conn, telegramId, lock = false) {
  const uid = String(telegramId);
  const suffix = lock ? ' FOR UPDATE' : '';
  let [rows] = await conn.execute(`SELECT * FROM loyalty_profiles WHERE telegram_id = ?${suffix}`, [uid]);
  if (rows.length) return rows[0];

  const { xpTomanStep } = getConfig();
  const historicalSpend = await getHistoricalEligibleSpend(conn, uid);
  const bootstrapXp = Math.floor(historicalSpend / xpTomanStep);

  await conn.execute(
    `INSERT IGNORE INTO loyalty_profiles
      (telegram_id, xp_total, lifetime_spend, reward_total, reward_floor_xp, bootstrapped_at)
     VALUES (?, ?, ?, 0, ?, NOW())`,
    [uid, bootstrapXp, historicalSpend, bootstrapXp]
  );
  [rows] = await conn.execute(`SELECT * FROM loyalty_profiles WHERE telegram_id = ?${suffix}`, [uid]);
  return rows[0];
}

async function ensureProfile(telegramId) {
  await ensureSchema();
  const conn = await pool.getConnection();
  try {
    return await ensureProfileWithConnection(conn, telegramId, false);
  } finally {
    conn.release();
  }
}

function resolveLevel(xp, levels) {
  let current = levels[0];
  for (const level of levels) {
    if (xp >= level.minXp) current = level;
    else break;
  }
  const currentIndex = Math.max(0, levels.findIndex(level => level.key === current.key));
  const next = currentIndex < levels.length - 1 ? levels[currentIndex + 1] : null;
  return { current, next };
}

function makeProgressBar(xp, currentLevel, nextLevel) {
  if (!nextLevel) return '██████████';
  const span = Math.max(1, nextLevel.minXp - currentLevel.minXp);
  const done = Math.max(0, Math.min(span, xp - currentLevel.minXp));
  const ratio = done / span;
  const filled = Math.max(0, Math.min(10, Math.floor(ratio * 10)));
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
}

function formatNumber(value) {
  return Math.round(Number(value || 0)).toLocaleString('fa-IR');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getActiveCampaign() {
  const title = String(process.env.LOYALTY_ACTIVE_CAMPAIGN_TITLE || '').trim();
  if (!title) return null;
  const until = String(process.env.LOYALTY_ACTIVE_CAMPAIGN_UNTIL || '').trim();
  const detail = String(process.env.LOYALTY_ACTIVE_CAMPAIGN_DETAIL || '').trim();
  return { title, detail, until };
}

async function getDashboard(telegramId) {
  const profile = await ensureProfile(telegramId);
  const { levels, milestones } = getConfig();
  const xp = Math.max(0, Number(profile.xp_total || 0));
  const { current, next } = resolveLevel(xp, levels);
  const nextMilestone = milestones.find(item => item.xp > xp) || null;
  const campaign = getActiveCampaign();
  const progressBar = makeProgressBar(xp, current, next);

  const lines = [
    '🏆 <b>باشگاه هامون</b>',
    '',
    `${current.emoji} سطح شما: <b>${escapeHtml(current.name)}</b>`,
    `⭐ امتیاز: <b>${formatNumber(xp)} XP</b>`
  ];

  if (next) {
    const remaining = Math.max(0, next.minXp - xp);
    lines.push(`${progressBar}  ${formatNumber(remaining)} XP تا ${escapeHtml(next.name)}`);
  } else {
    lines.push(`${progressBar}  بالاترین سطح باشگاه 🎉`);
  }

  lines.push(
    '',
    '💰 <b>پاداش‌های شما</b>',
    `🎁 مجموع جایزه دریافتی: <b>${formatNumber(profile.reward_total)} تومان</b>`,
    `🛒 خرید واجد امتیاز: <b>${formatNumber(profile.lifetime_spend)} تومان</b>`
  );

  if (nextMilestone) {
    lines.push(
      '',
      '🎯 <b>جایزه بعدی</b>',
      `${formatNumber(nextMilestone.xp - xp)} XP دیگه → <b>${formatNumber(nextMilestone.rewardToman)} تومان</b> اعتبار کیف پول`
    );
  } else {
    lines.push('', '🎯 همه جایزه‌های فعلی باشگاه را رد کرده‌اید ✨');
  }

  if (campaign) {
    lines.push('', '🔥 <b>فرصت فعال</b>', escapeHtml(campaign.title));
    if (campaign.detail) lines.push(escapeHtml(campaign.detail));
    if (campaign.until) lines.push(`⏳ تا ${escapeHtml(campaign.until)}`);
  }

  lines.push('', 'ℹ️ خریدهای بیشتر، XP بیشتری می‌دهند و با عبور از مراحل جدید، جایزه مستقیم به کیف پول اضافه می‌شود.');

  return {
    text: lines.join('\n'),
    profile,
    level: current,
    nextLevel: next,
    nextMilestone
  };
}

async function recordPurchaseReward({ telegramId, referenceId, amountToman, datacenter = null, serverName = null }) {
  const uid = String(telegramId);
  const ref = String(referenceId || '').trim();
  const spend = Math.max(0, Math.floor(Number(amountToman || 0)));
  if (!uid || !ref || spend <= 0) return { awarded: false, reason: 'invalid_input' };

  await ensureSchema();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const profile = await ensureProfileWithConnection(conn, uid, true);
    const eventKey = `purchase:${ref}`;
    const [existing] = await conn.execute('SELECT id FROM loyalty_events WHERE event_key = ? LIMIT 1', [eventKey]);
    if (existing.length) {
      await conn.rollback();
      return { awarded: false, reason: 'duplicate' };
    }

    const { xpTomanStep, milestones } = getConfig();
    const xpDelta = Math.max(1, Math.floor(spend / xpTomanStep));
    const oldXp = Math.max(0, Number(profile.xp_total || 0));
    const newXp = oldXp + xpDelta;
    const rewardFloor = Math.max(0, Number(profile.reward_floor_xp || 0));
    const crossed = milestones.filter(item => item.xp > rewardFloor && item.xp > oldXp && item.xp <= newXp);
    const rewardDelta = crossed.reduce((sum, item) => sum + Number(item.rewardToman || 0), 0);
    const nextRewardFloor = crossed.length ? Math.max(rewardFloor, ...crossed.map(item => item.xp)) : rewardFloor;

    await conn.execute(
      `INSERT INTO loyalty_events
        (telegram_id, event_key, event_type, reference_id, spend_amount, xp_delta, reward_delta, metadata_json)
       VALUES (?, ?, 'purchase', ?, ?, ?, ?, ?)`,
      [uid, eventKey, ref, spend, xpDelta, rewardDelta, JSON.stringify({ datacenter, serverName })]
    );

    await conn.execute(
      `UPDATE loyalty_profiles
          SET xp_total = xp_total + ?,
              lifetime_spend = lifetime_spend + ?,
              reward_total = reward_total + ?,
              reward_floor_xp = ?,
              updated_at = CURRENT_TIMESTAMP
        WHERE telegram_id = ?`,
      [xpDelta, spend, rewardDelta, nextRewardFloor, uid]
    );

    if (rewardDelta > 0) {
      const [walletResult] = await conn.execute('UPDATE users SET wallet = wallet + ? WHERE telegram_id = ?', [rewardDelta, uid]);
      if (walletResult.affectedRows === 0) {
        throw new Error(`Cannot credit loyalty reward: user ${uid} does not exist`);
      }
      await conn.execute(
        `INSERT INTO wallet_logs (telegram_id, amount, description, type)
         VALUES (?, ?, ?, 'loyalty_reward')`,
        [uid, rewardDelta, `جایزه باشگاه هامون - عبور از ${crossed.map(item => `${item.xp} XP`).join('، ')}`]
      );
    }

    await conn.commit();
    return {
      awarded: true,
      xpDelta,
      rewardDelta,
      newXp,
      crossedMilestones: crossed
    };
  } catch (error) {
    await conn.rollback().catch(() => null);
    throw error;
  } finally {
    conn.release();
  }
}

module.exports = {
  getDashboard,
  recordPurchaseReward,
  ensureSchema,
  getConfig,
  resolveLevel,
  makeProgressBar
};
