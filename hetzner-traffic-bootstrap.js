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

async function handleHetznerTrafficInfo(chatId, userId, serverId, dcConfig, range = 'current') {
  const purchase = await getPurchaseForUserServer(userId, serverId, dcConfig?.key).catch(() => null)
    || await getPurchaseByServerId(serverId).catch(() => null);
  if (!purchase || String(purchase.telegram_id) !== String(userId) || String(purchase.datacenter) !== String(dcConfig?.key)) {
    return sendMessage(chatId, '❌ این سرور متعلق به حساب شما نیست.');
  }

  try {
    const { getServerTraffic } = require('./hetzner-traffic');
    const traffic = await getServerTraffic(dcConfig, serverId, range);
    const incoming = Number(traffic.period_incoming_traffic || 0);
    const outgoing = Number(traffic.period_outgoing_traffic || 0);
    const included = Number(traffic.included_traffic || 0);
    const quotaUsed = Number(traffic.outgoing_traffic || 0);
    const remaining = Math.max(0, included - quotaUsed);
    const percent = included > 0 ? Math.min(100, quotaUsed / included * 100) : 0;
    const selectedRange = traffic.range || range || 'current';

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
      '🎁 سقف ترافیک: ' + htmlEscape(formatTrafficBytesFa(included)) + '\\n' +
      '📤 مصرف مشمول سهمیه: ' + htmlEscape(formatTrafficBytesFa(quotaUsed)) + '\\n' +
      '📉 باقی‌مانده: ' + htmlEscape(formatTrafficBytesFa(remaining)) + '\\n' +
      '📈 درصد مصرف: ' + percent.toFixed(2) + '%\\n\\n' +
      '<i>ترافیک Hetzner مستقل از تاریخ خرید یا تمدید سرور است و در ابتدای هر ماه میلادی ریست می‌شود. فقط ترافیک خروجی از سهمیه کم می‌شود.</i>';

    const trafficButton = (selected, label) => ({ text: label, callback_data: makeShortCb(userId, { action: 'HETZNER_TRAFFIC', dcKey: dcConfig.key, serverId, range: selected }) });
    return sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
      [trafficButton('current', '📊 ماه جاری Hetzner'), trafficButton('24h', '🕐 ۲۴ ساعت')],
      [trafficButton('7d', '📅 ۷ روز'), trafficButton('30d', '🗓 ۳۰ روز')],
      [trafficButton(selectedRange, '🔄 بروزرسانی')],
      [{ text: '🔙 بازگشت', callback_data: makeShortCb(userId, { action: 'M', dcKey: dcConfig.key, serverId }) }]
    ] } });
  } catch (error) {
    console.error('[HETZNER_TRAFFIC_ERROR]', { server_id: String(serverId), datacenter: dcConfig?.key, status: error?.response?.status || error?.status || null, code: error?.code || null });
    return sendMessage(chatId, '❌ دریافت اطلاعات ترافیک در حال حاضر ممکن نیست. لطفاً کمی بعد دوباره تلاش کنید.');
  }
}

`;

  source = replaceOnce(source, 'async function handleHetznerConsole(chatId, userId, serverId, dcConfig) {', helpers + 'async function handleHetznerConsole(chatId, userId, serverId, dcConfig) {', 'add traffic handler');

  source = replaceOnce(source, `      case 'HCONSOLE': {`, `      case 'HETZNER_TRAFFIC': {\n        const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey] || baseDatacenters[payload.dcKey];\n        if (!dc || !isHetznerDc(dc)) return sendMessage(effectiveChatId, '❌ این قابلیت فقط برای سرورهای Hetzner فعال است.');\n        return handleHetznerTrafficInfo(effectiveChatId, effectiveUserId, payload.serverId, dc, payload.range || 'current');\n      }\n\n      case 'HCONSOLE': {`, 'add traffic callback');

  const consoleBlock = `    if (isHetznerDc(dcConfig) && purchase && String(purchase.telegram_id) === String(userId)) {\n      keyboard.push([{ text: '🖥 کنسول', callback_data: short('HCONSOLE') }]);\n    }`;
  const trafficAndConsole = `    if (isHetznerDc(dcConfig) && purchase && String(purchase.telegram_id) === String(userId)) {\n      keyboard.push([{ text: '📊 مصرف ترافیک', callback_data: short('HETZNER_TRAFFIC', { range: 'current' }) }]);\n    }\n${consoleBlock}`;
  source = replaceInSection(source, 'async function handleServerManagement(chatId, userId, serverId, dcConfig) {', 'async function getProjectTrafficSummary(chatId, userId, dcConfig, projectId) {', consoleBlock, trafficAndConsole, 'add traffic button');

  return source;
}

module.exports = { applyHetznerTrafficPatches };
