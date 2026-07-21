$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$ServerIP = '91.107.241.4'
$KeyPath = "$env:USERPROFILE\.ssh\hamoon-rescue-recovery-20260718-224538"
$V1Path = "$env:USERPROFILE\Downloads\hamoon-hetzner-traffic-provider404-deploy-20260721-v1.ps1"

$ExpectedHashes = @{
    'index.js' = '92c6f27376dc23270582723ed3695c5c82c2821309dccb0c84cf0fdee273ff41'
    'cloud-api.js' = 'd888aa46d72a35e7d95990a629ddb9b53969d30cf38428839aeba13a3ba096b2'
    'Hetzner/hetzner-api.js' = '430191e2ae4488ff328739e964b32d02e3e2ce5ef876dc6a13ac43f1600fe1a0'
}

foreach ($Path in @($KeyPath, $V1Path)) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Required file not found: $Path"
    }
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

    if ($Value.Length -eq 0) {
        return '""'
    }

    if ($Value -notmatch '[\s"]') {
        return $Value
    }

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

        $StdOut = $StdOutTask.GetAwaiter().GetResult()
        $StdErr = $StdErrTask.GetAwaiter().GetResult()

        return [pscustomobject]@{
            ExitCode = $Process.ExitCode
            StdOut = $StdOut
            StdErr = $StdErr
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

        if ($LastResult.ExitCode -eq 0) {
            return $LastResult
        }

        if (-not $Quiet) {
            $ErrorText = ($LastResult.StdErr + ' ' + $LastResult.StdOut).Trim()
            Write-Warning "SSH attempt $Attempt/$Retries failed (exit $($LastResult.ExitCode)): $ErrorText"
        }

        if ($Attempt -lt $Retries) {
            Start-Sleep -Seconds ([Math]::Min(15, 2 + $Attempt))
        }
    }

    $FinalText = ($LastResult.StdErr + "`n" + $LastResult.StdOut).Trim()
    throw "SSH command failed after $Retries attempts (exit $($LastResult.ExitCode)): $FinalText"
}

function Replace-OneRegex {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][string]$Pattern,
        [Parameter(Mandatory = $true)][string]$Replacement,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $Regex = New-Object System.Text.RegularExpressions.Regex(
        $Pattern,
        [System.Text.RegularExpressions.RegexOptions]::Singleline
    )
    $Matches = $Regex.Matches($Text)
    if ($Matches.Count -ne 1) {
        throw "$Name expected exactly one match; found $($Matches.Count)."
    }

    return $Regex.Replace(
        $Text,
        [System.Text.RegularExpressions.MatchEvaluator]{ param($Match) $Replacement },
        1
    )
}

Write-Host ''
Write-Host '===== BUILD CLEAN REMOTE HOTFIX v10 =====' -ForegroundColor Cyan

$V1Source = [System.IO.File]::ReadAllText($V1Path)
$RemotePattern = '(?s)\$RemoteScript = @''\r?\n(?<body>.*?)\r?\n''@\r?\n\r?\ntry \{'
$RemoteMatch = [System.Text.RegularExpressions.Regex]::Match($V1Source, $RemotePattern)
if (-not $RemoteMatch.Success) {
    throw 'Could not extract the original remote deployment body from v1.'
}

$RemoteScript = ($RemoteMatch.Groups['body'].Value -replace "`r`n", "`n")

$RestartPattern = 'restart_apps\(\) \{\n  set \+e\n  pm2 restart dashboard-server --update-env >/dev/null 2>&1 \|\| true\n  sleep 7\n  pm2 restart hamoonbot --update-env >/dev/null 2>&1 \|\| true\n  sleep 12\n  pm2 save >/dev/null 2>&1 \|\| true\n\}'
$RestartReplacement = @'
restart_apps() (
  set +e
  pm2 restart dashboard-server --update-env >/dev/null 2>&1 || true
  sleep 7
  pm2 restart hamoonbot --update-env >/dev/null 2>&1 || true
  sleep 12
  pm2 save >/dev/null 2>&1 || true
)
'@.TrimEnd("`r", "`n")
$RemoteScript = Replace-OneRegex $RemoteScript $RestartPattern $RestartReplacement 'restart_apps safety patch'

