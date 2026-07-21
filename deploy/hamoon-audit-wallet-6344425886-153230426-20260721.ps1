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
REPORT="/root/hamoon-wallet-audit-${TARGET_SERVER_ID}-${STAMP}.txt"

if [ ! -d "$PRODUCTION" ] || [ ! -f "$PRODUCTION/.env" ]; then
  echo "ERROR: Production directory or .env is missing."
  exit 1
fi

cd "$PRODUCTION"

TARGET_TELEGRAM_ID="$TARGET_TELEGRAM_ID" \
TARGET_SERVER_ID="$TARGET_SERVER_ID" \
TARGET_SERVER_NAME="$TARGET_SERVER_NAME" \
DB_AUTO_INIT=false \
DISABLE_AUTO_BILLING=1 \
node <<'NODE' | tee "$REPORT"
'use strict';

require('dotenv').config({
  path: '/root/Hamoon/.env'
});

const db = require('./db');

const telegramId = String(process.env.TARGET_TELEGRAM_ID);
const serverId = String(process.env.TARGET_SERVER_ID);
const serverName = String(process.env.TARGET_SERVER_NAME);

function clean(value) {
  return String(value ?? '')
    .replace(/[\r\n|]+/g, ' ')
    .trim();
}

function asNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

(async () => {
  const connection = await db.pool.getConnection();

  try {
    const [[user]] = await connection.execute(
      `SELECT telegram_id, wallet, updated_at
       FROM users
       WHERE telegram_id = ?
       LIMIT 1`,
      [telegramId]
    );

    if (!user) {
      throw new Error('TARGET_USER_NOT_FOUND');
    }

    const [[purchase]] = await connection.execute(
      `SELECT *
       FROM purchases
       WHERE telegram_id = ?
         AND server_id = ?
       LIMIT 1`,
      [telegramId, serverId]
    );

    if (!purchase) {
      throw new Error('TARGET_PURCHASE_NOT_FOUND');
    }

    console.log('===== USER =====');
    console.log(
      `USER=${user.telegram_id}|wallet=${user.wallet}|updated_at=${user.updated_at}`
    );

    console.log('===== TARGET PURCHASE =====');
    console.log(
      `PURCHASE=${[
        purchase.telegram_id,
        purchase.server_id,
        clean(purchase.server_name),
        purchase.datacenter,
        purchase.status,
        purchase.auto_renew,
        purchase.duration,
        purchase.amount,
        purchase.created_at,
        purchase.updated_at,
        purchase.last_billed_at,
        purchase.renewal_stopped_at,
        purchase.suspend_reason,
        purchase.lifecycle_error_code
      ].join('|')}`
    );

    const [allPurchases] = await connection.execute(
      `SELECT
         server_id,
         server_name,
         datacenter,
         status,
         auto_renew,
         duration,
         amount,
         created_at,
         last_billed_at
       FROM purchases
       WHERE telegram_id = ?
       ORDER BY created_at DESC`,
      [telegramId]
    );

    console.log('===== ALL USER PURCHASES =====');
    for (const row of allPurchases) {
      console.log(
        `USER_PURCHASE=${[
          row.server_id,
          clean(row.server_name),
          row.datacenter,
          row.status,
          row.auto_renew,
          row.duration,
          row.amount,
          row.created_at,
          row.last_billed_at
        ].join('|')}`
      );
    }

    const [logs] = await connection.execute(
      `SELECT
         id,
         amount,
         type,
         description,
         timestamp
       FROM wallet_logs
       WHERE telegram_id = ?
         AND timestamp >= DATE_SUB(?, INTERVAL 12 HOUR)
       ORDER BY timestamp ASC, id ASC`,
      [telegramId, purchase.created_at]
    );

    console.log('===== WALLET LOGS SINCE 12H BEFORE PURCHASE =====');

    let totalNegative = 0;
    let totalPositive = 0;
    let targetRelatedNegative = 0;
    let targetRelatedCount = 0;

    for (const row of logs) {
      const amount = asNumber(row.amount);
      const description = clean(row.description);
      const haystack = `${description} ${clean(row.type)}`.toLowerCase();
      const targetRelated = (
        haystack.includes(serverId.toLowerCase()) ||
        haystack.includes(serverName.toLowerCase()) ||
        (
          haystack.includes('hetzner') &&
          haystack.includes('fin')
        )
      );

      if (amount < 0) totalNegative += Math.abs(amount);
      if (amount > 0) totalPositive += amount;
      if (targetRelated) {
        targetRelatedCount += 1;
        if (amount < 0) {
          targetRelatedNegative += Math.abs(amount);
        }
      }

      console.log(
        `WALLET_LOG=${[
          row.id,
          amount,
          clean(row.type),
          description,
          row.timestamp,
          targetRelated ? 'target_related' : 'other'
        ].join('|')}`
      );
    }

    const [summaryRows] = await connection.execute(
      `SELECT
         type,
         COUNT(*) AS log_count,
         SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END) AS debited,
         SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS credited
       FROM wallet_logs
       WHERE telegram_id = ?
         AND timestamp >= DATE_SUB(?, INTERVAL 12 HOUR)
       GROUP BY type
       ORDER BY type`,
      [telegramId, purchase.created_at]
    );

    console.log('===== WALLET SUMMARY BY TYPE =====');
    for (const row of summaryRows) {
      console.log(
        `WALLET_SUMMARY=${[
          clean(row.type),
          row.log_count,
          row.debited,
          row.credited
        ].join('|')}`
      );
    }

    console.log('===== AUDIT TOTALS =====');
    console.log(`TOTAL_LOG_COUNT=${logs.length}`);
    console.log(`TOTAL_DEBITED_IN_WINDOW=${totalNegative}`);
    console.log(`TOTAL_CREDITED_IN_WINDOW=${totalPositive}`);
    console.log(`TARGET_RELATED_LOG_COUNT=${targetRelatedCount}`);
    console.log(`TARGET_RELATED_DEBITED=${targetRelatedNegative}`);
    console.log('NO_DATABASE_ROWS_CHANGED');
    console.log('NO_WALLET_BALANCE_CHANGED');
    console.log('NO_PM2_RESTART_PERFORMED');
    console.log('TARGET_WALLET_AUDIT=SUCCESS');
  } finally {
    connection.release();
    await db.pool.end();
  }
})().catch(error => {
  console.error(`TARGET_WALLET_AUDIT_ERROR=${error.message}`);
  process.exit(1);
});
NODE

echo "REPORT_FILE=$REPORT" | tee -a "$REPORT"
echo "TARGET WALLET AUDIT COMPLETED" | tee -a "$REPORT"
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
Write-Host "===== AUDIT TARGET USER WALLET =====" -ForegroundColor Cyan
Write-Host "User:   $TargetTelegramId"
Write-Host "Server: $TargetServerName ($TargetServerId)"

& $SshPath @SshArguments

if ($LASTEXITCODE -ne 0) {
    throw "Target wallet audit failed with exit code $LASTEXITCODE."
}

Write-Host ""
Write-Host "TARGET WALLET AUDIT COMPLETED" -ForegroundColor Green
