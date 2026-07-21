$ErrorActionPreference = "Stop"

$V5Path = "$env:USERPROFILE\Downloads\hamoon-hetzner-traffic-provider404-deploy-20260721-v5-no-scp-fixed.ps1"
$GeneratedPath = Join-Path $env:TEMP "hamoon-hetzner-traffic-provider404-deploy-20260721-v7-generated-$PID.ps1"

if (-not (Test-Path -LiteralPath $V5Path -PathType Leaf)) {
    throw "v5 source script not found: $V5Path"
}

$Source = [System.IO.File]::ReadAllText($V5Path)
$TransportPattern = '(?s)\$TransportReplacement = @''\r?\n.*?\r?\n''@'

$TransportBody = @'
Write-Host ""
Write-Host "===== PREFLIGHT CURRENT PRODUCTION =====" -ForegroundColor Cyan

$ExpectedIndex = "92c6f27376dc23270582723ed3695c5c82c2821309dccb0c84cf0fdee273ff41"
$ExpectedCloud = "d888aa46d72a35e7d95990a629ddb9b53969d30cf38428839aeba13a3ba096b2"
$ExpectedApi = "430191e2ae4488ff328739e964b32d02e3e2ce5ef876dc6a13ac43f1600fe1a0"

function Invoke-HamoonSshSmall {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,
        [int]$Retries = 8
    )

    $LastOutput = @()
    $LastCode = 255

    for ($Attempt = 1; $Attempt -le $Retries; $Attempt++) {
        $LastOutput = @(& $SshPath @Options "root@$ServerIP" $Command 2>&1)
        $LastCode = $LASTEXITCODE

        if ($LastCode -eq 0) {
            return $LastOutput
        }

        if ($Attempt -lt $Retries) {
            $Delay = [Math]::Min(12, 2 + $Attempt)
            Write-Warning "SSH command attempt $Attempt/$Retries failed with exit code $LastCode. Retrying in $Delay seconds."
            Start-Sleep -Seconds $Delay
        }
    }

    $Text = ($LastOutput -join "`n")
    throw "Small SSH command failed after $Retries attempts (exit $LastCode): $Text"
}

$PreflightCommand = 'cd /root/Hamoon && echo INDEX=$(sha256sum index.js | cut -d" " -f1) && echo CLOUD=$(sha256sum cloud-api.js | cut -d" " -f1) && echo API=$(sha256sum Hetzner/hetzner-api.js | cut -d" " -f1) && echo BOT=$(pm2 jlist | node -e ''let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const a=JSON.parse(s||"[]").find(x=>x.name==="hamoonbot");process.stdout.write(a?.pm2_env?.status||"missing")})'') && echo DASH=$(pm2 jlist | node -e ''let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const a=JSON.parse(s||"[]").find(x=>x.name==="dashboard-server");process.stdout.write(a?.pm2_env?.status||"missing")})'') && echo HTTP=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 15 http://127.0.0.1:3000/health)'
$PreflightText = (Invoke-HamoonSshSmall -Command $PreflightCommand -Retries 5) -join "`n"
Write-Host $PreflightText

if ($PreflightText -notlike "*INDEX=$ExpectedIndex*" -or
    $PreflightText -notlike "*CLOUD=$ExpectedCloud*" -or
    $PreflightText -notlike "*API=$ExpectedApi*") {
    throw "Production hashes changed or a previous partial deployment modified files. Deployment aborted before upload."
}

if ($PreflightText -notlike "*BOT=online*" -or
    $PreflightText -notlike "*DASH=online*" -or
    $PreflightText -notlike "*HTTP=200*") {
    throw "Production is unhealthy before deployment. Deployment aborted."
}

Write-Host "V7_PRODUCTION_PREFLIGHT=SUCCESS" -ForegroundColor Green

$NormalizedRemoteScript = $RemoteScript -replace "`r`n", "`n"
$RemoteBytes = [System.Text.Encoding]::UTF8.GetBytes($NormalizedRemoteScript)
$RemoteBase64 = [Convert]::ToBase64String($RemoteBytes)
$Hasher = [System.Security.Cryptography.SHA256]::Create()
try {
    $RemoteSha256 = ([BitConverter]::ToString($Hasher.ComputeHash($RemoteBytes))).Replace("-", "").ToLowerInvariant()
}
finally {
    $Hasher.Dispose()
}

$UploadId = "$(Get-Date -Format 'yyyyMMddHHmmss')-$PID"
$RemoteBase64Path = "/tmp/hamoon-traffic-provider404-v7-$UploadId.b64"
$RemoteScriptPath = "/tmp/hamoon-traffic-provider404-v7-$UploadId.sh"
$RemoteStatusPath = "/tmp/hamoon-traffic-provider404-v7-$UploadId.status"
$RemotePidPath = "/tmp/hamoon-traffic-provider404-v7-$UploadId.pid"
$RemoteLogPath = "/root/hamoon-traffic-provider404-v7-$UploadId.log"
$ChunkSize = 1024
$ChunkCount = [int][Math]::Ceiling($RemoteBase64.Length / $ChunkSize)

