$ErrorActionPreference = "Stop"

$ServerIP = "91.107.241.4"
$KeyPath = "C:\Users\diatell\.ssh\hamoon-rescue-recovery-20260718-224538"

if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) {
    throw "SSH private key not found: $KeyPath"
}

$SshPath = (Get-Command ssh.exe -ErrorAction Stop).Source
$ScpPath = (Get-Command scp.exe -ErrorAction Stop).Source

$SshOptions = @(
    "-i", $KeyPath,
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "ConnectTimeout=20",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=8",
    "-o", "StrictHostKeyChecking=accept-new"
)

$Stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$LocalScript = Join-Path $env:TEMP "hamoon-unique-ip-history-v2-$Stamp.sh"
$RemoteScriptPath = "/tmp/hamoon-unique-ip-history-v2-$Stamp.sh"

$RemoteScript = @'
set -Eeuo pipefail
set +x

PRODUCTION="/root/Hamoon"
STAMP="$(date -u +%Y%m%d_%H%M%S)"
BACKUP="/root/hamoon-unique-ip-history-v2-backup-${STAMP}"
STAGING="/root/hamoon-unique-ip-history-v2-stage-${STAMP}"
PATCHER="/tmp/hamoon-unique-ip-history-v2-patch-${STAMP}.py"
RUNTIME_TEST="/tmp/hamoon-unique-ip-history-v2-test-${STAMP}.js"
REPORT="${BACKUP}/deployment-report.txt"

SUCCESS=0
FILES_INSTALLED=0
APPS_STOPPED=0
TABLE_CREATED_BY_PATCH=0

mkdir -p "$BACKUP"

cleanup_temp() {
    rm -f "$PATCHER" "$RUNTIME_TEST"
    rm -rf "$STAGING"
}

app_status() {
    local name="$1"
    pm2 jlist | node -e '
      let input = "";
      process.stdin.on("data", chunk => input += chunk);
      process.stdin.on("end", () => {
        const rows = JSON.parse(input || "[]");
        const app = rows.find(row => row.name === process.argv[1]);
        process.stdout.write(app?.pm2_env?.status || "missing");
      });
    ' "$name"
}

restart_apps() (
    set +e
    pm2 restart dashboard-server --update-env >/dev/null 2>&1 || true
    sleep 7
    pm2 restart hamoonbot --update-env >/dev/null 2>&1 || true
    sleep 10
    pm2 save >/dev/null 2>&1 || true
)

drop_new_table() {
    if [ "$TABLE_CREATED_BY_PATCH" -ne 1 ]; then
        return
    fi

    cd "$PRODUCTION"
    DB_AUTO_INIT=false DISABLE_AUTO_BILLING=1 node <<'NODE' >/dev/null 2>&1 || true
'use strict';
require('dotenv').config({ path: '/root/Hamoon/.env' });
const db = require('./db');
(async () => {
  await db.pool.query('DROP TABLE IF EXISTS server_ip_history');
  await db.pool.end();
})().catch(async () => {
  try { await db.pool.end(); } catch {}
  process.exit(1);
});
NODE
}

rollback() {
    local code="${1:-1}"
    trap - ERR EXIT
    set +e

    echo
    echo "===== AUTOMATIC UNIQUE-IP HISTORY ROLLBACK ====="

    if [ "$FILES_INSTALLED" -eq 1 ] && \
       [ -f "$BACKUP/original-files.tar.gz" ]; then
        tar -xzf "$BACKUP/original-files.tar.gz" -C "$PRODUCTION"
        echo "ROLLBACK_FILES=RESTORED"
    fi

    drop_new_table

    if [ "$APPS_STOPPED" -eq 1 ] || \
       [ "$FILES_INSTALLED" -eq 1 ]; then
        restart_apps
    fi

    echo "ROLLBACK_HAMOONBOT_STATUS=$(app_status hamoonbot)"
    echo "ROLLBACK_DASHBOARD_SERVER_STATUS=$(app_status dashboard-server)"

    local http
    http="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
        http://127.0.0.1:3000/health 2>/dev/null || true)"
    echo "ROLLBACK_DASHBOARD_HTTP=$http"
    echo "AUTOMATIC_UNIQUE_IP_HISTORY_ROLLBACK=COMPLETED"

    cleanup_temp
    exit "$code"
}

