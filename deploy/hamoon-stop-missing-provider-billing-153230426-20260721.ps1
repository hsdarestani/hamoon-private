$ErrorActionPreference = "Stop"

$ServerIP = "91.107.241.4"
$KeyPath = "C:\Users\diatell\.ssh\hamoon-rescue-recovery-20260718-224538"

$TargetTelegramId = "6344425886"
$TargetServerId = "153230426"
$TargetServerName = "Srv-FIN-928ab9"

if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) {
    throw "SSH private key not found: $KeyPath"
}

$SshPath = (Get-Command ssh.exe -ErrorAction Stop).Source

$RemoteScript = @'
set -Eeuo pipefail
set +x

PRODUCTION="/root/Hamoon"
TARGET_TELEGRAM_ID="6344425886"
TARGET_SERVER_ID="153230426"
TARGET_SERVER_NAME="Srv-FIN-928ab9"
STAMP="$(date -u +%Y%m%d_%H%M%S)"
REPORT="/root/hamoon-provider-missing-${TARGET_SERVER_ID}-${STAMP}.txt"

if [ ! -d "$PRODUCTION" ] || [ ! -f "$PRODUCTION/.env" ]; then
  echo "ERROR: Production directory or .env is missing."
  exit 1
fi

cd "$PRODUCTION"

for required in db.js cloud-api.js datacenters.js provider-detector.js; do
  if [ ! -f "$required" ]; then
    echo "ERROR: Required file missing: $required"
    exit 1
  fi
done

HAMOONBOT_STATUS="$(
  pm2 jlist |
  node -e '
    let input="";
    process.stdin.on("data", d => input += d);
    process.stdin.on("end", () => {
      const rows = JSON.parse(input || "[]");
      const item = rows.find(row => row.name === "hamoonbot");
      process.stdout.write(item?.pm2_env?.status || "missing");
    });
  '
)"

DASHBOARD_STATUS="$(
  pm2 jlist |
  node -e '
    let input="";
    process.stdin.on("data", d => input += d);
    process.stdin.on("end", () => {
      const rows = JSON.parse(input || "[]");
      const item = rows.find(row => row.name === "dashboard-server");
      process.stdout.write(item?.pm2_env?.status || "missing");
    });
  '
)"

DASHBOARD_HTTP="$(
  curl -sS -o /dev/null -w '%{http_code}' \
    --max-time 15 \
    http://127.0.0.1:3000/health \
    2>/dev/null || true
)"

{
  echo "===== TARGET PROVIDER-MISSING REMEDIATION ====="
  echo "TIME=$(date -Iseconds)"
  echo "TARGET_TELEGRAM_ID=$TARGET_TELEGRAM_ID"
  echo "TARGET_SERVER_ID=$TARGET_SERVER_ID"
  echo "TARGET_SERVER_NAME=$TARGET_SERVER_NAME"
  echo "HAMOONBOT_STATUS=$HAMOONBOT_STATUS"
  echo "DASHBOARD_SERVER_STATUS=$DASHBOARD_STATUS"
  echo "DASHBOARD_HEALTH_HTTP=$DASHBOARD_HTTP"
} | tee "$REPORT"

if [ "$HAMOONBOT_STATUS" != "online" ] || \
   [ "$DASHBOARD_STATUS" != "online" ] || \
   [ "$DASHBOARD_HTTP" != "200" ]; then
  echo "ERROR: Production is unhealthy before remediation." | tee -a "$REPORT"
  exit 1
fi

TARGET_TELEGRAM_ID="$TARGET_TELEGRAM_ID" \
TARGET_SERVER_ID="$TARGET_SERVER_ID" \
TARGET_SERVER_NAME="$TARGET_SERVER_NAME" \
DB_AUTO_INIT=false \
DISABLE_AUTO_BILLING=1 \
node <<'NODE' | tee -a "$REPORT"
'use strict';

require('dotenv').config({
  path: '/root/Hamoon/.env'
});

const db = require('./db');
const cloud = require('./cloud-api');
const datacenters = require('./datacenters');
const {
  isHetznerConfig
} = require('./provider-detector');

const telegramId = String(
  process.env.TARGET_TELEGRAM_ID
);
const serverId = String(
  process.env.TARGET_SERVER_ID
);
const expectedName = String(
  process.env.TARGET_SERVER_NAME
);

function providerHttpStatus(error) {
  return Number(
    error?.response?.status ||
    error?.status ||
    error?.statusCode ||
    error?.response?.data?.status ||
    0
  );
}

function providerErrorCode(error) {
  return String(
    error?.response?.data?.error?.code ||
    error?.data?.error?.code ||
    error?.code ||
    ''
  ).toLowerCase();
}

function isProviderNotFound(error) {
  const status = providerHttpStatus(error);
  const code = providerErrorCode(error);
  const message = String(
    error?.response?.data?.error?.message ||
    error?.message ||
    ''
  ).toLowerCase();

  return (
    status === 404 ||
    code === 'not_found' ||
    code === 'server_not_found' ||
    message.includes('status code 404') ||
    message.includes('server not found')
  );
}

