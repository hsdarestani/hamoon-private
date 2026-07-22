$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$ServerIP = '91.107.241.4'
$KeyPath = "$env:USERPROFILE\.ssh\hamoon-rescue-recovery-20260718-224538"

$RemoteScriptPath = '/tmp/hamoon-traffic-provider404-v10-20260721231819-11008.sh'
$FailedStatusPath = '/tmp/hamoon-traffic-provider404-v10-20260721231819-11008.status'
$FailedLogPath = '/root/hamoon-traffic-provider404-v10-20260721231819-11008.log'
$ExpectedFailedScriptSha256 = '37b76d6beb279cd73b3041256ed73fad427fbcc3e013805cf68ec5e550c18452'

$ExpectedHashes = @{
    'index.js' = '92c6f27376dc23270582723ed3695c5c82c2821309dccb0c84cf0fdee273ff41'
    'cloud-api.js' = 'd888aa46d72a35e7d95990a629ddb9b53969d30cf38428839aeba13a3ba096b2'
    'Hetzner/hetzner-api.js' = '430191e2ae4488ff328739e964b32d02e3e2ce5ef876dc6a13ac43f1600fe1a0'
}

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

Write-Host ''
Write-Host '===== VERIFY FAILED v10 AND CURRENT PRODUCTION =====' -ForegroundColor Cyan

$RemoteStateCommand = "test -f '$RemoteScriptPath' && test -f '$FailedStatusPath' && test -f '$FailedLogPath' && printf 'FAILED_STATUS=' && cat '$FailedStatusPath' && echo && sha256sum '$RemoteScriptPath' && grep -q 'AUTOMATIC_TRAFFIC_PROVIDER404_ROLLBACK=COMPLETED' '$FailedLogPath' && grep -q 'SyntaxError: Unexpected token' '$FailedLogPath' && echo FAILED_V10_FORENSICS=VERIFIED"
$RemoteState = Invoke-HamoonSsh -Command $RemoteStateCommand -Retries 8
Write-Host $RemoteState.StdOut.Trim()

if ($RemoteState.StdOut -notlike '*FAILED_STATUS=1*' -or
    $RemoteState.StdOut -notlike "*$ExpectedFailedScriptSha256  $RemoteScriptPath*" -or
    $RemoteState.StdOut -notlike '*FAILED_V10_FORENSICS=VERIFIED*') {
    throw 'The failed v10 artifacts do not match the verified rollback run. Nothing was changed.'
}