Write-Host ""
Write-Host "===== CHUNKED SSH UPLOAD =====" -ForegroundColor Cyan
Write-Host "REMOTE_SCRIPT_BYTES=$($RemoteBytes.Length)"
Write-Host "REMOTE_SCRIPT_SHA256=$RemoteSha256"
Write-Host "REMOTE_CHUNK_COUNT=$ChunkCount"

Invoke-HamoonSshSmall -Command "umask 077; : > '$RemoteBase64Path'; rm -f '$RemoteScriptPath' '$RemoteStatusPath' '$RemotePidPath'" -Retries 8 | Out-Null

for ($Index = 0; $Index -lt $RemoteBase64.Length; $Index += $ChunkSize) {
    $Length = [Math]::Min($ChunkSize, $RemoteBase64.Length - $Index)
    $Chunk = $RemoteBase64.Substring($Index, $Length)
    $Number = [int]([Math]::Floor($Index / $ChunkSize) + 1)

    Invoke-HamoonSshSmall -Command "printf '%s' '$Chunk' >> '$RemoteBase64Path'" -Retries 10 | Out-Null

    if (($Number % 5) -eq 0 -or $Number -eq $ChunkCount) {
        Write-Host "REMOTE_CHUNK_PROGRESS=$Number/$ChunkCount"
    }

    Start-Sleep -Milliseconds 700
}

$VerifyCommand = "base64 -d '$RemoteBase64Path' > '$RemoteScriptPath' && chmod 700 '$RemoteScriptPath' && echo '$RemoteSha256  $RemoteScriptPath' | sha256sum -c - >/dev/null && echo REMOTE_CHUNK_VERIFY=SUCCESS"
$VerifyText = (Invoke-HamoonSshSmall -Command $VerifyCommand -Retries 8) -join "`n"
Write-Host $VerifyText
if ($VerifyText -notlike "*REMOTE_CHUNK_VERIFY=SUCCESS*") {
    throw "Remote chunk verification did not return success."
}

Write-Host ""
Write-Host "===== DETACHED REMOTE DEPLOYMENT =====" -ForegroundColor Cyan
$LaunchCommand = "rm -f '$RemoteLogPath' '$RemoteStatusPath' '$RemotePidPath'; nohup sh -c 'bash $RemoteScriptPath >$RemoteLogPath 2>&1; echo `$? >$RemoteStatusPath' </dev/null >/dev/null 2>&1 & echo `$! >'$RemotePidPath'; echo DETACHED_DEPLOY_PID=`$(cat '$RemotePidPath')"
$LaunchText = (Invoke-HamoonSshSmall -Command $LaunchCommand -Retries 8) -join "`n"
Write-Host $LaunchText

$Deadline = (Get-Date).AddMinutes(20)
$RemoteExitCode = $null
while ((Get-Date) -lt $Deadline) {
    Start-Sleep -Seconds 8
    try {
        $StatusText = ((Invoke-HamoonSshSmall -Command "if [ -f '$RemoteStatusPath' ]; then cat '$RemoteStatusPath'; else echo RUNNING; fi" -Retries 4) -join "`n").Trim()
    }
    catch {
        Write-Warning $_.Exception.Message
        continue
    }

    if ($StatusText -match '^-?\d+$') {
        $RemoteExitCode = [int]$StatusText
        break
    }

    Write-Host "REMOTE_DEPLOY_STATUS=RUNNING"
}

if ($null -eq $RemoteExitCode) {
    Write-Host "REMOTE_DEPLOY_LOG=$RemoteLogPath"
    throw "Detached deployment did not finish within 20 minutes. Do not rerun before checking the remote log."
}

Write-Host "REMOTE_DEPLOY_EXIT_CODE=$RemoteExitCode"
Write-Host "REMOTE_DEPLOY_LOG=$RemoteLogPath"

$MarkerCommand = "grep -E 'SUCCESS|FAILED|ROLLBACK|ERROR|FINAL_DASHBOARD_HTTP|POST_HAMOONBOT_STATUS|POST_DASHBOARD_SERVER_STATUS|COMPLETED' '$RemoteLogPath' | tail -n 160 || true"
$MarkerText = (Invoke-HamoonSshSmall -Command $MarkerCommand -Retries 6) -join "`n"
Write-Host ""
Write-Host "===== REMOTE DEPLOYMENT MARKERS =====" -ForegroundColor Cyan
Write-Host $MarkerText