on_exit() {
    local code="$?"
    if [ "$code" -ne 0 ] && [ "$SUCCESS" -ne 1 ]; then
        rollback "$code"
    fi
}

trap 'rollback $?' ERR
trap on_exit EXIT

fail() {
    echo "ERROR: $*" >&2
    return 1
}

[ -d "$PRODUCTION" ] || fail "Production directory missing."
cd "$PRODUCTION"

for required in \
    services/hetzner-lifecycle.js \
    scripts/validate-hetzner-lifecycle.js \
    cloud-api.js \
    db.js \
    package.json
do
    [ -f "$required" ] || fail "Required file missing: $required"
done

echo
echo "===== UNIQUE PRIMARY-IP HISTORY HOTFIX v2 ====="
echo "Production: $PRODUCTION"
echo "Backup:     $BACKUP"

echo
echo "===== PRE-HOTFIX HEALTH ====="
PRE_HAMOONBOT="$(app_status hamoonbot)"
PRE_DASHBOARD="$(app_status dashboard-server)"
PRE_HTTP="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
    http://127.0.0.1:3000/health 2>/dev/null || true)"

echo "PRE_HAMOONBOT_STATUS=$PRE_HAMOONBOT"
echo "PRE_DASHBOARD_SERVER_STATUS=$PRE_DASHBOARD"
echo "PRE_DASHBOARD_HTTP=$PRE_HTTP"

[ "$PRE_HAMOONBOT" = "online" ] || fail "hamoonbot is not online before patch."
[ "$PRE_DASHBOARD" = "online" ] || fail "dashboard-server is not online before patch."
[ "$PRE_HTTP" = "200" ] || fail "Dashboard health is not 200 before patch."

echo
echo "===== BACKUP CURRENT SOURCE ====="
sha256sum \
    services/hetzner-lifecycle.js \
    scripts/validate-hetzner-lifecycle.js \
    index.js \
    Hetzner/hetzner-api.js | tee "$BACKUP/pre-patch-sha256.txt"

tar -czf "$BACKUP/original-files.tar.gz" \
    -C "$PRODUCTION" services/hetzner-lifecycle.js
sha256sum "$BACKUP/original-files.tar.gz" | \
    tee "$BACKUP/original-files.tar.gz.sha256"
echo "UNIQUE_IP_HISTORY_FILE_BACKUP=SUCCESS"

cat > "$PATCHER" <<'PY'
from pathlib import Path
import json
import re
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")

required = [
    "async function changePublicIpLifecycle(",
    "function safeProviderMessage(error)",
    "uniqueCompatibleImages",
    "waitForReadiness",
    "module.exports = {"
]
missing = [item for item in required if item not in text]
if missing:
    raise SystemExit("Incompatible lifecycle base: " + ", ".join(missing))

safe_message = (
    "در حال حاضر IP جدیدی که قبلاً روی این سرور استفاده نشده باشد موجود نیست. "
    "IP فعلی سرور بدون تغییر باقی ماند؛ لطفاً کمی بعد دوباره تلاش کنید."
)

if "NO_UNUSED_PRIMARY_IPV4_AVAILABLE" not in text:
    pattern = re.compile(
        r"(function safeProviderMessage\(error\)\s*\{\s*"
        r"const code = providerCode\(error\);)"
    )

    def add_safe_message(match):
        return (
            match.group(1)
            + "\n\n  if (\n"
            + "    code === 'NO_UNUSED_PRIMARY_IPV4_AVAILABLE' ||\n"
            + "    providerCode(error?.cause) === "
            + "'NO_UNUSED_PRIMARY_IPV4_AVAILABLE'\n"
            + "  ) {\n"
            + "    return "
            + json.dumps(safe_message, ensure_ascii=True)
            + ";\n  }"
        )

    text, count = pattern.subn(add_safe_message, text, count=1)
    if count != 1:
        raise SystemExit("safeProviderMessage marker not found")

