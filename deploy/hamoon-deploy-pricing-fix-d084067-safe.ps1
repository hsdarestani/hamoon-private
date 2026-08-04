$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$ServerIP = '91.107.241.4'
$KeyPath = "$env:USERPROFILE\.ssh\hamoon-rescue-recovery-20260718-224538"
$TargetCommit = 'd0840677692c53bd2318904d77fc9c6b05047945'

if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) {
    throw "SSH private key not found: $KeyPath"
}

$SshPath = (Get-Command ssh.exe -ErrorAction Stop).Source
$SshOptions = @(
    '-T',
    '-i', $KeyPath,
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'ConnectTimeout=30',
    '-o', 'ConnectionAttempts=1',
    '-o', 'TCPKeepAlive=yes',
    '-o', 'ServerAliveInterval=10',
    '-o', 'ServerAliveCountMax=6',
    '-o', 'IPQoS=none',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'LogLevel=ERROR'
)

function ConvertTo-NativeArgument {
    param([AllowEmptyString()][string]$Value)

    if ($Value.Length -eq 0) { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }

    $Builder = New-Object System.Text.StringBuilder
    [void]$Builder.Append('"')
    $Backslashes = 0

    foreach ($Character in $Value.ToCharArray()) {
        if ($Character -eq '\') {
            $Backslashes += 1
            continue
        }
        if ($Character -eq '"') {
            [void]$Builder.Append(('\' * ($Backslashes * 2 + 1)))
            [void]$Builder.Append('"')
            $Backslashes = 0
            continue
        }
        if ($Backslashes -gt 0) {
            [void]$Builder.Append(('\' * $Backslashes))
            $Backslashes = 0
        }
        [void]$Builder.Append($Character)
    }

    if ($Backslashes -gt 0) {
        [void]$Builder.Append(('\' * ($Backslashes * 2)))
    }
    [void]$Builder.Append('"')
    return $Builder.ToString()
}

function Invoke-NativeProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [int]$TimeoutSeconds = 90
    )

    $Info = New-Object System.Diagnostics.ProcessStartInfo
    $Info.FileName = $FilePath
    $Info.Arguments = (($Arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' ')
    $Info.UseShellExecute = $false
    $Info.RedirectStandardOutput = $true
    $Info.RedirectStandardError = $true
    $Info.CreateNoWindow = $true

    $Process = New-Object System.Diagnostics.Process
    $Process.StartInfo = $Info

    try {
        if (-not $Process.Start()) {
            return [pscustomobject]@{ ExitCode = 255; StdOut = ''; StdErr = 'Process did not start'; TimedOut = $false }
        }

        $StdOutTask = $Process.StandardOutput.ReadToEndAsync()
        $StdErrTask = $Process.StandardError.ReadToEndAsync()

        if (-not $Process.WaitForExit($TimeoutSeconds * 1000)) {
            try { $Process.Kill() } catch {}
            return [pscustomobject]@{ ExitCode = 124; StdOut = ''; StdErr = 'Process timed out'; TimedOut = $true }
        }

        return [pscustomobject]@{
            ExitCode = $Process.ExitCode
            StdOut = $StdOutTask.GetAwaiter().GetResult()
            StdErr = $StdErrTask.GetAwaiter().GetResult()
            TimedOut = $false
        }
    }
    catch {
        return [pscustomobject]@{ ExitCode = 255; StdOut = ''; StdErr = $_.Exception.Message; TimedOut = $false }
    }
    finally {
        $Process.Dispose()
    }
}

function Invoke-HamoonSsh {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [int]$Retries = 8,
        [int]$TimeoutSeconds = 90,
        [switch]$Quiet
    )

    $LastResult = $null
    for ($Attempt = 1; $Attempt -le $Retries; $Attempt++) {
        $Arguments = @($SshOptions) + @("root@$ServerIP", $Command)
        $LastResult = Invoke-NativeProcess -FilePath $SshPath -Arguments $Arguments -TimeoutSeconds $TimeoutSeconds

        if ($LastResult.ExitCode -eq 0) { return $LastResult }

        if (-not $Quiet) {
            $Text = ($LastResult.StdErr + ' ' + $LastResult.StdOut).Trim()
            Write-Warning "SSH attempt $Attempt/$Retries failed (exit $($LastResult.ExitCode)): $Text"
        }

        if ($Attempt -lt $Retries) {
            Start-Sleep -Seconds ([Math]::Min(15, 2 + $Attempt))
        }
    }

    $FinalText = ($LastResult.StdErr + "`n" + $LastResult.StdOut).Trim()
    throw "SSH command failed after $Retries attempts (exit $($LastResult.ExitCode)): $FinalText"
}

$RemoteScript = @'
#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

PROD='/root/Hamoon'
COMMIT='d0840677692c53bd2318904d77fc9c6b05047945'
RUN_ID="$(date -u +%Y%m%d_%H%M%S)"
STAGE="/root/hamoon-pricing-stage-${RUN_ID}"
BACKUP="/root/hamoon-pricing-backup-${RUN_ID}"
PATCH_FILE="/tmp/hamoon-pricing-${RUN_ID}.patch"

PATCH_FILES=(
  'Hetzner/hetzner-api.js'
  'index.js'
  'package.json'
  'scripts/reconcile-hetzner-billing-amounts.js'
  'scripts/validate-hetzner-pricing.js'
)

installed=0
apps_touched=0
success=0

restart_apps() (
  set +e
  pm2 restart dashboard-server --update-env >/dev/null 2>&1 || true
  sleep 7
  pm2 restart hamoonbot --update-env >/dev/null 2>&1 || true
  sleep 12
  pm2 save >/dev/null 2>&1 || true
)

health_snapshot() {
  local prefix="$1"
  local bot_pid dash_pid http
  bot_pid="$(pm2 pid hamoonbot 2>/dev/null | tr -d '\r\n' || true)"
  dash_pid="$(pm2 pid dashboard-server 2>/dev/null | tr -d '\r\n' || true)"
  http="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 http://127.0.0.1:3000/health || true)"
  echo "${prefix}_BOT_PID=${bot_pid}"
  echo "${prefix}_DASH_PID=${dash_pid}"
  echo "${prefix}_DASHBOARD_HTTP=${http}"
  [[ "$bot_pid" =~ ^[0-9]+$ ]] && [ "$bot_pid" -gt 0 ]
  [[ "$dash_pid" =~ ^[0-9]+$ ]] && [ "$dash_pid" -gt 0 ]
  [ "$http" = '200' ]
}

rollback() {
  set +e
  echo '===== AUTOMATIC PRICING DEPLOY ROLLBACK ====='

  if [ "$installed" -eq 1 ] && [ -f "$BACKUP/original-files.tar.gz" ]; then
    tar -xzf "$BACKUP/original-files.tar.gz" -C "$PROD"
    if [ -f "$BACKUP/absent-files.txt" ]; then
      while IFS= read -r relative; do
        [ -n "$relative" ] && rm -f "$PROD/$relative"
      done < "$BACKUP/absent-files.txt"
    fi
  fi

  if [ "$apps_touched" -eq 1 ] || [ "$installed" -eq 1 ]; then
    restart_apps
  fi

  local bot_pid dash_pid http
  bot_pid="$(pm2 pid hamoonbot 2>/dev/null | tr -d '\r\n' || true)"
  dash_pid="$(pm2 pid dashboard-server 2>/dev/null | tr -d '\r\n' || true)"
  http="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 http://127.0.0.1:3000/health || true)"
  echo "ROLLBACK_HAMOONBOT_PID=${bot_pid}"
  echo "ROLLBACK_DASHBOARD_PID=${dash_pid}"
  echo "ROLLBACK_DASHBOARD_HTTP=${http}"
  echo 'AUTOMATIC_PRICING_DEPLOY_ROLLBACK=COMPLETED'
}

cleanup() {
  rm -rf "$STAGE" "$PATCH_FILE" 2>/dev/null || true
}

on_exit() {
  local rc=$?
  trap - EXIT
  if [ "$rc" -ne 0 ] && [ "$success" -ne 1 ]; then
    rollback
  fi
  cleanup
  exit "$rc"
}
trap on_exit EXIT

cd "$PROD"

echo '===== HETZNER PRICING FIX SAFE DEPLOY ====='
echo "TARGET_COMMIT=$COMMIT"
echo "PRODUCTION=$PROD"

echo '===== PRE-DEPLOY HEALTH ====='
health_snapshot 'PRE'
echo 'PRE_DEPLOY_HEALTH=SUCCESS'

echo '===== VERIFY CURRENT v10 FEATURES ====='
count_fixed() {
  local file="$1"
  local text="$2"
  grep -F -c -- "$text" "$file" 2>/dev/null || true
}

V10_CLOUD_TRAFFIC_BEFORE="$(count_fixed "$PROD/cloud-api.js" 'getServerTraffic')"
V10_HETZNER_TRAFFIC_BEFORE="$(count_fixed "$PROD/Hetzner/hetzner-api.js" 'getServerTraffic')"
V10_BUTTON_BEFORE="$(count_fixed "$PROD/index.js" '📊 مصرف ترافیک')"
V10_PROVIDER_MISSING_BEFORE="$(count_fixed "$PROD/index.js" 'provider_missing')"

echo "V10_CLOUD_TRAFFIC_BEFORE=$V10_CLOUD_TRAFFIC_BEFORE"
echo "V10_HETZNER_TRAFFIC_BEFORE=$V10_HETZNER_TRAFFIC_BEFORE"
echo "V10_BUTTON_BEFORE=$V10_BUTTON_BEFORE"
echo "V10_PROVIDER_MISSING_BEFORE=$V10_PROVIDER_MISSING_BEFORE"

[ "$V10_CLOUD_TRAFFIC_BEFORE" -gt 0 ]
[ "$V10_HETZNER_TRAFFIC_BEFORE" -gt 0 ]
[ "$V10_BUTTON_BEFORE" -gt 0 ]
[ "$V10_PROVIDER_MISSING_BEFORE" -gt 0 ]
echo 'CURRENT_V10_FEATURES=VERIFIED'

echo '===== FETCH EXACT COMMIT WITHOUT PULL ====='
git rev-parse --is-inside-work-tree >/dev/null
if ! git fetch --no-tags origin "$COMMIT"; then
  git fetch --no-tags origin main
fi
git cat-file -e "${COMMIT}^{commit}"
RESOLVED_COMMIT="$(git rev-parse "$COMMIT")"
[ "$RESOLVED_COMMIT" = "$COMMIT" ]
echo "FETCHED_COMMIT=$RESOLVED_COMMIT"

git show --format= --binary "$COMMIT" -- "${PATCH_FILES[@]}" > "$PATCH_FILE"
[ -s "$PATCH_FILE" ]
sha256sum "$PATCH_FILE"
echo 'TARGET_PATCH=GENERATED'

echo '===== BACKUP CURRENT PRODUCTION FILES ====='
mkdir -p "$BACKUP"
: > "$BACKUP/absent-files.txt"
existing_files=()
for relative in "${PATCH_FILES[@]}"; do
  if [ -e "$PROD/$relative" ]; then
    existing_files+=("$relative")
  else
    echo "$relative" >> "$BACKUP/absent-files.txt"
  fi
done

tar -C "$PROD" -czf "$BACKUP/original-files.tar.gz" "${existing_files[@]}"
sha256sum "$BACKUP/original-files.tar.gz"
sha256sum "${existing_files[@]}" > "$BACKUP/original-hashes.txt"
echo "PRICING_DEPLOY_BACKUP=$BACKUP"
echo 'PRICING_DEPLOY_BACKUP=SUCCESS'

echo '===== CREATE ISOLATED STAGING FROM CURRENT PRODUCTION ====='
mkdir -p "$STAGE"
tar -C "$PROD" --exclude='./.git' --exclude='./node_modules' -cf - . | tar -C "$STAGE" -xf -
if [ -d "$PROD/node_modules" ]; then
  ln -s "$PROD/node_modules" "$STAGE/node_modules"
fi

cd "$STAGE"
if git apply --check "$PATCH_FILE"; then
  git apply "$PATCH_FILE"
  echo 'TARGET_PATCH_APPLIED_TO_STAGING=SUCCESS'
elif git apply --reverse --check "$PATCH_FILE"; then
  echo 'TARGET_PATCH_ALREADY_PRESENT_IN_STAGING=YES'
else
  echo 'ERROR: target commit patch does not apply cleanly to current production copy'
  exit 31
fi

echo '===== VERIFY v10 PRESERVATION IN STAGING ====='
V10_CLOUD_TRAFFIC_AFTER="$(count_fixed "$STAGE/cloud-api.js" 'getServerTraffic')"
V10_HETZNER_TRAFFIC_AFTER="$(count_fixed "$STAGE/Hetzner/hetzner-api.js" 'getServerTraffic')"
V10_BUTTON_AFTER="$(count_fixed "$STAGE/index.js" '📊 مصرف ترافیک')"
V10_PROVIDER_MISSING_AFTER="$(count_fixed "$STAGE/index.js" 'provider_missing')"

echo "V10_CLOUD_TRAFFIC_AFTER=$V10_CLOUD_TRAFFIC_AFTER"
echo "V10_HETZNER_TRAFFIC_AFTER=$V10_HETZNER_TRAFFIC_AFTER"
echo "V10_BUTTON_AFTER=$V10_BUTTON_AFTER"
echo "V10_PROVIDER_MISSING_AFTER=$V10_PROVIDER_MISSING_AFTER"

[ "$V10_CLOUD_TRAFFIC_AFTER" -ge "$V10_CLOUD_TRAFFIC_BEFORE" ]
[ "$V10_HETZNER_TRAFFIC_AFTER" -ge "$V10_HETZNER_TRAFFIC_BEFORE" ]
[ "$V10_BUTTON_AFTER" -ge "$V10_BUTTON_BEFORE" ]
[ "$V10_PROVIDER_MISSING_AFTER" -ge "$V10_PROVIDER_MISSING_BEFORE" ]
echo 'V10_PRESERVATION=SUCCESS'

echo '===== VERIFY TARGET PRICING CHANGES ====='
grep -Fq 'const serverTypeCache = new Map();' Hetzner/hetzner-api.js
grep -Fq 'function configuredPriceLocations' Hetzner/hetzner-api.js
grep -Fq 'function normalizeStoredCycleAmount' index.js
grep -Fq 'const amountForDb = finalPrice;' index.js
grep -Fq 'validate-hetzner-pricing' package.json
[ -f scripts/validate-hetzner-pricing.js ]
echo 'TARGET_PRICING_CHANGES=VERIFIED'

echo '===== STAGING STATIC AND REGRESSION TESTS ====='
node --check Hetzner/hetzner-api.js
node --check index.js
node --check scripts/reconcile-hetzner-billing-amounts.js
node --check scripts/validate-hetzner-pricing.js
node scripts/validate-hetzner-pricing.js
npm run validate:hetzner-lifecycle
npm run validate:provider-capabilities
if node -e "const p=require('./package.json'); process.exit(p.scripts && p.scripts['validate:production-patch'] ? 0 : 1)"; then
  npm run validate:production-patch
fi
echo 'PRICING_TESTS=SUCCESS'
echo 'RECONCILIATION_SCRIPT_NOT_EXECUTED=SUCCESS'

echo '===== INSTALL VERIFIED FILES ====='
cd "$PROD"
apps_touched=1
pm2 stop dashboard-server >/dev/null
pm2 stop hamoonbot >/dev/null
echo 'APPLICATIONS_STOPPED=SUCCESS'

installed=1
for relative in "${PATCH_FILES[@]}"; do
  install -D -m 0644 "$STAGE/$relative" "$PROD/$relative"
done
echo 'PRICING_FILES_INSTALLED=SUCCESS'

node --check "$PROD/Hetzner/hetzner-api.js"
node --check "$PROD/index.js"
node --check "$PROD/scripts/reconcile-hetzner-billing-amounts.js"
node --check "$PROD/scripts/validate-hetzner-pricing.js"
echo 'INSTALLED_NODE_CHECKS=SUCCESS'

restart_apps

echo '===== POST-DEPLOY HEALTH ====='
health_snapshot 'POST'
echo 'POST_DEPLOY_HEALTH=SUCCESS'

cd "$PROD"
node scripts/validate-hetzner-pricing.js
npm run validate:hetzner-lifecycle
npm run validate:provider-capabilities
echo 'INSTALLED_PRICING_TESTS=SUCCESS'

V10_CLOUD_TRAFFIC_FINAL="$(count_fixed "$PROD/cloud-api.js" 'getServerTraffic')"
V10_HETZNER_TRAFFIC_FINAL="$(count_fixed "$PROD/Hetzner/hetzner-api.js" 'getServerTraffic')"
V10_BUTTON_FINAL="$(count_fixed "$PROD/index.js" '📊 مصرف ترافیک')"
V10_PROVIDER_MISSING_FINAL="$(count_fixed "$PROD/index.js" 'provider_missing')"

[ "$V10_CLOUD_TRAFFIC_FINAL" -ge "$V10_CLOUD_TRAFFIC_BEFORE" ]
[ "$V10_HETZNER_TRAFFIC_FINAL" -ge "$V10_HETZNER_TRAFFIC_BEFORE" ]
[ "$V10_BUTTON_FINAL" -ge "$V10_BUTTON_BEFORE" ]
[ "$V10_PROVIDER_MISSING_FINAL" -ge "$V10_PROVIDER_MISSING_BEFORE" ]
echo 'FINAL_V10_PRESERVATION=SUCCESS'

sha256sum "${PATCH_FILES[@]}" > "$BACKUP/installed-hashes.txt"
printf '%s\n' "$COMMIT" > "$BACKUP/deployed-commit.txt"

echo 'FINAL_DASHBOARD_HTTP=200'
echo 'HAMOON_PRICING_D084_DEPLOY=SUCCESS'
echo 'HETZNER LOCATION PRICING FIX DEPLOYMENT COMPLETED'
success=1
'@

$RemoteBytes = [System.Text.Encoding]::UTF8.GetBytes($RemoteScript + "`n")
$Hasher = [System.Security.Cryptography.SHA256]::Create()
try {
    $RemoteSha256 = ([BitConverter]::ToString($Hasher.ComputeHash($RemoteBytes))).Replace('-', '').ToLowerInvariant()
}
finally {
    $Hasher.Dispose()
}
$RemoteBase64 = [Convert]::ToBase64String($RemoteBytes)

Write-Host ''
Write-Host '===== BUILD SAFE PRICING DEPLOYMENT =====' -ForegroundColor Cyan
Write-Host "TARGET_COMMIT=$TargetCommit"
Write-Host "REMOTE_SCRIPT_BYTES=$($RemoteBytes.Length)"
Write-Host "REMOTE_SCRIPT_SHA256=$RemoteSha256"
Write-Host 'SAFE_PRICING_DEPLOYMENT=GENERATED' -ForegroundColor Green

Write-Host ''
Write-Host '===== READ-ONLY PRODUCTION PREFLIGHT =====' -ForegroundColor Cyan
$PreflightCommand = "cd /root/Hamoon && test -d .git && printf 'HEAD=' && git rev-parse HEAD && printf 'BOT_PID=' && pm2 pid hamoonbot && printf 'DASH_PID=' && pm2 pid dashboard-server && printf 'HTTP=' && curl -sS -o /dev/null -w '%{http_code}' --max-time 15 http://127.0.0.1:3000/health && echo && grep -q 'getServerTraffic' cloud-api.js && grep -q 'getServerTraffic' Hetzner/hetzner-api.js && grep -q 'provider_missing' index.js && echo CURRENT_V10_PREFLIGHT=SUCCESS"
$Preflight = Invoke-HamoonSsh -Command $PreflightCommand -Retries 8
Write-Host $Preflight.StdOut.Trim()
if ($Preflight.StdOut -notlike '*HTTP=200*' -or $Preflight.StdOut -notlike '*CURRENT_V10_PREFLIGHT=SUCCESS*') {
    throw 'Production preflight failed. Nothing was uploaded or changed.'
}
Write-Host 'PRICING_DEPLOY_PRODUCTION_PREFLIGHT=SUCCESS' -ForegroundColor Green

$UploadId = "$(Get-Date -Format 'yyyyMMddHHmmss')-$PID"
$ChunkDirectory = "/tmp/hamoon-pricing-d084-$UploadId.chunks"
$RemoteBase64Path = "/tmp/hamoon-pricing-d084-$UploadId.b64"
$RemoteScriptPath = "/tmp/hamoon-pricing-d084-$UploadId.sh"
$RemoteStatusPath = "/tmp/hamoon-pricing-d084-$UploadId.status"
$RemotePidPath = "/tmp/hamoon-pricing-d084-$UploadId.pid"
$RemoteLogPath = "/root/hamoon-pricing-d084-$UploadId.log"
$ChunkSize = 768
$ChunkCount = [int][Math]::Ceiling($RemoteBase64.Length / $ChunkSize)

Write-Host ''
Write-Host '===== IDEMPOTENT CHUNKED SSH UPLOAD =====' -ForegroundColor Cyan
Write-Host "REMOTE_CHUNK_COUNT=$ChunkCount"

$InitializeCommand = "umask 077; rm -rf '$ChunkDirectory'; mkdir -m 700 '$ChunkDirectory'; rm -f '$RemoteBase64Path' '$RemoteScriptPath' '$RemoteStatusPath' '$RemotePidPath'"
Invoke-HamoonSsh -Command $InitializeCommand -Retries 10 | Out-Null

for ($Offset = 0; $Offset -lt $RemoteBase64.Length; $Offset += $ChunkSize) {
    $Length = [Math]::Min($ChunkSize, $RemoteBase64.Length - $Offset)
    $Chunk = $RemoteBase64.Substring($Offset, $Length)
    $Number = [int]([Math]::Floor($Offset / $ChunkSize) + 1)
    $FileNumber = $Number.ToString('D6')
    $ChunkPath = "$ChunkDirectory/chunk-$FileNumber"

    Invoke-HamoonSsh -Command "umask 077; printf '%s' '$Chunk' > '$ChunkPath'" -Retries 12 -Quiet | Out-Null

    if (($Number % 5) -eq 0 -or $Number -eq $ChunkCount) {
        Write-Host "REMOTE_CHUNK_PROGRESS=$Number/$ChunkCount"
    }
    Start-Sleep -Milliseconds 650
}

$VerifyCommand = "cat '$ChunkDirectory'/chunk-* > '$RemoteBase64Path' && base64 -d '$RemoteBase64Path' > '$RemoteScriptPath' && chmod 700 '$RemoteScriptPath' && echo '$RemoteSha256  $RemoteScriptPath' | sha256sum -c - >/dev/null && bash -n '$RemoteScriptPath' && echo REMOTE_PRICING_UPLOAD_VERIFY=SUCCESS"
$VerifyResult = Invoke-HamoonSsh -Command $VerifyCommand -Retries 10
Write-Host $VerifyResult.StdOut.Trim()
if ($VerifyResult.StdOut -notlike '*REMOTE_PRICING_UPLOAD_VERIFY=SUCCESS*') {
    throw 'Remote upload verification failed. Deployment was not launched.'
}

Write-Host ''
Write-Host '===== IDEMPOTENT DETACHED PRICING DEPLOYMENT =====' -ForegroundColor Cyan
$LaunchCommand = "if [ -f '$RemoteStatusPath' ]; then echo STATUS=`$(cat '$RemoteStatusPath'); elif [ -f '$RemotePidPath' ] && kill -0 `$(cat '$RemotePidPath') 2>/dev/null; then echo RUNNING=`$(cat '$RemotePidPath'); else rm -f '$RemoteLogPath' '$RemoteStatusPath' '$RemotePidPath'; nohup sh -c 'bash $RemoteScriptPath >$RemoteLogPath 2>&1; echo `$? >$RemoteStatusPath' </dev/null >/dev/null 2>&1 & echo `$! >'$RemotePidPath'; echo STARTED=`$(cat '$RemotePidPath'); fi"
$LaunchResult = Invoke-HamoonSsh -Command $LaunchCommand -Retries 10
Write-Host $LaunchResult.StdOut.Trim()
Write-Host "REMOTE_DEPLOY_LOG=$RemoteLogPath"
Write-Host "REMOTE_DEPLOY_STATUS_FILE=$RemoteStatusPath"

$Deadline = (Get-Date).AddMinutes(30)
$RemoteExitCode = $null
while ((Get-Date) -lt $Deadline) {
    Start-Sleep -Seconds 8
    try {
        $StatusResult = Invoke-HamoonSsh -Command "if [ -f '$RemoteStatusPath' ]; then cat '$RemoteStatusPath'; else echo RUNNING; fi" -Retries 5 -Quiet
        $StatusText = $StatusResult.StdOut.Trim()
    }
    catch {
        Write-Warning $_.Exception.Message
        continue
    }

    if ($StatusText -match '^-?\d+$') {
        $RemoteExitCode = [int]$StatusText
        break
    }
    Write-Host 'REMOTE_DEPLOY_STATUS=RUNNING'
}

if ($null -eq $RemoteExitCode) {
    throw "Remote deployment is still running or status could not be read. Do not rerun. Log: $RemoteLogPath"
}

Write-Host "REMOTE_DEPLOY_EXIT_CODE=$RemoteExitCode"
$Markers = Invoke-HamoonSsh -Command "grep -E 'SUCCESS|FAILED|ROLLBACK|ERROR|HTTP|COMPLETED|PRESERVATION|INSTALLED|TARGET_PATCH' '$RemoteLogPath' | tail -n 260 || true" -Retries 8
Write-Host ''
Write-Host '===== REMOTE DEPLOYMENT MARKERS =====' -ForegroundColor Cyan
Write-Host $Markers.StdOut.Trim()

if ($RemoteExitCode -ne 0) {
    $Tail = Invoke-HamoonSsh -Command "tail -n 220 '$RemoteLogPath'" -Retries 8
    Write-Host ''
    Write-Host '===== REMOTE FAILURE LOG TAIL =====' -ForegroundColor Red
    Write-Host $Tail.StdOut
    throw "Pricing deployment failed with exit code $RemoteExitCode. Review rollback markers above."
}

$Required = Invoke-HamoonSsh -Command "grep -q 'HAMOON_PRICING_D084_DEPLOY=SUCCESS' '$RemoteLogPath' && grep -q 'V10_PRESERVATION=SUCCESS' '$RemoteLogPath' && grep -q 'FINAL_V10_PRESERVATION=SUCCESS' '$RemoteLogPath' && grep -q 'PRICING_TESTS=SUCCESS' '$RemoteLogPath' && grep -q 'INSTALLED_PRICING_TESTS=SUCCESS' '$RemoteLogPath' && grep -q 'FINAL_DASHBOARD_HTTP=200' '$RemoteLogPath' && echo PRICING_REQUIRED_MARKERS=SUCCESS" -Retries 8
Write-Host $Required.StdOut.Trim()
if ($Required.StdOut -notlike '*PRICING_REQUIRED_MARKERS=SUCCESS*') {
    throw 'Remote process exited zero but required success markers are missing. Do not rerun.'
}

$FinalCheck = Invoke-HamoonSsh -Command "cd /root/Hamoon && node --check index.js && node --check Hetzner/hetzner-api.js && printf 'FINAL_BOT_PID=' && pm2 pid hamoonbot && printf 'FINAL_DASH_PID=' && pm2 pid dashboard-server && printf 'FINAL_HTTP=' && curl -sS -o /dev/null -w '%{http_code}' --max-time 15 http://127.0.0.1:3000/health && echo" -Retries 8
Write-Host $FinalCheck.StdOut.Trim()
if ($FinalCheck.StdOut -notlike '*FINAL_HTTP=200*') {
    throw "Final service verification failed. Do not rerun. Log: $RemoteLogPath"
}

Invoke-HamoonSsh -Command "rm -rf '$ChunkDirectory'; rm -f '$RemoteBase64Path' '$RemoteScriptPath' '$RemoteStatusPath' '$RemotePidPath'" -Retries 6 -Quiet | Out-Null

Write-Host ''
Write-Host 'PRICING_DEPLOY_REMOTE_VERIFICATION=SUCCESS' -ForegroundColor Green
Write-Host 'HETZNER LOCATION PRICING SAFE DEPLOYMENT COMPLETED' -ForegroundColor Green
Write-Host "REMOTE_DEPLOY_LOG=$RemoteLogPath"
