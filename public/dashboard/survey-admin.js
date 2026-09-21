'use strict';

(() => {
  let surveyTab = 'charts';
  let surveyOverviewCache = null;
  let surveyRawCache = null;
  let surveyCharts = [];
  let surveyRawState = { page: 1, pageSize: 50, q: '', status: 'all' };

  function destroySurveyCharts() {
    for (const chart of surveyCharts) {
      try { chart.destroy(); } catch (_) {}
    }
    surveyCharts = [];
  }

  function pct(value) {
    const n = Number(value || 0);
    return n.toLocaleString('fa-IR', { maximumFractionDigits: 1 }) + '٪';
  }

  function money(value) {
    return (Number(value || 0)).toLocaleString('fa-IR') + ' تومان';
  }

  function surveyStatusBadge(row) {
    if (row.status === 'completed') return '<span class="badge ok">تکمیل‌شده</span>';
    return '<span class="badge suspended">ناتمام</span>';
  }

  function surveyTabs() {
    return `
      <div class="survey-tabs">
        <button type="button" class="${surveyTab === 'charts' ? 'active' : ''}" onclick="surveySetTab('charts')">📊 نمای نموداری</button>
        <button type="button" class="${surveyTab === 'analysis' ? 'active' : ''}" onclick="surveySetTab('analysis')">🧠 تحلیل و فرصت‌ها</button>
        <button type="button" class="${surveyTab === 'raw' ? 'active' : ''}" onclick="surveySetTab('raw')">🗂 داده خام</button>
      </div>`;
  }

  function surveyKpis(data) {
    const s = data.stats || {};
    const cards = [
      ['📨', 'دعوت موفق', s.sent, ''],
      ['▶️', 'شروع کرده', s.started, ''],
      ['✅', 'تکمیل کرده', s.completed, 'survey-kpi-success'],
      ['🎁', 'جایزه گرفته', s.rewarded, 'survey-kpi-success'],
      ['⏳', 'ناتمام', s.in_progress, ''],
      ['📈', 'نرخ تکمیل از دعوت', pct(s.completion_rate_sent), ''],
      ['🎯', 'نرخ اتمام بعد از شروع', pct(s.finish_rate_started), ''],
      ['💰', 'اعتبار هدیه پرداخت‌شده', money(s.reward_cost), 'survey-kpi-money']
    ];
    return `<div class="cards kpi-grid survey-kpis">${cards.map(card => `
      <div class="card kpi-card ${card[3]}">
        <span>${card[0]} ${esc(card[1])}</span>
        <b>${typeof card[2] === 'number' ? fmt(card[2]) : esc(card[2])}</b>
      </div>`).join('')}</div>`;
  }

  function chartPanel(id, title, subtitle = '') {
    return `<div class="panel survey-chart-panel">
      <div class="survey-panel-head"><div><h3>${esc(title)}</h3>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div></div>
      <div class="survey-canvas-wrap"><canvas id="${id}"></canvas></div>
    </div>`;
  }

  function renderCharts(data) {
    const q = Object.fromEntries((data.questions || []).map(item => [item.number, item]));
    const trend = data.trend || [];
    return `
      <div class="survey-grid survey-grid-main">
        ${chartPanel('surveyTrendChart', 'روند تکمیل نظرسنجی', 'تعداد پاسخ کامل در ۳۰ روز اخیر')}
        ${chartPanel('surveyQ2Chart', q[2]?.title || 'نوع کاربر', 'توزیع سگمنت پاسخ‌دهندگان')}
      </div>
      <div class="survey-grid">
        ${chartPanel('surveyQ1Chart', q[1]?.title || 'کاربرد سرورها', 'چندانتخابی؛ تعداد انتخاب هر گزینه')}
        ${chartPanel('surveyQ4Chart', q[4]?.title || 'سرویس‌های جدید جذاب', 'حداکثر ۵ انتخاب برای هر کاربر')}
      </div>
      <div class="survey-grid">
        ${chartPanel('surveyQ3Chart', q[3]?.title || 'هزینه فعلی یا آینده', 'دسته‌هایی که کاربر برای آن‌ها هزینه می‌کند یا احتمال هزینه‌کرد دارد')}
        <div class="panel">
          <div class="survey-panel-head"><div><h3>پاسخ‌های متنی اخیر</h3><p>سؤال ۵ · نیاز یا ابزاری که پیدا کردنش سخت است</p></div><span class="survey-count">${fmt(data.analysis?.open_response_count || 0)}</span></div>
          <div class="survey-open-list">
            ${(data.open_responses || []).slice(0, 12).map(item => `<div class="survey-open-item"><span>${esc(item.text)}</span><small>${date(item.completed_at)}</small></div>`).join('') || empty('هنوز پاسخ متنی ثبت نشده است.')}
          </div>
        </div>
      </div>`;
  }

  function makeBarChart(canvasId, question) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || !window.Chart || !question) return;
    const rows = question.data || [];
    const chart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: rows.map(x => x.label),
        datasets: [{
          label: 'تعداد انتخاب',
          data: rows.map(x => x.count),
          borderWidth: 1,
          borderRadius: 7
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              afterLabel(ctx) {
                return `${rows[ctx.dataIndex]?.percentage || 0}٪ از پاسخ‌دهندگان`;
              }
            }
          }
        },
        scales: {
          x: {
            beginAtZero: true,
            ticks: { precision: 0 },
            grid: { color: 'rgba(148,163,184,.10)' }
          },
          y: { grid: { display: false } }
        }
      }
    });
    surveyCharts.push(chart);
  }

  function makePersonaChart(question) {
    const canvas = document.getElementById('surveyQ2Chart');
    if (!canvas || !window.Chart || !question) return;
    const rows = question.data || [];
    const chart = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: rows.map(x => x.label),
        datasets: [{ data: rows.map(x => x.count), borderWidth: 1 }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 10, usePointStyle: true } },
          tooltip: {
            callbacks: {
              afterLabel(ctx) { return `${rows[ctx.dataIndex]?.percentage || 0}٪`; }
            }
          }
        }
      }
    });
    surveyCharts.push(chart);
  }

  function makeTrendChart(rows) {
    const canvas = document.getElementById('surveyTrendChart');
    if (!canvas || !window.Chart) return;
    const chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: (rows || []).map(x => {
          try { return new Date(x.day).toLocaleDateString('fa-IR', { month: 'short', day: 'numeric' }); }
          catch { return x.day; }
        }),
        datasets: [{
          label: 'پاسخ کامل',
          data: (rows || []).map(x => x.completed),
          tension: .3,
          fill: true,
          borderWidth: 2,
          pointRadius: 3
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: 'rgba(148,163,184,.10)' } },
          x: { grid: { display: false } }
        }
      }
    });
    surveyCharts.push(chart);
  }

  function wireSurveyCharts(data) {
    destroySurveyCharts();
    if (surveyTab !== 'charts') return;
    requestAnimationFrame(() => {
      const byNumber = Object.fromEntries((data.questions || []).map(item => [item.number, item]));
      makeTrendChart(data.trend || []);
      makePersonaChart(byNumber[2]);
      makeBarChart('surveyQ1Chart', byNumber[1]);
      makeBarChart('surveyQ3Chart', byNumber[3]);
      makeBarChart('surveyQ4Chart', byNumber[4]);
    });
  }

  function insightIcon(type) {
    return ({ opportunity: '🚀', gap: '💡', segment: '👥', usage: '🧭', spend: '💳', conversion: '📈' })[type] || '•';
  }

  function renderAnalysis(data) {
    const analysis = data.analysis || {};
    const opportunities = analysis.opportunity_matrix || [];
    return `
      <div class="survey-analysis-grid">
        <div class="panel survey-insights">
          <div class="survey-panel-head"><div><h3>تحلیل خودکار نتایج</h3><p>تحلیل توصیفی بر اساس پاسخ‌های ثبت‌شده؛ بدون حدس خارج از داده</p></div></div>
          <div class="survey-insight-list">
            ${(analysis.insights || []).map(item => `
              <article class="survey-insight">
                <i>${insightIcon(item.type)}</i>
                <div><b>${esc(item.title)}</b><p>${esc(item.text)}</p></div>
              </article>`).join('') || empty()}
          </div>
        </div>
        <div class="panel">
          <div class="survey-panel-head"><div><h3>ماتریس فرصت محصول</h3><p>مقایسه علاقه به سرویس جدید با هزینه‌کرد فعلی/احتمالی</p></div></div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>دسته</th><th>علاقه</th><th>هزینه فعلی/آتی</th><th>شکاف</th><th>نرخ علاقه</th></tr></thead>
              <tbody>
                ${opportunities.map(row => `<tr>
                  <td data-label="دسته"><b>${esc(row.label)}</b></td>
                  <td data-label="علاقه">${fmt(row.interest)}</td>
                  <td data-label="هزینه فعلی/آتی">${fmt(row.current)}</td>
                  <td data-label="شکاف"><span class="${row.gap > 0 ? 'survey-gap-positive' : ''}">${row.gap > 0 ? '+' : ''}${fmt(row.gap)}</span></td>
                  <td data-label="نرخ علاقه">${pct(row.interest_rate)}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="panel survey-open-analysis">
        <div class="survey-panel-head"><div><h3>صدای مستقیم کاربران</h3><p>پاسخ‌های باز سؤال ۵ برای پیدا کردن نیازهای تکرارشونده</p></div><span class="survey-count">${fmt(analysis.open_response_count || 0)}</span></div>
        <div class="survey-open-grid">
          ${(data.open_responses || []).map(item => `<blockquote><p>${esc(item.text)}</p><footer><code>${esc(item.telegram_id)}</code> · ${date(item.completed_at)}</footer></blockquote>`).join('') || empty('پاسخ متنی ثبت نشده است.')}
        </div>
      </div>`;
  }

  function rawToolbar(raw) {
    return `
      <div class="survey-raw-toolbar">
        <input id="surveyRawSearch" value="${esc(surveyRawState.q)}" placeholder="جستجو در Telegram ID، تلفن یا پاسخ‌ها">
        <select id="surveyRawStatus">
          <option value="all" ${surveyRawState.status === 'all' ? 'selected' : ''}>همه وضعیت‌ها</option>
          <option value="completed" ${surveyRawState.status === 'completed' ? 'selected' : ''}>تکمیل‌شده</option>
          <option value="started" ${surveyRawState.status === 'started' ? 'selected' : ''}>ناتمام</option>
        </select>
        <button class="primary" type="button" onclick="surveyApplyRawFilters()">اعمال</button>
        <button type="button" onclick="surveyClearRawFilters()">پاک کردن</button>
        <a class="export" href="/dashboard/api/export/survey.csv">⬇️ CSV کامل</a>
        <span class="survey-raw-total">${fmt(raw?.total || 0)} رکورد</span>
      </div>`;
  }

  function renderRaw(raw) {
    const rows = raw?.rows || [];
    const body = rows.map(row => `<tr>
      <td data-label="کاربر"><code>${esc(row.telegram_id)}</code><br><small>${esc(row.phone || 'بدون شماره')}</small></td>
      <td data-label="وضعیت">${surveyStatusBadge(row)}<br><small>${date(row.completed_at || row.started_at)}</small></td>
      <td data-label="سرور / کیف پول"><b>${fmt(row.server_count)}</b> سرور<br><small>${money(row.wallet)}</small></td>
      <td data-label="کاربرد"><span class="survey-cell-text">${esc(row.q1 || '—')}</span></td>
      <td data-label="نوع کاربر"><span class="survey-cell-text">${esc(row.q2 || '—')}</span></td>
      <td data-label="هزینه سرویس"><span class="survey-cell-text">${esc(row.q3 || '—')}</span></td>
      <td data-label="علاقه‌مندی"><span class="survey-cell-text">${esc(row.q4 || '—')}</span></td>
      <td data-label="پاسخ متنی"><span class="survey-cell-text survey-open-cell">${esc(row.q5 || '—')}</span></td>
      <td data-label="جایزه">${row.rewarded_at ? '<span class="badge ok">پرداخت شد</span>' : '<span class="badge">—</span>'}<br><small>${row.reward_amount ? money(row.reward_amount) : ''}</small></td>
    </tr>`).join('');

    return `
      ${rawToolbar(raw)}
      <div class="table-wrap survey-raw-table">
        <table>
          <thead><tr><th>کاربر</th><th>وضعیت</th><th>سرور / کیف پول</th><th>کاربرد سرور</th><th>نوع کاربر</th><th>هزینه سرویس</th><th>علاقه‌مندی</th><th>پاسخ متنی</th><th>جایزه</th></tr></thead>
          <tbody>${body || '<tr><td colspan="9">داده‌ای پیدا نشد.</td></tr>'}</tbody>
        </table>
      </div>
      <div class="survey-pager">
        <button type="button" ${raw.page <= 1 ? 'disabled' : ''} onclick="surveyRawPage(${raw.page - 1})">صفحه قبل</button>
        <span>صفحه ${fmt(raw.page)} از ${fmt(raw.pages)}</span>
        <button type="button" ${raw.page >= raw.pages ? 'disabled' : ''} onclick="surveyRawPage(${raw.page + 1})">صفحه بعد</button>
      </div>`;
  }

  function renderSurvey() {
    const data = surveyOverviewCache;
    if (!data) return;
    const raw = surveyRawCache || { rows: [], total: 0, page: 1, pages: 1 };

    let body = '';
    if (surveyTab === 'charts') body = renderCharts(data);
    if (surveyTab === 'analysis') body = renderAnalysis(data);
    if (surveyTab === 'raw') body = renderRaw(raw);

    $('#content').innerHTML = `
      <div class="content-head survey-head">
        <div>
          <h3>نتایج نظرسنجی HamoonCloud</h3>
          <p>نسخه ${esc(data.version)} · آخرین بروزرسانی ${date(data.updated_at)}</p>
        </div>
        <div class="content-actions">
          <a class="export" href="/dashboard/api/export/survey.csv">CSV خام</a>
          <button type="button" class="primary" onclick="surveyResults(true)">↻ بروزرسانی</button>
        </div>
      </div>
      ${surveyKpis(data)}
      ${surveyTabs()}
      <div id="surveyTabBody">${body}</div>`;
    wireSurveyCharts(data);
  }

  async function loadSurveyRaw() {
    const params = new URLSearchParams({
      page: String(surveyRawState.page),
      pageSize: String(surveyRawState.pageSize),
      q: surveyRawState.q,
      status: surveyRawState.status
    });
    surveyRawCache = await api('/survey/raw?' + params.toString());
  }

  window.surveyResults = async function surveyResults(force = false) {
    try {
      if (force || !surveyOverviewCache) surveyOverviewCache = await api('/survey/overview');
      if (force || !surveyRawCache) await loadSurveyRaw();
      renderSurvey();
    } catch (error) {
      $('#content').innerHTML = `<div class="panel error-box"><h3>نتایج نظرسنجی بارگذاری نشد</h3><p>${esc(error?.message || error)}</p><button class="primary" onclick="surveyResults(true)">تلاش دوباره</button></div>`;
    }
  };

  window.surveySetTab = async function surveySetTab(tab) {
    surveyTab = ['charts', 'analysis', 'raw'].includes(tab) ? tab : 'charts';
    if (surveyTab === 'raw' && !surveyRawCache) await loadSurveyRaw();
    renderSurvey();
  };

  window.surveyApplyRawFilters = async function surveyApplyRawFilters() {
    surveyRawState = {
      ...surveyRawState,
      page: 1,
      q: document.getElementById('surveyRawSearch')?.value || '',
      status: document.getElementById('surveyRawStatus')?.value || 'all'
    };
    await loadSurveyRaw();
    renderSurvey();
  };

  window.surveyClearRawFilters = async function surveyClearRawFilters() {
    surveyRawState = { ...surveyRawState, page: 1, q: '', status: 'all' };
    await loadSurveyRaw();
    renderSurvey();
  };

  window.surveyRawPage = async function surveyRawPage(page) {
    surveyRawState.page = Math.max(1, Number(page || 1));
    await loadSurveyRaw();
    renderSurvey();
    document.querySelector('.survey-tabs')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
})();
