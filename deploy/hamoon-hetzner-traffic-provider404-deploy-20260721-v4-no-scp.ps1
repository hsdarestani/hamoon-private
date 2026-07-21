$ErrorActionPreference = "Stop"

$V1Path = "$env:USERPROFILE\Downloads\hamoon-hetzner-traffic-provider404-deploy-20260721-v1.ps1"
$GeneratedPath = Join-Path $env:TEMP "hamoon-hetzner-traffic-provider404-deploy-20260721-v4-generated-$PID.ps1"

if (-not (Test-Path -LiteralPath $V1Path -PathType Leaf)) {
    throw "Original v1 deploy script not found: $V1Path"
}

$Source = [System.IO.File]::ReadAllText($V1Path)

$ManagementPattern = '(?s)old_catch = """.*?index = index\[:management_start\] \+ management \+ index\[management_end:\]'
$ManagementReplacement = @'
if 'MANAGEMENT_PROVIDER404_GUARD_V4' not in management:
    provider_call = re.compile(
        r"(?P<indent>^[ \t]*)const\s+srv\s*=\s*await\s+openstackApi\.getServer\(dcConfig,\s*tok,\s*serverId\);",
        re.MULTILINE
    )
    match = provider_call.search(management)
    if not match:
        raise SystemExit('MANAGEMENT_PROVIDER_CALL_NOT_FOUND')

    indent = match.group('indent')
    guarded = f'''{indent}// MANAGEMENT_PROVIDER404_GUARD_V4
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

$TransportPattern = '(?s)try \{\s+\$Utf8NoBom = New-Object System\.Text\.UTF8Encoding\(\$false\).*?finally \{\s+Remove-Item -LiteralPath \$LocalTemp -Force -ErrorAction SilentlyContinue\s+\}'
$TransportReplacement = @'
Write-Host ""
Write-Host "===== DEPLOY HETZNER TRAFFIC / PROVIDER-404 HOTFIX OVER DIRECT SSH =====" -ForegroundColor Cyan
Write-Host "DIRECT_SSH_STDIN_TRANSPORT_V4=STARTED"

$NormalizedRemoteScript = $RemoteScript -replace "`r`n", "`n"
$RemoteBytes = [System.Text.Encoding]::UTF8.GetBytes($NormalizedRemoteScript)

$ProcessInfo = New-Object System.Diagnostics.ProcessStartInfo
$ProcessInfo.FileName = $SshPath
$ProcessInfo.UseShellExecute = $false
$ProcessInfo.RedirectStandardInput = $true
$ProcessInfo.RedirectStandardOutput = $false
$ProcessInfo.RedirectStandardError = $false
$ProcessInfo.CreateNoWindow = $false

$NativeArgs = @($Options) + @("root@$ServerIP", "bash", "-s")
$ProcessInfo.Arguments = ($NativeArgs | ForEach-Object {
    if ($_ -match '[\s"]') {
        '"' + ($_ -replace '"', '\"') + '"'
    }
    else {
        $_
    }
}) -join ' '

$DeployProcess = New-Object System.Diagnostics.Process
$DeployProcess.StartInfo = $ProcessInfo

try {
    if (-not $DeployProcess.Start()) {
        throw "Could not start direct SSH deployment process."
    }

    $DeployProcess.StandardInput.BaseStream.Write(
        $RemoteBytes,
        0,
        $RemoteBytes.Length
    )
    $DeployProcess.StandardInput.BaseStream.Flush()
    $DeployProcess.StandardInput.Close()
    $DeployProcess.WaitForExit()

    if ($DeployProcess.ExitCode -ne 0) {
        throw "Direct SSH hotfix failed with exit code $($DeployProcess.ExitCode). Review rollback markers above."
    }

    Write-Host ""
    Write-Host "DIRECT_SSH_STDIN_TRANSPORT_V4=SUCCESS" -ForegroundColor Green
    Write-Host "HETZNER TRAFFIC + PROVIDER-404 HOTFIX v4 DEPLOYMENT COMPLETED" -ForegroundColor Green
}
finally {
    if ($DeployProcess -and -not $DeployProcess.HasExited) {
        try { $DeployProcess.Kill() } catch {}
    }
    if ($DeployProcess) {
        $DeployProcess.Dispose()
    }
}
'@

$TransportRegex = New-Object System.Text.RegularExpressions.Regex(
    $TransportPattern,
    [System.Text.RegularExpressions.RegexOptions]::Singleline
)
$TransportMatches = $TransportRegex.Matches($Patched)
if ($TransportMatches.Count -ne 1) {
    throw "Expected exactly one SCP transport block; found $($TransportMatches.Count)."
}
$Patched = $TransportRegex.Replace($Patched, $TransportReplacement, 1)

$Patched = $Patched.Replace(
    '"ConnectTimeout=20",',
    '"ConnectTimeout=30",' + "`r`n" +
    '    "-o", "ConnectionAttempts=3",' + "`r`n" +
    '    "-o", "TCPKeepAlive=yes",' + "`r`n" +
    '    "-o", "IPQoS=none",'
)

$Patched = $Patched.Replace(
    "HETZNER TRAFFIC + PROVIDER-404 HOTFIX v1",
    "HETZNER TRAFFIC + PROVIDER-404 HOTFIX v4"
)
$Patched = $Patched.Replace(
    "HAMOON_HETZNER_TRAFFIC_PROVIDER404_V1=SUCCESS",
    "HAMOON_HETZNER_TRAFFIC_PROVIDER404_V4=SUCCESS"
)
$Patched = $Patched.Replace(
    "TRAFFIC_PROVIDER404_STAGING_TESTS=SUCCESS",
    "TRAFFIC_PROVIDER404_V4_STAGING_TESTS=SUCCESS"
)
$Patched = $Patched.Replace(
    "TRAFFIC_PROVIDER404_FILES=INSTALLED",
    "TRAFFIC_PROVIDER404_V4_FILES=INSTALLED"
)
$Patched = $Patched.Replace(
    "INSTALLED_TRAFFIC_PROVIDER404_TESTS=SUCCESS",
    "INSTALLED_TRAFFIC_PROVIDER404_V4_TESTS=SUCCESS"
)

foreach ($Marker in @(
    "MANAGEMENT_PROVIDER404_GUARD_V4",
    "CLOUD_EXPORT_BLOCK_NOT_FOUND",
    "[BILLING_HETZNER_PREFLIGHT_SKIP]",
    "DIRECT_SSH_STDIN_TRANSPORT_V4=STARTED",
    "HAMOON_HETZNER_TRAFFIC_PROVIDER404_V4=SUCCESS"
)) {
    if (-not $Patched.Contains($Marker)) {
        throw "Generated v4 verification failed for marker: $Marker"
    }
}

try {
    $Utf8Bom = New-Object System.Text.UTF8Encoding($true)
    [System.IO.File]::WriteAllText($GeneratedPath, $Patched, $Utf8Bom)

    Write-Host ""
    Write-Host "===== GENERATED NO-SCP TRAFFIC / PROVIDER-404 v4 =====" -ForegroundColor Cyan
    Write-Host "Source:    $V1Path"
    Write-Host "Generated: $GeneratedPath"
    Write-Host "MANAGEMENT_PROVIDER404_GUARD_V4=GENERATED"
    Write-Host "CLOUD_API_EXPORT_PATCH_V4=GENERATED"
    Write-Host "BILLING_PREFLIGHT_FAIL_CLOSED_V4=GENERATED"
    Write-Host "DIRECT_SSH_STDIN_TRANSPORT_V4=GENERATED"

    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
    & $GeneratedPath
}
finally {
    Remove-Item -LiteralPath $GeneratedPath -Force -ErrorAction SilentlyContinue
}