$HashResult = Invoke-HamoonSsh -Command 'cd /root/Hamoon && sha256sum index.js cloud-api.js Hetzner/hetzner-api.js' -Retries 8
$HashText = $HashResult.StdOut.Trim()
Write-Host $HashText
foreach ($Entry in $ExpectedHashes.GetEnumerator()) {
    $ExpectedLine = "$($Entry.Value)  $($Entry.Key)"
    if ($HashText -notlike "*$ExpectedLine*") {
        throw "Production hash mismatch for $($Entry.Key). Resume aborted before modifying the temporary script."
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

if ($BotPid -notmatch '^\d+$' -or [int64]$BotPid -le 0 -or
    $DashPid -notmatch '^\d+$' -or [int64]$DashPid -le 0 -or
    $Health -ne '200') {
    throw 'Production is not healthy. Resume aborted before modifying the temporary script.'
}

Write-Host 'FAILED_V10_PROCESS=FINISHED'
Write-Host 'V10_RESUME_PREFLIGHT=SUCCESS' -ForegroundColor Green

Write-Host ''
Write-Host '===== PATCH ONLY THE FAILED TEMPORARY v10 SCRIPT =====' -ForegroundColor Cyan

$RemotePatcher = @'
from pathlib import Path
import re
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding='utf-8')
marker = 'CLOUD_EXPORT_MULTILINE_FIX_V10R1'

if marker in text:
    print('REMOTE_V10_CLOUD_FIX=ALREADY_APPLIED')
    raise SystemExit(0)

pattern = re.compile(
    r"if 'getServerTraffic:' not in cloud:\n"
    r"    export_start = cloud\.find\('module\.exports = \{'\)\n"
    r".*?"
    r"    cloud = cloud\[:export_start\] \+ export_block \+ cloud\[export_end:\]",
    re.DOTALL,
)

replacement = r'''if 'getServerTraffic:' not in cloud:
    # CLOUD_EXPORT_MULTILINE_FIX_V10R1
    export_start = cloud.find('module.exports = {')
    if export_start < 0:
        raise SystemExit('CLOUD_EXPORT_BLOCK_NOT_FOUND')

    export_end = cloud.find('\n};', export_start)
    if export_end < 0:
        raise SystemExit('CLOUD_EXPORT_END_NOT_FOUND')

    export_block = cloud[export_start:export_end]
    get_server_anchor = """    getServer: (dc, ...args) =>
      pick(dc).getServer(dc, ...args),
"""
    if export_block.count(get_server_anchor) != 1:
        raise SystemExit('CLOUD_GET_SERVER_EXPORT_EXACT_ANCHOR_NOT_FOUND')

    traffic_export = """    getServerTraffic: (dc, ...args) =>
      pick(dc).getServerTraffic
        ? pick(dc).getServerTraffic(dc, ...args)
        : unsupported('traffic not supported'),
"""
    export_block = export_block.replace(
        get_server_anchor,
        get_server_anchor + '\n' + traffic_export,
        1
    )
    cloud = cloud[:export_start] + export_block + cloud[export_end:]'''

matches = list(pattern.finditer(text))
if len(matches) != 1:
    raise SystemExit(f'EXPECTED_ONE_BROKEN_CLOUD_PATCH_FOUND_{len(matches)}')

fixed = pattern.sub(lambda _match: replacement, text, count=1)
path.write_text(fixed, encoding='utf-8')
print('REMOTE_V10_CLOUD_FIX=APPLIED')
'@

$PatcherBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($RemotePatcher))
$PatchCommand = "printf '%s' '$PatcherBase64' | base64 -d | python3 - '$RemoteScriptPath' && bash -n '$RemoteScriptPath' && grep -q 'CLOUD_EXPORT_MULTILINE_FIX_V10R1' '$RemoteScriptPath' && echo REMOTE_V10_FIXED_SCRIPT_VERIFY=SUCCESS && sha256sum '$RemoteScriptPath'"
$PatchResult = Invoke-HamoonSsh -Command $PatchCommand -Retries 10
Write-Host $PatchResult.StdOut.Trim()

if ($PatchResult.StdOut -notlike '*REMOTE_V10_FIXED_SCRIPT_VERIFY=SUCCESS*') {
    throw 'The temporary v10 script could not be patched and verified. Production was not changed.'
}

Write-Host ''
Write-Host '===== LAUNCH PATCHED v10 AS A NEW DETACHED RUN =====' -ForegroundColor Cyan

$RetryId = "$(Get-Date -Format 'yyyyMMddHHmmss')-$PID"
$RetryLogPath = "/root/hamoon-traffic-provider404-v10-resume-$RetryId.log"
$RetryStatusPath = "/tmp/hamoon-traffic-provider404-v10-resume-$RetryId.status"
$RetryPidPath = "/tmp/hamoon-traffic-provider404-v10-resume-$RetryId.pid"

$LaunchCommand = "if [ -f '$RetryStatusPath' ]; then echo RESUME_STATUS=`$(cat '$RetryStatusPath'); elif [ -f '$RetryPidPath' ] && kill -0 `$(cat '$RetryPidPath') 2>/dev/null; then echo RESUME_RUNNING=`$(cat '$RetryPidPath'); else rm -f '$RetryLogPath' '$RetryStatusPath' '$RetryPidPath'; nohup sh -c 'bash $RemoteScriptPath >$RetryLogPath 2>&1; echo `$? >$RetryStatusPath' </dev/null >/dev/null 2>&1 & echo `$! >'$RetryPidPath'; echo RESUME_STARTED=`$(cat '$RetryPidPath'); fi"
$LaunchResult = Invoke-HamoonSsh -Command $LaunchCommand -Retries 10
Write-Host $LaunchResult.StdOut.Trim()
Write-Host "RESUME_REMOTE_LOG=$RetryLogPath"
Write-Host "RESUME_REMOTE_STATUS=$RetryStatusPath"

