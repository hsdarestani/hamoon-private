'use strict';

// Reseller API admin editor.
// Loaded after dashboard-v2 so it can extend the existing client drawer without
// duplicating any backend business rules.
(() => {
  function textValue(value) {
    return value == null ? '' : String(value);
  }

  function nullablePositiveNumber(selector) {
    const raw = $(selector)?.value?.trim() || '';
    if (!raw) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error('سقف هزینه باید عددی بزرگ‌تر از صفر باشد یا خالی بماند.');
    return value;
  }

  window.editApiClient = async function editApiClient(id) {
    try {
      const [client, usage] = await Promise.all([
        api(`/api-clients/${id}`),
        api(`/api-clients/${id}/usage`)
      ]);
      const activeServers = Number(usage?.active_servers || 0);
      const html = `
        <div class="form-row">
          <label>نام مشتری<input id="editApiName" value="${esc(textValue(client.name))}" placeholder="نام مشتری"></label>
          <label>حداکثر سرور<input id="editApiMax" inputmode="numeric" value="${esc(textValue(client.max_servers ?? 2))}" placeholder="مثلاً 10"></label>
          <label>حداقل موجودی رزرو<input id="editApiMinWallet" inputmode="decimal" value="${esc(textValue(client.min_wallet_balance ?? 0))}" placeholder="0"></label>
          <label>سقف هزینه ماهانه<input id="editApiMonthly" inputmode="decimal" value="${esc(textValue(client.max_monthly_spend))}" placeholder="خالی = بدون سقف"></label>
          <label>سقف هزینه ساعتی<input id="editApiHourly" inputmode="decimal" value="${esc(textValue(client.max_hourly_spend))}" placeholder="خالی = بدون سقف"></label>
          <label>دیتاسنترهای مجاز<input id="editApiDcs" value="${esc(textValue(client.allowed_datacenters))}" placeholder="hetzner"></label>
          <label>پلن‌های مجاز<input id="editApiPlans" value="${esc(textValue(client.allowed_plans))}" placeholder="cx22,cx32"></label>
          <label>لوکیشن‌های مجاز<input id="editApiLocations" value="${esc(textValue(client.allowed_locations))}" placeholder="nbg1,fsn1"></label>
          <label>ایمیج‌های مجاز<input id="editApiImages" value="${esc(textValue(client.allowed_images))}" placeholder="ubuntu-24.04"></label>
        </div>
        <label><input id="editApiActive" type="checkbox" ${client.is_active ? 'checked' : ''}> کلاینت API فعال باشد</label>
        <label><input id="editApiMonthlyProrated" type="checkbox" ${client.monthly_prorated_pricing ? 'checked' : ''}> Monthly pricing basis (prorated billing)</label>
        <label>یادداشت<textarea id="editApiNotes" placeholder="یادداشت">${esc(textValue(client.notes))}</textarea></label>
        <p class="hint">الان ${fmt(activeServers)} سرور فعال برای این کلاینت ثبت شده است. تغییر Limit سرورهای فعلی را حذف نمی‌کند؛ فقط ساخت سرور جدید را کنترل می‌کند.</p>
        <p class="hint">خالی گذاشتن پلن، لوکیشن یا ایمیج یعنی محدودیت اختصاصی برای آن مورد اعمال نشود.</p>`;

      modal('ویرایش تنظیمات Reseller API', html, async () => {
        const maxServers = Number($('#editApiMax')?.value);
        const minWalletBalance = Number($('#editApiMinWallet')?.value || 0);
        if (!Number.isInteger(maxServers) || maxServers < 1) throw new Error('حداکثر سرور باید یک عدد صحیح حداقل ۱ باشد.');
        if (!Number.isFinite(minWalletBalance) || minWalletBalance < 0) throw new Error('حداقل موجودی نمی‌تواند منفی باشد.');

        const body = {
          name: $('#editApiName')?.value?.trim() || client.name || `API Client ${id}`,
          notes: $('#editApiNotes')?.value || '',
          isActive: $('#editApiActive')?.checked ? 1 : 0,
          monthlyProratedPricing: $('#editApiMonthlyProrated')?.checked ? 1 : 0,
          maxServers,
          minWalletBalance,
          maxMonthlySpend: nullablePositiveNumber('#editApiMonthly'),
          maxHourlySpend: nullablePositiveNumber('#editApiHourly'),
          allowedDatacenters: $('#editApiDcs')?.value?.trim() || '',
          allowedPlans: $('#editApiPlans')?.value?.trim() || '',
          allowedLocations: $('#editApiLocations')?.value?.trim() || '',
          allowedImages: $('#editApiImages')?.value?.trim() || ''
        };

        await api(`/api-clients/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
        closeModal();
        toast('تنظیمات Reseller API ذخیره شد');
        if (current === 'api') await apiClients();
        await apiClientDetail(id);
      });
    } catch (error) {
      toast(error.message || 'ویرایش کلاینت API باز نشد', 'error');
    }
  };

  apiClientDetail = async function apiClientDetailEditable(id) {
    try {
      const [client, keys, usage, requestLogs] = await Promise.all([
        api(`/api-clients/${id}`),
        api(`/api-clients/${id}/keys`),
        api(`/api-clients/${id}/usage`),
        api(`/api-clients/${id}/logs?limit=50`)
      ]);
      $('#drawer').innerHTML = `
        <div class="drawer-head"><h2>${esc(client.name || `API Client ${id}`)}</h2><button onclick="$('#drawer').classList.add('hidden')">×</button></div>
        <div class="detail-grid">
          <span>telegram_id</span><b class="mono">${esc(client.telegram_id)}</b>
          <span>کیف پول</span><b>${fmt(client.wallet)}</b>
          <span>سرور فعال</span><b>${fmt(usage.active_servers)}</b>
          <span>Limit سرور</span><b>${fmt(client.max_servers)}</b>
          <span>حداقل موجودی رزرو</span><b>${fmt(client.min_wallet_balance)}</b>
          <span>مصرف ماهانه</span><b>${fmt(usage.monthly_spend)}</b>
          <span>سقف هزینه ماهانه</span><b>${client.max_monthly_spend == null ? 'بدون سقف' : fmt(client.max_monthly_spend)}</b>
          <span>سقف هزینه ساعتی</span><b>${client.max_hourly_spend == null ? 'بدون سقف' : fmt(client.max_hourly_spend)}</b>
          <span>Monthly pricing basis (prorated billing)</span><b>${badge(client.monthly_prorated_pricing ? 'active' : 'disabled')}</b>
          <span>دیتاسنتر مجاز</span><b class="mono">${esc(client.allowed_datacenters || 'همه')}</b>
          <span>پلن‌های مجاز</span><b class="mono">${esc(client.allowed_plans || 'همه')}</b>
          <span>لوکیشن‌های مجاز</span><b class="mono">${esc(client.allowed_locations || 'همه')}</b>
          <span>ایمیج‌های مجاز</span><b class="mono">${esc(client.allowed_images || 'همه')}</b>
          <span>وضعیت</span><b>${badge(client.is_active ? 'active' : 'disabled')}</b>
        </div>
        <div class="detail-actions">
          <button class="primary" onclick="editApiClient(${Number(id)})">ویرایش محدودیت‌ها</button>
          <button onclick="createApiKey(${Number(id)})">کلید جدید</button>
          <button onclick="toggleApiClient(${Number(id)},${client.is_active ? 0 : 1})">${client.is_active ? 'غیرفعال کردن' : 'فعال کردن'}</button>
        </div>
        <div class="detail-section"><h3>کلیدها</h3>${table(keys,[['key_prefix','Prefix'],['label','Label'],['scopes','Scopes'],['is_active','وضعیت',r=>badge(r.is_active?'active':'revoked')],['last_used_at','آخرین استفاده',r=>date(r.last_used_at)],['created_at','ایجاد',r=>date(r.created_at)]],r=>r.is_active?`<button class="danger" onclick="revokeApiKey(${Number(r.id)},${Number(id)})">لغو</button>`:'')}</div>
        <div class="detail-section"><h3>درخواست‌های اخیر</h3>${table(requestLogs,[['method','Method'],['path','Path'],['status_code','Status'],['ip','IP'],['request_id','Request ID'],['created_at','زمان',r=>date(r.created_at)]],()=> '')}</div>`;
      $('#drawer').classList.remove('hidden');
    } catch (error) {
      toast(error.message || 'جزئیات API Client بارگذاری نشد', 'error');
    }
  };
})();