if ($RemoteExitCode -ne 0) {
    $TailText = (Invoke-HamoonSshSmall -Command "tail -n 100 '$RemoteLogPath'" -Retries 6) -join "`n"
    Write-Host ""
    Write-Host "===== REMOTE FAILURE LOG TAIL =====" -ForegroundColor Red
    Write-Host $TailText
    throw "Detached remote deployment failed with exit code $RemoteExitCode."
}

$FinalCheckCommand = "grep -q 'HAMOON_HETZNER_TRAFFIC_PROVIDER404_V7=SUCCESS' '$RemoteLogPath' && grep -q 'FINAL_DASHBOARD_HTTP=200' '$RemoteLogPath' && cd /root/Hamoon && node --check index.js && node --check cloud-api.js && node --check Hetzner/hetzner-api.js && echo FINAL_REMOTE_VERIFICATION_V7=SUCCESS"
$FinalText = (Invoke-HamoonSshSmall -Command $FinalCheckCommand -Retries 8) -join "`n"
Write-Host $FinalText
if ($FinalText -notlike "*FINAL_REMOTE_VERIFICATION_V7=SUCCESS*") {
    throw "Final remote verification failed."
}

Invoke-HamoonSshSmall -Command "rm -f '$RemoteBase64Path' '$RemoteScriptPath' '$RemoteStatusPath' '$RemotePidPath'" -Retries 5 | Out-Null

Write-Host ""
Write-Host "CHUNKED_SSH_TRANSPORT_V7=SUCCESS" -ForegroundColor Green
Write-Host "HETZNER TRAFFIC + PROVIDER-404 HOTFIX v7 DEPLOYMENT COMPLETED" -ForegroundColor Green
'@

$TransportReplacement = '$TransportReplacement = @''' + "`r`n" + $TransportBody + "`r`n'@"
$TransportRegex = New-Object System.Text.RegularExpressions.Regex(
    $TransportPattern,
    [System.Text.RegularExpressions.RegexOptions]::Singleline
)

$TransportMatches = $TransportRegex.Matches($Source)
if ($TransportMatches.Count -ne 1) {
    throw "Expected exactly one v5 transport replacement block; found $($TransportMatches.Count)."
}

$Patched = $TransportRegex.Replace(
    $Source,
    [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $TransportReplacement },
    1
)

$Patched = $Patched.Replace(
    'hamoon-hetzner-traffic-provider404-deploy-20260721-v5-generated-',
    'hamoon-hetzner-traffic-provider404-deploy-20260721-v7-generated-'
)
$Patched = $Patched.Replace('GUARD_V5', 'GUARD_V7')
$Patched = $Patched.Replace('TRANSPORT_V5', 'TRANSPORT_V7')
$Patched = $Patched.Replace('HOTFIX v5', 'HOTFIX v7')
$Patched = $Patched.Replace('PROVIDER404_V5', 'PROVIDER404_V7')
$Patched = $Patched.Replace('GENERATED_V5_', 'GENERATED_V7_')
$Patched = $Patched.Replace('Generated v5', 'Generated v7')
$Patched = $Patched.Replace('generated v5', 'generated v7')

foreach ($Marker in @(
    "MANAGEMENT_PROVIDER404_GUARD_V7",
    "CHUNKED_SSH_TRANSPORT_V7=SUCCESS",
    "HAMOON_HETZNER_TRAFFIC_PROVIDER404_V7=SUCCESS",
    "V7_PRODUCTION_PREFLIGHT=SUCCESS"
)) {
    if (-not $Patched.Contains($Marker)) {
        throw "Generated v7 verification failed for marker: $Marker"
    }
}

$Tokens = $null
$ParseErrors = $null
[System.Management.Automation.Language.Parser]::ParseInput(
    $Patched,
    [ref]$Tokens,
    [ref]$ParseErrors
) | Out-Null

if ($ParseErrors.Count -gt 0) {
    $Details = ($ParseErrors | ForEach-Object { $_.Message }) -join " | "
    throw "Generated v7 PowerShell parser check failed: $Details"
}

Write-Host "GENERATED_V7_POWERSHELL_PARSE_CHECK=SUCCESS"

try {
    $Utf8Bom = New-Object System.Text.UTF8Encoding($true)
    [System.IO.File]::WriteAllText($GeneratedPath, $Patched, $Utf8Bom)

    Write-Host ""
    Write-Host "===== GENERATED CHUNKED/DETACHED TRAFFIC HOTFIX v7 =====" -ForegroundColor Cyan
    Write-Host "Source:    $V5Path"
    Write-Host "Generated: $GeneratedPath"
    Write-Host "CHUNKED_SSH_TRANSPORT_V7=GENERATED"
    Write-Host "DETACHED_REMOTE_EXECUTION_V7=GENERATED"

    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
    & $GeneratedPath
}
finally {
    Remove-Item -LiteralPath $GeneratedPath -Force -ErrorAction SilentlyContinue
}