helpers = r'''
function normalizeRememberedIpv4(value) {
  const ip = String(value || '').trim();
  return net.isIP(ip) === 4 ? ip : null;
}

async function ensureServerIpHistoryTable(db) {
  if (!db?.pool?.query) return false;

  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS server_ip_history (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      telegram_id BIGINT NULL,
      datacenter VARCHAR(64) NOT NULL,
      server_id VARCHAR(128) NOT NULL,
      ip_address VARCHAR(45) NOT NULL,
      first_seen_at DATETIME(3) NOT NULL
        DEFAULT CURRENT_TIMESTAMP(3),
      last_seen_at DATETIME(3) NOT NULL
        DEFAULT CURRENT_TIMESTAMP(3)
        ON UPDATE CURRENT_TIMESTAMP(3),
      seen_count INT UNSIGNED NOT NULL DEFAULT 1,
      last_event VARCHAR(64) NOT NULL DEFAULT 'observed',
      PRIMARY KEY (id),
      UNIQUE KEY uq_server_ip_history (
        datacenter,
        server_id,
        ip_address
      ),
      KEY idx_server_ip_history_owner (
        telegram_id,
        datacenter,
        server_id
      )
    ) ENGINE=InnoDB
      DEFAULT CHARSET=utf8mb4
      COLLATE=utf8mb4_unicode_ci
  `);

  return true;
}

async function rememberServerIp({
  db,
  telegramId,
  serverId,
  datacenter,
  ip,
  event = 'observed'
}) {
  const normalized = normalizeRememberedIpv4(ip);
  if (!normalized || !db?.pool?.query) return false;

  await ensureServerIpHistoryTable(db);
  await db.pool.query(
    `
      INSERT INTO server_ip_history (
        telegram_id,
        datacenter,
        server_id,
        ip_address,
        last_event
      ) VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        telegram_id = COALESCE(VALUES(telegram_id), telegram_id),
        last_seen_at = CURRENT_TIMESTAMP(3),
        seen_count = seen_count + 1,
        last_event = VALUES(last_event)
    `,
    [
      telegramId || null,
      String(datacenter || ''),
      String(serverId || ''),
      normalized,
      String(event || 'observed').slice(0, 64)
    ]
  );

  return true;
}

async function listRememberedServerIps({ db, serverId, datacenter }) {
  const used = new Set();
  if (!db?.pool?.query) return used;

  await ensureServerIpHistoryTable(db);

  const [historyRows] = await db.pool.query(
    `SELECT ip_address FROM server_ip_history
     WHERE datacenter = ? AND server_id = ?`,
    [String(datacenter || ''), String(serverId || '')]
  );

  const [purchaseRows] = await db.pool.query(
    `SELECT DISTINCT public_ip AS ip_address FROM purchases
     WHERE datacenter = ? AND server_id = ?
       AND public_ip IS NOT NULL AND TRIM(public_ip) <> ''`,
    [String(datacenter || ''), String(serverId || '')]
  );

  for (const row of [...(historyRows || []), ...(purchaseRows || [])]) {
    const ip = normalizeRememberedIpv4(row.ip_address);
    if (ip) used.add(ip);
  }

  return used;
}

async function deleteUnusedPrimaryIpCandidate(dc, id, attempts = 3) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await cloud.deletePrimaryIp(dc, id);
      return true;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise(resolve => setTimeout(resolve, attempt * 1000));
      }
    }
  }

  throw lastError;
}

async function cleanupRejectedPrimaryIps(dc, candidates) {
  for (const candidate of candidates || []) {
    await deleteUnusedPrimaryIpCandidate(dc, candidate.id);
  }
}

async function reserveUnusedPrimaryIpv4({
  db,
  dc,
  telegramId,
  serverId,
  datacenter,
  location,
  oldIp,
  maxAttempts
}) {
  const attempts = Math.max(
    1,
    Math.min(
      12,
      Number(
        maxAttempts ||
        process.env.HETZNER_CHANGE_IP_UNIQUE_ATTEMPTS ||
        8
      )
    )
  );

  const usedIps = await listRememberedServerIps({
    db,
    serverId,
    datacenter
  });

  const currentIp = normalizeRememberedIpv4(oldIp);
  if (currentIp) {
    usedIps.add(currentIp);
    await rememberServerIp({
      db,
      telegramId,
      serverId,
      datacenter,
      ip: currentIp,
      event: 'current_before_change'
    });
  }

  const rejected = [];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let candidate;

    try {
      candidate = await cloud.createPrimaryIpv4(dc, location);
    } catch (cause) {
      await cleanupRejectedPrimaryIps(dc, rejected).catch(() => null);

      if (rejected.length > 0) {
        const error = new Error('NO_UNUSED_PRIMARY_IPV4_AVAILABLE');
        error.code = 'NO_UNUSED_PRIMARY_IPV4_AVAILABLE';
        error.cause = cause;
        error.attempts = attempt - 1;
        throw error;
      }

      throw cause;
    }

    const candidateId = candidate?.id;
    const candidateIp = normalizeRememberedIpv4(candidate?.ip);

    if (!candidateId || !candidateIp) {
      if (candidateId) {
        await deleteUnusedPrimaryIpCandidate(dc, candidateId).catch(() => null);
      }
      await cleanupRejectedPrimaryIps(dc, rejected).catch(() => null);
      const error = new Error('INVALID_PRIMARY_IPV4_CANDIDATE');
      error.code = 'INVALID_PRIMARY_IPV4_CANDIDATE';
      throw error;
    }

    if (!usedIps.has(candidateIp)) {
      try {
        await cleanupRejectedPrimaryIps(dc, rejected);
      } catch (cause) {
        await deleteUnusedPrimaryIpCandidate(dc, candidateId).catch(() => null);
        const error = new Error('DUPLICATE_PRIMARY_IPV4_CLEANUP_FAILED');
        error.code = 'DUPLICATE_PRIMARY_IPV4_CLEANUP_FAILED';
        error.cause = cause;
        throw error;
      }

      await rememberServerIp({
        db,
        telegramId,
        serverId,
        datacenter,
        ip: candidateIp,
        event: 'reserved_unique_candidate'
      });

      console.log('[HETZNER_CHANGE_IP_UNIQUE_CANDIDATE]', {
        server_id: String(serverId),
        attempt,
        ip: candidateIp
      });

      return candidate;
    }

    usedIps.add(candidateIp);
    rejected.push(candidate);

    await rememberServerIp({
      db,
      telegramId,
      serverId,
      datacenter,
      ip: candidateIp,
      event: 'duplicate_candidate_rejected'
    });

    console.warn('[HETZNER_CHANGE_IP_CANDIDATE_REJECTED]', {
      server_id: String(serverId),
      attempt,
      ip: candidateIp,
      reason: 'previously_used'
    });
  }

  await cleanupRejectedPrimaryIps(dc, rejected).catch(() => null);
  const error = new Error('NO_UNUSED_PRIMARY_IPV4_AVAILABLE');
  error.code = 'NO_UNUSED_PRIMARY_IPV4_AVAILABLE';
  error.attempts = attempts;
  throw error;
}

'''

