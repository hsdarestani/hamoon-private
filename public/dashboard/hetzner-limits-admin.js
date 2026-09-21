'use strict';

(() => {
  let hetznerLimitsCache = null;

  function hFmt(value) {
    if (value === null || value === undefined || value === '') return '—';
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString('fa-IR') : esc(value);
  }

  function hPct(value) {
    if (value === null || value === undefined) return '—';
    return Number(value).toLocaleString('fa-IR', { maximumFractionDigits: 1 }) + '٪';
  }

  function limitState(row) {
    if (row.limit === null || row.limit === undefined) {
      return { cls: 'unknown', text: 'نامشخص از API' };
    }
    const p = Number(row.usage_percent || 0);
    if (p >= 100) return { cls: 'danger', text: 'سقف پر شده' };
    if (p >= 85) return { cls: 'warn', text: 'نزدیک سقف' };
    return { cls: 'ok', text: 'عادی' };
  }

  function usageBar(row) {
    if (row.limit === null || row.limit === undefined) {
      return '<div class="hz-limit-bar unknown"><i></i></div>';
    }
    const p = Math.max(0, Math.min(100, Number(row.usage_percent || 0)));
    return `<div class="hz-limit-bar"><i style="width:${p}%"></i></div>`;
  }

  function resourceCard(row, icon) {
    const state = limitState(row);
    return `
      <div class="card kpi-card hz-limit-card">
        <div class="hz-card-top"><span>${icon} ${esc(row.label)}</span><span class="hz-state ${state.cls}">${state.text}</span></div>
        <b>${hFmt(row.used)}</b>
        <small>سقف: ${row.limit == null ? 'از API قابل دریافت نیست' : hFmt(row.limit)} ${row.remaining == null ? '' : '· باقی‌مانده ' + hFmt(row.remaining)}</small>
        ${usageBar(row)}
      </div>`;
  }

  function configuredLimitHint(data) {
    const configured = Object.entries(data.configured_limits || {}).filter(([, value]) => value != null);
    if (configured.length) {
      return '<span class="badge ok">سقف‌های سفارشی config شده‌اند</span>';
    }
    return '<span class="badge suspended">سقف اختصاصی پروژه در Public API موجود نیست</span>';
  }

  function limitsTable(data) {
    const rows = data.resources || [];
    return `
      <div class="table-wrap hz-limits-table">
        <table>
          <thead><tr><th>منبع</th><th>مصرف‌شده</th><th>سقف</th><th>باقی‌مانده</th><th>مصرف</th><th>وضعیت</th><th>منبع سقف / توضیح</th></tr></thead>
          <tbody>
            ${rows.map(row => {
              const state = limitState(row);
              return `<tr>
                <td data-label="منبع"><b>${esc(row.label)}</b></td>
                <td data-label="مصرف‌شده">${hFmt(row.used)}</td>
                <td data-label="سقف">${row.limit == null ? '—' : hFmt(row.limit)}</td>
                <td data-label="باقی‌مانده">${row.remaining == null ? '—' : hFmt(row.remaining)}</td>
                <td data-label="مصرف">
                  <div class="hz-table-usage"><span>${hPct(row.usage_percent)}</span>${usageBar(row)}</div>
                </td>
                <td data-label="وضعیت"><span class="hz-state ${state.cls}">${state.text}</span></td>
                <td data-label="توضیح"><span class="hz-source">${esc(row.limit_source || '')}</span>${row.note ? `<small>${esc(row.note)}</small>` : ''}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  }

  function rulesGrid(data) {
    return `<div class="hz-rules-grid">${(data.platform_rules || []).map(rule => `
      <div class="hz-rule"><b>${esc(rule.label)}</b><span>${esc(rule.value)}</span><small>${esc(rule.source || '')}</small></div>
    `).join('')}</div>`;
  }

  function renderHetznerLimits(data) {
    const map = Object.fromEntries((data.resources || []).map(row => [row.key, row]));
    const rate = data.api_rate_limit || {};
    const primary = data.primary_ips || {};
    const servers = data.server_breakdown || {};

    $('#content').innerHTML = `
      <div class="content-head">
        <div>
          <h3>Hetzner Account Limits & Usage</h3>
          <p>مصرف زنده از Cloud API همین پروژه · آخرین بروزرسانی ${date(data.updated_at)}</p>
        </div>
        <div class="content-actions">
          ${configuredLimitHint(data)}
          <button class="primary" type="button" onclick="hetznerLimits(true)">↻ بروزرسانی زنده</button>
        </div>
      </div>

      <div class="hz-info-banner">
        <div><b>نکته درباره سقف‌ها</b><p>Hetzner مصرف منابع را از Public API می‌دهد، اما سقف‌های اختصاصی Project/Account را از API عمومی expose نمی‌کند. هر سقفی که عدد دقیقش در config ثبت شده باشد، باقی‌مانده و درصد مصرفش خودکار محاسبه می‌شود.</p></div>
      </div>

      <div class="cards kpi-grid hz-limit-cards">
        ${resourceCard(map.servers || {label:'Cloud Servers',used:0,limit:null}, '🖥️')}
        ${resourceCard(map.primary_ips || {label:'Primary IPs',used:0,limit:null}, '🌐')}
        ${resourceCard(map.primary_ipv4 || {label:'Primary IPv4',used:0,limit:null}, '4️⃣')}
        ${resourceCard(map.primary_ipv6 || {label:'Primary IPv6',used:0,limit:null}, '6️⃣')}
        ${resourceCard(map.dedicated_cores || {label:'Dedicated CPU Cores',used:0,limit:null}, '🧠')}
        <div class="card kpi-card hz-limit-card">
          <div class="hz-card-top"><span>⚡ API Rate Limit</span><span class="hz-state ok">زنده</span></div>
          <b>${hFmt(rate.remaining)}</b>
          <small>باقی‌مانده از ${hFmt(rate.limit_per_hour)} درخواست در ساعت</small>
          ${rate.limit_per_hour ? usageBar({limit:rate.limit_per_hour,usage_percent:((rate.limit_per_hour-rate.remaining)/rate.limit_per_hour)*100}) : ''}
        </div>
      </div>

      <div class="hz-grid">
        <div class="panel">
          <div class="survey-panel-head"><div><h3>خلاصه سرورها</h3><p>بر اساس تمام Serverهای موجود در Hetzner Project</p></div></div>
          <div class="hz-stat-list">
            <div><span>کل Serverها</span><b>${hFmt(servers.total)}</b></div>
            <div><span>Shared Core Server</span><b>${hFmt(servers.shared_servers)}</b></div>
            <div><span>Dedicated Server</span><b>${hFmt(servers.dedicated_servers)}</b></div>
            <div><span>Shared CPU Core مصرفی</span><b>${hFmt(servers.shared_cores)}</b></div>
            <div><span>Dedicated CPU Core مصرفی</span><b>${hFmt(servers.dedicated_cores)}</b></div>
          </div>
        </div>
        <div class="panel">
          <div class="survey-panel-head"><div><h3>وضعیت IP</h3><p>Primary IPهای واقعی پروژه</p></div></div>
          <div class="hz-stat-list">
            <div><span>کل Primary IP</span><b>${hFmt(primary.total)}</b></div>
            <div><span>IPv4</span><b>${primary.ipv4 == null ? '—' : hFmt(primary.ipv4)}</b></div>
            <div><span>IPv6</span><b>${primary.ipv6 == null ? '—' : hFmt(primary.ipv6)}</b></div>
            <div><span>قاعده سقف</span><b class="hz-formula">${esc(primary.formula || '')}</b></div>
            <div><span>Server limit ثبت‌شده</span><b>${primary.server_limit == null ? 'ثبت نشده' : hFmt(primary.server_limit)}</b></div>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="survey-panel-head"><div><h3>تمام منابع Hetzner</h3><p>Usage واقعی + سقف و باقی‌مانده در صورت قابل‌دسترسی بودن limit</p></div></div>
        ${limitsTable(data)}
      </div>

      <div class="panel hz-rules-panel">
        <div class="survey-panel-head"><div><h3>قواعد رسمی Hetzner</h3><p>این‌ها محدودیت‌های ساختاری هر Server هستند و با quota سفارشی پروژه فرق دارند.</p></div></div>
        ${rulesGrid(data)}
      </div>

      <div class="panel hz-limitations">
        <h3>دقت داده‌ها</h3>
        <ul>${(data.limitations || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul>
        <p>برای اینکه ستون «سقف» برای limitهای سفارشی دقیق پر شود، مقدارهای Hetzner Console → Project → Limits را می‌توان در config سرور ثبت کرد؛ Usage همیشه خودکار و زنده است.</p>
      </div>`;
  }

  window.hetznerLimits = async function hetznerLimits(force = false) {
    $('#content').innerHTML = skeleton();
    try {
      if (force || !hetznerLimitsCache) {
        hetznerLimitsCache = await api('/hetzner/account-limits' + (force ? '?refresh=1' : ''));
      }
      renderHetznerLimits(hetznerLimitsCache);
    } catch (error) {
      console.error('[HETZNER_LIMITS_ERROR]', error);
      $('#content').innerHTML = `<div class="panel error-box"><h3>اطلاعات Hetzner بارگذاری نشد</h3><p>${esc(error?.message || error)}</p><button class="primary" onclick="hetznerLimits(true)">تلاش دوباره</button></div>`;
    }
  };
})();
