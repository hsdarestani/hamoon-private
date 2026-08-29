'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

function patchLifecycleSource(originalSource) {
  let source = String(originalSource);

  const importMarker = "const { reserveUniquePrimaryIpv4, rememberIp } = require('./hetzner-change-ip');";
  const importReplacement = "const { rememberIp, changeHetznerPublicIp } = require('./hetzner-change-ip');";
  if (!source.includes(importMarker)) throw new Error('HETZNER_SAFE_LIFECYCLE_IMPORT_MARKER_MISSING');
  source = source.replace(importMarker, importReplacement);

  const startMarker = 'async function rotateProvisioningIp({ dc, serverId, db, telegramId, datacenter }) {';
  const endMarker = 'async function deletePurchaseServer({ db, dc, telegramId, serverId, datacenter }) {';
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start === -1 || end === -1) throw new Error('HETZNER_SAFE_LIFECYCLE_ROTATE_MARKER_MISSING');

  const replacement = `async function verifyProvisioningCandidate(ip, {\n  waitTcp = waitTcp22,\n  checkQuality = checkIpQuality,\n  sshTimeoutMs = Number(process.env.HETZNER_PROVISIONING_SSH_VERIFY_TIMEOUT_MS || 90000)\n} = {}) {\n  const reachable = await waitTcp(ip, sshTimeoutMs);\n  if (!reachable) {\n    return {\n      ok: false,\n      definitive: false,\n      reason: 'ssh_unreachable',\n      ssh: { ok: false },\n      quality: null\n    };\n  }\n\n  const quality = await checkQuality(ip);\n  return {\n    ok: Boolean(quality?.ok),\n    definitive: Boolean(quality?.definitive),\n    reason: quality?.ok ? 'ok' : (quality?.reason || 'quality_inconclusive'),\n    ssh: { ok: true },\n    quality\n  };\n}\n\nasync function rotateProvisioningIp({ dc, serverId, db, telegramId, datacenter }) {\n  const maxCandidates = Math.max(1, Math.min(20, Number(process.env.HETZNER_PROVISIONING_CLEAN_ATTEMPTS || 8)));\n  let lastRejected = null;\n\n  for (let attempt = 1; attempt <= maxCandidates; attempt += 1) {\n    try {\n      const result = await changeHetznerPublicIp({\n        db,\n        dc,\n        telegramId,\n        serverId,\n        datacenter,\n        verifyCandidate: async ({ ip }) => verifyProvisioningCandidate(ip)\n      });\n\n      await rememberIp(db, {\n        telegramId,\n        datacenter,\n        serverId,\n        ip: result.newIp,\n        event: 'provisioning_clean_ip_verified'\n      }).catch(() => {});\n\n      console.log('[HETZNER_PROVISIONING_IP_VERIFIED]', {\n        server_id: String(serverId),\n        attempt,\n        old_ip: result.oldIp,\n        new_ip: result.newIp,\n        quality: qualitySummary(result.verification?.quality || result.verification)\n      });\n\n      return {\n        oldIp: result.oldIp,\n        newIp: result.newIp,\n        newIpId: null,\n        verification: result.verification || null\n      };\n    } catch (error) {\n      if (error?.code === 'CANDIDATE_REJECTED') {\n        lastRejected = error;\n        const verification = error.verification || {};\n        console.warn('[HETZNER_PROVISIONING_IP_REJECTED_ROLLED_BACK]', {\n          server_id: String(serverId),\n          attempt,\n          candidate_ip: error.candidateIp || null,\n          restored_ip: error.oldIp || null,\n          definitive: Boolean(verification.definitive),\n          reason: verification.reason || 'unknown'\n        });\n\n        // A definitive Iran/global failure means this candidate is genuinely bad;\n        // try another candidate. Inconclusive checks or slow SSH are not grounds to\n        // keep mutating the server: rollback has already restored the old IP, so\n        // stop and let the next reconcile retry later.\n        if (verification.definitive) continue;\n        const unavailable = new Error('IP_QUALITY_CHECK_UNAVAILABLE');\n        unavailable.code = 'IP_QUALITY_CHECK_UNAVAILABLE';\n        unavailable.currentIp = error.oldIp || null;\n        unavailable.candidateIp = error.candidateIp || null;\n        unavailable.verification = verification;\n        throw unavailable;\n      }\n\n      if (error?.code === 'CANDIDATE_REJECTED_ROLLBACK_FAILED') {\n        const rollbackError = new Error('IP_CHANGE_ROLLBACK_FAILED');\n        rollbackError.code = 'IP_CHANGE_ROLLBACK_FAILED';\n        rollbackError.currentIp = error.oldIp || null;\n        rollbackError.candidateIp = error.candidateIp || null;\n        rollbackError.verification = error.verification || null;\n        throw rollbackError;\n      }\n\n      throw error;\n    }\n  }\n\n  const exhausted = new Error('NO_CLEAN_IPV4_AVAILABLE');\n  exhausted.code = 'NO_CLEAN_IPV4_AVAILABLE';\n  exhausted.currentIp = lastRejected?.oldIp || null;\n  exhausted.candidateIp = lastRejected?.candidateIp || null;\n  exhausted.verification = lastRejected?.verification || null;\n  throw exhausted;\n}\n\n`;

  source = source.slice(0, start) + replacement + source.slice(end);

  const exportMarker = 'qualitySummary, rotateProvisioningIp, deletePurchaseServer, reconcileDeletionPending, reconcileProvisioning,';
  const exportReplacement = 'qualitySummary, verifyProvisioningCandidate, rotateProvisioningIp, deletePurchaseServer, reconcileDeletionPending, reconcileProvisioning,';
  if (!source.includes(exportMarker)) throw new Error('HETZNER_SAFE_LIFECYCLE_EXPORT_MARKER_MISSING');
  source = source.replace(exportMarker, exportReplacement);

  if (!source.includes('HETZNER_PROVISIONING_IP_REJECTED_ROLLED_BACK') ||
      !source.includes('verifyCandidate: async ({ ip }) => verifyProvisioningCandidate(ip)')) {
    throw new Error('HETZNER_SAFE_LIFECYCLE_PATCH_FAILED');
  }
  return source;
}

function installSafeLifecycleModule() {
  const lifecyclePath = require.resolve('./hetzner-lifecycle');
  if (require.cache[lifecyclePath]) {
    const existing = require.cache[lifecyclePath].exports;
    if (typeof existing?.verifyProvisioningCandidate === 'function') return existing;
    throw new Error('HETZNER_LIFECYCLE_LOADED_BEFORE_SAFETY_PATCH');
  }

  const source = patchLifecycleSource(fs.readFileSync(lifecyclePath, 'utf8'));
  const child = new Module(lifecyclePath, module.parent);
  child.filename = lifecyclePath;
  child.paths = Module._nodeModulePaths(path.dirname(lifecyclePath));
  require.cache[lifecyclePath] = child;
  child._compile(source, lifecyclePath);
  return child.exports;
}

module.exports = { patchLifecycleSource, installSafeLifecycleModule };
