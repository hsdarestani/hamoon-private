'use strict';

function count(source, needle) {
  return String(source).split(needle).length - 1;
}

function replaceOnce(source, needle, replacement, label) {
  const matches = count(source, needle);
  if (matches !== 1) throw new Error(`[server-power-controls] ${label}: expected 1 match, found ${matches}`);
  return source.replace(needle, replacement);
}

function applyServerPowerControlPatches(input) {
  let source = String(input);

  const oldButtons = `    if (hasCapability(dcConfig, 'suspendServer') && ['active', 'running', 'started'].some(x => stateText.includes(x))) {\n      keyboard.push([{ text: '⏸ خاموش کردن', callback_data: short('SUSPEND') }]);\n    }\n    if (hasCapability(dcConfig, 'resumeServer') && ['shutoff', 'stopped', 'suspended'].some(x => stateText.includes(x))) {\n      keyboard.push([{ text: '▶️ روشن کردن', callback_data: short('RESUME') }]);\n    }`;

  const newButtons = `    const serverIsRunning = ['active', 'running', 'started'].some(x => stateText.includes(x));\n    const serverIsOff = ['off', 'shutoff', 'stopped', 'suspended', 'powered_off'].some(x => stateText.includes(x));\n    if (hasCapability(dcConfig, 'suspendServer') && serverIsRunning) {\n      keyboard.push([{ text: '⏸ خاموش کردن', callback_data: short('SUSPEND') }]);\n    }\n    if (isHetznerDc(dcConfig) && serverIsRunning) {\n      keyboard.push([{ text: '🔄 ریبوت سرور', callback_data: short('REBOOT') }]);\n    }\n    if (hasCapability(dcConfig, 'resumeServer') && serverIsOff) {\n      keyboard.push([{ text: '▶️ روشن کردن', callback_data: short('RESUME') }]);\n    }`;

  source = replaceOnce(source, oldButtons, newButtons, 'management power buttons');

  const shortMarker = `case 'SUSPEND': {\n  const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];`;
  const shortReplacement = `case 'REBOOT': {\n  const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];\n  if (!dc || !isHetznerDc(dc)) return sendMessage(effectiveChatId, '❌ ریبوت مستقیم فقط برای سرورهای Hetzner فعال است.');\n  try {\n    const hetznerApi = require('./Hetzner/hetzner-api');\n    const data = await hetznerApi.hetznerRequest(dc, 'POST', '/servers/' + encodeURIComponent(payload.serverId) + '/actions/reboot', {});\n    if (data?.action?.id) await openstackApi.waitHetznerAction(dc, data.action.id, 180000);\n    await sendMessage(effectiveChatId, '✅ دستور ریبوت با موفقیت انجام شد.');\n  } catch (e) {\n    console.error('[HETZNER_REBOOT]', { user_id: effectiveUserId, server_id: payload.serverId, status: e?.status || e?.response?.status || null, message: e?.message || String(e) });\n    return sendMessage(effectiveChatId, '❌ ریبوت سرور انجام نشد. اگر سرور خاموش است ابتدا آن را روشن کنید.');\n  }\n  return handleServerManagement(effectiveChatId, effectiveUserId, payload.serverId, dc);\n}\ncase 'SUSPEND': {\n  const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];`;
  source = replaceOnce(source, shortMarker, shortReplacement, 'short reboot callback');

  const legacyMarker = `    case 'SUSPEND': {\n      const dcKey = params[0];`;
  const legacyReplacement = `    case 'REBOOT': {\n      const dcKey = params[0];\n      const serverId = params[1];\n      const dcConfig = getUserEffectiveDCs(effectiveUserId)[dcKey];\n      if (!dcConfig || !isHetznerDc(dcConfig)) return sendMessage(effectiveChatId, '❌ ریبوت مستقیم فقط برای سرورهای Hetzner فعال است.');\n      try {\n        const hetznerApi = require('./Hetzner/hetzner-api');\n        const data = await hetznerApi.hetznerRequest(dcConfig, 'POST', '/servers/' + encodeURIComponent(serverId) + '/actions/reboot', {});\n        if (data?.action?.id) await openstackApi.waitHetznerAction(dcConfig, data.action.id, 180000);\n        await sendMessage(effectiveChatId, '✅ دستور ریبوت با موفقیت انجام شد.');\n      } catch (e) {\n        console.error('[HETZNER_REBOOT]', { user_id: effectiveUserId, server_id: serverId, status: e?.status || e?.response?.status || null, message: e?.message || String(e) });\n        return sendMessage(effectiveChatId, '❌ ریبوت سرور انجام نشد. اگر سرور خاموش است ابتدا آن را روشن کنید.');\n      }\n      return handleServerManagement(effectiveChatId, effectiveUserId, serverId, dcConfig);\n    }\n\n    case 'SUSPEND': {\n      const dcKey = params[0];`;
  source = replaceOnce(source, legacyMarker, legacyReplacement, 'legacy reboot callback');

  return source;
}

module.exports = { applyServerPowerControlPatches };