function maskIp(value) {
  const ip = String(value || '');
  return ip.replace(/\.\d+$/, '.x');
}

(async () => {
  const connection = await db.pool.getConnection();

  try {
    const [rows] = await connection.execute(
      `SELECT *
       FROM purchases
       WHERE telegram_id = ?
         AND server_id = ?
       LIMIT 1`,
      [telegramId, serverId]
    );

    if (rows.length !== 1) {
      throw new Error(
        `TARGET_PURCHASE_NOT_FOUND_OR_AMBIGUOUS:${rows.length}`
      );
    }

    const purchase = rows[0];

    console.log(
      `PURCHASE_BEFORE=${[
        purchase.telegram_id,
        purchase.server_id,
        purchase.datacenter,
        purchase.server_name,
        purchase.status,
        purchase.auto_renew,
        purchase.duration,
        purchase.amount,
        maskIp(purchase.public_ip),
        purchase.last_billed_at
      ].join('|')}`
    );

    if (
      expectedName &&
      String(purchase.server_name || '') !== expectedName
    ) {
      throw new Error(
        `TARGET_SERVER_NAME_MISMATCH:${purchase.server_name}`
      );
    }

    const datacenterKey = String(
      purchase.datacenter || ''
    );

    let dc = datacenters[datacenterKey];

    if (!dc || !isHetznerConfig({
      ...dc,
      key: datacenterKey
    })) {
      const fallbackEntry = Object.entries(datacenters)
        .find(([key, value]) =>
          isHetznerConfig({
            ...(value || {}),
            key
          })
        );

      if (!fallbackEntry) {
        throw new Error(
          'HETZNER_DATACENTER_CONFIGURATION_NOT_FOUND'
        );
      }

      const [fallbackKey, fallbackDc] = fallbackEntry;
      dc = {
        ...fallbackDc,
        key: fallbackKey
      };
    } else {
      dc = {
        ...dc,
        key: datacenterKey
      };
    }

    let providerMissing = false;

    try {
      const providerServer = await cloud.getServer(
        dc,
        null,
        serverId
      );

      console.log(
        `PROVIDER_SERVER_EXISTS=yes|status=${providerServer?.status || 'unknown'}|ip=${maskIp(providerServer?.public_ip)}`
      );
    } catch (error) {
      const status = providerHttpStatus(error);
      const code = providerErrorCode(error);

      console.log(
        `PROVIDER_LOOKUP_ERROR=http_${status || 'unknown'}|code=${code || 'unknown'}`
      );

      if (!isProviderNotFound(error)) {
        throw new Error(
          `PROVIDER_LOOKUP_INCONCLUSIVE:${status || 'unknown'}:${code || 'unknown'}`
        );
      }

      providerMissing = true;
    }

    if (!providerMissing) {
      console.log('REMEDIATION_SKIPPED=SERVER_EXISTS_AT_PROVIDER');
      console.log('NO_DATABASE_ROWS_CHANGED');
      console.log('NO_WALLET_BALANCE_CHANGED');
      return;
    }

    await connection.beginTransaction();

    const [lockedRows] = await connection.execute(
      `SELECT *
       FROM purchases
       WHERE telegram_id = ?
         AND server_id = ?
       FOR UPDATE`,
      [telegramId, serverId]
    );

    if (lockedRows.length !== 1) {
      throw new Error(
        'TARGET_PURCHASE_DISAPPEARED_DURING_TRANSACTION'
      );
    }

    await connection.execute(
      `UPDATE purchases
       SET status = 'provider_missing',
           auto_renew = 0,
           auto_renew_disabled_at = COALESCE(
             auto_renew_disabled_at,
             NOW()
           ),
           renewal_stopped_at = COALESCE(
             renewal_stopped_at,
             NOW()
           ),
           suspend_reason = 'provider_not_found_404',
           lifecycle_error_code = 'provider_not_found_404',
           lifecycle_updated_at = NOW(),
           updated_at = CURRENT_TIMESTAMP
       WHERE telegram_id = ?
         AND server_id = ?`,
      [telegramId, serverId]
    );

    await connection.execute(
      `CREATE TABLE IF NOT EXISTS admin_audit_logs (
         id BIGINT AUTO_INCREMENT PRIMARY KEY,
         actor VARCHAR(128),
         action VARCHAR(128),
         target_type VARCHAR(64),
         target_id VARCHAR(128),
         result VARCHAR(64) NULL,
         metadata JSON NULL,
         ip VARCHAR(64),
         created_at DATETIME DEFAULT CURRENT_TIMESTAMP
       )`
    );

    await connection.execute(
      `INSERT INTO admin_audit_logs (
         actor,
         action,
         target_type,
         target_id,
         result,
         metadata,
         ip
       ) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      [
        'emergency-provider-reconcile',
        'mark_provider_missing',
        'server',
        serverId,
        'success',
        JSON.stringify({
          telegram_id: telegramId,
          server_name: expectedName,
          datacenter: datacenterKey,
          reason: 'provider_http_404',
          wallet_refund_applied: false
        })
      ]
    );

    await connection.commit();

    const [afterRows] = await connection.execute(
      `SELECT
         telegram_id,
         server_id,
         datacenter,
         server_name,
         status,
         auto_renew,
         auto_renew_disabled_at,
         renewal_stopped_at,
         suspend_reason,
         lifecycle_error_code,
         lifecycle_updated_at,
         last_billed_at,
         amount,
         duration
       FROM purchases
       WHERE telegram_id = ?
         AND server_id = ?`,
      [telegramId, serverId]
    );

    const after = afterRows[0];

    console.log(
      `PURCHASE_AFTER=${[
        after.telegram_id,
        after.server_id,
        after.datacenter,
        after.server_name,
        after.status,
        after.auto_renew,
        after.suspend_reason,
        after.lifecycle_error_code,
        after.last_billed_at,
        after.amount,
        after.duration
      ].join('|')}`
    );

    const [walletRows] = await connection.execute(
      `SELECT
         id,
         amount,
         type,
         description,
         timestamp
       FROM wallet_logs
       WHERE telegram_id = ?
         AND description LIKE ?
       ORDER BY timestamp DESC
       LIMIT 100`,
      [telegramId, `%${serverId}%`]
    );

    let totalDebited = 0;

    for (const row of walletRows) {
      const amount = Number(row.amount || 0);
      if (amount < 0) {
        totalDebited += Math.abs(amount);
      }

      console.log(
        `WALLET_LOG=${[
          row.id,
          amount,
          row.type,
          String(row.description || '').replace(/[\r\n|]+/g, ' '),
          row.timestamp
        ].join('|')}`
      );
    }

    console.log(
      `MATCHING_WALLET_LOG_COUNT=${walletRows.length}`
    );
    console.log(
      `MATCHING_TOTAL_DEBITED=${totalDebited}`
    );
    console.log(
      'WALLET_REFUND_APPLIED=NO'
    );
    console.log(
      'FUTURE_BILLING_STOPPED=YES'
    );
    console.log(
      'TARGET_PROVIDER_MISSING_REMEDIATION=SUCCESS'
    );
  } catch (error) {
    try {
      await connection.rollback();
    } catch {}

    console.error(
      `REMEDIATION_ERROR=${error.message}`
    );
    process.exitCode = 1;
  } finally {
    connection.release();
    await db.pool.end();
  }
})().catch(error => {
  console.error(
    `FATAL_REMEDIATION_ERROR=${error.message}`
  );
  process.exit(1);
});
NODE

POST_HAMOONBOT_STATUS="$(
  pm2 jlist |
  node -e '
    let input="";
    process.stdin.on("data", d => input += d);
    process.stdin.on("end", () => {
      const rows = JSON.parse(input || "[]");
      const item = rows.find(row => row.name === "hamoonbot");
      process.stdout.write(item?.pm2_env?.status || "missing");
    });
  '
)"

POST_DASHBOARD_STATUS="$(
  pm2 jlist |
  node -e '
    let input="";
    process.stdin.on("data", d => input += d);
    process.stdin.on("end", () => {
      const rows = JSON.parse(input || "[]");
      const item = rows.find(row => row.name === "dashboard-server");
      process.stdout.write(item?.pm2_env?.status || "missing");
    });
  '
)"

POST_HTTP="$(
  curl -sS -o /dev/null -w '%{http_code}' \
    --max-time 15 \
    http://127.0.0.1:3000/health \
    2>/dev/null || true
)"

echo "POST_HAMOONBOT_STATUS=$POST_HAMOONBOT_STATUS" | tee -a "$REPORT"
echo "POST_DASHBOARD_SERVER_STATUS=$POST_DASHBOARD_STATUS" | tee -a "$REPORT"
echo "POST_DASHBOARD_HTTP=$POST_HTTP" | tee -a "$REPORT"
echo "REPORT_FILE=$REPORT" | tee -a "$REPORT"
echo "NO_PM2_RESTART_PERFORMED" | tee -a "$REPORT"
echo "NO_PRODUCTION_SOURCE_FILES_CHANGED" | tee -a "$REPORT"
echo "TARGET PROVIDER-MISSING CHECK COMPLETED" | tee -a "$REPORT"
'@

$RemoteScript = $RemoteScript -replace "`r`n", "`n"
$Encoded = [Convert]::ToBase64String(
    [Text.Encoding]::UTF8.GetBytes($RemoteScript)
)

$SshArguments = @(
    "-i", $KeyPath,
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "ConnectTimeout=20",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=8",
    "-o", "StrictHostKeyChecking=accept-new",
    "root@$ServerIP",
    "echo '$Encoded' | base64 -d | bash"
)

Write-Host ""
Write-Host "===== CHECK AND STOP MISSING SERVER BILLING =====" -ForegroundColor Cyan
Write-Host "User:   $TargetTelegramId"
Write-Host "Server: $TargetServerName ($TargetServerId)"

& $SshPath @SshArguments

if ($LASTEXITCODE -ne 0) {
    throw "Target provider-missing remediation failed with exit code $LASTEXITCODE."
}

Write-Host ""
Write-Host "TARGET PROVIDER-MISSING CHECK COMPLETED" -ForegroundColor Green
