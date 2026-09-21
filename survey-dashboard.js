'use strict';

const db = require('./db');

const SURVEY_VERSION = 'services_2026_09';
const REWARD_AMOUNT = 50000;

const QUESTIONS = {
  1: {
    key: 'usage',
    title: 'کاربرد اصلی سرورها',
    multi: true,
    options: [
      ['vpn', 'VPN / Proxy'],
      ['telegram_bot', 'ربات تلگرام'],
      ['website', 'وب‌سایت / فروشگاه'],
      ['api_backend', 'API / Backend'],
      ['trading', 'ترید و بازار مالی'],
      ['automation', 'اتوماسیون / اسکریپت'],
      ['scraping', 'Scraping / Crawler'],
      ['rdp', 'Remote Desktop'],
      ['ai', 'AI / هوش مصنوعی'],
      ['game', 'Game Server'],
      ['storage', 'Storage / Backup'],
      ['resale', 'فروش سرویس به مشتری'],
      ['company', 'استفاده شرکتی'],
      ['other', 'سایر موارد']
    ]
  },
  2: {
    key: 'persona',
    title: 'نوع کاربر',
    multi: false,
    options: [
      ['personal', 'مصرف شخصی'],
      ['developer', 'برنامه‌نویس / متخصص فنی'],
      ['freelancer', 'فریلنسر'],
      ['startup', 'صاحب کسب‌وکار / استارتاپ'],
      ['company', 'شرکت / سازمان'],
      ['reseller', 'فروشنده / Reseller'],
      ['trader', 'فعال بازارهای مالی'],
      ['marketing', 'آژانس / تیم مارکتینگ'],
      ['other', 'مورد دیگر']
    ]
  },
  3: {
    key: 'current_spend',
    title: 'سرویس‌هایی که برایشان هزینه می‌شود',
    multi: true,
    options: [
      ['security', 'امنیت سایبری'],
      ['monitoring', 'Monitoring'],
      ['apis', 'APIها'],
      ['api_marketplace', 'API Marketplace'],
      ['ai_tools', 'ابزارهای AI'],
      ['automation', 'Automation'],
      ['backup', 'Backup / Cloud Storage'],
      ['webinfra', 'Domain / DNS / CDN'],
      ['email', 'Email'],
      ['messaging', 'SMS / OTP / Notification'],
      ['secrets', 'Password / Secret Management'],
      ['analytics', 'Analytics / Reporting'],
      ['devtools', 'Developer Tools'],
      ['payments', 'پرداخت و سرویس‌های مالی'],
      ['business', 'ابزارهای کسب‌وکار'],
      ['crm', 'CRM'],
      ['marketing', 'ابزارهای مارکتینگ'],
      ['none', 'هیچ‌کدام'],
      ['other', 'سایر موارد']
    ]
  },
  4: {
    key: 'future_interest',
    title: 'سرویس‌های جدید جذاب',
    multi: true,
    options: [
      ['security', 'Security'],
      ['monitoring', 'Monitoring'],
      ['api_marketplace', 'API Marketplace'],
      ['ai_services', 'AI Services'],
      ['automation', 'Automation'],
      ['backup', 'Cloud Backup & Storage'],
      ['messaging', 'Messaging Services'],
      ['webinfra', 'Web Infrastructure'],
      ['devtools', 'Developer Tools'],
      ['business', 'Business Tools'],
      ['reseller', 'Reseller Services'],
      ['payments', 'Payment & Financial APIs'],
      ['privacy', 'Privacy & Identity'],
      ['other', 'حوزه دیگر']
    ]
  },
  5: {
    key: 'open_need',
    title: 'نیاز آزاد / پاسخ متنی',
    multi: false,
    options: []
  }
};

function parseJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return {}; }
}

function optionMap(question) {
  return Object.fromEntries((question?.options || []).map(([code, label]) => [code, label]));
}

function normalizeAnswer(questionNumber, value) {
  const q = QUESTIONS[questionNumber];
  const labels = optionMap(q);
  if (questionNumber === 5) {
    const text = value == null ? '' : String(value).trim();
    return { codes: text ? [text] : [], labels: text ? [text] : [], text };
  }
  const codes = q?.multi
    ? (Array.isArray(value) ? value.map(String) : [])
    : (value == null || value === '' ? [] : [String(value)]);
  return {
    codes,
    labels: codes.map(code => labels[code] || code),
    text: ''
  };
}

function percent(count, total) {
  if (!total) return 0;
  return Math.round((Number(count || 0) / total) * 1000) / 10;
}

function flattenRow(row) {
  const answers = parseJson(row.answers_json);
  const out = {
    telegram_id: String(row.telegram_id || ''),
    phone: row.phone || '',
    wallet: Number(row.wallet || 0),
    server_count: Number(row.server_count || 0),
    current_step: Number(row.current_step || 1),
    started_at: row.started_at || null,
    completed_at: row.completed_at || null,
    rewarded_at: row.rewarded_at || null,
    reward_amount: Number(row.reward_amount || 0),
    status: row.completed_at ? 'completed' : 'started'
  };
  for (let i = 1; i <= 5; i += 1) {
    const normalized = normalizeAnswer(i, answers[String(i)]);
    out[`q${i}`] = i === 5 ? normalized.text : normalized.labels.join(' | ');
    out[`q${i}_codes`] = i === 5 ? normalized.text : normalized.codes.join('|');
  }
  return out;
}