$CloudPattern = "if 'getServerTraffic:' not in cloud:\n    lines = cloud\.splitlines\(True\).*?    cloud = ''\.join\(lines\)"
$CloudReplacement = @'
if 'getServerTraffic:' not in cloud:
    export_start = cloud.find('module.exports = {')
    if export_start < 0:
        raise SystemExit('CLOUD_EXPORT_BLOCK_NOT_FOUND')

    export_end = cloud.find('\n};', export_start)
    if export_end < 0:
        raise SystemExit('CLOUD_EXPORT_END_NOT_FOUND')

    export_block = cloud[export_start:export_end]
    match = re.search(
        r'(?m)^(?P<indent>\s*)getServer\s*:.*\n',
        export_block
    )
    if not match:
        raise SystemExit('CLOUD_GET_SERVER_EXPORT_NOT_FOUND')

    indent = match.group('indent')
    insertion = (
        indent
        + "getServerTraffic:      (dc, ...a) => pick(dc).getServerTraffic ? pick(dc).getServerTraffic(dc, ...a) : Promise.reject(new Error('traffic not supported')),\n"
    )
    export_block = export_block[:match.end()] + insertion + export_block[match.end():]
    cloud = cloud[:export_start] + export_block + cloud[export_end:]
'@.TrimEnd("`r", "`n")
$RemoteScript = Replace-OneRegex $RemoteScript $CloudPattern $CloudReplacement 'cloud-api export patch'

$ManagementPattern = 'old_catch = """.*?index = index\[:management_start\] \+ management \+ index\[management_end:\]'
$ManagementReplacement = @'
if 'MANAGEMENT_PROVIDER404_GUARD_V10' not in management:
    provider_call = re.compile(
        r"(?P<indent>^[ \t]*)const\s+srv\s*=\s*await\s+openstackApi\.getServer\(dcConfig,\s*tok,\s*serverId\);",
        re.MULTILINE
    )
    match = provider_call.search(management)
    if not match:
        raise SystemExit('MANAGEMENT_PROVIDER_CALL_NOT_FOUND')

    indent = match.group('indent')
    guarded = f'''{indent}// MANAGEMENT_PROVIDER404_GUARD_V10
{indent}let srv;
{indent}try {{
{indent}  srv = await openstackApi.getServer(dcConfig, tok, serverId);
{indent}}} catch (providerError) {{
{indent}  if (isHetznerDc(dcConfig) && isHetznerProviderNotFound(providerError)) {{
{indent}    await markHetznerProviderMissing(userId, serverId, dcConfig);
{indent}    return sendMessage(
{indent}      chatId,
{indent}      '⚠️ این سرور در زیرساخت ارائه‌دهنده پیدا نشد. محاسبه هزینه و تمدید خودکار آن متوقف شد و موضوع نیازمند بررسی پشتیبانی است.'
{indent}    );
{indent}  }}
{indent}  throw providerError;
{indent}}}'''

    management = management[:match.start()] + guarded + management[match.end():]

index = index[:management_start] + management + index[management_end:]
'@.TrimEnd("`r", "`n")
$RemoteScript = Replace-OneRegex $RemoteScript $ManagementPattern $ManagementReplacement 'management provider-404 patch'

$RemoteScript = $RemoteScript.Replace(
    '[BILLING_HETZNER_PREFLIGHT_WARNING]',
    '[BILLING_HETZNER_PREFLIGHT_SKIP]'
)

$BillingPattern = "(console\.warn\('\[BILLING_HETZNER_PREFLIGHT_SKIP\]', \{.*?message: providerError\?\.message\s*\}\);)"
$BillingRegex = New-Object System.Text.RegularExpressions.Regex(
    $BillingPattern,
    [System.Text.RegularExpressions.RegexOptions]::Singleline
)
$BillingMatches = $BillingRegex.Matches($RemoteScript)
if ($BillingMatches.Count -ne 1) {
    throw "billing fail-closed patch expected exactly one match; found $($BillingMatches.Count)."
}
$RemoteScript = $BillingRegex.Replace(
    $RemoteScript,
    [System.Text.RegularExpressions.MatchEvaluator]{
        param($Match)
        $Match.Groups[1].Value + "`n        continue;"
    },
    1
)

$PostHealthPattern = 'if \[ "\$POST_BOT" != "online" \] \|\| \[ "\$POST_DASH" != "online" \] \|\| \[ "\$POST_HTTP" != "200" \]; then\n  echo "ERROR: service health failed after hotfix"\n  exit 1\nfi'
$PostHealthReplacement = @'
if [ "$POST_BOT" != "online" ] || [ "$POST_DASH" != "online" ] || [ "$POST_HTTP" != "200" ]; then
  echo "ERROR: service health failed after hotfix"
  false