if "async function reserveUnusedPrimaryIpv4(" not in text:
    marker = "async function changePublicIpLifecycle("
    if text.count(marker) != 1:
        raise SystemExit("Expected one changePublicIpLifecycle function")
    text = text.replace(marker, helpers + marker, 1)

start = text.index("async function changePublicIpLifecycle(")
end = text.index("\nmodule.exports = {", start)
block = text[start:end]

if "reserveUnusedPrimaryIpv4({" not in block:
    call = re.compile(
        r"newIp\s*=\s*await\s+cloud\.createPrimaryIpv4"
        r"\(\s*dc\s*,\s*location\s*\)\s*;"
    )
    replacement = """newIp = await reserveUnusedPrimaryIpv4({
          db,
          dc,
          telegramId,
          serverId,
          datacenter,
          location,
          oldIp
        });"""
    block, count = call.subn(replacement, block, count=1)
    if count != 1:
        raise SystemExit("Primary IPv4 reservation call not found")

update_marker = """        await db.updatePublicIp?.(
          telegramId,
          serverId,
          datacenter,
          readiness.ip || newIp.ip
        );"""

if "event: 'assigned_successfully'" not in block:
    if update_marker not in block:
        raise SystemExit("Successful updatePublicIp marker not found")
    remember = """        await rememberServerIp({
          db,
          telegramId,
          serverId,
          datacenter,
          ip: readiness.ip || newIp.ip,
          event: 'assigned_successfully'
        });

"""
    block = block.replace(update_marker, remember + update_marker, 1)

text = text[:start] + block + text[end:]