async function loadSurveyRows({ completedOnly = false } = {}) {
  const where = completedOnly ? 'AND s.completed_at IS NOT NULL' : '';
  const [rows] = await db.pool.query(
    `SELECT
       s.telegram_id, s.current_step, s.answers_json, s.started_at, s.updated_at,
       s.completed_at, s.reward_amount, s.rewarded_at,
       u.phone, u.wallet,
       COALESCE(p.server_count, 0) AS server_count
     FROM user_surveys s
     LEFT JOIN users u ON u.telegram_id = s.telegram_id
     LEFT JOIN (
       SELECT telegram_id,
              SUM(status NOT IN ('deleted','deletion_pending')) AS server_count
       FROM purchases
       GROUP BY telegram_id
     ) p ON p.telegram_id = s.telegram_id
     WHERE s.survey_version = ?
       ${where}
     ORDER BY COALESCE(s.completed_at, s.updated_at, s.started_at) DESC`,
    [SURVEY_VERSION]
  );
  return rows;
}

function aggregateQuestion(rows, questionNumber) {
  const q = QUESTIONS[questionNumber];
  const labels = optionMap(q);
  const counts = new Map();
  let answered = 0;

  for (const row of rows) {
    const answers = parseJson(row.answers_json);
    const normalized = normalizeAnswer(questionNumber, answers[String(questionNumber)]);
    if (!normalized.codes.length) continue;
    answered += 1;
    for (const code of normalized.codes) counts.set(code, (counts.get(code) || 0) + 1);
  }

  const data = [...counts.entries()]
    .map(([code, count]) => ({
      code,
      label: labels[code] || code,
      count,
      percentage: percent(count, answered)
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'fa'));

  return {
    number: questionNumber,
    key: q.key,
    title: q.title,
    multi: q.multi,
    answered,
    data
  };
}

function buildOpportunityRows(q3, q4, completed) {
  const aliases = [
    ['security', 'security', 'امنیت سایبری'],
    ['monitoring', 'monitoring', 'Monitoring'],
    ['api_marketplace', 'api_marketplace', 'API Marketplace'],
    ['automation', 'automation', 'Automation'],
    ['backup', 'backup', 'Cloud Backup & Storage'],
    ['messaging', 'messaging', 'Messaging Services'],
    ['webinfra', 'webinfra', 'Web Infrastructure'],
    ['devtools', 'devtools', 'Developer Tools'],
    ['business', 'business', 'Business Tools'],
    ['payments', 'payments', 'Payment & Financial APIs']
  ];
  const spend = new Map(q3.data.map(x => [x.code, x.count]));
  const interest = new Map(q4.data.map(x => [x.code, x.count]));
  return aliases.map(([spendCode, interestCode, label]) => {
    const current = Number(spend.get(spendCode) || 0);
    const wanted = Number(interest.get(interestCode) || 0);
    return {
      label,
      current,
      interest: wanted,
      gap: wanted - current,
      interest_rate: percent(wanted, completed),
      current_rate: percent(current, completed)
    };
  }).sort((a, b) => b.gap - a.gap || b.interest - a.interest);
}

function buildAnalysis({ completed, started, sent, questions, opportunities, openResponses }) {
  const q1 = questions[0];
  const q2 = questions[1];
  const q3 = questions[2];
  const q4 = questions[3];

  const top = list => list?.data?.[0] || null;
  const topUse = top(q1);
  const topPersona = top(q2);
  const topSpend = top(q3);
  const topInterest = top(q4);
  const topGap = opportunities.find(x => x.gap > 0) || opportunities[0] || null;

  const insights = [];
  if (topInterest) {
    insights.push({
      type: 'opportunity',
      title: 'بیشترین تقاضای محصول جدید',
      text: `${topInterest.label} با ${topInterest.count} انتخاب (${topInterest.percentage}٪ از پاسخ‌دهندگان این سؤال) در صدر علاقه‌مندی‌هاست.`
    });
  }
  if (topGap && topGap.gap > 0) {
    insights.push({
      type: 'gap',
      title: 'شکاف بازار قابل بررسی',
      text: `${topGap.label}: علاقه ${topGap.interest} نفر است در حالی که ${topGap.current} نفر گفته‌اند اکنون برای این دسته هزینه می‌کنند؛ شکاف +${topGap.gap} نفر.`
    });
  }
  if (topPersona) {
    insights.push({
      type: 'segment',
      title: 'بزرگ‌ترین سگمنت',
      text: `${topPersona.label} با ${topPersona.count} نفر (${topPersona.percentage}٪) بزرگ‌ترین گروه پاسخ‌دهندگان است.`
    });
  }
  if (topUse) {
    insights.push({
      type: 'usage',
      title: 'کاربرد غالب',
      text: `${topUse.label} با ${topUse.count} انتخاب، پرتکرارترین کاربرد گزارش‌شده برای سرورهاست.`
    });
  }
  if (topSpend) {
    insights.push({
      type: 'spend',
      title: 'هزینه فعلی کاربران',
      text: `${topSpend.label} پرتکرارترین دسته‌ای است که کاربران گفته‌اند برایش هزینه می‌کنند یا احتمال هزینه‌کرد دارند.`
    });
  }

  const completionRate = percent(completed, sent);
  const finishRate = percent(completed, started);
  insights.push({
    type: 'conversion',
    title: 'کیفیت مشارکت',
    text: `از ${sent} دعوت موفق، ${completed} پاسخ کامل ثبت شده (${completionRate}٪). از کسانی که شروع کرده‌اند، ${finishRate}٪ نظرسنجی را تمام کرده‌اند.`
  });

  return {
    insights,
    opportunity_matrix: opportunities.slice(0, 10),
    open_response_count: openResponses.length
  };
}

async function getOverview() {
  const [inviteRows] = await db.pool.query(
    `SELECT invite_status, COUNT(*) AS total
       FROM survey_invites
      WHERE survey_version = ?
      GROUP BY invite_status`,
    [SURVEY_VERSION]
  );
  const inviteCounts = Object.fromEntries(inviteRows.map(row => [row.invite_status, Number(row.total || 0)]));
  const rows = await loadSurveyRows();
  const completedRows = rows.filter(row => row.completed_at);
  const completed = completedRows.length;
  const started = rows.length;
  const rewarded = completedRows.filter(row => row.rewarded_at).length;
  const sent = Number(inviteCounts.sent || 0);
  const failed = Number(inviteCounts.failed || 0);

  const questions = [1, 2, 3, 4].map(n => aggregateQuestion(completedRows, n));
  const q3 = questions.find(q => q.number === 3);
  const q4 = questions.find(q => q.number === 4);
  const opportunities = buildOpportunityRows(q3, q4, completed);

  const openResponses = completedRows
    .map(row => {
      const answer = normalizeAnswer(5, parseJson(row.answers_json)['5']).text;
      return answer ? {
        telegram_id: String(row.telegram_id),
        text: answer,
        completed_at: row.completed_at
      } : null;
    })
    .filter(Boolean);

  const [trendRows] = await db.pool.query(
    `SELECT DATE(completed_at) AS day, COUNT(*) AS completed
       FROM user_surveys
      WHERE survey_version = ?
        AND completed_at IS NOT NULL
        AND completed_at >= DATE_SUB(CURRENT_DATE, INTERVAL 29 DAY)
      GROUP BY DATE(completed_at)
      ORDER BY day ASC`,
    [SURVEY_VERSION]
  );

  const analysis = buildAnalysis({
    completed,
    started,
    sent,
    questions,
    opportunities,
    openResponses
  });

  return {
    version: SURVEY_VERSION,
    reward_amount: REWARD_AMOUNT,
    stats: {
      sent,
      failed,
      started,
      completed,
      rewarded,
      in_progress: Math.max(0, started - completed),
      completion_rate_sent: percent(completed, sent),
      finish_rate_started: percent(completed, started),
      reward_cost: rewarded * REWARD_AMOUNT
    },
    questions,
    open_responses: openResponses.slice(0, 100),
    trend: trendRows.map(row => ({
      day: row.day,
      completed: Number(row.completed || 0)
    })),
    analysis,
    updated_at: new Date().toISOString()
  };
}

async function getRaw(query = {}) {
  const all = await loadSurveyRows();
  const q = String(query.q || '').trim().toLowerCase();
  const status = String(query.status || 'all');
  const pageSize = Math.min(100, Math.max(10, parseInt(query.pageSize, 10) || 50));
  const page = Math.max(1, parseInt(query.page, 10) || 1);

  let rows = all.map(flattenRow);
  if (status === 'completed') rows = rows.filter(row => row.status === 'completed');
  if (status === 'started') rows = rows.filter(row => row.status === 'started');

  if (q) {
    rows = rows.filter(row => [
      row.telegram_id, row.phone, row.q1, row.q2, row.q3, row.q4, row.q5
    ].some(value => String(value || '').toLowerCase().includes(q)));
  }

  const total = rows.length;
  const offset = (page - 1) * pageSize;
  return {
    rows: rows.slice(offset, offset + pageSize),
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize))
  };
}

async function getExportRows() {
  const rows = await loadSurveyRows();
  return rows.map(flattenRow).map(row => ({
    telegram_id: row.telegram_id,
    phone: row.phone,
    wallet_toman: row.wallet,
    server_count: row.server_count,
    status: row.status,
    started_at: row.started_at,
    completed_at: row.completed_at,
    rewarded_at: row.rewarded_at,
    reward_amount_toman: row.reward_amount,
    q1_server_usage: row.q1,
    q2_user_type: row.q2,
    q3_current_or_future_spend: row.q3,
    q4_new_services_interest: row.q4,
    q5_open_need: row.q5
  }));
}

module.exports = {
  SURVEY_VERSION,
  REWARD_AMOUNT,
  QUESTIONS,
  getOverview,
  getRaw,
  getExportRows
};