if ($LaunchResult.StdOut -notlike '*RESUME_STARTED=*' -and
    $LaunchResult.StdOut -notlike '*RESUME_RUNNING=*' -and
    $LaunchResult.StdOut -notlike '*RESUME_STATUS=*') {
    throw 'The patched deployment was not confirmed as started. Do not rerun before checking the printed paths.'
}

$Deadline = (Get-Date).AddMinutes(25)
$RemoteExitCode = $null
while ((Get-Date) -lt $Deadline) {
    Start-Sleep -Seconds 8
    try {
        $StatusResult = Invoke-HamoonSsh -Command "if [ -f '$RetryStatusPath' ]; then cat '$RetryStatusPath'; else echo RUNNING; fi" -Retries 5 -Quiet
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
    Write-Host 'RESUME_DEPLOY_STATUS=RUNNING'
}

if ($null -eq $RemoteExitCode) {
    throw "The detached deployment is still running or status could not be read. Do not rerun. Log: $RetryLogPath"
}

Write-Host "RESUME_DEPLOY_EXIT_CODE=$RemoteExitCode"

$MarkerResult = Invoke-HamoonSsh -Command "grep -E 'SUCCESS|FAILED|ROLLBACK|ERROR|FINAL_DASHBOARD_HTTP|POST_HAMOONBOT_STATUS|POST_DASHBOARD_SERVER_STATUS|COMPLETED|AUDIT_ONLY|FILES=INSTALLED' '$RetryLogPath' | tail -n 220 || true" -Retries 8
Write-Host ''
Write-Host '===== RESUME DEPLOYMENT MARKERS =====' -ForegroundColor Cyan
Write-Host $MarkerResult.StdOut.Trim()

if ($RemoteExitCode -ne 0) {
    $TailResult = Invoke-HamoonSsh -Command "tail -n 180 '$RetryLogPath'" -Retries 8
    Write-Host ''
    Write-Host '===== RESUME FAILURE LOG TAIL =====' -ForegroundColor Red
    Write-Host $TailResult.StdOut
    throw "Patched v10 deployment failed with exit code $RemoteExitCode. Review rollback markers above."
}

$RequiredMarkerResult = Invoke-HamoonSsh -Command "grep -q 'HAMOON_HETZNER_TRAFFIC_PROVIDER404_V10=SUCCESS' '$RetryLogPath' && grep -q 'TRAFFIC_PROVIDER404_V10_STAGING_TESTS=SUCCESS' '$RetryLogPath' && grep -q 'TRAFFIC_PROVIDER404_V10_FILES=INSTALLED' '$RetryLogPath' && grep -q 'INSTALLED_TRAFFIC_PROVIDER404_V10_TESTS=SUCCESS' '$RetryLogPath' && grep -q 'PROVIDER404_AUDIT_ONLY=SUCCESS' '$RetryLogPath' && grep -q 'FINAL_DASHBOARD_HTTP=200' '$RetryLogPath' && echo RESUME_REQUIRED_MARKERS=SUCCESS" -Retries 8
Write-Host $RequiredMarkerResult.StdOut.Trim()
if ($RequiredMarkerResult.StdOut -notlike '*RESUME_REQUIRED_MARKERS=SUCCESS*') {
    throw 'Remote process exited zero but required success markers are missing. Do not rerun.'
}

$SyntaxResult = Invoke-HamoonSsh -Command 'cd /root/Hamoon && node --check index.js && node --check cloud-api.js && node --check Hetzner/hetzner-api.js && echo RESUME_FINAL_NODE_CHECKS=SUCCESS' -Retries 8
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
    throw "Final service verification failed. Do not rerun. Log: $RetryLogPath"
}

Write-Host ''
Write-Host 'V10_RESUME_REMOTE_VERIFICATION=SUCCESS' -ForegroundColor Green
Write-Host 'HETZNER TRAFFIC + PROVIDER-404 v10 RESUME COMPLETED' -ForegroundColor Green
Write-Host "RESUME_REMOTE_LOG=$RetryLogPath"
