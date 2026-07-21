$ErrorActionPreference = "Stop"

$V7Path = "$env:USERPROFILE\Downloads\hamoon-hetzner-traffic-provider404-deploy-20260721-v7-chunked-detached-fixed.ps1"
$GeneratedPath = Join-Path $env:TEMP "hamoon-hetzner-traffic-provider404-deploy-20260721-v8-fixed-$PID.ps1"

if (-not (Test-Path -LiteralPath $V7Path -PathType Leaf)) {
    throw "v7 source script not found: $V7Path"
}

$Source = [System.IO.File]::ReadAllText($V7Path)

$Anchor = '$Patched = $Patched.Replace(''generated v5'', ''generated v7'')'
$Count = ([regex]::Matches($Source, [regex]::Escape($Anchor))).Count
if ($Count -ne 1) {
    throw "Expected exactly one v7 post-processing anchor; found $Count."
}

$Injection = @'
$Patched = $Patched.Replace('generated v5', 'generated v7')
$Patched = $Patched.Replace(
    'DIRECT_SSH_BASE64_TRANSPORT_V7=STARTED',
    'V7_PRODUCTION_PREFLIGHT=SUCCESS'
)
'@

$Fixed = $Source.Replace($Anchor, $Injection)

if (-not $Fixed.Contains("V7_PRODUCTION_PREFLIGHT=SUCCESS")) {
    throw "v8 marker correction was not injected."
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
    throw "Corrected v8 wrapper parser check failed: $Details"
}

try {
    $Utf8Bom = New-Object System.Text.UTF8Encoding($true)
    [System.IO.File]::WriteAllText($GeneratedPath, $Fixed, $Utf8Bom)

    Write-Host "GENERATED_V8_MARKER_FIX_PARSE_CHECK=SUCCESS" -ForegroundColor Green
    Write-Host "STALE_DIRECT_SSH_MARKER_V7=REMOVED" -ForegroundColor Green
    Write-Host "Source:    $V7Path"
    Write-Host "Generated: $GeneratedPath"

    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
    & $GeneratedPath
}
finally {
    Remove-Item -LiteralPath $GeneratedPath -Force -ErrorAction SilentlyContinue
}
