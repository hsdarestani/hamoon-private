'use strict';

// Hamoon Admin Dashboard v2
// Loaded after app.js + runtime-fix.js. It keeps the existing API contract but
// upgrades reliability, responsive rendering and section UX without duplicating
// business logic in the backend.
(() => {
  const STATUS_LABELS = {
    active: 'فعال', ok: 'سالم', suspended: 'معلق', stopped: 'متوقف', stop: 'متوقف',
    deleted: 'حذف‌شده', deletion_pending: 'در انتظار حذف', provisioning: 'در حال ساخت',
    building: 'در حال آماده‌سازی', rebuilding: 'در حال بازسازی', pending_ssh: 'در انتظار SSH',
    pending_ip: 'در انتظار IP', pending_ip_quality: 'بررسی کیفیت IP', manual_review: 'بررسی دستی',
    provider_missing: 'یافت نشد در Provider', provisioning_failed: 'ساخت ناموفق',
    disabled: 'غیرفعال', revoked: 'لغوشده', fail: 'خطا', manual: 'دستی',
    true: 'فعال', false: 'غیرفعال'
  };
  const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  const baseShowApp = showApp;
  const baseCloseModal = closeModal;
  let toastTimer = null;

  function jsArg(value) {
    return JSON.stringify(String(value ?? ''))
      .replace(/&/g, '\\u0026')
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/'/g, '\\u0027');
  }

  function asNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function sum(rows, key) {
    return (rows || []).reduce((total, row) => total + (Number(row?.[key]) || 0), 0);
  }

  function firstDay(rows) { return rows?.[0]?.day || '—'; }
  function lastDay(rows) { return rows?.[rows.length - 1]?.day || '—'; }

  fmt = function fmtSafe(value) {
    if (value === null || value === undefined || value === '') return '—';
    const n = asNumber(value);
    return n === null ? esc(value) : nf.format(n);
  };

  badge = function badgeFa(status) {
    const raw = String(status ?? 'نامشخص');
    const klass = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const label = STATUS_LABELS[raw] || STATUS_LABELS[raw.toLowerCase()] || raw;
    return `<span class="badge ${esc(klass)}">${esc(label)}</span>`;
  };

  copyText = async function copyTextSafe(value) {
    const text = String(value ?? '');
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        area.remove();
      }
      toast('کپی شد', 'ok');
    } catch {
      toast('کپی انجام نشد', 'error');
    }
  };

  copyBtn = function copyBtnSafe(value) {
    if (value === null || value === undefined || value === '') return '';
    return `<button class="mini" type="button" onclick='copyText(${jsArg(value)})'>کپی</button>`;
  };

  toast = function toastV2(text, kind = 'ok') {
    const el = $('#toast');
    if (!el) return;
    clearTimeout(toastTimer);
    el.textContent = text;
    el.classList.remove('hidden', 'toast-error', 'toast-ok');
    el.classList.add(kind === 'error' ? 'toast-error' : 'toast-ok');
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3600);
  };

  api = async function apiV2(url, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(options.timeout || 22000));
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (options.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (MUTATING_METHODS.has(method)) headers['X-Admin-Action'] = 'true';

    try {
      const response = await fetch('/dashboard/api' + url, {
        ...options,
        method,
        headers,
        signal: options.signal || controller.signal,
        cache: method === 'GET' ? 'no-store' : options.cache
      });
      const text = await response.text();
      let json = null;
      try { json = text ? JSON.parse(text) : { ok: response.ok }; }
      catch { json = { ok: false, message: 'پاسخ نامعتبر از سرور دریافت شد.' }; }

      if (response.status === 401 && url !== '/login') {
        showLogin();
        throw new Error('نشست مدیریت منقضی شده؛ دوباره وارد شوید.');
      }
      if (!response.ok || json?.ok === false) {
        const error = new Error(json?.message || json?.error || `HTTP ${response.status}`);
        error.status = response.status;
        error.code = json?.error;
        throw error;
      }
      return json?.data === undefined ? json : json.data;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('پاسخ سرور بیش از حد طول کشید. دوباره تلاش کنید.');
      if (error instanceof TypeError && /fetch/i.test(error.message || '')) throw new Error('ارتباط با سرور برقرار نشد.');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };

  empty = function emptyV2(message = 'داده‌ای برای نمایش وجود ندارد') {
    return `<div class="empty">${esc(message)}</div>`;
  };

  skeleton = function skeletonV2() {
    return '<div class="cards kpi-grid"><div class="panel skeleton"></div><div class="panel skeleton"></div><div class="panel skeleton"></div><div class="panel skeleton"></div></div>';
  };

  table = function tableResponsive(rows, cols, actions) {
    if (!rows?.length) return empty();
    const prepared = rows.map(row => ({ row, actionHtml: typeof actions === 'function' ? String(actions(row) || '') : '' }));
    const hasActions = prepared.some(item => item.actionHtml.trim());
    return `<div class="table-wrap"><table><thead><tr>${cols.map(col => `<th>${esc(col[1])}</th>`).join('')}${hasActions ? '<th>عملیات</th>' : ''}</tr></thead><tbody>${prepared.map(({ row, actionHtml }) => `<tr>${cols.map(col => {
      const raw = col[2] ? col[2](row) : esc(row[col[0]] ?? '—');
      return `<td data-label="${esc(col[1])}" class="cell-${esc(col[0])}">${raw}</td>`;
    }).join('')}${hasActions ? `<td data-label="عملیات" class="actions">${actionHtml}</td>` : ''}</tr>`).join('')}</tbody></table></div>`;
  };

  function closeDrawer() {
    const drawer = $('#drawer');
    if (!drawer) return;
    drawer.classList.add('hidden');
    drawer.innerHTML = '';
  }

  function closeMobileNav() {
    $('#app')?.classList.remove('mobile-nav-open');
  }

  function openMobileNav() {
    $('#app')?.classList.add('mobile-nav-open');
  }

  function enhanceShell() {
    const app = $('#app');
    const header = document.querySelector('main > header');
    const aside = document.querySelector('.shell > aside');
    if (!app || !header || !aside) return;

    if (!app.querySelector('.sidebar-overlay')) {
      const overlay = document.createElement('div');
      overlay.className = 'sidebar-overlay';
      overlay.onclick = closeMobileNav;
      app.appendChild(overlay);
    }
    if (!aside.querySelector('.sidebar-close')) {
      const close = document.createElement('button');
      close.className = 'sidebar-close';
      close.type = 'button';
      close.setAttribute('aria-label', 'بستن منو');
      close.textContent = '×';
      close.onclick = closeMobileNav;
      aside.prepend(close);
    }
    const titleWrap = header.firstElementChild;
    if (titleWrap && !titleWrap.querySelector('.mobile-menu-btn')) {
      const menu = document.createElement('button');
      menu.className = 'mobile-menu-btn';
      menu.type = 'button';
      menu.setAttribute('aria-label', 'باز کردن منو');
      menu.textContent = '☰';
      menu.onclick = openMobileNav;
      titleWrap.prepend(menu);
    }
    document.querySelectorAll('nav button').forEach(button => {
      if (!button.dataset.v2Bound) {
        button.dataset.v2Bound = '1';
        button.addEventListener('click', closeMobileNav);
      }
    });
  }

  showApp = function showAppV2() {
    baseShowApp();
    enhanceShell();
  };

  closeModal = function closeModalV2() {
    baseCloseModal();
  };

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (!$('#modal')?.classList.contains('hidden')) closeModal();
      else if (!$('#drawer')?.classList.contains('hidden')) closeDrawer();
      else closeMobileNav();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      $('#globalSearch')?.focus();
    }
  });

  window.addEventListener('offline', () => {
    const healthEl = $('#health');
    if (healthEl) { healthEl.textContent = 'مرورگر آفلاین است'; healthEl.classList.add('health-bad'); }
  });
  window.addEventListener('online', () => health());

  health = async function healthV2() {
    const el = $('#health');
    if (!el) return;
    try {
      const response = await fetch('/health', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      const healthy = result.db === 'ok' && result.ok !== false;
      el.classList.toggle('health-bad', !healthy);
      el.textContent = healthy
        ? `پنل و دیتابیس آنلاین · ${new Date().toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' })}`
        : `پنل آنلاین · دیتابیس: ${result.db || 'نامشخص'}`;
    } catch {
      try {
        await api('/me');
        el.classList.add('health-bad');
        el.textContent = 'پنل آنلاین · وضعیت دیتابیس نامشخص';
      } catch {
        el.classList.add('health-bad');
        el.textContent = 'ارتباط با پنل برقرار نیست';
      }
    }
  };

  function renderLoadError(error) {
    const message = error?.message || 'خطای نامشخص';
    $('#content').innerHTML = `<div class="panel error-box"><h3>این بخش بارگذاری نشد</h3><p>${esc(message)}</p><div class="content-actions"><button class="primary" onclick="load(current)">تلاش دوباره</button></div></div>`;
  }

  load = async function loadV2(section = current) {
    current = section;
    document.querySelectorAll('nav button').forEach(button => button.classList.toggle('active', button.dataset.s === section));
    const title = sections.find(item => item[0] === section)?.[1] || '';
    $('#title').textContent = title;
    $('#content').innerHTML = skeleton();
    closeMobileNav();
    if (window.innerWidth < 980) window.scrollTo({ top: 0, behavior: 'smooth' });
    try {
      if (section === 'overview') return await overview();
      if (section === 'users') return await users();
      if (section === 'servers') return await servers();
      if (section === 'wallet') return await wallet();
      if (section === 'purchases') return await purchases();
      if (section === 'datacenters') return await dcs();
      if (section === 'api') return await apiClients();
      if (section === 'logs') return await logs();
      if (section === 'tools') return await tools();
      $('#content').innerHTML = empty('بخش درخواستی وجود ندارد.');
    } catch (error) {
      console.error('[DASHBOARD_SECTION_ERROR]', section, error);
      renderLoadError(error);
    }
  };

  bars = function barsV2(rows, key) {
    if (!rows?.length || rows.every(row => !Number(row[key]))) return empty('در این بازه داده‌ای ثبت نشده است.');
    const max = Math.max(1, ...rows.map(row => Number(row[key]) || 0));
    const total = sum(rows, key);
    return `<div class="chart-shell"><div class="chart-meta"><b>${fmt(total)}</b><span>مجموع بازه</span></div><div class="chart">${rows.map(row => {
      const value = Number(row[key]) || 0;
      const height = value ? Math.max(3, value / max * 100) : 1;
      return `<div class="bar" aria-label="${esc(row.day)}: ${esc(value)}" title="${esc(row.day)} · ${fmt(value)}" style="height:${height}%"></div>`;
    }).join('')}</div><div class="chart-foot"><span>${esc(firstDay(rows))}</span><span>${esc(lastDay(rows))}</span></div></div>`;
  };

  flowBars = function flowBarsV2(rows) {
    if (!rows?.length || rows.every(row => !Number(row.credits) && !Number(row.debits))) return empty('در این بازه گردش کیف پولی ثبت نشده است.');
    const max = Math.max(1, ...rows.flatMap(row => [Number(row.credits) || 0, Number(row.debits) || 0]));
    return `<div class="chart-shell"><div class="chart-meta"><b>${fmt(sum(rows, 'credits') - sum(rows, 'debits'))}</b><span>خالص گردش</span></div><div class="flow">${rows.map(row => {
      const credits = Number(row.credits) || 0;
      const debits = Number(row.debits) || 0;
      return `<span title="${esc(row.day)} · ورودی ${fmt(credits)} · خروجی ${fmt(debits)}"><i style="height:${credits ? Math.max(3, credits / max * 100) : 0}%"></i><b style="height:${debits ? Math.max(3, debits / max * 100) : 0}%"></b></span>`;
    }).join('')}</div><div class="flow-legend"><span>ورودی</span><span>خروجی</span></div><div class="chart-foot"><span>${esc(firstDay(rows))}</span><span>${esc(lastDay(rows))}</span></div></div>`;
  };

  function datacenterSummary(rows) {
    if (!rows?.length) return empty();
    const pendingStatuses = new Set(['suspended', 'stopped', 'stop', 'provisioning', 'building', 'rebuilding', 'pending_ssh', 'pending_ip', 'pending_ip_quality', 'manual_review', 'provider_missing', 'provisioning_failed', 'deletion_pending']);
    const grouped = new Map();
    for (const row of rows) {
      const key = String(row.datacenter || 'نامشخص');
      const item = grouped.get(key) || { datacenter: key, total: 0, active: 0, pending: 0, deleted: 0 };
      const count = Number(row.count) || 0;
      item.total += count;
      if (row.status === 'active') item.active += count;
      else if (row.status === 'deleted') item.deleted += count;
      else if (pendingStatuses.has(row.status)) item.pending += count;
      else item.pending += count;
      grouped.set(key, item);
    }
    return `<div class="dc-summary">${[...grouped.values()].sort((a, b) => b.total - a.total).map(item => `<div class="dc-row"><div class="dc-name"><b>${esc(item.datacenter)}</b><span>${fmt(item.total)} رکورد</span></div><div class="dc-counts"><span class="dc-active">فعال ${fmt(item.active)}</span>${item.pending ? `<span class="dc-pending">در انتظار ${fmt(item.pending)}</span>` : ''}${item.deleted ? `<span class="dc-deleted">حذف ${fmt(item.deleted)}</span>` : ''}</div></div>`).join('')}</div>`;
  }

  overview = async function overviewV2() {
    const failed = [];
    const optional = async path => {
      try { return await api(path); }
      catch (error) { failed.push(path); console.warn('[DASHBOARD_OPTIONAL_DATA]', path, error?.message || error); return []; }
    };
    const o = await api('/overview');
    const [rev, pur, dc, flow] = await Promise.all([
      optional('/charts/revenue?days=30'), optional('/charts/purchases?days=30'),
      optional('/charts/servers-by-datacenter'), optional('/charts/wallet-flow?days=30')
    ]);

    const cards = [
      ['users_total', 'کل کاربران', o.totalUsers, ''],
      ['total_balance', 'موجودی فعلی کاربران', o.totalWalletBalance, 'kpi-money'],
      ['servers_active', 'سرور فعال', o.activeServers, ''],
      ['servers_pending', 'در انتظار / معلق', o.suspendedServers, ''],
      ['purchases_today', 'خرید امروز', o.purchasesToday, ''],
      ['purchases_month', 'خرید ماه', o.purchasesThisMonth, ''],
      ['revenue_today', 'ورودی کیف پول امروز', o.revenueToday, 'kpi-money'],
      ['revenue_30d', 'ورودی کیف پول ۳۰ روز', o.revenue30d, 'kpi-money']
    ];
    const providers = [
      ['datacenter_hetzner', 'Hetzner', o.hetznerServers], ['datacenter_tebyan', 'Tebyan', o.tebyanServers],
      ['datacenter_afracloud', 'AfraCloud', o.afraServers], ['datacenter_openstack', 'OpenStack', o.openstackServers],
      ['purchases_total', 'کل خریدها', o.totalPurchases], ['servers_deleted', 'حذف‌شده', o.deletedServers]
    ];
    const status = failed.length
      ? `<span class="badge suspended">${fmt(failed.length)} نمودار در دسترس نیست</span>`
      : '<span class="badge ok">همه داده‌ها بارگذاری شد</span>';

    $('#content').innerHTML = `
      <div class="content-head"><div><h3>نمای کلی کسب‌وکار</h3><p>اعداد زنده از دیتابیس؛ برای جزئیات روی کارت‌ها کلیک کنید.</p></div><div class="content-actions"><button onclick="load('overview')">↻ بروزرسانی</button></div></div>
      <div class="data-source"><span>منبع داده: دیتابیس ${status}</span><span>آخرین بروزرسانی: ${esc(new Date().toLocaleString('fa-IR'))}</span></div>
      <div class="cards kpi-grid">${cards.map(card => `<button class="card kpi-card ${card[3]}" onclick='metricDetails(${jsArg(card[0])})'><span>${esc(card[1])}</span><b>${fmt(card[2])}</b><small>مشاهده ریز داده‌ها</small></button>`).join('')}</div>
      <div class="provider-strip">${providers.map(item => `<button class="provider-chip" onclick='metricDetails(${jsArg(item[0])})'><span>${esc(item[1])}</span><b>${fmt(item[2])}</b></button>`).join('')}</div>
      <div class="cards wide overview-panels">
        <div class="panel"><h3>ورودی کیف پول · ۳۰ روز</h3>${bars(rev, 'value')}</div>
        <div class="panel"><h3>خریدها · ۳۰ روز</h3>${bars(pur, 'value')}</div>
        <div class="panel"><h3>جریان کیف پول · ۳۰ روز</h3>${flowBars(flow)}</div>
        <div class="panel overview-dc"><h3>توزیع دیتاسنترها</h3>${datacenterSummary(dc)}</div>
      </div>`;
  };

  // Persistent filters per list.
  Object.assign(listState.servers, { status: '', datacenter: '', hasPassword: '', duration: '', sort: 'created_at', dir: 'desc', pageSize: 25 });
  Object.assign(listState.wallet, { type: '', from: '', to: '', pageSize: 25 });
  Object.assign(listState.purchases, { status: '', datacenter: '', duration: '', sort: 'created_at', dir: 'desc', pageSize: 25 });
  Object.assign(userState, { pageSize: 25, dir: userState.dir || 'desc' });

  function statusOptions(selected = '') {
    const options = [
      ['', 'همه وضعیت‌ها'], ['active', 'فعال'], ['provisioning', 'در حال ساخت'], ['building', 'در حال آماده‌سازی'],
      ['pending_ip', 'در انتظار IP'], ['pending_ip_quality', 'بررسی کیفیت IP'], ['pending_ssh', 'در انتظار SSH'],
      ['suspended', 'معلق'], ['stopped', 'متوقف'], ['manual_review', 'بررسی دستی'], ['provider_missing', 'Provider missing'],
      ['provisioning_failed', 'ساخت ناموفق'], ['deletion_pending', 'در انتظار حذف'], ['deleted', 'حذف‌شده']
    ];
    return options.map(([value, label]) => `<option value="${esc(value)}" ${selected === value ? 'selected' : ''}>${esc(label)}</option>`).join('');
  }

  function pageSizeOptions(selected) {
    return [25, 50, 100, 200].map(n => `<option value="${n}" ${Number(selected) === n ? 'selected' : ''}>${fmt(n)} ردیف</option>`).join('');
  }

  toolbar = function toolbarV2(type) {
    const st = listState[type] || {};
    setTimeout(wireToolbar, 0);
    if (type === 'servers') return `<div class="toolbar"><input class="search-field" id="search" value="${esc(st.q || '')}" placeholder="نام، ID، کاربر، IP، پلن..."><select id="status">${statusOptions(st.status)}</select><input id="dc" value="${esc(st.datacenter || '')}" placeholder="دیتاسنتر"><select id="hasPassword"><option value="">همه رمزها</option><option value="yes" ${st.hasPassword === 'yes' ? 'selected' : ''}>رمز ذخیره شده</option><option value="no" ${st.hasPassword === 'no' ? 'selected' : ''}>بدون رمز</option></select><select id="sort"><option value="created_at">جدیدترین</option><option value="server_name" ${st.sort === 'server_name' ? 'selected' : ''}>نام</option><option value="status" ${st.sort === 'status' ? 'selected' : ''}>وضعیت</option><option value="amount" ${st.sort === 'amount' ? 'selected' : ''}>قیمت</option></select><select id="pageSize">${pageSizeOptions(st.pageSize)}</select><button class="primary" onclick="applyFilters('servers')">اعمال</button><button onclick="clearFilters('servers')">پاک کردن</button><a class="export" href="/dashboard/api/export/servers.csv?q=${encodeURIComponent(st.q || '')}">CSV</a></div>`;
    if (type === 'purchases') return `<div class="toolbar"><input class="search-field" id="search" value="${esc(st.q || '')}" placeholder="ID، کاربر، IP، نام سرور..."><select id="status">${statusOptions(st.status)}</select><input id="dc" value="${esc(st.datacenter || '')}" placeholder="دیتاسنتر"><select id="duration"><option value="">همه دوره‌ها</option>${['hourly','daily','weekly','monthly'].map(v => `<option value="${v}" ${st.duration === v ? 'selected' : ''}>${v}</option>`).join('')}</select><select id="sort"><option value="created_at">جدیدترین</option><option value="amount" ${st.sort === 'amount' ? 'selected' : ''}>مبلغ</option><option value="status" ${st.sort === 'status' ? 'selected' : ''}>وضعیت</option></select><select id="pageSize">${pageSizeOptions(st.pageSize)}</select><button class="primary" onclick="applyFilters('purchases')">اعمال</button><button onclick="clearFilters('purchases')">پاک کردن</button><a class="export" href="/dashboard/api/export/purchases.csv?q=${encodeURIComponent(st.q || '')}">CSV</a></div>`;
    if (type === 'wallet') return `<div class="toolbar"><input class="search-field" id="search" value="${esc(st.q || '')}" placeholder="کاربر، نوع، شرح یا مبلغ..."><input id="walletType" value="${esc(st.type || '')}" placeholder="نوع تراکنش"><input id="from" type="date" value="${esc(st.from || '')}"><input id="to" type="date" value="${esc(st.to || '')}"><select id="pageSize">${pageSizeOptions(st.pageSize)}</select><button class="primary" onclick="applyFilters('wallet')">اعمال</button><button onclick="clearFilters('wallet')">پاک کردن</button><a class="export" href="/dashboard/api/export/wallet.csv?q=${encodeURIComponent(st.q || '')}">CSV</a></div>`;
    return '';
  };

  usersToolbar = function usersToolbarV2() {
    setTimeout(wireToolbar, 0);
    return `<div class="toolbar"><input class="search-field" id="search" value="${esc(userState.q || '')}" placeholder="telegram_id، تلفن، کد ملی، نام یا سرور"><select id="status">${statusOptions(userState.status || '')}</select><input id="dc" value="${esc(userState.datacenter || '')}" placeholder="دیتاسنتر"><select id="userSort"><option value="last_activity_at">آخرین فعالیت</option><option value="created_at" ${userState.sort === 'created_at' ? 'selected' : ''}>تاریخ ایجاد</option><option value="telegram_id" ${userState.sort === 'telegram_id' ? 'selected' : ''}>تلگرام</option><option value="wallet_balance" ${userState.sort === 'wallet_balance' ? 'selected' : ''}>موجودی</option><option value="active_servers" ${userState.sort === 'active_servers' ? 'selected' : ''}>سرور فعال</option></select><select id="userDir"><option value="desc">نزولی</option><option value="asc" ${userState.dir === 'asc' ? 'selected' : ''}>صعودی</option></select><select id="pageSize">${pageSizeOptions(userState.pageSize)}</select><button class="primary" onclick="applyFilters('users')">اعمال</button><button onclick="clearFilters('users')">پاک کردن</button><a class="export" href="/dashboard/api/export/users.csv?q=${encodeURIComponent(userState.q || '')}">CSV</a></div>`;
  };

  applyFilters = function applyFiltersV2(type) {
    if (type === 'users') {
      userState = {
        ...userState,
        page: 1,
        q: $('#search')?.value?.trim() || '',
        status: $('#status')?.value || '',
        datacenter: $('#dc')?.value?.trim() || '',
        sort: $('#userSort')?.value || 'last_activity_at',
        dir: $('#userDir')?.value || 'desc',
        pageSize: Number($('#pageSize')?.value || 25)
      };
      return users();
    }
    const st = listState[type];
    if (!st) return;
    st.page = 1;
    st.q = $('#search')?.value?.trim() || '';
    st.pageSize = Number($('#pageSize')?.value || st.pageSize || 25);
    if (type === 'servers' || type === 'purchases') {
      st.status = $('#status')?.value || '';
      st.datacenter = $('#dc')?.value?.trim() || '';
      st.duration = $('#duration')?.value || '';
      st.sort = $('#sort')?.value || 'created_at';
    }
    if (type === 'servers') st.hasPassword = $('#hasPassword')?.value || '';
    if (type === 'wallet') {
      st.type = $('#walletType')?.value?.trim() || '';
      st.from = $('#from')?.value || '';
      st.to = $('#to')?.value || '';
    }
    return load(type);
  };

  clearFilters = function clearFiltersV2(type) {
    if (type === 'users') {
      userState = { page: 1, pageSize: 25, q: '', status: '', datacenter: '', sort: 'last_activity_at', dir: 'desc' };
      return users();
    }
    if (type === 'servers') listState.servers = { page: 1, pageSize: 25, q: '', status: '', datacenter: '', hasPassword: '', duration: '', sort: 'created_at', dir: 'desc' };
    if (type === 'purchases') listState.purchases = { page: 1, pageSize: 25, q: '', status: '', datacenter: '', duration: '', sort: 'created_at', dir: 'desc' };
    if (type === 'wallet') listState.wallet = { page: 1, pageSize: 25, q: '', type: '', from: '', to: '' };
    return load(type);
  };

  wireToolbar = function wireToolbarV2() {
    const box = $('#search');
    if (box && !box.dataset.bound) {
      box.dataset.bound = '1';
      box.onkeydown = event => { if (event.key === 'Enter') applyFilters(current); };
    }
  };

  function summaryLine(d, extras = []) {
    return `<div class="panel list-summary"><span>تعداد کل <b>${fmt(d.total || 0)}</b></span>${extras.map(item => `<span>${esc(item[0])} <b>${fmt(item[1])}</b></span>`).join('')}</div>`;
  }

  users = async function usersV2() {
    const qs = new URLSearchParams(userState).toString();
    const d = await api('/users?' + qs);
    const cols = [
      ['telegram_id', 'تلگرام', r => `<span class="mono">${esc(r.telegram_id)}</span> ${copyBtn(r.telegram_id)}`],
      ['phone', 'تلفن'], ['national_id', 'کد ملی'],
      ['wallet_balance', 'موجودی', r => `<span class="${Number(r.wallet_balance) < 0 ? 'money-negative' : 'money-positive'}">${fmt(r.wallet_balance)}</span>`],
      ['purchases_count', 'خرید', r => fmt(r.purchases_count)], ['active_servers', 'فعال', r => fmt(r.active_servers)],
      ['pending_servers', 'در انتظار', r => fmt(r.pending_servers)], ['deleted_servers', 'حذف‌شده', r => fmt(r.deleted_servers)],
      ['created_at', 'ایجاد', r => date(r.created_at)], ['last_activity_at', 'آخرین فعالیت', r => date(r.last_activity_at)]
    ];
    $('#content').innerHTML = `<div class="content-head"><div><h3>کاربران</h3><p>جستجو، مشاهده کیف پول و مدیریت حساب‌ها.</p></div></div>${usersToolbar()}${summaryLine(d)}${table(d.rows, cols, r => `<button onclick='userDetail(${jsArg(r.telegram_id)})'>جزئیات</button><button onclick='adjust(${jsArg(r.telegram_id)},1)'>شارژ</button><button onclick='adjust(${jsArg(r.telegram_id)},-1)'>کسر</button>`)}${userPager(d)}`;
  };

  serverButtons = function serverButtonsV2(row) {
    const c = row.capabilities || {};
    const id = jsArg(row.server_id);
    const name = jsArg(row.server_name || row.server_id);
    const menu = [
      c.refresh ? `<button onclick='serverAction(${id},"refresh")'>رفرش Provider</button>` : '',
      c.suspend ? `<button onclick='serverAction(${id},"suspend",true)'>توقف</button>` : '',
      c.resume ? `<button onclick='serverAction(${id},"resume")'>شروع</button>` : '',
      c.checkSsh ? `<button onclick='serverAction(${id},"check-ssh")'>بررسی SSH</button>` : '',
      `<button onclick='trafficPreview(${id})'>ترافیک</button>`,
      `<button onclick='setBilling(${id})'>تنظیم Billing</button>`,
      `<button onclick='runBillingPreview(${id})'>پیش‌نمایش Billing</button>`,
      c.setPassword ? `<button onclick='setPassword(${id})'>ثبت رمز</button>` : '',
      c.resetPassword ? `<button onclick='resetPassword(${id})'>ریست رمز</button>` : '',
      c.revealPassword ? `<button onclick='revealPassword(${id})'>نمایش رمز</button>` : '',
      c.delete ? `<button class="danger" onclick='deleteServer(${id},${name})'>حذف سرور</button>` : ''
    ].filter(Boolean).join('');
    return `<button onclick='serverDetail(${id})'>جزئیات</button><details class="actions-menu"><summary>عملیات</summary><div class="actions-popover">${menu}</div></details>`;
  };

  servers = async function serversV2() {
    const st = listState.servers;
    const qs = new URLSearchParams({ page: st.page, pageSize: st.pageSize, q: st.q || '', status: st.status || '', datacenter: st.datacenter || '', hasPassword: st.hasPassword || '', duration: st.duration || '', sort: st.sort || 'created_at', dir: st.dir || 'desc' });
    const d = await api('/servers?' + qs.toString());
    const activeOnPage = (d.rows || []).filter(r => r.status === 'active').length;
    const cols = [
      ['server_name', 'نام', r => `<span class="truncate">${esc(r.server_name || '—')}</span>`],
      ['server_id', 'ID', r => `<span class="mono">${esc(r.server_id)}</span> ${copyBtn(r.server_id)}`],
      ['telegram_id', 'کاربر', r => `<span class="mono">${esc(r.telegram_id)}</span>`],
      ['datacenter_label', 'دیتاسنتر'], ['provider', 'Provider'],
      ['ip', 'IP', r => `<span class="mono">${esc(r.ip || r.public_ip || '—')}</span> ${copyBtn(r.ip || r.public_ip)}`],
      ['status', 'وضعیت', r => badge(r.status)], ['os_label', 'OS'], ['flavor_id', 'پلن'], ['duration', 'چرخه'],
      ['amount', 'قیمت', r => fmt(r.amount)], ['password_stored', 'رمز', r => badge(r.password_stored ? 'ok' : 'disabled')],
      ['created_at', 'ایجاد', r => date(r.created_at)], ['last_billed_at', 'آخرین صورتحساب', r => date(r.last_billed_at)]
    ];
    $('#content').innerHTML = `<div class="content-head"><div><h3>سرورها</h3><p>وضعیت دیتابیس، Provider، IP، Billing و عملیات مدیریتی.</p></div><div class="content-actions"><button onclick="servers()">↻ بروزرسانی</button></div></div>${toolbar('servers')}${summaryLine(d, [['فعال در این صفحه', activeOnPage]])}${table(d.rows, cols, serverButtons)}${listPager('servers', d)}`;
  };

  wallet = async function walletV2() {
    const st = listState.wallet;
    const qs = new URLSearchParams({ page: st.page, pageSize: st.pageSize, q: st.q || '', type: st.type || '', from: st.from || '', to: st.to || '' });
    const d = await api('/wallet/logs?' + qs.toString());
    const pageNet = (d.rows || []).reduce((n, r) => n + (Number(r.amount) || 0), 0);
    const cols = [
      ['telegram_id', 'کاربر', r => `<span class="mono">${esc(r.telegram_id)}</span> ${copyBtn(r.telegram_id)}`],
      ['current_balance', 'موجودی فعلی', r => fmt(r.current_balance)],
      ['amount', 'مبلغ', r => `<span class="${Number(r.amount) < 0 ? 'money-negative' : 'money-positive'}">${Number(r.amount) > 0 ? '+' : ''}${fmt(r.amount)}</span>`],
      ['type', 'نوع'], ['description', 'شرح', r => `<span class="truncate">${esc(r.description || '—')}</span>`], ['timestamp', 'زمان', r => date(r.timestamp)]
    ];
    $('#content').innerHTML = `<div class="content-head"><div><h3>کیف پول</h3><p>تاریخچه کامل تراکنش‌ها و موجودی فعلی کاربران.</p></div><div class="content-actions"><button onclick="wallet()">↻ بروزرسانی</button></div></div>${toolbar('wallet')}${summaryLine(d, [['خالص این صفحه', pageNet]])}${table(d.rows, cols, r => r.telegram_id ? `<button onclick='userDetail(${jsArg(r.telegram_id)})'>کاربر</button>` : '')}${listPager('wallet', d)}`;
  };

  purchases = async function purchasesV2() {
    const st = listState.purchases;
    const qs = new URLSearchParams({ page: st.page, pageSize: st.pageSize, q: st.q || '', status: st.status || '', datacenter: st.datacenter || '', duration: st.duration || '', sort: st.sort || 'created_at', dir: st.dir || 'desc' });
    const d = await api('/purchases?' + qs.toString());
    const pageAmount = sum(d.rows, 'amount');
    const cols = [
      ['server_id', 'ID', r => `<span class="mono">${esc(r.server_id)}</span> ${copyBtn(r.server_id)}`],
      ['telegram_id', 'کاربر', r => `<span class="mono">${esc(r.telegram_id)}</span>`], ['server_name', 'نام'],
      ['public_ip', 'IP', r => `<span class="mono">${esc(r.public_ip || r.ip || '—')}</span> ${copyBtn(r.public_ip || r.ip)}`],
      ['datacenter', 'دیتاسنتر'], ['flavor_id', 'پلن'], ['amount', 'مبلغ', r => fmt(r.amount)], ['duration', 'چرخه'],
      ['status', 'وضعیت', r => badge(r.status)], ['created_at', 'زمان', r => date(r.created_at)]
    ];
    $('#content').innerHTML = `<div class="content-head"><div><h3>خریدها</h3><p>تمام سفارش‌های سرور با فیلتر وضعیت، دیتاسنتر و دوره.</p></div></div>${toolbar('purchases')}${summaryLine(d, [['جمع مبلغ این صفحه', pageAmount]])}${table(d.rows, cols, r => `<button onclick='serverDetail(${jsArg(r.server_id)})'>مشاهده</button><button onclick='statusModal(${jsArg(r.server_id)})'>تغییر وضعیت</button>`)}${listPager('purchases', d)}`;
  };

  dcs = async function datacentersV2() {
    const rows = await api('/datacenters');
    $('#content').innerHTML = `<div class="content-head"><div><h3>دیتاسنترها</h3><p>قابلیت‌های خرید، مدیریت و ترافیک هر Provider.</p></div><div class="content-actions"><button onclick="dcs()">↻ بروزرسانی</button></div></div><div class="dc-grid">${(rows || []).map(dc => `<div class="dc-card"><div class="dc-card-head"><div><h3>${esc(dc.name || dc.key)}</h3><p class="mono">${esc(dc.key)}</p></div>${badge(dc.manageEnabled ? 'ok' : 'disabled')}</div><div class="dc-meta"><div><span>Provider</span><b>${esc(dc.provider || '—')}</b></div><div><span>خرید</span><b>${dc.buyEnabled ? 'فعال' : 'غیرفعال'}</b></div><div><span>مدیریت</span><b>${dc.manageEnabled ? 'فعال' : 'غیرفعال'}</b></div><div><span>ترافیک</span><b>${dc.trafficSupport ? 'پشتیبانی می‌شود' : 'ندارد'}</b></div></div><div class="dc-cycles">${(dc.allowedCycles || []).map(cycle => `<span>${esc(cycle)}</span>`).join('') || '<span>بدون چرخه</span>'}</div><button class="primary" onclick='dcHealth(${jsArg(dc.key)})'>بررسی Health</button></div>`).join('')}</div>`;
  };

  logs = async function logsV2() {
    const [events, auditRows] = await Promise.all([api('/logs/server-events?limit=100'), api('/logs/audit?limit=100')]);
    const cols = [['actor', 'ادمین'], ['action', 'عملیات'], ['target_type', 'نوع'], ['target_id', 'هدف'], ['metadata', 'جزئیات', r => `<span class="mono truncate">${esc(JSON.stringify(r.metadata || {}))}</span>`], ['created_at', 'زمان', r => date(r.created_at)]];
    $('#content').innerHTML = `<div class="content-head"><div><h3>فعالیت‌های ادمین</h3><p>Audit عملیات مدیریتی و رویدادهای اخیر سرور.</p></div><div class="content-actions"><button onclick="logs()">↻ بروزرسانی</button></div></div><div class="panel"><h3>Audit log</h3>${table(auditRows, cols, () => '')}</div><div class="panel" style="margin-top:11px"><h3>رویدادهای سرور</h3>${events?.length ? `<pre>${esc(events.join('\n'))}</pre>` : empty()}</div>`;
  };

  tools = function toolsV2() {
    $('#content').innerHTML = `<div class="content-head"><div><h3>ابزار ادمین</h3><p>ابزارهای عملیاتی با دسترسی کنترل‌شده و ثبت Audit.</p></div></div><div class="tools-grid"><div class="panel tool-card"><h3>جستجوی سریع سرور</h3><p>با Server ID یا IP، جزئیات سرور را باز کنید.</p><input id="lookupServer" placeholder="server_id یا IP"><button class="primary" onclick="quickServerLookup()">جستجو</button></div><div class="panel tool-card"><h3>جستجوی کاربر</h3><p>جزئیات کامل یک کاربر را با telegram_id باز کنید.</p><input id="lookupUser" placeholder="telegram_id"><button class="primary" onclick="userDetail($('#lookupUser').value.trim())">باز کردن کاربر</button></div><div class="panel tool-card"><h3>اتصال سرور AfraCloud</h3><p>سرور موجود را به خرید کاربر وصل یا همگام کنید.</p><div class="form-row"><input id="afraUser" placeholder="telegram_id"><input id="afraServer" placeholder="server_id"><input id="afraName" placeholder="نام سرور"><input id="afraPrice" inputmode="decimal" placeholder="قیمت ماهانه"><input id="afraOs" placeholder="OS"><input id="afraPass" type="password" autocomplete="new-password" placeholder="رمز اختیاری"></div><span class="hint">این عملیات روی دیتابیس اثر می‌گذارد و در Audit ثبت می‌شود.</span><button class="primary" onclick="attachAfra()">ثبت اتصال</button></div><div class="panel tool-card"><h3>پیام‌رسانی</h3><p>این نصب در حال حاضر ارسال مستقیم پیام را انجام نمی‌دهد و فقط درخواست را Audit می‌کند.</p><input id="msgUser" placeholder="telegram_id"><textarea id="msgText" placeholder="متن پیام"></textarea><button class="primary" onclick="sendMsg()">ثبت درخواست</button></div></div>`;
  };

  globalSearch = async function globalSearchV2() {
    const input = $('#globalSearch');
    const q = input?.value?.trim() || '';
    if (q.length < 2) return;
    try {
      const d = await api('/search?q=' + encodeURIComponent(q));
      const usersRows = d.users || [];
      const serverRows = d.servers || [];
      $('#content').innerHTML = `<div class="content-head"><div><h3>نتایج جستجو</h3><p>«${esc(q)}» · ${fmt(usersRows.length)} کاربر · ${fmt(serverRows.length)} سرور</p></div><div class="content-actions"><button onclick="load(current)">بستن نتایج</button></div></div><div class="panel"><h3>کاربران</h3>${table(usersRows,[['telegram_id','تلگرام',r=>`<span class="mono">${esc(r.telegram_id)}</span> ${copyBtn(r.telegram_id)}`],['phone_masked','تلفن'],['wallet','کیف پول',r=>fmt(r.wallet)],['created_at','ایجاد',r=>date(r.created_at)]],r=>`<button onclick='userDetail(${jsArg(r.telegram_id)})'>باز کردن</button>`)}</div><div class="panel" style="margin-top:11px"><h3>سرورها / خریدها</h3>${table(serverRows,[['server_name','نام'],['server_id','ID',r=>`<span class="mono">${esc(r.server_id)}</span> ${copyBtn(r.server_id)}`],['telegram_id','کاربر'],['datacenter','دیتاسنتر'],['public_ip','IP',r=>`<span class="mono">${esc(r.public_ip||r.ip||'—')}</span>`],['status','وضعیت',r=>badge(r.status)],['created_at','ایجاد',r=>date(r.created_at)]],r=>`<button onclick='serverDetail(${jsArg(r.server_id)})'>باز کردن</button>`)}</div>`;
    } catch (error) {
      toast(error.message || 'جستجو انجام نشد', 'error');
    }
  };

  metricDetails = async function metricDetailsV2(metric, patch = {}) {
    metricState = { ...metricState, metric, page: patch.page ?? (patch.q !== undefined || patch.sort !== undefined || patch.dir !== undefined ? 1 : metricState.page), ...patch };
    const qs = new URLSearchParams(metricState).toString();
    try {
      const d = await api(`/metrics/${metric}/details?${qs}`);
      const pages = Math.max(1, Math.ceil(Number(d.rowTotal || d.total || 0) / Number(d.pageSize || 50)));
      const cols = (d.columns || []).map(c => [c.key, c.label, r => renderMetricCell(c.key, r)]);
      $('#modal').innerHTML = `<div class="modal-card detail-modal"><div class="modal-head"><div><h3>${esc(d.title)}</h3><p>مجموع ${fmt(d.total)} · ${fmt(d.rowTotal || d.total)} ردیف · صفحه ${fmt(d.page)} از ${fmt(pages)}</p></div><button onclick="closeModal()">×</button></div><div class="detail-filters"><input id="metricQ" value="${esc(metricState.q || '')}" placeholder="جستجو">${d.columns?.length ? `<select id="metricSort"><option value="">مرتب‌سازی پیش‌فرض</option>${d.columns.map(c => `<option value="${esc(c.key)}" ${metricState.sort === c.key ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select>` : ''}<select id="metricDir"><option value="desc">نزولی</option><option value="asc" ${metricState.dir === 'asc' ? 'selected' : ''}>صعودی</option></select><button class="primary" onclick='metricDetails(${jsArg(metric)},{q:$("#metricQ").value,sort:$("#metricSort")?.value||"",dir:$("#metricDir").value,page:1})'>اعمال</button><a class="export" href="/dashboard/api/metrics/${encodeURIComponent(metric)}/export.csv?q=${encodeURIComponent(metricState.q || '')}">CSV</a></div>${table(d.rows, cols, metricActions)}<div class="pager"><button ${d.page <= 1 ? 'disabled' : ''} onclick='metricDetails(${jsArg(metric)},{page:${Number(d.page)-1}})'>قبلی</button><span>${fmt(d.page)} / ${fmt(pages)}</span><button ${d.page >= pages ? 'disabled' : ''} onclick='metricDetails(${jsArg(metric)},{page:${Number(d.page)+1}})'>بعدی</button></div></div>`;
      $('#modal').classList.remove('hidden');
    } catch (error) {
      toast(error.message || 'جزئیات شاخص بارگذاری نشد', 'error');
    }
  };

  renderMetricCell = function renderMetricCellV2(key, row) {
    const value = row[key];
    if (key.includes('amount') || key === 'wallet' || key === 'current_balance') return fmt(value);
    if (key.includes('_at') || key === 'timestamp' || key === 'created_at' || key === 'updated_at') return date(value);
    if (key === 'status') return badge(value);
    if (key === 'metadata') return `<span class="mono truncate">${esc(JSON.stringify(value || {}))}</span>`;
    if (key === 'server_id' || key === 'telegram_id') return `<span class="mono">${esc(value || '—')}</span> ${copyBtn(value)}`;
    return esc(value ?? '—');
  };

  metricActions = function metricActionsV2(row) {
    let out = '';
    if (row.telegram_id) out += `<button onclick='userDetail(${jsArg(row.telegram_id)})'>کاربر</button>`;
    if (row.server_id) out += `<button onclick='serverDetail(${jsArg(row.server_id)})'>سرور</button>`;
    return out;
  };

  userDetail = async function userDetailV2(id) {
    const cleanId = String(id || '').trim();
    if (!cleanId) return toast('telegram_id را وارد کنید', 'error');
    try {
      const d = await api('/users/' + encodeURIComponent(cleanId));
      const walletRows = d.wallet_logs || [];
      const serversRows = d.servers || [];
      $('#drawer').innerHTML = `<div class="drawer-head"><h2>کاربر <span class="mono">${esc(cleanId)}</span></h2><button onclick="$('#drawer').classList.add('hidden')">×</button></div><div class="detail-grid"><span>تلفن</span><b>${esc(d.user.phone || '—')}</b><span>کد ملی</span><b>${esc(d.user.national_code_masked || '—')}</b><span>شاهکار</span><b>${badge(d.user.shahkar_verified ? 'ok' : 'disabled')}</b><span>کیف پول</span><b>${fmt(d.user.wallet)}</b><span>عضویت</span><b>${date(d.user.created_at)}</b></div><div class="detail-actions"><button class="primary" onclick='adjust(${jsArg(cleanId)},1)'>شارژ کیف پول</button><button class="danger" onclick='adjust(${jsArg(cleanId)},-1)'>کسر کیف پول</button><button onclick='userBillingSummary(${jsArg(cleanId)})'>Billing summary</button></div><div class="detail-section"><div class="detail-section-head"><h3>سرورها (${fmt(serversRows.length)})</h3></div>${table(serversRows,[['server_name','نام'],['server_id','ID',r=>`<span class="mono">${esc(r.server_id)}</span>`],['public_ip','IP',r=>`<span class="mono">${esc(r.public_ip||r.ip||'—')}</span> ${copyBtn(r.public_ip||r.ip)}`],['datacenter','دیتاسنتر'],['status','وضعیت',r=>badge(r.status)]],r=>`<button onclick='serverDetail(${jsArg(r.server_id)})'>جزئیات</button>`)}</div><div class="detail-section"><div class="detail-section-head"><h3>آخرین تراکنش‌ها (${fmt(walletRows.length)})</h3></div>${table(walletRows,[['amount','مبلغ',r=>`<span class="${Number(r.amount)<0?'money-negative':'money-positive'}">${fmt(r.amount)}</span>`],['type','نوع'],['description','شرح'],['timestamp','زمان',r=>date(r.timestamp)]],()=> '')}</div>`;
      $('#drawer').classList.remove('hidden');
    } catch (error) { toast(error.message || 'کاربر پیدا نشد', 'error'); }
  };

  serverDetail = async function serverDetailV2(id) {
    const cleanId = String(id || '').trim();
    if (!cleanId) return toast('شناسه سرور معتبر نیست', 'error');
    try {
      const d = await api('/servers/' + encodeURIComponent(cleanId));
      const p = d.purchase || {};
      const caps = d.capabilities || {};
      $('#drawer').innerHTML = `<div class="drawer-head"><h2>${esc(p.server_name || 'سرور')} <span class="mono">${esc(cleanId)}</span></h2><button onclick="$('#drawer').classList.add('hidden')">×</button></div><div class="detail-grid"><span>وضعیت</span><b>${badge(p.status)}</b><span>کاربر</span><b><span class="mono">${esc(d.user?.telegram_id || p.telegram_id || '—')}</span> ${copyBtn(d.user?.telegram_id || p.telegram_id)}</b><span>تلفن</span><b>${esc(d.user?.phone || '—')}</b><span>دیتاسنتر</span><b>${esc(d.datacenter_label || p.datacenter || '—')}</b><span>Provider</span><b>${esc(d.provider || '—')}</b><span>IP</span><b><span class="mono">${esc(p.public_ip || p.ip || '—')}</span> ${copyBtn(p.public_ip || p.ip)}</b><span>پلن</span><b>${esc(p.flavor_id || '—')}</b><span>چرخه</span><b>${esc(p.duration || '—')}</b><span>قیمت</span><b>${fmt(p.amount)}</b><span>رمز ذخیره</span><b>${badge(d.password_stored ? 'ok' : 'disabled')}</b></div><div class="detail-actions"><button onclick='trafficPreview(${jsArg(cleanId)})'>ترافیک</button><button onclick='setBilling(${jsArg(cleanId)})'>Billing</button>${caps.refresh ? `<button onclick='serverAction(${jsArg(cleanId)},"refresh")'>رفرش</button>` : ''}${caps.checkSsh ? `<button onclick='serverAction(${jsArg(cleanId)},"check-ssh")'>SSH</button>` : ''}${caps.setPassword ? `<button onclick='setPassword(${jsArg(cleanId)})'>ثبت رمز</button>` : ''}${caps.revealPassword ? `<button onclick='revealPassword(${jsArg(cleanId)})'>نمایش رمز</button>` : ''}</div><div class="detail-section"><h3>لاگ کیف پول مرتبط</h3>${table(d.wallet_logs || [],[['amount','مبلغ',r=>fmt(r.amount)],['type','نوع'],['description','شرح'],['timestamp','زمان',r=>date(r.timestamp)]],()=> '')}</div><div class="detail-section"><h3>Audit سرور</h3>${table(d.audit_logs || [],[['actor','ادمین'],['action','عملیات'],['created_at','زمان',r=>date(r.created_at)]],()=> '')}</div><details class="collapsible detail-section"><summary>داده فنی خرید</summary><pre>${esc(JSON.stringify(p, null, 2))}</pre></details>`;
      $('#drawer').classList.remove('hidden');
    } catch (error) { toast(error.message || 'سرور پیدا نشد', 'error'); }
  };

  dcHealth = async function dcHealthV2(key) {
    try {
      const h = await api('/datacenters/' + encodeURIComponent(key) + '/health');
      modal('Health دیتاسنتر', `<pre>${esc(JSON.stringify(h, null, 2))}</pre>`, closeModal);
    } catch (error) { toast(error.message || 'Health check ناموفق بود', 'error'); }
  };

  quickServerLookup = async function quickServerLookupV2() {
    const q = $('#lookupServer')?.value?.trim() || '';
    if (!q) return toast('شناسه یا IP را وارد کنید', 'error');
    try {
      const d = await api('/servers?pageSize=1&q=' + encodeURIComponent(q));
      if (d.rows?.[0]) return serverDetail(d.rows[0].server_id);
      toast('سرور پیدا نشد', 'error');
    } catch (error) { toast(error.message, 'error'); }
  };

  attachAfra = async function attachAfraV2() {
    const body = {
      telegram_id: $('#afraUser')?.value?.trim(), server_id: $('#afraServer')?.value?.trim(),
      server_name: $('#afraName')?.value?.trim(), monthly_price: $('#afraPrice')?.value,
      os_label: $('#afraOs')?.value?.trim(), password: $('#afraPass')?.value || '', confirm: true
    };
    if (!body.telegram_id || !body.server_id) return toast('telegram_id و server_id الزامی است', 'error');
    try {
      await api('/servers/attach-afra', { method: 'POST', body: JSON.stringify(body) });
      if ($('#afraPass')) $('#afraPass').value = '';
      toast('سرور AfraCloud متصل شد');
    } catch (error) { toast(error.message || 'اتصال ناموفق بود', 'error'); }
  };

  sendMsg = async function sendMsgV2() {
    const id = $('#msgUser')?.value?.trim() || '';
    const message = $('#msgText')?.value?.trim() || '';
    if (!/^\d+$/.test(id) || !message) return toast('telegram_id و متن معتبر وارد کنید', 'error');
    try {
      const result = await api(`/users/${encodeURIComponent(id)}/message`, { method: 'POST', body: JSON.stringify({ message }) });
      toast(result.message || 'درخواست ثبت شد');
    } catch (error) { toast(error.message || 'ثبت پیام ناموفق بود', 'error'); }
  };

  // More defensive admin write actions: disable confirm buttons while requests run.
  modal = function modalV2(title, html, onOk, danger = false) {
    $('#modal').innerHTML = `<div class="modal-card"><div class="modal-head"><div><h3>${esc(title)}</h3></div><button onclick="closeModal()">×</button></div><div>${html}</div><div class="modal-actions"><button onclick="closeModal()">انصراف</button><button class="${danger ? 'danger' : 'primary'}" id="modalOk">تأیید</button></div></div>`;
    $('#modal').classList.remove('hidden');
    const button = $('#modalOk');
    button.onclick = async () => {
      if (button.disabled) return;
      button.disabled = true;
      const oldText = button.textContent;
      button.textContent = 'در حال انجام...';
      try { await onOk(); }
      catch (error) { toast(error.message || 'عملیات انجام نشد', 'error'); }
      finally { if (button?.isConnected) { button.disabled = false; button.textContent = oldText; } }
    };
  };

  apiClients = async function apiClientsV2() {
    const [clients, plans] = await Promise.all([api('/api-clients'), api('/hetzner/plans').catch(() => [])]);
    $('#content').innerHTML = `<div class="content-head"><div><h3>Reseller API</h3><p>مدیریت کلاینت‌ها، کلیدها، محدودیت‌ها و مصرف.</p></div><div class="content-actions"><button onclick="apiClients()">↻ بروزرسانی</button></div></div><div class="tools-grid"><div class="panel tool-card"><h3>ایجاد API Client</h3><div class="form-row"><input id="apiTg" placeholder="telegram_id"><input id="apiName" placeholder="نام مشتری"><input id="apiMax" inputmode="numeric" placeholder="حداکثر سرور" value="2"><input id="apiMinWallet" inputmode="decimal" placeholder="حداقل موجودی" value="0"><input id="apiPlans" placeholder="پلن‌ها: cx22,cx32"><input id="apiLocations" placeholder="لوکیشن‌ها: nbg1,fsn1"></div><input id="apiImages" placeholder="ایمیج‌ها: ubuntu-24.04"><textarea id="apiNotes" placeholder="یادداشت"></textarea><button class="primary" onclick="createApiClient()">ایجاد کلاینت</button></div><div class="panel tool-card"><h3>نمونه استفاده API</h3><p>کلید API فقط هنگام ساخت یک‌بار نمایش داده می‌شود.</p><pre>Authorization: Bearer hm_live_xxx\nGET /api/v1/me\nGET /api/v1/prices\nPOST /api/v1/servers\nDELETE /api/v1/servers/SERVER_ID</pre></div></div><div class="panel" style="margin-top:11px"><h3>کلاینت‌ها</h3>${table(clients,[['name','نام'],['telegram_id','تلگرام'],['wallet','کیف پول',r=>fmt(r.wallet)],['active_servers','سرور فعال',r=>fmt(r.active_servers)],['active_keys','کلید فعال',r=>fmt(r.active_keys)],['last_used_at','آخرین استفاده',r=>date(r.last_used_at)],['is_active','وضعیت',r=>badge(r.is_active?'active':'disabled')]],r=>`<button onclick="apiClientDetail(${Number(r.id)})">جزئیات</button><button onclick="createApiKey(${Number(r.id)})">ساخت کلید</button>`)}</div><div class="panel" style="margin-top:11px"><h3>پلن‌های Hetzner</h3>${table(plans,[['id','Plan'],['cores','CPU'],['memory','RAM'],['disk','Disk'],['amount_hourly','ساعتی',r=>fmt(r.amount_hourly)],['amount_monthly','ماهانه',r=>fmt(r.amount_monthly)],['available','فعال',r=>badge(r.available?'ok':'fail')]],()=> '')}</div>`;
  };

  apiClientDetail = async function apiClientDetailV2(id) {
    try {
      const [client, keys, usage, requestLogs] = await Promise.all([api(`/api-clients/${id}`), api(`/api-clients/${id}/keys`), api(`/api-clients/${id}/usage`), api(`/api-clients/${id}/logs?limit=50`)]);
      $('#drawer').innerHTML = `<div class="drawer-head"><h2>${esc(client.name || `API Client ${id}`)}</h2><button onclick="$('#drawer').classList.add('hidden')">×</button></div><div class="detail-grid"><span>telegram_id</span><b class="mono">${esc(client.telegram_id)}</b><span>کیف پول</span><b>${fmt(client.wallet)}</b><span>سرور فعال</span><b>${fmt(usage.active_servers)}</b><span>مصرف ماهانه</span><b>${fmt(usage.monthly_spend)}</b><span>وضعیت</span><b>${badge(client.is_active ? 'active' : 'disabled')}</b></div><div class="detail-actions"><button class="primary" onclick="createApiKey(${Number(id)})">کلید جدید</button><button onclick="toggleApiClient(${Number(id)},${client.is_active ? 0 : 1})">${client.is_active ? 'غیرفعال کردن' : 'فعال کردن'}</button></div><div class="detail-section"><h3>کلیدها</h3>${table(keys,[['key_prefix','Prefix'],['label','Label'],['scopes','Scopes'],['is_active','وضعیت',r=>badge(r.is_active?'active':'revoked')],['last_used_at','آخرین استفاده',r=>date(r.last_used_at)],['created_at','ایجاد',r=>date(r.created_at)]],r=>r.is_active?`<button class="danger" onclick="revokeApiKey(${Number(r.id)},${Number(id)})">لغو</button>`:'')}</div><div class="detail-section"><h3>درخواست‌های اخیر</h3>${table(requestLogs,[['method','Method'],['path','Path'],['status_code','Status'],['ip','IP'],['request_id','Request ID'],['created_at','زمان',r=>date(r.created_at)]],()=> '')}</div>`;
      $('#drawer').classList.remove('hidden');
    } catch (error) { toast(error.message || 'جزئیات API Client بارگذاری نشد', 'error'); }
  };

  // Ensure dynamically-created navigation gets responsive bindings even when
  // the original init() finished unusually fast.
  queueMicrotask(() => {
    enhanceShell();
    if (!$('#app')?.classList.contains('hidden')) health();
  });
})();
