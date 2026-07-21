$ErrorActionPreference = "Stop"

$ServerIP = "91.107.241.4"
$KeyPath = "C:\Users\diatell\.ssh\hamoon-rescue-recovery-20260718-224538"
$TargetTelegramId = "6344425886"
$TargetServerId = "153230426"

if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) {
    throw "SSH private key not found: $KeyPath"
}

$SshPath = (Get-Command ssh.exe -ErrorAction Stop).Source
$ScpPath = (Get-Command scp.exe -ErrorAction Stop).Source

$ConnectionOptions = @(
    "-i", $KeyPath,
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "ConnectTimeout=20",
    "-o", "ConnectionAttempts=1",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=8",
    "-o", "StrictHostKeyChecking=accept-new"
)

$RemoteScript = @'
set -Eeuo pipefail
set +x

PRODUCTION="/root/Hamoon"
TARGET_TELEGRAM_ID="6344425886"
TARGET_SERVER_ID="153230426"
STAMP="$(date -u +%Y%m%d_%H%M%S)"
BACKUP="/root/hamoon-hide-provider-missing-v2-backup-${STAMP}"
STAGING="/root/hamoon-hide-provider-missing-v2-stage-${STAMP}"

FILES_INSTALLED=0
APPS_STOPPED=0

mkdir -p "$BACKUP"

app_status() {
  local app_name="$1"
  pm2 jlist |
  node -e '
    let input = "";
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      const rows = JSON.parse(input || "[]");
      const appName = process.argv[1];
      const app = rows.find(item => item.name === appName);
      process.stdout.write(app?.pm2_env?.status || "missing");
    });
  ' "$app_name"
}

restart_apps() (
  set +e
  pm2 restart dashboard-server --update-env >/dev/null 2>&1 || true
  sleep 7
  pm2 restart hamoonbot --update-env >/dev/null 2>&1 || true
  sleep 10
  pm2 save >/dev/null 2>&1 || true
)

cleanup() {
  rm -rf "$STAGING"
}

rollback() {
  local exit_code="$?"
  set +e

  echo
  echo "===== AUTOMATIC HIDE PROVIDER-MISSING v2 ROLLBACK ====="

  if [ "$FILES_INSTALLED" -eq 1 ] &&
     [ -f "$BACKUP/original-db.js" ]; then
    install -m 0644 \
      "$BACKUP/original-db.js" \
      "$PRODUCTION/db.js"
    echo "ROLLBACK_DB_JS=RESTORED"
  fi

  if [ "$APPS_STOPPED" -eq 1 ] ||
     [ "$FILES_INSTALLED" -eq 1 ]; then
    restart_apps
  fi

  echo "ROLLBACK_HAMOONBOT_STATUS=$(app_status hamoonbot)"
  echo "ROLLBACK_DASHBOARD_SERVER_STATUS=$(app_status dashboard-server)"

  local rollback_http
  rollback_http="$(
    curl -sS -o /dev/null -w '%{http_code}' \
      --max-time 15 \
      http://127.0.0.1:3000/health \
      2>/dev/null || true
  )"

  echo "ROLLBACK_DASHBOARD_HTTP=$rollback_http"
  echo "AUTOMATIC_HIDE_PROVIDER_MISSING_V2_ROLLBACK=COMPLETED"

  cleanup
  exit "$exit_code"
}

trap rollback ERR

if [ ! -d "$PRODUCTION" ] ||
   [ ! -f "$PRODUCTION/db.js" ]; then
  echo "ERROR: Production directory or db.js is missing."
  exit 1
fi

cd "$PRODUCTION"

for required in db.js package.json; do
  if [ ! -f "$required" ]; then
    echo "ERROR: Required file missing: $required"
    exit 1
  fi
done

echo
echo "===== HIDE PROVIDER-MISSING SERVERS FROM USER LIST v2 ====="
echo "Production: $PRODUCTION"
echo "Backup:     $BACKUP"

