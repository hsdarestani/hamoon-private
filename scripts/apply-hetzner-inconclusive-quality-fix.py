#!/usr/bin/env python3
from pathlib import Path

path = Path('services/hetzner-lifecycle.js')
text = path.read_text()
marker = 'HETZNER_IP_QUALITY_INCONCLUSIVE_FAIL_OPEN_MS'
if marker in text:
    print('apply-hetzner-inconclusive-quality-fix: already patched')
    raise SystemExit(0)

anchor = """      if (readiness.quality && db.updateIpQualityResult) {\n        await db.updateIpQualityResult(purchase.telegram_id, purchase.server_id, purchase.datacenter, qualitySummary(readiness.quality), false);\n      }\n\n      if (readiness.ready) {\n"""

replacement = """      if (readiness.quality && db.updateIpQualityResult) {\n        await db.updateIpQualityResult(purchase.telegram_id, purchase.server_id, purchase.datacenter, qualitySummary(readiness.quality), false);\n      }\n\n      // Check-Host is an external signal, not the server itself. If Hetzner is running,\n      // IPv4 exists and SSH/22 was reachable, an inconclusive probe must not strand a\n      // healthy purchase forever. Keep a grace period for repeated probes, then fail open\n      // only for non-definitive quality results. Definitive failures still rotate IPs below.\n      const configuredQualityFailOpenMs = Number(process.env.HETZNER_IP_QUALITY_INCONCLUSIVE_FAIL_OPEN_MS || 5 * 60 * 1000);\n      const qualityFailOpenMs = Number.isFinite(configuredQualityFailOpenMs)\n        ? Math.max(60 * 1000, configuredQualityFailOpenMs)\n        : 5 * 60 * 1000;\n      const purchaseCreatedMs = new Date(purchase.created_at || purchase.lifecycle_updated_at || 0).getTime();\n      const qualityPendingAgeMs = Number.isFinite(purchaseCreatedMs) && purchaseCreatedMs > 0\n        ? Math.max(0, Date.now() - purchaseCreatedMs)\n        : 0;\n      const qualityInconclusiveTimedOut = Boolean(\n        isDelivery &&\n        readiness.status === 'pending_ip_quality' &&\n        readiness.ip &&\n        readiness.quality &&\n        readiness.quality.definitive === false &&\n        qualityPendingAgeMs >= qualityFailOpenMs\n      );\n\n      if (qualityInconclusiveTimedOut) {\n        const failOpenQuality = {\n          ...readiness.quality,\n          fail_open: true,\n          reason: `${readiness.quality.reason || 'inconclusive'}:fail_open_after_timeout`\n        };\n        if (db.updateIpQualityResult) {\n          await db.updateIpQualityResult(\n            purchase.telegram_id,\n            purchase.server_id,\n            purchase.datacenter,\n            qualitySummary(failOpenQuality),\n            false\n          );\n        }\n        const newlyDelivered = Boolean(await db.markDelivered?.(\n          purchase.telegram_id,\n          purchase.server_id,\n          purchase.datacenter,\n          readiness.ip\n        ));\n        results.push({\n          server_id: purchase.server_id,\n          telegram_id: purchase.telegram_id,\n          datacenter: purchase.datacenter,\n          previous_status: purchase.status,\n          status: 'active',\n          ready: true,\n          newly_delivered: newlyDelivered,\n          ip: readiness.ip,\n          quality: failOpenQuality,\n          quality_fail_open: true\n        });\n        continue;\n      }\n\n      if (readiness.ready) {\n"""

if anchor not in text:
    raise SystemExit('apply-hetzner-inconclusive-quality-fix: anchor not found')

path.write_text(text.replace(anchor, replacement, 1))
print('apply-hetzner-inconclusive-quality-fix: patched')
