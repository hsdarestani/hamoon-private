$ErrorActionPreference = "Stop"

$V1Path = "$env:USERPROFILE\Downloads\hamoon-hetzner-traffic-provider404-deploy-20260721-v1.ps1"
$GeneratedPath = Join-Path $env:TEMP "hamoon-hetzner-traffic-provider404-deploy-20260721-v3-generated-$PID.ps1"

if (-not (Test-Path -LiteralPath $V1Path -PathType Leaf)) {
    throw "Original v1 deploy script not found: $V1Path"
}

$Source = [System.IO.File]::ReadAllText($V1Path)

$ManagementPattern = '(?s)old_catch = """.*?index = index\[:management_start\] \+ management \+ index\[management_end:\]'
$ManagementReplacement = @'
if 'MANAGEMENT_PROVIDER404_GUARD_V3' not in management:
    provider_call = re.compile(
        r"(?P<indent>^[ \t]*)const\s+srv\s*=\s*await\s+openstackApi\.getServer\(dcConfig,\s*tok,\s*serverId\);",
        re.MULTILINE
    )
    match = provider_call.search(management)
    if not match:
        raise SystemExit('MANAGEMENT_PROVIDER_CALL_NOT_FOUND')

    indent = match.group('indent')
    guarded = f'''{indent}// MANAGEMENT_PROVIDER404_GUARD_V3
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

    management = (
        management[:match.start()]
        + guarded
        + management[match.end():]
    )

index = index[:management_start] + management + index[management_end:]
'@

$ManagementRegex = New-Object System.Text.RegularExpressions.Regex(
    $ManagementPattern,
    [System.Text.RegularExpressions.RegexOptions]::Singleline
)
$ManagementMatches = $ManagementRegex.Matches($Source)
if ($ManagementMatches.Count -ne 1) {
    throw "Expected exactly one v1 management patch block; found $($ManagementMatches.Count)."
}
$Patched = $ManagementRegex.Replace($Source, $ManagementReplacement, 1)

$CloudPattern = "(?s)if 'getServerTraffic:' not in cloud:\s+lines = cloud\.splitlines\(True\).*?cloud = ''\.join\(lines\)"
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

    export_block = (
        export_block[:match.end()]
        + insertion
        + export_block[match.end():]
    )
    cloud = cloud[:export_start] + export_block + cloud[export_end:]
'@

$CloudRegex = New-Object System.Text.RegularExpressions.Regex(
    $CloudPattern,
    [System.Text.RegularExpressions.RegexOptions]::Singleline
)
$CloudMatches = $CloudRegex.Matches($Patched)
if ($CloudMatches.Count -ne 1) {
    throw "Expected exactly one v1 cloud export patch block; found $($CloudMatches.Count)."
}
$Patched = $CloudRegex.Replace($Patched, $CloudReplacement, 1)

$Patched = $Patched.Replace(
    "[BILLING_HETZNER_PREFLIGHT_WARNING]",
    "[BILLING_HETZNER_PREFLIGHT_SKIP]"
)

$BillingPattern = "(?s)(console\.warn\('\[BILLING_HETZNER_PREFLIGHT_SKIP\]', \{.*?message: providerError\?\.message\s*\}\);)"
$BillingRegex = New-Object System.Text.RegularExpressions.Regex(
    $BillingPattern,
    [System.Text.RegularExpressions.RegexOptions]::Singleline
)
$BillingMatches = $BillingRegex.Matches($Patched)
if ($BillingMatches.Count -ne 1) {
    throw "Expected exactly one billing preflight warning block; found $($BillingMatches.Count)."
}
$Patched = $BillingRegex.Replace(
    $Patched,
    '$1' + "`n        continue;",
    1
)

$Patched = $Patched.Replace(
    "HETZNER TRAFFIC + PROVIDER-404 HOTFIX v1",
    "HETZNER TRAFFIC + PROVIDER-404 HOTFIX v3"
)
$Patched = $Patched.Replace(
    "HAMOON_HETZNER_TRAFFIC_PROVIDER404_V1=SUCCESS",
    "HAMOON_HETZNER_TRAFFIC_PROVIDER404_V3=SUCCESS"
)
$Patched = $Patched.Replace(
    "TRAFFIC_PROVIDER404_STAGING_TESTS=SUCCESS",
    "TRAFFIC_PROVIDER404_V3_STAGING_TESTS=SUCCESS"
)
$Patched = $Patched.Replace(
    "TRAFFIC_PROVIDER404_FILES=INSTALLED",
    "TRAFFIC_PROVIDER404_V3_FILES=INSTALLED"
)
$Patched = $Patched.Replace(
    "INSTALLED_TRAFFIC_PROVIDER404_TESTS=SUCCESS",
    "INSTALLED_TRAFFIC_PROVIDER404_V3_TESTS=SUCCESS"
)

foreach ($Marker in @(
    "MANAGEMENT_PROVIDER404_GUARD_V3",
    "CLOUD_EXPORT_BLOCK_NOT_FOUND",
    "[BILLING_HETZNER_PREFLIGHT_SKIP]",
    "HAMOON_HETZNER_TRAFFIC_PROVIDER404_V3=SUCCESS"
)) {
    if (-not $Patched.Contains($Marker)) {
        throw "Generated v3 verification failed for marker: $Marker"
    }
}

try {
    $Utf8Bom = New-Object System.Text.UTF8Encoding($true)
    [System.IO.File]::WriteAllText($GeneratedPath, $Patched, $Utf8Bom)

    Write-Host ""
    Write-Host "===== GENERATED CORRECTED TRAFFIC / PROVIDER-404 v3 =====" -ForegroundColor Cyan
    Write-Host "Source:    $V1Path"
    Write-Host "Generated: $GeneratedPath"
    Write-Host "MANAGEMENT_PROVIDER404_GUARD_V3=GENERATED"
    Write-Host "CLOUD_API_EXPORT_PATCH_V3=GENERATED"
    Write-Host "BILLING_PREFLIGHT_FAIL_CLOSED_V3=GENERATED"

    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
    & $GeneratedPath
}
finally {
    Remove-Item -LiteralPath $GeneratedPath -Force -ErrorAction SilentlyContinue
}
