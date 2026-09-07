'use strict';

function countOccurrences(source, needle) {
  let count = 0;
  let from = 0;
  while (true) {
    const idx = source.indexOf(needle, from);
    if (idx === -1) return count;
    count += 1;
    from = idx + needle.length;
  }
}

function replaceOnce(source, needle, replacement, label) {
  const count = countOccurrences(source, needle);
  if (count !== 1) throw new Error(`[hetzner-traffic] patch "${label}" expected exactly 1 match, found ${count}`);
  return source.replace(needle, replacement);
}

function replaceInSection(source, startMarker, endMarker, needle, replacement, label) {
  const start = source.indexOf(startMarker);
  if (start === -1) throw new Error(`[hetzner-traffic] section start not found for "${label}"`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end === -1) throw new Error(`[hetzner-traffic] section end not found for "${label}"`);
  const section = source.slice(start, end);
  const patched = replaceOnce(section, needle, replacement, label);
  return source.slice(0, start) + patched + source.slice(end);
}

function applyHetznerTrafficPatches(input) {
  let source = String(input);

  const helpers = `function formatTrafficBytesFa(bytes) {
  const value = Math.max(0, Number(bytes || 0));
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  if (value < 1024) return \`${'${Math.round(value)}'} B\`;
  const unitIndex = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const normalized = value / Math.pow(1024, unitIndex);
  const digits = normalized >= 100 ? 0 : normalized >= 10 ? 1 : 2;
  return \`${'${normalized.toFixed(digits)}'} ${'${units[unitIndex]}'}\`;
}

function formatTrafficTomanFa(value) {
  return Math.max(0, Math.round(Number(value || 0))).toLocaleString('fa-IR') + ' تومان';
}

function formatHetznerTrafficDateFa(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('fa-IR-u-ca-gregory', {
      timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric'
    }).format(date);
  } catch (_) {
    return date.toISOString().slice(0, 10);
  }
}

function hetznerTrafficRangeLabel(range) {
  return ({ current: 'ماه تقویمی جاری Hetzner', '24h': '۲۴ ساعت گذشته', '7d': '۷ روز گذشته', '30d': '۳۰ روز گذشته' })[range] || 'ماه تقویمی جاری Hetzner';
}

async function getOwnedHetznerTrafficPurchase(userId, serverId, dcConfig) {
  const purchase = await getPurchaseForUserServer(userId, serverId, dcConfig?.key).catch(() => null)
    || await getPurchaseByServerId(serverId).catch(() => null);
  if (!purchase || String(purchase.telegram_id) !== String(userId) || String(purchase.datacenter) !== String(dcConfig?.key)) return null;
  return purchase;
}

async function handleHetznerTrafficInfo(chatId, userId, serverId, dcConfig, range = 'current') {
  const purchase = await getOwnedHetznerTrafficPurchase(userId, serverId, dcConfig);
  if (!purchase) return sendMessage(chatId, '❌ این سرور متعلق به حساب شما نیست.');

  try {
    const { getServerTraffic } = require('./hetzner-traffic');
    const traffic = await getServerTraffic(dcConfig, serverId, range);
    const incoming = Number(traffic.period_incoming_traffic || 0);
    const outgoing = Number(traffic.period_outgoing_traffic || 0);
    const included = Number(traffic.included_traffic || 0);
    const quotaUsed = Number(traffic.outgoing_traffic || 0);
    const selectedRange = traffic.range || range || 'current';
    let addonSummary = { extraBytes: 0, amountToman: 0, purchaseCount: 0 };
    if (traffic.traffic_period_start) {
      addonSummary = await require('./hetzner-traffic-addons').getTrafficAddonSummary({
        telegramId: userId, serverId, datacenter: dcConfig.key, periodStart: traffic.traffic_period_start
      }).catch(() => addonSummary);
    }
    const extraAllowance = Number(addonSummary.extraBytes || 0);
    const customerAllowance = included + extraAllowance;
    const remaining = Math.max(0, customerAllowance - quotaUsed);
    const percent = customerAllowance > 0 ? Math.min(100, quotaUsed / customerAllowance * 100) : 0;

    let text = '<b>📊 مصرف ترافیک سرور</b>\\n\\n' +
      '🖥 <b>' + htmlEscape(traffic.server_name || serverId) + '</b>\\n' +
      '🗓 بازه: ' + htmlEscape(hetznerTrafficRangeLabel(selectedRange)) + '\\n';

    if (selectedRange === 'current' && traffic.traffic_period_start && traffic.traffic_period_reset) {
      text += '▶️ شروع دوره ترافیک: <b>' + htmlEscape(formatHetznerTrafficDateFa(traffic.traffic_period_start)) + '</b>\\n' +
        '🔄 ریست بعدی: <b>' + htmlEscape(formatHetznerTrafficDateFa(traffic.traffic_period_reset)) + '</b>\\n';
    }
    text += '\\n';

    if (traffic.period_available) {
      text += '⬇️ ورودی: <b>' + htmlEscape(formatTrafficBytesFa(incoming)) + '</b>\\n' +
        '⬆️ خروجی: <b>' + htmlEscape(formatTrafficBytesFa(outgoing)) + '</b>\\n' +
        '🔄 مجموع تبادل: <b>' + htmlEscape(formatTrafficBytesFa(incoming + outgoing)) + '</b>\\n\\n';
    } else {
      text += '⚠️ متریک جزئی این بازه موقتاً از Hetzner دریافت نشد.\\n\\n';
    }

    text += '<b>سهمیه ماه تقویمی Hetzner</b>\\n' +
      '🎁 سهمیه پایه: ' + htmlEscape(formatTrafficBytesFa(included)) + '\\n';
    if (extraAllowance > 0) {
      text += '➕ ترافیک خریداری‌شده: <b>' + htmlEscape(formatTrafficBytesFa(extraAllowance)) + '</b>\\n' +
        '📦 سهمیه کل این ماه: <b>' + htmlEscape(formatTrafficBytesFa(customerAllowance)) + '</b>\\n';
    }
    text += '📤 مصرف مشمول سهمیه: ' + htmlEscape(formatTrafficBytesFa(quotaUsed)) + '\\n' +
      '📉 باقی‌مانده: ' + htmlEscape(formatTrafficBytesFa(remaining)) + '\\n' +
      '📈 درصد مصرف: ' + percent.toFixed(2) + '%\\n\\n' +
      '<i>ترافیک Hetzner مستقل از تاریخ خرید یا تمدید سرور است و در ابتدای هر ماه میلادی ریست می‌شود. فقط ترافیک خروجی از سهمیه کم می‌شود.</i>';

    const trafficButton = (selected, label) => ({ text: label, callback_data: makeShortCb(userId, { action: 'HETZNER_TRAFFIC', dcKey: dcConfig.key, serverId, range: selected }) });
    return sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
      [trafficButton('current', '📊 ماه جاری Hetzner'), trafficButton('24h', '🕐 ۲۴ ساعت')],
      [trafficButton('7d', '📅 ۷ روز'), trafficButton('30d', '🗓 ۳۰ روز')],
      [{ text: '➕ خرید ترافیک اضافه', callback_data: makeShortCb(userId, { action: 'HETZNER_TRAFFIC_BUY', dcKey: dcConfig.key, serverId }) }],
      [trafficButton(selectedRange, '🔄 بروزرسانی')],
      [{ text: '🔙 بازگشت', callback_data: makeShortCb(userId, { action: 'M', dcKey: dcConfig.key, serverId }) }]
    ] } });
  } catch (error) {
    console.error('[HETZNER_TRAFFIC_ERROR]', { server_id: String(serverId), datacenter: dcConfig?.key, status: error?.response?.status || error?.status || null, code: error?.code || null });
    return sendMessage(chatId, '❌ دریافت اطلاعات ترافیک در حال حاضر ممکن نیست. لطفاً کمی بعد دوباره تلاش کنید.');
  }
}

async function handleHetznerTrafficBuyMenu(chatId, userId, serverId, dcConfig) {
  const purchase = await getOwnedHetznerTrafficPurchase(userId, serverId, dcConfig);
  if (!purchase) return sendMessage(chatId, '❌ این سرور متعلق به حساب شما نیست.');
  try {
    const traffic = await require('./hetzner-traffic').getServerTraffic(dcConfig, serverId, 'current');
    const addons = require('./hetzner-traffic-addons');
    const unitQuote = addons.quoteTrafficAddon(traffic.price_per_tb_traffic, 5);
    if (!unitQuote.ok) return sendMessage(chatId, '❌ قیمت ترافیک اضافه برای این پلن/لوکیشن از Hetzner دریافت نشد.');
    const summary = await addons.getTrafficAddonSummary({
      telegramId: userId, serverId, datacenter: dcConfig.key, periodStart: traffic.traffic_period_start
    });
    const perTb = Math.round(unitQuote.amountToman / unitQuote.packageTb);
    const boughtTb = Number(summary.extraBytes || 0) / 1000000000000;
    let text = '<b>➕ خرید ترافیک اضافه Hetzner</b>\\n\\n' +
      '🖥 ' + htmlEscape(traffic.server_name || serverId) + '\\n' +
      '💳 نرخ فعلی هر TB: <b>' + htmlEscape(formatTrafficTomanFa(perTb)) + '</b>\\n' +
      '📦 خریداری‌شده در این دوره: <b>' + boughtTb.toFixed(boughtTb % 1 ? 2 : 0) + ' TB</b>\\n' +
      '🔄 اعتبار تا ریست ماهانه: <b>' + htmlEscape(formatHetznerTrafficDateFa(traffic.traffic_period_reset)) + '</b>\\n\\n' +
      'بسته موردنظر را انتخاب کنید:';
    return sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
      [
        { text: '➕ ۵ TB', callback_data: makeShortCb(userId, { action: 'HETZNER_TRAFFIC_BUY_QUOTE', dcKey: dcConfig.key, serverId, packageTb: 5 }) },
        { text: '➕ ۱۰ TB', callback_data: makeShortCb(userId, { action: 'HETZNER_TRAFFIC_BUY_QUOTE', dcKey: dcConfig.key, serverId, packageTb: 10 }) }
      ],
      [{ text: '➕ ۲۰ TB', callback_data: makeShortCb(userId, { action: 'HETZNER_TRAFFIC_BUY_QUOTE', dcKey: dcConfig.key, serverId, packageTb: 20 }) }],
      [{ text: '🔙 بازگشت به مصرف ترافیک', callback_data: makeShortCb(userId, { action: 'HETZNER_TRAFFIC', dcKey: dcConfig.key, serverId, range: 'current' }) }]
    ] } });
  } catch (error) {
    console.error('[HETZNER_TRAFFIC_BUY_MENU_ERROR]', { server_id: String(serverId), code: error?.code || null, message: error?.message });
    return sendMessage(chatId, '❌ امکان دریافت قیمت ترافیک اضافه در حال حاضر وجود ندارد.');
  }
}

async function handleHetznerTrafficBuyQuote(chatId, userId, serverId, dcConfig, packageTb) {
  const purchase = await getOwnedHetznerTrafficPurchase(userId, serverId, dcConfig);
  if (!purchase) return sendMessage(chatId, '❌ این سرور متعلق به حساب شما نیست.');
  try {
    const traffic = await require('./hetzner-traffic').getServerTraffic(dcConfig, serverId, 'current');
    const addons = require('./hetzner-traffic-addons');
    const quote = addons.quoteTrafficAddon(traffic.price_per_tb_traffic, packageTb);
    if (!quote.ok) return sendMessage(chatId, '❌ بسته یا قیمت ترافیک معتبر نیست.');
    const nonce = crypto.randomBytes(8).toString('hex');
    const text = '<b>تأیید خرید ترافیک اضافه</b>\\n\\n' +
      '🖥 ' + htmlEscape(traffic.server_name || serverId) + '\\n' +
      '📦 حجم: <b>' + quote.packageTb + ' TB</b>\\n' +
      '💳 مبلغ: <b>' + htmlEscape(formatTrafficTomanFa(quote.amountToman)) + '</b>\\n' +
      '🔄 معتبر تا: <b>' + htmlEscape(formatHetznerTrafficDateFa(traffic.traffic_period_reset)) + '</b>\\n\\n' +
      '<i>پس از تأیید، مبلغ از کیف پول کم و این حجم به سهمیه همین دوره اضافه می‌شود.</i>';
    return sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
      [{ text: '✅ تأیید و پرداخت', callback_data: makeShortCb(userId, {
        action: 'HETZNER_TRAFFIC_BUY_CONFIRM', dcKey: dcConfig.key, serverId,
        packageTb: quote.packageTb, quotedAmount: quote.amountToman,
        periodStart: traffic.traffic_period_start, nonce
      }) }],
      [{ text: '❌ انصراف', callback_data: makeShortCb(userId, { action: 'HETZNER_TRAFFIC_BUY', dcKey: dcConfig.key, serverId }) }]
    ] } });
  } catch (error) {
    console.error('[HETZNER_TRAFFIC_BUY_QUOTE_ERROR]', { server_id: String(serverId), code: error?.code || null, message: error?.message });
    return sendMessage(chatId, '❌ امکان محاسبه قیمت این بسته در حال حاضر وجود ندارد.');
  }
}

async function handleHetznerTrafficBuyConfirm(chatId, userId, serverId, dcConfig, payload) {
  const purchase = await getOwnedHetznerTrafficPurchase(userId, serverId, dcConfig);
  if (!purchase) return sendMessage(chatId, '❌ این سرور متعلق به حساب شما نیست.');
  try {
    const traffic = await require('./hetzner-traffic').getServerTraffic(dcConfig, serverId, 'current');
    if (String(traffic.traffic_period_start) !== String(payload.periodStart)) {
      return sendMessage(chatId, '⚠️ دوره ترافیک Hetzner عوض شده است. لطفاً بسته را دوباره انتخاب کنید.', {
        reply_markup: { inline_keyboard: [[{ text: '➕ انتخاب بسته', callback_data: makeShortCb(userId, { action: 'HETZNER_TRAFFIC_BUY', dcKey: dcConfig.key, serverId }) }]] }
      });
    }
    const addons = require('./hetzner-traffic-addons');
    const quote = addons.quoteTrafficAddon(traffic.price_per_tb_traffic, payload.packageTb);
    if (!quote.ok) return sendMessage(chatId, '❌ قیمت ترافیک معتبر نیست.');
    if (Number(quote.amountToman) !== Number(payload.quotedAmount)) {
      return sendMessage(chatId, '⚠️ نرخ ترافیک تغییر کرده است. برای مشاهده قیمت جدید دوباره بسته را انتخاب کنید.', {
        reply_markup: { inline_keyboard: [[{ text: '🔄 قیمت جدید', callback_data: makeShortCb(userId, { action: 'HETZNER_TRAFFIC_BUY', dcKey: dcConfig.key, serverId }) }]] }
      });
    }

    await require('./billing-settlement').ensureBillingSettlementSchema();
    const result = await addons.purchaseTrafficAddonAtomic({
      telegramId: userId,
      serverId,
      datacenter: dcConfig.key,
      serverName: traffic.server_name || purchase.server_name || serverId,
      periodStart: traffic.traffic_period_start,
      includedBytes: traffic.included_traffic,
      pricePerTb: traffic.price_per_tb_traffic,
      packageTb: payload.packageTb,
      nonce: payload.nonce
    });

    if (result.status === 'insufficient') {
      return sendMessage(chatId,
        '⚠️ موجودی کیف پول کافی نیست.\\n\\n' +
        '💳 مبلغ بسته: ' + formatTrafficTomanFa(result.required) + '\\n' +
        '💰 موجودی فعلی: ' + formatTrafficTomanFa(result.balance) + '\\n' +
        '📉 کسری: ' + formatTrafficTomanFa(result.missing));
    }
    if (result.status === 'already_purchased') {
      return sendMessage(chatId, '✅ این پرداخت قبلاً ثبت شده و دوباره از کیف پول کسر نشد.', {
        reply_markup: { inline_keyboard: [[{ text: '📊 مشاهده ترافیک', callback_data: makeShortCb(userId, { action: 'HETZNER_TRAFFIC', dcKey: dcConfig.key, serverId, range: 'current' }) }]] }
      });
    }
    if (result.status !== 'purchased') {
      console.warn('[HETZNER_TRAFFIC_BUY_SKIPPED]', { server_id: String(serverId), status: result.status });
      return sendMessage(chatId, '❌ خرید ترافیک انجام نشد. لطفاً دوباره تلاش کنید.');
    }

    return sendMessage(chatId,
      '✅ <b>خرید ترافیک با موفقیت انجام شد.</b>\\n\\n' +
      '📦 حجم اضافه: <b>' + result.packageTb + ' TB</b>\\n' +
      '💳 مبلغ پرداختی: <b>' + htmlEscape(formatTrafficTomanFa(result.charged)) + '</b>\\n' +
      '💰 موجودی جدید: <b>' + htmlEscape(formatTrafficTomanFa(result.newWallet)) + '</b>\\n' +
      '🔄 اعتبار تا ریست ماهانه Hetzner است.',
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '📊 مشاهده ترافیک', callback_data: makeShortCb(userId, { action: 'HETZNER_TRAFFIC', dcKey: dcConfig.key, serverId, range: 'current' }) }]] } }
    );
  } catch (error) {
    console.error('[HETZNER_TRAFFIC_BUY_CONFIRM_ERROR]', { server_id: String(serverId), code: error?.code || null, message: error?.message });
    return sendMessage(chatId, '❌ خرید ترافیک در حال حاضر انجام نشد. هیچ مبلغ تأییدنشده‌ای نباید از کیف پول کسر شود.');
  }
}

`;

  source = replaceOnce(source, 'async function handleHetznerConsole(chatId, userId, serverId, dcConfig) {', helpers + 'async function handleHetznerConsole(chatId, userId, serverId, dcConfig) {', 'add traffic handler');

  source = replaceOnce(source, `      case 'HCONSOLE': {`, `      case 'HETZNER_TRAFFIC': {\n        const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey] || baseDatacenters[payload.dcKey];\n        if (!dc || !isHetznerDc(dc)) return sendMessage(effectiveChatId, '❌ این قابلیت فقط برای سرورهای Hetzner فعال است.');\n        return handleHetznerTrafficInfo(effectiveChatId, effectiveUserId, payload.serverId, dc, payload.range || 'current');\n      }\n\n      case 'HETZNER_TRAFFIC_BUY': {\n        const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey] || baseDatacenters[payload.dcKey];\n        if (!dc || !isHetznerDc(dc)) return sendMessage(effectiveChatId, '❌ این قابلیت فقط برای سرورهای Hetzner فعال است.');\n        return handleHetznerTrafficBuyMenu(effectiveChatId, effectiveUserId, payload.serverId, dc);\n      }\n\n      case 'HETZNER_TRAFFIC_BUY_QUOTE': {\n        const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey] || baseDatacenters[payload.dcKey];\n        if (!dc || !isHetznerDc(dc)) return sendMessage(effectiveChatId, '❌ این قابلیت فقط برای سرورهای Hetzner فعال است.');\n        return handleHetznerTrafficBuyQuote(effectiveChatId, effectiveUserId, payload.serverId, dc, payload.packageTb);\n      }\n\n      case 'HETZNER_TRAFFIC_BUY_CONFIRM': {\n        const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey] || baseDatacenters[payload.dcKey];\n        if (!dc || !isHetznerDc(dc)) return sendMessage(effectiveChatId, '❌ این قابلیت فقط برای سرورهای Hetzner فعال است.');\n        return handleHetznerTrafficBuyConfirm(effectiveChatId, effectiveUserId, payload.serverId, dc, payload);\n      }\n\n      case 'HCONSOLE': {`, 'add traffic callbacks');

  const consoleBlock = `    if (isHetznerDc(dcConfig) && purchase && String(purchase.telegram_id) === String(userId)) {\n      keyboard.push([{ text: '🖥 کنسول', callback_data: short('HCONSOLE') }]);\n    }`;
  const trafficAndConsole = `    if (isHetznerDc(dcConfig) && purchase && String(purchase.telegram_id) === String(userId)) {\n      keyboard.push([\n        { text: '📊 مصرف ترافیک', callback_data: short('HETZNER_TRAFFIC', { range: 'current' }) },\n        { text: '➕ خرید ترافیک', callback_data: short('HETZNER_TRAFFIC_BUY') }\n      ]);\n    }\n${consoleBlock}`;
  source = replaceInSection(source, 'async function handleServerManagement(chatId, userId, serverId, dcConfig) {', 'async function getProjectTrafficSummary(chatId, userId, dcConfig, projectId) {', consoleBlock, trafficAndConsole, 'add traffic buttons');

  return source;
}

module.exports = { applyHetznerTrafficPatches };