PRE_HAMOONBOT="$(app_status hamoonbot)"
PRE_DASHBOARD="$(app_status dashboard-server)"
PRE_HTTP="$(
  curl -sS -o /dev/null -w '%{http_code}' \
    --max-time 15 \
    http://127.0.0.1:3000/health \
    2>/dev/null || true
)"

echo "PRE_HAMOONBOT_STATUS=$PRE_HAMOONBOT"
echo "PRE_DASHBOARD_SERVER_STATUS=$PRE_DASHBOARD"
echo "PRE_DASHBOARD_HTTP=$PRE_HTTP"

if [ "$PRE_HAMOONBOT" != "online" ] ||
   [ "$PRE_DASHBOARD" != "online" ] ||
   [ "$PRE_HTTP" != "200" ]; then
  echo "ERROR: Production is unhealthy before patch."
  exit 1
fi

echo
echo "===== VERIFY TARGET BEFORE PATCH ====="

DB_AUTO_INIT=false \
DISABLE_AUTO_BILLING=1 \
TARGET_TELEGRAM_ID="$TARGET_TELEGRAM_ID" \
TARGET_SERVER_ID="$TARGET_SERVER_ID" \
node <<'NODE'
'use strict';

require('dotenv').config({
  path: '/root/Hamoon/.env'
});

const db = require('./db');

(async () => {
  const purchase = await db.getPurchaseByServerId(
    process.env.TARGET_SERVER_ID
  );

  if (!purchase) {
    throw new Error('TARGET_PURCHASE_NOT_FOUND');
  }

  if (
    String(purchase.telegram_id) !==
    String(process.env.TARGET_TELEGRAM_ID)
  ) {
    throw new Error('TARGET_PURCHASE_OWNER_MISMATCH');
  }

  console.log(`TARGET_STATUS_BEFORE=${purchase.status}`);

  const visible = await db.getUserActivePurchases(
    process.env.TARGET_TELEGRAM_ID
  );

  const targetVisible = visible.some(
    item =>
      String(item.server_id) ===
      String(process.env.TARGET_SERVER_ID)
  );

  console.log(
    `TARGET_VISIBLE_BEFORE=${targetVisible ? 'YES' : 'NO'}`
  );

  await db.pool.end();
})().catch(async error => {
  console.error(error);
  try {
    await db.pool.end();
  } catch {}
  process.exit(1);
});
NODE

echo
echo "===== BACKUP CURRENT DB.JS ====="

cp "$PRODUCTION/db.js" "$BACKUP/original-db.js"
sha256sum "$BACKUP/original-db.js" |
  tee "$BACKUP/original-db.js.sha256"

echo "DB_JS_BACKUP=SUCCESS"

echo
echo "===== CREATE ISOLATED STAGING ====="

mkdir -p "$STAGING"

rsync -a \
  --exclude node_modules \
  --exclude .git \
  --exclude .env \
  --exclude '*.log' \
  "$PRODUCTION/" \
  "$STAGING/"

ln -s "$PRODUCTION/node_modules" "$STAGING/node_modules"

python3 - "$STAGING/db.js" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")

old = "AND (status IS NULL OR status NOT IN ('deleted','cancelled'))"
new = "AND (status IS NULL OR status NOT IN ('deleted','cancelled','provider_missing'))"

if new in text:
    print("PROVIDER_MISSING_FILTER_ALREADY_PRESENT")
elif text.count(old) == 1:
    text = text.replace(old, new, 1)
    path.write_text(text, encoding="utf-8")
    print("PROVIDER_MISSING_FILTER_PATCHED")
else:
    raise SystemExit(
        "Expected getUserActivePurchases filter was not found exactly once."
    )
PY

grep -F \
  "status NOT IN ('deleted','cancelled','provider_missing')" \
  "$STAGING/db.js" >/dev/null

