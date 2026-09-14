'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const INSTALL_MARK = Symbol.for('hamoon.hetznerFastLocationFallbackInstalled');

function patchLocationFallbackSource(originalSource) {
  let source = String(originalSource || '');

  const from = `      const readiness = await lifecycle.waitForReadiness(targetDc, String(candidate.id), {\n        waitActionId: candidate?.action?.id || candidate?.action_id || null,\n        timeoutMs: Math.max(60000, Number(timeoutMs || 150000)),\n        requireIpQuality: true\n      });\n\n      if (!readiness?.ready || !readiness?.quality?.ok) {\n        lastFailure = {\n          code: 'REPLACEMENT_QUALITY_REJECTED',\n          status: readiness?.status || null,\n          ip: readiness?.ip || null,\n          quality: readiness?.quality || null\n        };\n        console.warn('[HETZNER_LOCATION_FALLBACK_CANDIDATE_REJECTED]', {\n          old_server_id: oldServerId,\n          candidate_server_id: String(candidate.id),\n          attempt,\n          ip: readiness?.ip || null,\n          quality: readiness?.quality ? lifecycle.qualitySummary(readiness.quality) : null\n        });\n        await safeDeleteServer(targetDc, candidate.id);\n        await deleteCandidateSecret(db, candidate.id);\n        continue;\n      }`;

  const to = `      let readiness = await lifecycle.waitForReadiness(targetDc, String(candidate.id), {\n        waitActionId: candidate?.action?.id || candidate?.action_id || null,\n        timeoutMs: Math.max(60000, Number(timeoutMs || 150000)),\n        requireIpQuality: true\n      });\n\n      // A newly-created FSN VM is expensive compared with a Primary IPv4 swap.\n      // If the VM itself is healthy but its first IP is definitively dirty, keep\n      // the same temporary VM and let the bounded provisioning rotator search\n      // several more IPv4 candidates. The purchase is still undelivered, so this\n      // is safe and avoids rebuilding the whole VM for every rejected address.\n      if (!readiness?.ready &&\n          readiness?.status === 'pending_ip_quality' &&\n          readiness?.ip &&\n          readiness?.quality?.definitive === true) {\n        try {\n          const rotationDb = Object.create(db);\n          rotationDb.getPurchaseForOwner = async () => ({\n            ...purchase,\n            server_id: String(candidate.id),\n            status: 'pending_ip_quality',\n            delivered_at: null,\n            public_ip: readiness.ip\n          });\n          // The replacement VM is not the purchase commit point yet. Keep all\n          // candidate IP bookkeeping in server_ip_history, but do not overwrite\n          // the old purchase row until migrateServerIdAtomic commits the winner.\n          rotationDb.updatePublicIp = async () => true;\n\n          const rotated = await lifecycle.rotateProvisioningIp({\n            dc: targetDc,\n            serverId: String(candidate.id),\n            db: rotationDb,\n            telegramId,\n            datacenter\n          });\n          const verification = rotated?.verification || null;\n          if (rotated?.newIp && verification?.ok) {\n            readiness = {\n              server: readiness.server,\n              ip: rotated.newIp,\n              status: 'active',\n              ready: true,\n              quality: verification.quality || verification,\n              ssh: verification.ssh || null\n            };\n            console.log('[HETZNER_LOCATION_FALLBACK_IP_POOL_RECOVERED]', {\n              old_server_id: oldServerId,\n              candidate_server_id: String(candidate.id),\n              attempt,\n              ip: rotated.newIp,\n              quality: lifecycle.qualitySummary(readiness.quality)\n            });\n          }\n        } catch (rotationError) {\n          lastFailure = {\n            code: rotationError?.code || 'FSN_IP_POOL_EXHAUSTED',\n            message: String(rotationError?.message || rotationError).slice(0, 160)\n          };\n          console.warn('[HETZNER_LOCATION_FALLBACK_IP_POOL_EXHAUSTED]', {\n            old_server_id: oldServerId,\n            candidate_server_id: String(candidate.id),\n            attempt,\n            code: rotationError?.code || null,\n            message: String(rotationError?.message || rotationError).slice(0, 120)\n          });\n        }\n      }\n\n      if (!readiness?.ready || !readiness?.quality?.ok) {\n        lastFailure = lastFailure || {\n          code: 'REPLACEMENT_QUALITY_REJECTED',\n          status: readiness?.status || null,\n          ip: readiness?.ip || null,\n          quality: readiness?.quality || null\n        };\n        console.warn('[HETZNER_LOCATION_FALLBACK_CANDIDATE_REJECTED]', {\n          old_server_id: oldServerId,\n          candidate_server_id: String(candidate.id),\n          attempt,\n          ip: readiness?.ip || null,\n          quality: readiness?.quality ? lifecycle.qualitySummary(readiness.quality) : null\n        });\n        await safeDeleteServer(targetDc, candidate.id);\n        await deleteCandidateSecret(db, candidate.id);\n        continue;\n      }`;

  if (source.includes('HETZNER_LOCATION_FALLBACK_IP_POOL_RECOVERED')) return source;
  if (!source.includes(from)) throw new Error('HETZNER_FAST_FALLBACK_MARKER_MISSING');
  source = source.replace(from, to);
  if (!source.includes('rotationDb.updatePublicIp = async () => true')) {
    throw new Error('HETZNER_FAST_FALLBACK_PATCH_FAILED');
  }
  return source;
}

function installFastLocationFallbackModule() {
  const modulePath = require.resolve('./hetzner-location-fallback');
  if (require.cache[modulePath]) {
    const existing = require.cache[modulePath].exports;
    if (existing?.[INSTALL_MARK]) return existing;
    throw new Error('HETZNER_LOCATION_FALLBACK_LOADED_BEFORE_FAST_PATCH');
  }

  const source = patchLocationFallbackSource(fs.readFileSync(modulePath, 'utf8'));
  const child = new Module(modulePath, module.parent);
  child.filename = modulePath;
  child.paths = Module._nodeModulePaths(path.dirname(modulePath));
  require.cache[modulePath] = child;
  child._compile(source, modulePath);
  child.exports[INSTALL_MARK] = true;
  return child.exports;
}

module.exports = {
  INSTALL_MARK,
  patchLocationFallbackSource,
  installFastLocationFallbackModule
};