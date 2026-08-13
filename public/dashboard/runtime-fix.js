'use strict';

// Runtime hardening for the admin dashboard.
// Loaded immediately after app.js so these replacements are installed before
// the async /me request in init() completes and the first dashboard render runs.
(() => {
  function renderLoadError(error) {
    const message = error?.message || 'خطای نامشخص';
    $('#content').innerHTML = `<div class="panel error"><h3>بارگذاری این بخش انجام نشد</h3><p>${esc(message)}</p><button class="primary" onclick="load(current)">تلاش دوباره</button></div>`;
  }

  async function optionalApi(path, failed) {
    try {
      return await api(path);
    } catch (error) {
      failed.push(path);
      console.warn('[DASHBOARD_OPTIONAL_DATA]', path, error?.message || error);
      return [];
    }
  }

  // Scale wallet-flow bars relative to the largest value in the selected range.
  // The old renderer treated rial values as CSS percentages directly, which
  // saturated almost every non-zero bar at 100%.
  flowBars = function flowBarsScaled(rows) {
    if (!rows?.length || rows.every(r => !Number(r.credits) && !Number(r.debits))) return empty();
    const max = Math.max(1, ...rows.flatMap(r => [Number(r.credits) || 0, Number(r.debits) || 0]));
    return `<div class="flow">${rows.map(r => {
      const credits = Number(r.credits) || 0;
      const debits = Number(r.debits) || 0;
      const creditHeight = credits ? Math.max(3, credits / max * 100) : 0;
      const debitHeight = debits ? Math.max(3, debits / max * 100) : 0;
      return `<span title="${esc(r.day)} +${esc(credits)} -${esc(debits)}"><i style="height:${creditHeight}%"></i><b style="height:${debitHeight}%"></b></span>`;
    }).join('')}</div>`;
  };

  function datacenterSummary(rows) {
    if (!rows?.length) return empty();
    const grouped = new Map();
    for (const row of rows) {
      const key = String(row.datacenter || 'نامشخص');
      const item = grouped.get(key) || { datacenter: key, total: 0, active: 0, pending: 0, deleted: 0 };
      const count = Number(row.count) || 0;
      item.total += count;
      if (row.status === 'active') item.active += count;
      else if (row.status === 'deleted') item.deleted += count;
      else item.pending += count;
      grouped.set(key, item);
    }
    const items = [...grouped.values()].sort((a, b) => b.total - a.total);
    return `<div class="dc-summary">${items.map(item => `
      <div class="dc-row">
        <div class="dc-name"><b>${esc(item.datacenter)}</b><span>${fmt(item.total)} سرور</span></div>
        <div class="dc-counts"><span class="dc-active">فعال ${fmt(item.active)}</span>${item.pending ? `<span class="dc-pending">در انتظار ${fmt(item.pending)}</span>` : ''}${item.deleted ? `<span class="dc-deleted">حذف ${fmt(item.deleted)}</span>` : ''}</div>
      </div>`).join('')}</div>`;
  }

  // The original loader returned promises from inside try/catch without awaiting
  // them, so rejected API/render promises left the skeleton on screen forever.
  load = async function loadSafe(s = current) {
    current = s;
    document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.s === s));
    $('#title').textContent = sections.find(x => x[0] === s)?.[1] || '';
    $('#content').innerHTML = skeleton();

    try {
      if (s === 'overview') return await overview();
      if (s === 'users') return await users();
      if (s === 'servers') return await servers();
      if (s === 'wallet') return await wallet();
      if (s === 'purchases') return await purchases();
      if (s === 'datacenters') return await dcs();
      if (s === 'api') return await apiClients();
      if (s === 'logs') return await logs();
      if (s === 'tools') return await tools();
    } catch (error) {
      renderLoadError(error);
    }
  };

  // Fixes the blank Summary page. The previous renderer referenced an undefined
  // variable (d) while appending a wallet pager to the datacenter table. It also
  // made every chart mandatory, so one chart failure blanked the whole overview.
  overview = async function overviewSafe() {
    try {
      const o = await api('/overview');
      const failed = [];
      const [rev, pur, dc, flow] = await Promise.all([
        optionalApi('/charts/revenue?days=30', failed),
        optionalApi('/charts/purchases?days=30', failed),
        optionalApi('/charts/servers-by-datacenter', failed),
        optionalApi('/charts/wallet-flow?days=30', failed)
      ]);

      const cards = [
        ['users_total', 'کل کاربران', o.totalUsers],
        ['approved_topups', 'شارژ تأیید شده', o.approvedTopups],
        ['total_balance', 'موجودی کل', o.totalWalletBalance],
        ['servers_active', 'سرور فعال', o.activeServers],
        ['servers_pending', 'معلق/خاموش', o.suspendedServers],
        ['servers_deleted', 'حذف‌شده', o.deletedServers],
        ['purchases_total', 'کل خریدها', o.totalPurchases],
        ['purchases_today', 'خرید امروز', o.purchasesToday],
        ['purchases_month', 'خرید ماه', o.purchasesThisMonth],
        ['revenue_today', 'درآمد امروز', o.revenueToday],
        ['revenue_month', 'درآمد ماه', o.revenueThisMonth],
        ['revenue_30d', 'درآمد ۳۰ روز', o.revenue30d],
        ['datacenter_tebyan', 'Tebyan', o.tebyanServers],
        ['datacenter_hetzner', 'Hetzner', o.hetznerServers],
        ['datacenter_afracloud', 'AfraCloud', o.afraServers],
        ['datacenter_openstack', 'OpenStack', o.openstackServers],
        ['errors_24h', 'خطاهای ۲۴ ساعت', o.failedOperationsLast24h]
      ];

      const partialWarning = failed.length
        ? `<span class="badge fail">${fmt(failed.length)} منبع نمودار موقتاً در دسترس نیست</span>`
        : '<span class="badge ok">داده‌ها بارگذاری شد</span>';

      $('#content').innerHTML = `
        <div class="data-source">منبع داده: دیتابیس ${partialWarning}<span>آخرین بررسی provider: فقط در عملیات رفرش/Health هر دیتاسنتر</span></div>
        <div class="cards kpi-grid">
          ${cards.map(c => `<button class="card kpi-card" onclick="metricDetails('${c[0]}')"><span>${c[1]}</span><b>${fmt(c[2])}</b><small>برای مشاهده جزئیات کلیک کنید</small></button>`).join('')}
        </div>
        <div class="cards wide overview-panels">
          <div class="panel"><h3>درآمد ۳۰ روز</h3>${bars(rev, 'value')}</div>
          <div class="panel"><h3>خریدها</h3>${bars(pur, 'value')}</div>
          <div class="panel"><h3>جریان کیف پول</h3>${flowBars(flow)}</div>
          <div class="panel overview-dc"><h3>دیتاسنترها</h3>${datacenterSummary(dc)}</div>
        </div>`;
    } catch (error) {
      renderLoadError(error);
    }
  };

  // /health may be unavailable behind a reverse proxy even while the dashboard
  // itself is healthy. Keep the status useful instead of showing only "unknown".
  health = async function healthSafe() {
    const now = new Date().toLocaleString('fa-IR');
    try {
      const response = await fetch('/health', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      $('#health').textContent = `DB: ${result.db || 'ok'} | ${now}`;
    } catch (error) {
      try {
        await api('/me');
        $('#health').textContent = `پنل آنلاین | DB: نامشخص | ${now}`;
      } catch {
        $('#health').textContent = 'سلامت نامشخص';
      }
    }
  };
})();