fi
'@.TrimEnd("`r", "`n")
$RemoteScript = Replace-OneRegex $RemoteScript $PostHealthPattern $PostHealthReplacement 'post-health rollback trigger'

$ReconNeedle = @'
      await db.pool.query(`
        UPDATE purchases
'@.TrimEnd("`r", "`n")
$ReconCount = ([regex]::Matches($RemoteScript, [regex]::Escape($ReconNeedle))).Count
if ($ReconCount -ne 1) {
    throw "provider-404 reconciliation audit patch expected exactly one match; found $ReconCount."
}
$ReconReplacement = @'
      console.warn('[PROVIDER404_RECON_AUDIT_ONLY]', {
        server_id: String(row.server_id),
        telegram_id: String(row.telegram_id),
        datacenter: String(row.datacenter),
        database_changed: false
      });
      continue;

      await db.pool.query(`
        UPDATE purchases
'@.TrimEnd("`r", "`n")
$RemoteScript = $RemoteScript.Replace($ReconNeedle, $ReconReplacement)
$RemoteScript = $RemoteScript.Replace(
    'RECONCILE CURRENT HETZNER 404 RECORDS',
    'AUDIT CURRENT HETZNER 404 RECORDS (NO DB CHANGES)'
)
$RemoteScript = $RemoteScript.Replace(
    'PROVIDER404_RECONCILIATION=SUCCESS',
    'PROVIDER404_AUDIT_ONLY=SUCCESS'
)

$RemoteScript = $RemoteScript.Replace('HOTFIX v1', 'HOTFIX v10')
$RemoteScript = $RemoteScript.Replace(
    'HAMOON_HETZNER_TRAFFIC_PROVIDER404_V1=SUCCESS',
    'HAMOON_HETZNER_TRAFFIC_PROVIDER404_V10=SUCCESS'
)
$RemoteScript = $RemoteScript.Replace(
    'TRAFFIC_PROVIDER404_STAGING_TESTS=SUCCESS',
    'TRAFFIC_PROVIDER404_V10_STAGING_TESTS=SUCCESS'
)
$RemoteScript = $RemoteScript.Replace(
    'TRAFFIC_PROVIDER404_FILES=INSTALLED',
    'TRAFFIC_PROVIDER404_V10_FILES=INSTALLED'
)
$RemoteScript = $RemoteScript.Replace(
    'INSTALLED_TRAFFIC_PROVIDER404_TESTS=SUCCESS',
    'INSTALLED_TRAFFIC_PROVIDER404_V10_TESTS=SUCCESS'
)

foreach ($Marker in @(
    'restart_apps() (',
    'MANAGEMENT_PROVIDER404_GUARD_V10',
    'CLOUD_EXPORT_BLOCK_NOT_FOUND',
    '[BILLING_HETZNER_PREFLIGHT_SKIP]',
    'PROVIDER404_AUDIT_ONLY=SUCCESS',
    'HAMOON_HETZNER_TRAFFIC_PROVIDER404_V10=SUCCESS'
)) {
    if (-not $RemoteScript.Contains($Marker)) {
        throw "Generated v10 remote script is missing marker: $Marker"
    }
}

$RemoteBytes = [System.Text.Encoding]::UTF8.GetBytes($RemoteScript + "`n")
$Hasher = [System.Security.Cryptography.SHA256]::Create()
try {
    $RemoteSha256 = ([BitConverter]::ToString($Hasher.ComputeHash($RemoteBytes))).Replace('-', '').ToLowerInvariant()
}
finally {
    $Hasher.Dispose()
}
$RemoteBase64 = [Convert]::ToBase64String($RemoteBytes)

Write-Host "REMOTE_SCRIPT_BYTES=$($RemoteBytes.Length)"
Write-Host "REMOTE_SCRIPT_SHA256=$RemoteSha256"
Write-Host 'CLEAN_REMOTE_HOTFIX_V10=GENERATED' -ForegroundColor Green

Write-Host ''
Write-Host '===== READ-ONLY PRODUCTION PREFLIGHT =====' -ForegroundColor Cyan

$HashResult = Invoke-HamoonSsh -Command 'cd /root/Hamoon && sha256sum index.js cloud-api.js Hetzner/hetzner-api.js' -Retries 8
$HashText = $HashResult.StdOut.Trim()
Write-Host $HashText
foreach ($Entry in $ExpectedHashes.GetEnumerator()) {
    $ExpectedLine = "$($Entry.Value)  $($Entry.Key)"
    if ($HashText -notlike "*$ExpectedLine*") {
        throw "Production hash mismatch for $($Entry.Key). Nothing was uploaded or changed."
    }
}

$BotPidResult = Invoke-HamoonSsh -Command 'pm2 pid hamoonbot' -Retries 8
$DashPidResult = Invoke-HamoonSsh -Command 'pm2 pid dashboard-server' -Retries 8
$HealthResult = Invoke-HamoonSsh -Command "curl -sS -o /dev/null -w '%{http_code}' --max-time 15 http://127.0.0.1:3000/health" -Retries 8

$BotPid = $BotPidResult.StdOut.Trim()
$DashPid = $DashPidResult.StdOut.Trim()
$Health = $HealthResult.StdOut.Trim()

Write-Host "BOT_PID=$BotPid"
Write-Host "DASH_PID=$DashPid"
Write-Host "HTTP=$Health"

if ($BotPid -notmatch '^\d+$' -or [int64]$BotPid -le 0) {
    throw 'hamoonbot is not running. Deployment stopped before upload.'
}
if ($DashPid -notmatch '^\d+$' -or [int64]$DashPid -le 0) {
    throw 'dashboard-server is not running. Deployment stopped before upload.'
}
if ($Health -ne '200') {
    throw 'Dashboard health is not HTTP 200. Deployment stopped before upload.'
}

Write-Host 'FINAL_V10_PRODUCTION_PREFLIGHT=SUCCESS' -ForegroundColor Green

$UploadId = "$(Get-Date -Format 'yyyyMMddHHmmss')-$PID"
$ChunkDirectory = "/tmp/hamoon-traffic-provider404-v10-$UploadId.chunks"
$RemoteBase64Path = "/tmp/hamoon-traffic-provider404-v10-$UploadId.b64"
$RemoteScriptPath = "/tmp/hamoon-traffic-provider404-v10-$UploadId.sh"
$RemoteStatusPath = "/tmp/hamoon-traffic-provider404-v10-$UploadId.status"
$RemotePidPath = "/tmp/hamoon-traffic-provider404-v10-$UploadId.pid"
$RemoteLogPath = "/root/hamoon-traffic-provider404-v10-$UploadId.log"
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

$VerifyCommand = "cat '$ChunkDirectory'/chunk-* > '$RemoteBase64Path' && base64 -d '$RemoteBase64Path' > '$RemoteScriptPath' && chmod 700 '$RemoteScriptPath' && echo '$RemoteSha256  $RemoteScriptPath' | sha256sum -c - >/dev/null && echo REMOTE_V10_UPLOAD_VERIFY=SUCCESS"
$VerifyResult = Invoke-HamoonSsh -Command $VerifyCommand -Retries 10
Write-Host $VerifyResult.StdOut.Trim()
if ($VerifyResult.StdOut -notlike '*REMOTE_V10_UPLOAD_VERIFY=SUCCESS*') {
    throw 'Remote upload SHA256 verification failed. Deployment was not launched.'
}

Write-Host ''
Write-Host '===== IDEMPOTENT DETACHED REMOTE DEPLOYMENT =====' -ForegroundColor Cyan

$LaunchCommand = "if [ -f '$RemoteStatusPath' ]; then echo STATUS=`$(cat '$RemoteStatusPath'); elif [ -f '$RemotePidPath' ] && kill -0 `$(cat '$RemotePidPath') 2>/dev/null; then echo RUNNING=`$(cat '$RemotePidPath'); else rm -f '$RemoteLogPath' '$RemoteStatusPath' '$RemotePidPath'; nohup sh -c 'bash $RemoteScriptPath >$RemoteLogPath 2>&1; echo `$? >$RemoteStatusPath' </dev/null >/dev/null 2>&1 & echo `$! >'$RemotePidPath'; echo STARTED=`$(cat '$RemotePidPath'); fi"
$LaunchResult = Invoke-HamoonSsh -Command $LaunchCommand -Retries 10
Write-Host $LaunchResult.StdOut.Trim()

$Deadline = (Get-Date).AddMinutes(25)
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
    Write-Host "REMOTE_DEPLOY_LOG=$RemoteLogPath"
    throw 'Remote deployment is still running or its status could not be read. Do not rerun before checking the log.'
}

