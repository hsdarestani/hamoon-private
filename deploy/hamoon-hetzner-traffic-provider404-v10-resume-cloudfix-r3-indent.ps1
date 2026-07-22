$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$ServerIP = '91.107.241.4'
$KeyPath = "$env:USERPROFILE\.ssh\hamoon-rescue-recovery-20260718-224538"

$RemoteScriptPath = '/tmp/hamoon-traffic-provider404-v10-20260721231819-11008.sh'
$PriorStatusPath = '/tmp/hamoon-traffic-provider404-v10-r2-20260722123448-15072.status'
$PriorPidPath = '/tmp/hamoon-traffic-provider404-v10-r2-20260722123448-15072.pid'
$PriorLogPath = '/root/hamoon-traffic-provider404-v10-r2-20260722123448-15072.log'
$ExpectedRemoteScriptSha256 = 'd14d6063c0954f9fb2e750d958b41ff4f4b593c4e68051057685cdd1edf43608'

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
Write-Host '===== VERIFY R2 INDENT FAILURE AND CURRENT PRODUCTION =====' -ForegroundColor Cyan

$ForensicsCommand = "test -f '$RemoteScriptPath' && test -f '$PriorStatusPath' && test -f '$PriorLogPath' && printf 'PRIOR_STATUS=' && cat '$PriorStatusPath' && echo && sha256sum '$RemoteScriptPath' && grep -q 'CLOUD_GET_SERVER_EXPORT_EXACT_ANCHOR_NOT_FOUND' '$PriorLogPath' && grep -q 'AUTOMATIC_TRAFFIC_PROVIDER404_ROLLBACK=COMPLETED' '$PriorLogPath' && if [ -f '$PriorPidPath' ] && kill -0 `$(cat '$PriorPidPath') 2>/dev/null; then echo PRIOR_PROCESS_RUNNING=YES; else echo PRIOR_PROCESS_RUNNING=NO; fi && echo PRIOR_R2_INDENT_FAILURE=VERIFIED"
$Forensics = Invoke-HamoonSsh -Command $ForensicsCommand -Retries 8
Write-Host $Forensics.StdOut.Trim()

if ($Forensics.StdOut -notlike '*PRIOR_STATUS=1*' -or
    $Forensics.StdOut -notlike "*$ExpectedRemoteScriptSha256  $RemoteScriptPath*" -or
    $Forensics.StdOut -notlike '*PRIOR_PROCESS_RUNNING=NO*' -or
    $Forensics.StdOut -notlike '*PRIOR_R2_INDENT_FAILURE=VERIFIED*') {
    throw 'The prior r2 artifacts do not match the verified indentation failure. Nothing was changed.'
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

Write-Host 'V10_R3_PREFLIGHT=SUCCESS' -ForegroundColor Green

Write-Host ''
Write-Host '===== PATCH VERIFIED 2-SPACE EXPORT INDENTATION =====' -ForegroundColor Cyan

$RemotePatcher = @'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text(encoding='utf-8')
marker = 'CLOUD_EXPORT_MULTILINE_FIX_V10R3'

if marker in text:
    print('REMOTE_V10_INDENT_FIX=ALREADY_APPLIED')
    raise SystemExit(0)

old_marker = 'CLOUD_EXPORT_MULTILINE_FIX_V10R2'
if text.count(old_marker) != 1:
    raise SystemExit(f'EXPECTED_ONE_V10R2_MARKER_FOUND_{text.count(old_marker)}')

old_anchor = '''    get_server_anchor = """    getServer: (dc, ...args) =>
      pick(dc).getServer(dc, ...args),
"""'''
new_anchor = '''    get_server_anchor = """  getServer: (dc, ...args) =>
    pick(dc).getServer(dc, ...args),
"""'''

old_export = '''    traffic_export = """    getServerTraffic: (dc, ...args) =>
      pick(dc).getServerTraffic
        ? pick(dc).getServerTraffic(dc, ...args)
        : unsupported('traffic not supported'),
"""'''
new_export = '''    traffic_export = """  getServerTraffic: (dc, ...args) =>
    pick(dc).getServerTraffic
      ? pick(dc).getServerTraffic(dc, ...args)
      : unsupported('traffic not supported'),
"""'''

if text.count(old_anchor) != 1:
    raise SystemExit(f'EXPECTED_ONE_OLD_ANCHOR_FOUND_{text.count(old_anchor)}')
if text.count(old_export) != 1:
    raise SystemExit(f'EXPECTED_ONE_OLD_TRAFFIC_EXPORT_FOUND_{text.count(old_export)}')

text = text.replace(old_anchor, new_anchor, 1)
text = text.replace(old_export, new_export, 1)
text = text.replace(old_marker, marker, 1)
path.write_text(text, encoding='utf-8')
print('REMOTE_V10_INDENT_FIX=APPLIED')
'@

$PatcherBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($RemotePatcher))
$PatchCommand = "printf '%s' '$PatcherBase64' | base64 -d | python3 - '$RemoteScriptPath' && bash -n '$RemoteScriptPath' && grep -q 'CLOUD_EXPORT_MULTILINE_FIX_V10R3' '$RemoteScriptPath' && echo REMOTE_V10_R3_SCRIPT_VERIFY=SUCCESS && sha256sum '$RemoteScriptPath'"
$PatchResult = Invoke-HamoonSsh -Command $PatchCommand -Retries 10
Write-Host $PatchResult.StdOut.Trim()