echo "STAGING_PROVIDER_MISSING_FILTER=VERIFIED"

echo
echo "===== STAGING TESTS ====="

node --check "$STAGING/db.js"

(
  cd "$STAGING"
  npm test
)

echo "HIDE_PROVIDER_MISSING_STAGING_TESTS=SUCCESS"

echo
echo "===== STOP APPLICATIONS ====="

pm2 stop hamoonbot
pm2 stop dashboard-server
APPS_STOPPED=1

echo "APPLICATIONS_STOPPED=SUCCESS"

echo
echo "===== INSTALL PATCHED DB.JS ====="

install -m 0644 \
  "$STAGING/db.js" \
  "$PRODUCTION/db.js"

FILES_INSTALLED=1

echo "PROVIDER_MISSING_LIST_FILTER=INSTALLED"

echo
echo "===== TEST INSTALLED CODE ====="

cd "$PRODUCTION"
node --check db.js
npm test

echo "INSTALLED_PROJECT_TESTS=SUCCESS"

echo
echo "===== VERIFY TARGET IS HIDDEN ====="

DB_AUTO_INIT=false \
DISABLE_AUTO_BILLING=1 \
TARGET_TELEGRAM_ID="$TARGET_TELEGRAM_ID" \
TARGET_SERVER_ID="$TARGET_SERVER_ID" \
node <<'NODE'
'use strict';

require('dotenv').config({
  path: '/root/Hamoon/.env'
});

const db = require('./db');

(async () => {
  const purchase = await db.getPurchaseByServerId(
    process.env.TARGET_SERVER_ID
  );

  if (!purchase) {
    throw new Error('TARGET_PURCHASE_NOT_FOUND_AFTER_PATCH');
  }

  console.log(`TARGET_STATUS_AFTER=${purchase.status}`);

  if (String(purchase.status) !== 'provider_missing') {
    throw new Error(
      `TARGET_STATUS_CHANGED_UNEXPECTEDLY:${purchase.status}`
    );
  }

  const visible = await db.getUserActivePurchases(
    process.env.TARGET_TELEGRAM_ID
  );

  const targetVisible = visible.some(
    item =>
      String(item.server_id) ===
      String(process.env.TARGET_SERVER_ID)
  );

  const anyProviderMissing = visible.some(
    item => String(item.status) === 'provider_missing'
  );

  console.log(
    `TARGET_VISIBLE_AFTER=${targetVisible ? 'YES' : 'NO'}`
  );
  console.log(
    `ANY_PROVIDER_MISSING_VISIBLE_AFTER=${anyProviderMissing ? 'YES' : 'NO'}`
  );
  console.log(`VISIBLE_SERVER_COUNT_AFTER=${visible.length}`);

  if (targetVisible) {
    throw new Error(
      'TARGET_PROVIDER_MISSING_SERVER_STILL_VISIBLE'
    );
  }

  if (anyProviderMissing) {
    throw new Error(
      'PROVIDER_MISSING_SERVER_STILL_RETURNED_TO_USER_LIST'
    );
  }

  console.log('TARGET_PROVIDER_MISSING_HIDDEN=SUCCESS');

  await db.pool.end();
})().catch(async error => {
  console.error(error);
  try {
    await db.pool.end();
  } catch {}
  process.exit(1);
});
NODE

echo
echo "===== START APPLICATIONS ====="

restart_apps
APPS_STOPPED=0

POST_HAMOONBOT="$(app_status hamoonbot)"
POST_DASHBOARD="$(app_status dashboard-server)"
POST_HTTP="$(
  curl -sS -o /dev/null -w '%{http_code}' \
    --max-time 15 \
    http://127.0.0.1:3000/health \
    2>/dev/null || true
)"

echo "POST_HAMOONBOT_STATUS=$POST_HAMOONBOT"
echo "POST_DASHBOARD_SERVER_STATUS=$POST_DASHBOARD"
echo "FINAL_DASHBOARD_HTTP=$POST_HTTP"