Write-Host "REMOTE_DEPLOY_EXIT_CODE=$RemoteExitCode"
Write-Host "REMOTE_DEPLOY_LOG=$RemoteLogPath"

$MarkerResult = Invoke-HamoonSsh -Command "grep -E 'SUCCESS|FAILED|ROLLBACK|ERROR|FINAL_DASHBOARD_HTTP|POST_HAMOONBOT_STATUS|POST_DASHBOARD_SERVER_STATUS|COMPLETED|AUDIT_ONLY' '$RemoteLogPath' | tail -n 180 || true" -Retries 8
Write-Host ''
Write-Host '===== REMOTE DEPLOYMENT MARKERS =====' -ForegroundColor Cyan
Write-Host $MarkerResult.StdOut.Trim()

if ($RemoteExitCode -ne 0) {
    $TailResult = Invoke-HamoonSsh -Command "tail -n 140 '$RemoteLogPath'" -Retries 8
    Write-Host ''
    Write-Host '===== REMOTE FAILURE LOG TAIL =====' -ForegroundColor Red
    Write-Host $TailResult.StdOut
    throw "Remote deployment failed with exit code $RemoteExitCode. Review rollback markers above."
}

$SuccessMarkerResult = Invoke-HamoonSsh -Command "grep -q 'HAMOON_HETZNER_TRAFFIC_PROVIDER404_V10=SUCCESS' '$RemoteLogPath' && grep -q 'FINAL_DASHBOARD_HTTP=200' '$RemoteLogPath' && echo FINAL_V10_LOG_MARKERS=SUCCESS" -Retries 8
if ($SuccessMarkerResult.StdOut -notlike '*FINAL_V10_LOG_MARKERS=SUCCESS*') {
    throw 'Remote process exited zero but required success markers are missing.'
}