if ($PatchResult.StdOut -notlike '*REMOTE_V10_R3_SCRIPT_VERIFY=SUCCESS*') {
    throw 'The temporary v10 script could not be patched and verified. Production was not changed.'
}

Write-Host ''
Write-Host '===== LAUNCH INDENT-FIXED v10 AS DETACHED RUN =====' -ForegroundColor Cyan

$RunLogPath = '/root/hamoon-traffic-provider404-v10-r3.log'
$RunStatusPath = '/tmp/hamoon-traffic-provider404-v10-r3.status'
$RunPidPath = '/tmp/hamoon-traffic-provider404-v10-r3.pid'

$LaunchCommand = "if [ -f '$RunStatusPath' ]; then echo R3_STATUS=`$(cat '$RunStatusPath'); elif [ -f '$RunPidPath' ] && kill -0 `$(cat '$RunPidPath') 2>/dev/null; then echo R3_RUNNING=`$(cat '$RunPidPath'); else rm -f '$RunLogPath' '$RunStatusPath' '$RunPidPath'; nohup sh -c 'bash $RemoteScriptPath >$RunLogPath 2>&1; echo `$? >$RunStatusPath' </dev/null >/dev/null 2>&1 & echo `$! >'$RunPidPath'; echo R3_STARTED=`$(cat '$RunPidPath'); fi"
$LaunchResult = Invoke-HamoonSsh -Command $LaunchCommand -Retries 10
Write-Host $LaunchResult.StdOut.Trim()
Write-Host "R3_REMOTE_LOG=$RunLogPath"
Write-Host "R3_REMOTE_STATUS=$RunStatusPath"

if ($LaunchResult.StdOut -notlike '*R3_STARTED=*' -and
    $LaunchResult.StdOut -notlike '*R3_RUNNING=*' -and
    $LaunchResult.StdOut -notlike '*R3_STATUS=*') {
    throw 'The detached r3 deployment was not confirmed. Do not rerun before checking the printed paths.'
}

$Deadline = (Get-Date).AddMinutes(25)
$RemoteExitCode = $null
while ((Get-Date) -lt $Deadline) {
    Start-Sleep -Seconds 8
    try {
        $StatusResult = Invoke-HamoonSsh -Command "if [ -f '$RunStatusPath' ]; then cat '$RunStatusPath'; else echo RUNNING; fi" -Retries 5 -Quiet
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
    Write-Host 'R3_DEPLOY_STATUS=RUNNING'
}

if ($null -eq $RemoteExitCode) {
    throw "The detached r3 deployment is still running or status could not be read. Do not rerun. Log: $RunLogPath"
}

Write-Host "R3_DEPLOY_EXIT_CODE=$RemoteExitCode"

$MarkerResult = Invoke-HamoonSsh -Command "grep -E 'SUCCESS|FAILED|ROLLBACK|ERROR|FINAL_DASHBOARD_HTTP|POST_HAMOONBOT_STATUS|POST_DASHBOARD_SERVER_STATUS|COMPLETED|AUDIT_ONLY|FILES=INSTALLED' '$RunLogPath' | tail -n 220 || true" -Retries 8
Write-Host ''
Write-Host '===== R3 DEPLOYMENT MARKERS =====' -ForegroundColor Cyan
Write-Host $MarkerResult.StdOut.Trim()

if ($RemoteExitCode -ne 0) {
    $TailResult = Invoke-HamoonSsh -Command "tail -n 180 '$RunLogPath'" -Retries 8
    Write-Host ''
    Write-Host '===== R3 FAILURE LOG TAIL =====' -ForegroundColor Red
    Write-Host $TailResult.StdOut
    throw "Indent-fixed v10 deployment failed with exit code $RemoteExitCode. Review rollback markers above."
}

$RequiredMarkerResult = Invoke-HamoonSsh -Command "grep -q 'HAMOON_HETZNER_TRAFFIC_PROVIDER404_V10=SUCCESS' '$RunLogPath' && grep -q 'TRAFFIC_PROVIDER404_V10_STAGING_TESTS=SUCCESS' '$RunLogPath' && grep -q 'TRAFFIC_PROVIDER404_V10_FILES=INSTALLED' '$RunLogPath' && grep -q 'INSTALLED_TRAFFIC_PROVIDER404_V10_TESTS=SUCCESS' '$RunLogPath' && grep -q 'PROVIDER404_AUDIT_ONLY=SUCCESS' '$RunLogPath' && grep -q 'FINAL_DASHBOARD_HTTP=200' '$RunLogPath' && echo R3_REQUIRED_MARKERS=SUCCESS" -Retries 8
Write-Host $RequiredMarkerResult.StdOut.Trim()
if ($RequiredMarkerResult.StdOut -notlike '*R3_REQUIRED_MARKERS=SUCCESS*') {
    throw 'Remote process exited zero but required success markers are missing. Do not rerun.'
}

$SyntaxResult = Invoke-HamoonSsh -Command 'cd /root/Hamoon && node --check index.js && node --check cloud-api.js && node --check Hetzner/hetzner-api.js && echo R3_FINAL_NODE_CHECKS=SUCCESS' -Retries 8
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
    throw "Final service verification failed. Do not rerun. Log: $RunLogPath"
}

Write-Host ''
Write-Host 'V10_R3_REMOTE_VERIFICATION=SUCCESS' -ForegroundColor Green
Write-Host 'HETZNER TRAFFIC + PROVIDER-404 v10 INDENT RESUME COMPLETED' -ForegroundColor Green
Write-Host "R3_REMOTE_LOG=$RunLogPath"