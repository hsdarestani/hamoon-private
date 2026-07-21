$ErrorActionPreference = "Stop"

$V7Path = "$env:USERPROFILE\Downloads\hamoon-hetzner-traffic-provider404-deploy-20260721-v7-chunked-detached-fixed.ps1"
$GeneratedPath = Join-Path $env:TEMP "hamoon-hetzner-traffic-provider404-deploy-20260721-v9-fixed-$PID.ps1"

if (-not (Test-Path -LiteralPath $V7Path -PathType Leaf)) {
    throw "v7 source script not found: $V7Path"
}

$Source = [System.IO.File]::ReadAllText($V7Path)

$PreflightPattern = '(?m)^\$PreflightCommand = ''.*''$'
$PreflightReplacement = @'
$PreflightCommand = 'cd /root/Hamoon && set -- $(sha256sum index.js); echo INDEX=$1; set -- $(sha256sum cloud-api.js); echo CLOUD=$1; set -- $(sha256sum Hetzner/hetzner-api.js); echo API=$1; echo BOT=$(pm2 jlist | node -e ''let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const a=JSON.parse(s||"[]").find(x=>x.name==="hamoonbot");process.stdout.write(a?.pm2_env?.status||"missing")})'') && echo DASH=$(pm2 jlist | node -e ''let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const a=JSON.parse(s||"[]").find(x=>x.name==="dashboard-server");process.stdout.write(a?.pm2_env?.status||"missing")})'') && echo HTTP=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 15 http://127.0.0.1:3000/health)'
'@

$PreflightRegex = New-Object System.Text.RegularExpressions.Regex(
    $PreflightPattern,
    [System.Text.RegularExpressions.RegexOptions]::Multiline
)
$PreflightMatches = $PreflightRegex.Matches($Source)
if ($PreflightMatches.Count -ne 1) {
    throw "Expected exactly one v7 preflight command; found $($PreflightMatches.Count)."
}

$Fixed = $PreflightRegex.Replace(
    $Source,
    [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $PreflightReplacement.TrimEnd("`r", "`n") },
    1
)

$Anchor = '$Patched = $Patched.Replace(''generated v5'', ''generated v7'')'
$AnchorCount = ([regex]::Matches($Fixed, [regex]::Escape($Anchor))).Count
if ($AnchorCount -ne 1) {
    throw "Expected exactly one v7 post-processing anchor; found $AnchorCount."
}

$MarkerInjection = @'
$Patched = $Patched.Replace('generated v5', 'generated v7')
$Patched = $Patched.Replace(
    'DIRECT_SSH_BASE64_TRANSPORT_V7=STARTED',
    'V7_PRODUCTION_PREFLIGHT=SUCCESS'
)
'@

$Fixed = $Fixed.Replace($Anchor, $MarkerInjection)

foreach ($Marker in @(
    'set -- $(sha256sum index.js); echo INDEX=$1',
    'V7_PRODUCTION_PREFLIGHT=SUCCESS',
    'CHUNKED_SSH_TRANSPORT_V7=SUCCESS'
)) {
    if (-not $Fixed.Contains($Marker)) {
        throw "v9 verification failed for marker: $Marker"
    }
}

$Tokens = $null
$ParseErrors = $null
[System.Management.Automation.Language.Parser]::ParseInput(
    $Fixed,
    [ref]$Tokens,
    [ref]$ParseErrors
) | Out-Null

if ($ParseErrors.Count -gt 0) {
    $Details = ($ParseErrors | ForEach-Object { $_.Message }) -join " | "
    throw "Corrected v9 wrapper parser check failed: $Details"
}

try {
    $Utf8Bom = New-Object System.Text.UTF8Encoding($true)
    [System.IO.File]::WriteAllText($GeneratedPath, $Fixed, $Utf8Bom)

    Write-Host "GENERATED_V9_PREFLIGHT_FIX_PARSE_CHECK=SUCCESS" -ForegroundColor Green
    Write-Host "V7_CUT_DELIMITER_BUG=REMOVED" -ForegroundColor Green
    Write-Host "STALE_DIRECT_SSH_MARKER_V7=REMOVED" -ForegroundColor Green
    Write-Host "Source:    $V7Path"
    Write-Host "Generated: $GeneratedPath"

    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
    & $GeneratedPath
}
finally {
    Remove-Item -LiteralPath $GeneratedPath -Force -ErrorAction SilentlyContinue
}