export_marker = "  changePublicIpLifecycle,\n"
if "  reserveUnusedPrimaryIpv4,\n" not in text:
    if export_marker not in text:
        raise SystemExit("Lifecycle export marker not found")
    text = text.replace(
        export_marker,
        "  reserveUnusedPrimaryIpv4,\n" + export_marker,
        1
    )

for marker in [
    "CREATE TABLE IF NOT EXISTS server_ip_history",
    "async function reserveUnusedPrimaryIpv4(",
    "duplicate_candidate_rejected",
    "reserved_unique_candidate",
    "assigned_successfully",
    "NO_UNUSED_PRIMARY_IPV4_AVAILABLE",
    "  reserveUnusedPrimaryIpv4,"
]:
    if marker not in text:
        raise SystemExit("Missing installed marker: " + marker)

path.write_text(text, encoding="utf-8")
print("UNIQUE_IP_HISTORY_SOURCE_PATCH=SUCCESS")
PY

cat > "$RUNTIME_TEST" <<'NODE'
'use strict';
const assert = require('assert');
const root = process.argv[2];
const cloud = require(`${root}/cloud-api`);
const lifecycle = require(`${root}/services/hetzner-lifecycle`);

function fakeDb(initial = []) {
  const history = new Set(initial);
  return {
    history,
    pool: {
      async query(sql, params = []) {
        const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
        if (q.startsWith('create table if not exists server_ip_history')) {
          return [[], []];
        }
        if (q.includes('select ip_address from server_ip_history') ||
            q.includes('select distinct public_ip as ip_address')) {
          return [[...history].map(ip_address => ({ ip_address })), []];
        }
        if (q.startsWith('insert into server_ip_history')) {
          history.add(String(params[3]));
          return [{ affectedRows: 1 }, []];
        }
        throw new Error(`Unexpected fake SQL: ${q}`);
      }
    }
  };
}