if [ "$POST_HAMOONBOT" != "online" ] ||
   [ "$POST_DASHBOARD" != "online" ] ||
   [ "$POST_HTTP" != "200" ]; then
  echo "ERROR: Services are unhealthy after patch."
  exit 1
fi

pm2 save >/dev/null

echo
echo "===== HIDE PROVIDER-MISSING v2 COMPLETED ====="
echo "HAMOON_HIDE_PROVIDER_MISSING_FROM_USER_LIST_V2=SUCCESS"
echo "TARGET_SERVER_ID=$TARGET_SERVER_ID"
echo "TARGET_STATUS_PRESERVED=provider_missing"
echo "TARGET_VISIBLE_TO_USER=NO"
echo "NO_DATABASE_ROWS_CHANGED"
echo "NO_WALLET_BALANCE_CHANGED"
echo "HOTFIX_BACKUP=$BACKUP/original-db.js"

trap - ERR
cleanup

echo
echo "HIDE PROVIDER-MISSING SERVERS v2 DEPLOYMENT COMPLETED"
'@

$RemoteScript = $RemoteScript -replace "`r`n", "`n"
$Stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$LocalRemoteScript = Join-Path $env:TEMP "hamoon-hide-provider-missing-v2-$Stamp.sh"
$RemotePath = "/tmp/hamoon-hide-provider-missing-v2-$Stamp.sh"

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText(
    $LocalRemoteScript,
    $RemoteScript,
    $Utf8NoBom
)

try {
    Write-Host ""
    Write-Host "===== SSH PREFLIGHT =====" -ForegroundColor Cyan

    $Connected = $false
    for ($Attempt = 1; $Attempt -le 3; $Attempt++) {
        Write-Host "SSH attempt $Attempt of 3..."
        & $SshPath @ConnectionOptions "root@$ServerIP" "echo SSH_PREFLIGHT=SUCCESS"

        if ($LASTEXITCODE -eq 0) {
            $Connected = $true
            break
        }

        if ($Attempt -lt 3) {
            Start-Sleep -Seconds (5 * $Attempt)
        }
    }

    if (-not $Connected) {
        throw "SSH preflight failed after 3 attempts. No deployment was started."
    }

    Write-Host ""
    Write-Host "===== UPLOAD REMOTE DEPLOY SCRIPT =====" -ForegroundColor Cyan

    $Uploaded = $false
    for ($Attempt = 1; $Attempt -le 3; $Attempt++) {
        Write-Host "SCP attempt $Attempt of 3..."
        & $ScpPath @ConnectionOptions $LocalRemoteScript "root@${ServerIP}:$RemotePath"

        if ($LASTEXITCODE -eq 0) {
            $Uploaded = $true
            break
        }

        if ($Attempt -lt 3) {
            Start-Sleep -Seconds (5 * $Attempt)
        }
    }

    if (-not $Uploaded) {
        throw "Remote deploy script upload failed after 3 attempts. Production was not changed."
    }

    Write-Host ""
    Write-Host "===== EXECUTE HIDE PROVIDER-MISSING PATCH v2 =====" -ForegroundColor Cyan

    $ExecuteCommand = "chmod 700 '$RemotePath' && bash '$RemotePath'; code=`$?; rm -f '$RemotePath'; exit `$code"

    & $SshPath @ConnectionOptions "root@$ServerIP" $ExecuteCommand

    if ($LASTEXITCODE -ne 0) {
        throw "Hide provider-missing v2 patch failed with exit code $LASTEXITCODE. Review rollback markers above."
    }

    Write-Host ""
    Write-Host "HIDE PROVIDER-MISSING SERVERS v2 DEPLOYMENT COMPLETED" -ForegroundColor Green
}
finally {
    Remove-Item -LiteralPath $LocalRemoteScript -Force -ErrorAction SilentlyContinue
}
