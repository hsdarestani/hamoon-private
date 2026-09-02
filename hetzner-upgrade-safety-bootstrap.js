'use strict';

function replaceOnce(source, marker, replacement, code) {
  const count = String(source).split(marker).length - 1;
  if (count !== 1) {
    const error = new Error(`${code}:${count}`);
    error.code = code;
    throw error;
  }
  return String(source).replace(marker, replacement);
}

function applyHetznerUpgradeSafetyPatches(source) {
  let patched = String(source);

  patched = replaceOnce(
    patched,
    "function hetznerFlavorType(flavor) {\n  return normalizeHetznerFlavorId(flavor?.hetzner_type || flavor?.server_type || flavor?.name || flavor?.id);\n}\n",
    "function hetznerFlavorType(flavor) {\n  return normalizeHetznerFlavorId(flavor?.hetzner_type || flavor?.server_type || flavor?.name || flavor?.id);\n}\n\nfunction hetznerArchitectureFromType(value) {\n  const type = normalizeHetznerFlavorId(value);\n  if (!type) return '';\n  if (type.startsWith('cax')) return 'arm';\n  if (/^(cx|cpx|ccx)/.test(type)) return 'x86';\n  return '';\n}\n\nfunction hetznerFlavorArchitecture(flavor) {\n  const explicit = String(flavor?.architecture || '').trim().toLowerCase();\n  if (explicit.includes('arm') || explicit === 'aarch64') return 'arm';\n  if (explicit.includes('x86') || explicit.includes('amd64')) return 'x86';\n  return hetznerArchitectureFromType(hetznerFlavorType(flavor));\n}\n\nfunction sameHetznerArchitecture(currentFlavor, targetFlavor) {\n  const currentArch = hetznerFlavorArchitecture(currentFlavor);\n  const targetArch = hetznerFlavorArchitecture(targetFlavor);\n  return !currentArch || !targetArch || currentArch === targetArch;\n}\n",
    'HETZNER_UPGRADE_ARCH_HELPER_MARKER_MISMATCH'
  );

  patched = replaceOnce(
    patched,
    "    if (currentFlavor && normalizeHetznerFlavorId(f.id) === normalizeHetznerFlavorId(currentFlavor.id)) return false;\n    const price = getFlavorCyclePrice(f, duration);",
    "    if (currentFlavor && normalizeHetznerFlavorId(f.id) === normalizeHetznerFlavorId(currentFlavor.id)) return false;\n    if (currentFlavor && !sameHetznerArchitecture(currentFlavor, f)) return false;\n    const price = getFlavorCyclePrice(f, duration);",
    'HETZNER_UPGRADE_FILTER_MARKER_MISMATCH'
  );

  patched = replaceOnce(
    patched,
    "  let previousStatus = 'active';\n  let changeSucceeded = false;\n  try {",
    "  let previousStatus = 'active';\n  let changeSucceeded = false;\n  let poweredOffForUpgrade = false;\n  let wasRunningBeforeUpgrade = false;\n  try {",
    'HETZNER_UPGRADE_STATE_MARKER_MISMATCH'
  );

  patched = replaceOnce(
    patched,
    "    if (!['off', 'stopped'].includes(String(providerServer?.status || '').toLowerCase())) {\n      try { const a = await openstackApi.powerOffHetznerServer(dcConfig, serverId); await openstackApi.waitHetznerAction(dcConfig, a?.id); } catch (e) { if (!/already|offline|off/i.test(e.message)) throw e; }\n    }\n    const action = await openstackApi.changeHetznerServerType(dcConfig, serverId, hetznerFlavorType(target), !!upgradeDisk);",
    "    const providerType = providerServer?.server_type?.name || providerServer?.server_type || providerServer?.type || '';\n    const providerArchitecture = hetznerArchitectureFromType(providerType);\n    const targetArchitecture = hetznerFlavorArchitecture(target);\n    if (providerArchitecture && targetArchitecture && providerArchitecture !== targetArchitecture) {\n      await setPurchaseStatusForUser(userId, serverId, dcConfig.key, previousStatus).catch(() => {});\n      return sendMessage(chatId, '❌ ارتقا بین معماری x86 و ARM امکان‌پذیر نیست. لطفاً یک پلن سازگار با معماری فعلی سرور انتخاب کنید.');\n    }\n\n    const providerStatus = String(providerServer?.status || '').toLowerCase();\n    wasRunningBeforeUpgrade = !['off', 'stopped'].includes(providerStatus);\n    if (wasRunningBeforeUpgrade) {\n      try {\n        const a = await openstackApi.powerOffHetznerServer(dcConfig, serverId);\n        await openstackApi.waitHetznerAction(dcConfig, a?.id);\n        poweredOffForUpgrade = true;\n      } catch (e) {\n        if (!/already|offline|off/i.test(e.message)) throw e;\n        poweredOffForUpgrade = true;\n      }\n    }\n    const action = await openstackApi.changeHetznerServerType(dcConfig, serverId, hetznerFlavorType(target), !!upgradeDisk);",
    'HETZNER_UPGRADE_POWEROFF_MARKER_MISMATCH'
  );

  patched = replaceOnce(
    patched,
    "  } catch (e) {\n    console.error('[HETZNER_UPGRADE]', { user: userId, server_id: serverId, target_flavor: targetFlavorId, upgrade_disk: !!upgradeDisk, status: 'failed', message: e.message });\n    if (!changeSucceeded) await setPurchaseStatusForUser(userId, serverId, dcConfig.key, previousStatus).catch(() => {});\n    return sendMessage(chatId, '❌ ارتقای سرور انجام نشد.\\nهیچ تغییری در پلن و هزینه سرور شما ثبت نشد.');",
    "  } catch (e) {\n    console.error('[HETZNER_UPGRADE]', { user: userId, server_id: serverId, target_flavor: targetFlavorId, upgrade_disk: !!upgradeDisk, status: 'failed', message: e.message });\n    let recoveryMessage = '';\n    if (!changeSucceeded && poweredOffForUpgrade && wasRunningBeforeUpgrade) {\n      try {\n        const current = await openstackApi.getServer(dcConfig, null, serverId).catch(() => null);\n        if (!current || !['running', 'active', 'on'].includes(String(current?.status || '').toLowerCase())) {\n          const powerAction = await openstackApi.powerOnHetznerServer(dcConfig, serverId);\n          await openstackApi.waitHetznerAction(dcConfig, powerAction?.id, 180000);\n        }\n        console.warn('[HETZNER_UPGRADE_RECOVERED_POWER]', { user: userId, server_id: serverId, original_error: e.message });\n        recoveryMessage = '\\n✅ سرور به وضعیت روشن قبل از عملیات برگردانده شد.';\n      } catch (recoveryError) {\n        console.error('[HETZNER_UPGRADE_POWER_RECOVERY_FAILED]', { user: userId, server_id: serverId, message: recoveryError.message, original_error: e.message });\n        recoveryMessage = '\\n⚠️ روشن‌کردن خودکار سرور کامل نشد؛ پشتیبانی در جریان قرار گرفت.';\n      }\n    }\n    if (!changeSucceeded) await setPurchaseStatusForUser(userId, serverId, dcConfig.key, previousStatus).catch(() => {});\n    return sendMessage(chatId, `❌ ارتقای سرور انجام نشد.\\nهیچ تغییری در پلن و هزینه سرور شما ثبت نشد.${recoveryMessage}`);",
    'HETZNER_UPGRADE_RECOVERY_MARKER_MISMATCH'
  );

  return patched;
}

module.exports = { applyHetznerUpgradeSafetyPatches };
