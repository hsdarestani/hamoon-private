$ErrorActionPreference = "Stop"

$V1Path = "$env:USERPROFILE\Downloads\hamoon-hetzner-traffic-provider404-deploy-20260721-v1.ps1"
$GeneratedPath = Join-Path $env:TEMP "hamoon-hetzner-traffic-provider404-deploy-20260721-v2-generated-$PID.ps1"

if (-not (Test-Path -LiteralPath $V1Path -PathType Leaf)) {
    throw "Original v1 deploy script not found: $V1Path"
}

$Source = [System.IO.File]::ReadAllText($V1Path)

$Pattern = '(?s)old_catch = """.*?index = index\[:management_start\] \+ management \+ index\[management_end:\]'

$Replacement = @'
if 'MANAGEMENT_PROVIDER404_GUARD_V2' not in management:
    provider_call = re.compile(
        r"(?P<indent>^[ \t]*)const\s+srv\s*=\s*await\s+openstackApi\.getServer\(dcConfig,\s*tok,\s*serverId\);",
        re.MULTILINE
    )
    match = provider_call.search(management)
    if not match:
        raise SystemExit('MANAGEMENT_PROVIDER_CALL_NOT_FOUND')

    indent = match.group('indent')
    guarded = f'''{indent}// MANAGEMENT_PROVIDER404_GUARD_V2
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

$Regex = New-Object System.Text.RegularExpressions.Regex(
    $Pattern,
    [System.Text.RegularExpressions.RegexOptions]::Singleline
)

$Matches = $Regex.Matches($Source)
if ($Matches.Count -ne 1) {
    throw "Expected exactly one v1 management catch patch block; found $($Matches.Count)."
}

$Patched = $Regex.Replace($Source, $Replacement, 1)
$Patched = $Patched.Replace(
    "HETZNER TRAFFIC + PROVIDER-404 HOTFIX v1",
    "HETZNER TRAFFIC + PROVIDER-404 HOTFIX v2"
)
$Patched = $Patched.Replace(
    "HAMOON_HETZNER_TRAFFIC_PROVIDER404_V1=SUCCESS",
    "HAMOON_HETZNER_TRAFFIC_PROVIDER404_V2=SUCCESS"
)
$Patched = $Patched.Replace(
    "TRAFFIC_PROVIDER404_STAGING_TESTS=SUCCESS",
    "TRAFFIC_PROVIDER404_V2_STAGING_TESTS=SUCCESS"
)
$Patched = $Patched.Replace(
    "TRAFFIC_PROVIDER404_FILES=INSTALLED",
    "TRAFFIC_PROVIDER404_V2_FILES=INSTALLED"
)
$Patched = $Patched.Replace(
    "INSTALLED_TRAFFIC_PROVIDER404_TESTS=SUCCESS",
    "INSTALLED_TRAFFIC_PROVIDER404_V2_TESTS=SUCCESS"
)

if (-not $Patched.Contains("MANAGEMENT_PROVIDER404_GUARD_V2")) {
    throw "Generated v2 script verification failed."
}

try {
    $Utf8Bom = New-Object System.Text.UTF8Encoding($true)
    [System.IO.File]::WriteAllText($GeneratedPath, $Patched, $Utf8Bom)

    Write-Host ""
    Write-Host "===== GENERATED CORRECTED TRAFFIC / PROVIDER-404 v2 =====" -ForegroundColor Cyan
    Write-Host "Source:    $V1Path"
    Write-Host "Generated: $GeneratedPath"
    Write-Host "MANAGEMENT_PROVIDER404_GUARD_V2=GENERATED"

    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
    & $GeneratedPath
}
finally {
    Remove-Item -LiteralPath $GeneratedPath -Force -ErrorAction SilentlyContinue
}