(async () => {
  const originalCreate = cloud.createPrimaryIpv4;
  const originalDelete = cloud.deletePrimaryIp;

  try {
    const deleted = [];
    const queue = [
      { id: 101, ip: '192.0.2.10' },
      { id: 102, ip: '192.0.2.20' }
    ];
    cloud.createPrimaryIpv4 = async () => queue.shift();
    cloud.deletePrimaryIp = async (_dc, id) => deleted.push(id);

    const db = fakeDb(['192.0.2.10']);
    const selected = await lifecycle.reserveUnusedPrimaryIpv4({
      db,
      dc: {},
      telegramId: '1',
      serverId: 'server-1',
      datacenter: 'hetzner',
      location: 'nbg1',
      oldIp: '192.0.2.10',
      maxAttempts: 3
    });

    assert.strictEqual(selected.ip, '192.0.2.20');
    assert.deepStrictEqual(deleted, [101]);
    assert(db.history.has('192.0.2.10'));
    assert(db.history.has('192.0.2.20'));

    const rejected = [
      { id: 201, ip: '198.51.100.10' },
      { id: 202, ip: '198.51.100.10' }
    ];
    const deletedRejected = [];
    cloud.createPrimaryIpv4 = async () => rejected.shift();
    cloud.deletePrimaryIp = async (_dc, id) => deletedRejected.push(id);

    await assert.rejects(
      lifecycle.reserveUnusedPrimaryIpv4({
        db: fakeDb(['198.51.100.10']),
        dc: {},
        telegramId: '1',
        serverId: 'server-2',
        datacenter: 'hetzner',
        location: 'nbg1',
        oldIp: '198.51.100.10',
        maxAttempts: 2
      }),
      error => error?.code === 'NO_UNUSED_PRIMARY_IPV4_AVAILABLE'
    );

    assert.deepStrictEqual(
      deletedRejected.sort((a, b) => a - b),
      [201, 202]
    );

    const message = lifecycle.safeProviderMessage({
      code: 'NO_UNUSED_PRIMARY_IPV4_AVAILABLE'
    });
    assert(message.includes('IP'));

    console.log('UNIQUE_IP_HISTORY_RUNTIME_TEST=SUCCESS');
  } finally {
    cloud.createPrimaryIpv4 = originalCreate;
    cloud.deletePrimaryIp = originalDelete;
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
NODE

echo
echo "===== CREATE ISOLATED STAGING ====="
mkdir -p "$STAGING"
rsync -a --exclude node_modules --exclude .git --exclude '*.log' \
    "$PRODUCTION/" "$STAGING/"
ln -s "$PRODUCTION/node_modules" "$STAGING/node_modules"
python3 "$PATCHER" "$STAGING/services/hetzner-lifecycle.js"
echo "UNIQUE_IP_HISTORY_STAGING=PATCHED"

echo
echo "===== STAGING TESTS ====="
node --check "$STAGING/services/hetzner-lifecycle.js"
(cd "$STAGING" && npm test)
node "$RUNTIME_TEST" "$STAGING"
echo "UNIQUE_IP_HISTORY_STAGING_TESTS=SUCCESS"

echo
echo "===== DATABASE PRECHECK AND MIGRATION ====="
TABLE_PREEXISTED="$(
  cd "$PRODUCTION"
  DB_AUTO_INIT=false DISABLE_AUTO_BILLING=1 node <<'NODE'
'use strict';
require('dotenv').config({ path: '/root/Hamoon/.env' });
const db = require('./db');
(async () => {
  const [rows] = await db.pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = 'server_ip_history'`
  );
  process.stdout.write(Number(rows?.[0]?.n || 0) ? '1' : '0');
  await db.pool.end();
})().catch(async error => {
  console.error(error);
  try { await db.pool.end(); } catch {}
  process.exit(1);
});
NODE
)"

echo "TABLE_PREEXISTED=$TABLE_PREEXISTED"
if [ "$TABLE_PREEXISTED" = "0" ]; then
    TABLE_CREATED_BY_PATCH=1
fi

cd "$PRODUCTION"
DB_AUTO_INIT=false DISABLE_AUTO_BILLING=1 node <<'NODE'
'use strict';
require('dotenv').config({ path: '/root/Hamoon/.env' });
const db = require('./db');
(async () => {
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS server_ip_history (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      telegram_id BIGINT NULL,
      datacenter VARCHAR(64) NOT NULL,
      server_id VARCHAR(128) NOT NULL,
      ip_address VARCHAR(45) NOT NULL,
      first_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
        ON UPDATE CURRENT_TIMESTAMP(3),
      seen_count INT UNSIGNED NOT NULL DEFAULT 1,
      last_event VARCHAR(64) NOT NULL DEFAULT 'observed',
      PRIMARY KEY (id),
      UNIQUE KEY uq_server_ip_history (datacenter, server_id, ip_address),
      KEY idx_server_ip_history_owner (telegram_id, datacenter, server_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const [result] = await db.pool.query(`
    INSERT IGNORE INTO server_ip_history (
      telegram_id, datacenter, server_id, ip_address, last_event
    )
    SELECT telegram_id, datacenter, server_id, TRIM(public_ip),
      'purchase_backfill'
    FROM purchases
    WHERE public_ip IS NOT NULL AND TRIM(public_ip) <> ''
  `);

  const [rows] = await db.pool.query(
    'SELECT COUNT(*) AS n FROM server_ip_history'
  );
  console.log(`IP_HISTORY_BACKFILL_INSERTED=${Number(result?.affectedRows || 0)}`);
  console.log(`IP_HISTORY_TOTAL_ROWS=${Number(rows?.[0]?.n || 0)}`);
  console.log('IP_HISTORY_DATABASE_MIGRATION=SUCCESS');
  await db.pool.end();
})().catch(async error => {
  console.error(error);
  try { await db.pool.end(); } catch {}
  process.exit(1);
});
NODE

echo
echo "===== STOP APPLICATIONS ====="
pm2 stop hamoonbot
pm2 stop dashboard-server
APPS_STOPPED=1
echo "APPLICATIONS_STOPPED=SUCCESS"

echo
echo "===== INSTALL PATCHED LIFECYCLE ====="
install -m 0644 "$STAGING/services/hetzner-lifecycle.js" \
    "$PRODUCTION/services/hetzner-lifecycle.js"
FILES_INSTALLED=1
echo "UNIQUE_IP_HISTORY_CODE=INSTALLED"

echo
echo "===== INSTALLED TESTS ====="
cd "$PRODUCTION"
node --check services/hetzner-lifecycle.js
npm test
node "$RUNTIME_TEST" "$PRODUCTION"
echo "INSTALLED_UNIQUE_IP_HISTORY_TESTS=SUCCESS"

echo
echo "===== START APPLICATIONS ====="
restart_apps
APPS_STOPPED=0

POST_HAMOONBOT="$(app_status hamoonbot)"
POST_DASHBOARD="$(app_status dashboard-server)"
POST_HTTP="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
    http://127.0.0.1:3000/health 2>/dev/null || true)"

echo "POST_HOTFIX_HAMOONBOT_STATUS=$POST_HAMOONBOT"
echo "POST_HOTFIX_DASHBOARD_SERVER_STATUS=$POST_DASHBOARD"
echo "FINAL_DASHBOARD_HTTP=$POST_HTTP"

[ "$POST_HAMOONBOT" = "online" ] || fail "hamoonbot failed after patch."
[ "$POST_DASHBOARD" = "online" ] || fail "dashboard-server failed after patch."
[ "$POST_HTTP" = "200" ] || fail "Dashboard health failed after patch."

cd "$PRODUCTION"
DB_AUTO_INIT=false DISABLE_AUTO_BILLING=1 node <<'NODE'
'use strict';
require('dotenv').config({ path: '/root/Hamoon/.env' });
const db = require('./db');
(async () => {
  const [rows] = await db.pool.query(`
    SELECT COUNT(*) AS rows_count,
      COUNT(DISTINCT CONCAT(datacenter, ':', server_id)) AS servers_count
    FROM server_ip_history
  `);
  console.log(`FINAL_IP_HISTORY_ROWS=${Number(rows?.[0]?.rows_count || 0)}`);
  console.log(`FINAL_TRACKED_SERVERS=${Number(rows?.[0]?.servers_count || 0)}`);
  console.log('FINAL_IP_HISTORY_DATABASE=HEALTHY');
  await db.pool.end();
})().catch(async error => {
  console.error(error);
  try { await db.pool.end(); } catch {}
  process.exit(1);
});
NODE

{
  echo "HAMOON_UNIQUE_IP_HISTORY_HOTFIX_V2=SUCCESS"
  echo "HOTFIX_BACKUP=$BACKUP/original-files.tar.gz"
  echo "DATABASE_TABLE=server_ip_history"
  echo "MAX_UNIQUE_IP_ATTEMPTS_DEFAULT=8"
  echo "OLD_SERVER_IP_REUSE=BLOCKED"
  echo "CURRENT_IP_REMAINS_UNCHANGED_IF_NO_UNIQUE_IP=YES"
  echo "NO_NPM_INSTALL_WAS_RUN"
  echo "NO_GIT_COMMANDS_WERE_RUN"
} | tee "$REPORT"

SUCCESS=1
trap - ERR EXIT
cleanup_temp

echo
echo "UNIQUE PRIMARY-IP HISTORY HOTFIX v2 DEPLOYMENT COMPLETED"
'@

try {
    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText(
        $LocalScript,
        ($RemoteScript -replace "`r`n", "`n"),
        $Utf8NoBom
    )

    Write-Host ""
    Write-Host "===== UPLOAD UNIQUE PRIMARY-IP HISTORY HOTFIX v2 =====" -ForegroundColor Cyan
    & $ScpPath @SshOptions $LocalScript "root@${ServerIP}:$RemoteScriptPath"
    if ($LASTEXITCODE -ne 0) {
        throw "Hotfix upload failed."
    }

    Write-Host ""
    Write-Host "===== DEPLOY UNIQUE PRIMARY-IP HISTORY HOTFIX v2 =====" -ForegroundColor Cyan
    $RemoteCommand = "chmod 700 '$RemoteScriptPath'; bash '$RemoteScriptPath'; rc=`$?; rm -f '$RemoteScriptPath'; exit `$rc"
    & $SshPath @SshOptions "root@$ServerIP" $RemoteCommand
    if ($LASTEXITCODE -ne 0) {
        throw "Unique Primary-IP history hotfix v2 failed with exit code $LASTEXITCODE. Review rollback markers above."
    }

    Write-Host ""
    Write-Host "UNIQUE PRIMARY-IP HISTORY HOTFIX v2 DEPLOYMENT COMPLETED" -ForegroundColor Green
}
finally {
    Remove-Item -LiteralPath $LocalScript -Force -ErrorAction SilentlyContinue
}