$SyntaxResult = Invoke-HamoonSsh -Command 'cd /root/Hamoon && node --check index.js && node --check cloud-api.js && node --check Hetzner/hetzner-api.js && echo FINAL_V10_NODE_CHECKS=SUCCESS' -Retries 8
Write-Host $SyntaxResult.StdOut.Trim()

$FinalBotPidResult = Invoke-HamoonSsh -Command 'pm2 pid hamoonbot' -Retries 8
$FinalDashPidResult = Invoke-HamoonSsh -Command 'pm2 pid dashboard-server' -Retries 8
$FinalHealthResult = Invoke-HamoonSsh -Command "curl -sS -o /dev/null -w '%{http_code}' --max-time 15 http://127.0.0.1:3000/health" -Retries 8

$FinalBotPid = $FinalBotPidResult.StdOut.Trim()
$FinalDashPid = $FinalDashPidResult.StdOut.Trim()
$FinalHealth = $FinalHealthResult.StdOut.Trim()

Write-Host "FINAL_BOT_PID=$FinalBotPid"
Write-Host "FINAL_DASH_PID=$FinalDashPid"
Write-Host "FINAL_HTTP=$FinalHealth"

if ($FinalBotPid -notmatch '^\d+$' -or [int64]$FinalBotPid -le 0 -or
    $FinalDashPid -notmatch '^\d+$' -or [int64]$FinalDashPid -le 0 -or
    $FinalHealth -ne '200') {
    throw 'Final service verification failed. Do not rerun; inspect the remote deployment log.'
}

Invoke-HamoonSsh -Command "rm -rf '$ChunkDirectory'; rm -f '$RemoteBase64Path' '$RemoteScriptPath' '$RemoteStatusPath' '$RemotePidPath'" -Retries 6 -Quiet | Out-Null

Write-Host ''
Write-Host 'FINAL_V10_REMOTE_VERIFICATION=SUCCESS' -ForegroundColor Green
Write-Host 'CLEAN_CHUNKED_SSH_TRANSPORT_V10=SUCCESS' -ForegroundColor Green
Write-Host 'HETZNER TRAFFIC + PROVIDER-404 FINAL CLEAN v10 DEPLOYMENT COMPLETED' -ForegroundColor Green
Write-Host "REMOTE_DEPLOY_LOG=$RemoteLogPath"
