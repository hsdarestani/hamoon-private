$ErrorActionPreference = "Stop"

$ServerIP = "91.107.241.4"
$KeyPath = "C:\Users\diatell\.ssh\hamoon-rescue-recovery-20260718-224538"
$RemotePath = "/tmp/hamoon-hetzner-traffic-provider404-v1.ps1-remote.sh"
$LocalTemp = Join-Path $env:TEMP "hamoon-hetzner-traffic-provider404-v1-$PID.sh"

if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) {
    throw "SSH private key not found: $KeyPath"
}

$SshPath = (Get-Command ssh.exe -ErrorAction Stop).Source
$ScpPath = (Get-Command scp.exe -ErrorAction Stop).Source

$Options = @(
    "-i", $KeyPath,
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "ConnectTimeout=20",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=8",
    "-o", "StrictHostKeyChecking=accept-new"
)

$RemoteScript = @'
set -Eeuo pipefail
set +x

PRODUCTION="/root/Hamoon"
STAMP="$(date -u +%Y%m%d_%H%M%S)"
BACKUP="/root/hamoon-hetzner-traffic-provider404-backup-${STAMP}"
STAGING="/root/hamoon-hetzner-traffic-provider404-stage-${STAMP}"
PATCHER="/tmp/hamoon-hetzner-traffic-provider404-patch-${STAMP}.py"
REPORT="${BACKUP}/deployment-report.txt"
FILES_INSTALLED=0
APPS_STOPPED=0

mkdir -p "$BACKUP"

app_status() {
  local name="$1"
  pm2 jlist | node -e '
    let s="";
    process.stdin.on("data", d => s += d);
    process.stdin.on("end", () => {
      const rows = JSON.parse(s || "[]");
      const app = rows.find(x => x.name === process.argv[1]);
      process.stdout.write(app?.pm2_env?.status || "missing");
    });
  ' "$name"
}

restart_apps() {
  set +e
  pm2 restart dashboard-server --update-env >/dev/null 2>&1 || true
  sleep 7
  pm2 restart hamoonbot --update-env >/dev/null 2>&1 || true
  sleep 12
  pm2 save >/dev/null 2>&1 || true
}

cleanup() {
  rm -f "$PATCHER"
  rm -rf "$STAGING"
}

rollback() {
  local rc="$?"
  set +e
  echo
  echo "===== AUTOMATIC TRAFFIC / PROVIDER-404 ROLLBACK ====="
  if [ "$FILES_INSTALLED" -eq 1 ] && [ -f "$BACKUP/original-files.tar.gz" ]; then
    tar -xzf "$BACKUP/original-files.tar.gz" -C "$PRODUCTION"
    echo "ROLLBACK_FILES=RESTORED"
  fi
  if [ "$APPS_STOPPED" -eq 1 ] || [ "$FILES_INSTALLED" -eq 1 ]; then
    restart_apps
  fi
  echo "ROLLBACK_HAMOONBOT_STATUS=$(app_status hamoonbot)"
  echo "ROLLBACK_DASHBOARD_SERVER_STATUS=$(app_status dashboard-server)"
  echo "ROLLBACK_DASHBOARD_HTTP=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 http://127.0.0.1:3000/health 2>/dev/null || true)"
  echo "AUTOMATIC_TRAFFIC_PROVIDER404_ROLLBACK=COMPLETED"
  cleanup
  exit "$rc"
}

trap rollback ERR

cd "$PRODUCTION"

for file in index.js cloud-api.js Hetzner/hetzner-api.js package.json db.js datacenters.js; do
  test -f "$file" || { echo "ERROR: missing $file"; exit 1; }
done

echo
 echo "===== HETZNER TRAFFIC + PROVIDER-404 HOTFIX v1 ====="
echo "Production: $PRODUCTION"
echo "Backup:     $BACKUP"

echo
 echo "===== PRE-HOTFIX HEALTH ====="
PRE_BOT="$(app_status hamoonbot)"
PRE_DASH="$(app_status dashboard-server)"
PRE_HTTP="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 http://127.0.0.1:3000/health 2>/dev/null || true)"
echo "PRE_HAMOONBOT_STATUS=$PRE_BOT"
echo "PRE_DASHBOARD_SERVER_STATUS=$PRE_DASH"
echo "PRE_DASHBOARD_HTTP=$PRE_HTTP"
if [ "$PRE_BOT" != "online" ] || [ "$PRE_DASH" != "online" ] || [ "$PRE_HTTP" != "200" ]; then
  echo "ERROR: production unhealthy before patch"
  exit 1
fi

echo
 echo "===== BACKUP CURRENT FILES ====="
tar -czf "$BACKUP/original-files.tar.gz" -C "$PRODUCTION" index.js cloud-api.js Hetzner/hetzner-api.js
sha256sum "$BACKUP/original-files.tar.gz" | tee "$BACKUP/original-files.tar.gz.sha256"
sha256sum index.js cloud-api.js Hetzner/hetzner-api.js | tee "$BACKUP/pre-patch-files.sha256"
echo "TRAFFIC_PROVIDER404_BACKUP=SUCCESS"

cat > "$PATCHER" <<'PY'
from pathlib import Path
import re
import sys

root = Path(sys.argv[1])
index_path = root / 'index.js'
cloud_path = root / 'cloud-api.js'
api_path = root / 'Hetzner' / 'hetzner-api.js'

index = index_path.read_text(encoding='utf-8')
cloud = cloud_path.read_text(encoding='utf-8')
api = api_path.read_text(encoding='utf-8')

for marker in [
    'async function handleServerManagement(',
    "case 'GET_TRAFFIC':",
    'Billing candidates:',
    'module.exports = {'
]:
    if marker not in index + api:
        raise SystemExit(f'INCOMPATIBLE_BASE_MISSING:{marker}')

traffic_api = r'''
function integrateHetznerBandwidthSeries(values = [], fallbackStep = 60) {
  let total = 0;
  const rows = Array.isArray(values) ? values : [];

  for (let i = 0; i < rows.length; i += 1) {
    const timestamp = Number(rows[i]?.[0]);
    const bandwidth = Math.max(0, Number(rows[i]?.[1] || 0));
    const nextTimestamp = Number(rows[i + 1]?.[0]);
    let seconds = Number.isFinite(nextTimestamp) && nextTimestamp > timestamp
      ? nextTimestamp - timestamp
      : fallbackStep;

    seconds = Math.max(1, Math.min(seconds, fallbackStep * 4));
    total += bandwidth * seconds;
  }

  return Math.max(0, total);
}

function sumHetznerMetricDirection(timeSeries, direction, step) {
  let total = 0;

  for (const [key, value] of Object.entries(timeSeries || {})) {
    if (!String(key).endsWith(`.bandwidth.${direction}`)) continue;
    total += integrateHetznerBandwidthSeries(value?.values, step);
  }

  return total;
}

async function getServerTraffic(dcConfig, _token, serverId, range = 'current') {
  const http = client(dcConfig);
  const selectedRange = ['current', '24h', '7d', '30d'].includes(String(range))
    ? String(range)
    : 'current';

  const { data: serverData } = await http.get(`/servers/${serverId}`);
  const server = serverData?.server;

  if (!server) {
    const error = new Error('HETZNER_SERVER_NOT_FOUND');
    error.status = 404;
    throw error;
  }

  const result = {
    server_id: String(server.id),
    server_name: server.name || String(server.id),
    status: server.status || 'unknown',
    range: selectedRange,
    incoming_traffic: Math.max(0, Number(server.ingoing_traffic || 0)),
    outgoing_traffic: Math.max(0, Number(server.outgoing_traffic || 0)),
    included_traffic: Math.max(0, Number(server.included_traffic || 0)),
    period_incoming_traffic: null,
    period_outgoing_traffic: null,
    period_available: selectedRange === 'current',
    generated_at: new Date().toISOString()
  };

  if (selectedRange === 'current') {
    result.period_incoming_traffic = result.incoming_traffic;
    result.period_outgoing_traffic = result.outgoing_traffic;
    return result;
  }

  const hoursByRange = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30 };
  const stepByRange = { '24h': 60, '7d': 300, '30d': 1800 };
  const hours = hoursByRange[selectedRange];
  const step = stepByRange[selectedRange];
  const end = new Date();
  const start = new Date(end.getTime() - hours * 3600000);

  try {
    const { data: metricData } = await http.get(`/servers/${serverId}/metrics`, {
      params: {
        type: 'network',
        start: start.toISOString(),
        end: end.toISOString(),
        step
      }
    });

    const timeSeries = metricData?.metrics?.time_series || {};
    result.period_incoming_traffic = sumHetznerMetricDirection(timeSeries, 'in', step);
    result.period_outgoing_traffic = sumHetznerMetricDirection(timeSeries, 'out', step);
    result.period_available = true;
  } catch (error) {
    if (Number(error?.response?.status || error?.status || 0) === 404) throw error;
    result.period_available = false;
    result.metric_error = String(error?.message || 'metrics unavailable').slice(0, 180);
  }

  return result;
}
'''

if 'async function getServerTraffic(' not in api:
    marker = 'async function getServer(dcConfig,'
    pos = api.find(marker)
    if pos < 0:
        raise SystemExit('GET_SERVER_MARKER_NOT_FOUND')
    api = api[:pos] + traffic_api + '\n\n' + api[pos:]

export_pos = api.rfind('module.exports = {')
if export_pos < 0:
    raise SystemExit('API_EXPORT_BLOCK_NOT_FOUND')
api_head, api_exports = api[:export_pos], api[export_pos:]
if '  getServerTraffic,' not in api_exports:
    export_marker = '  getServer,\n'
    if export_marker not in api_exports:
        raise SystemExit('GET_SERVER_EXPORT_MARKER_NOT_FOUND')
    api_exports = api_exports.replace(export_marker, export_marker + '  getServerTraffic,\n', 1)
api = api_head + api_exports

if 'getServerTraffic:' not in cloud:
    lines = cloud.splitlines(True)
    inserted = False
    for i, line in enumerate(lines):
        if re.search(r'^\s*getServer\s*:', line):
            indent = re.match(r'^(\s*)', line).group(1)
            lines.insert(i + 1, indent + "getServerTraffic:      (dc, ...a) => pick(dc).getServerTraffic ? pick(dc).getServerTraffic(dc, ...a) : Promise.reject(new Error('traffic not supported')),\n")
            inserted = True
            break
    if not inserted:
        raise SystemExit('CLOUD_GET_SERVER_EXPORT_NOT_FOUND')
    cloud = ''.join(lines)

index_helpers = r'''
function isHetznerProviderNotFound(error) {
  const status = Number(
    error?.response?.status ||
    error?.status ||
    error?.cause?.response?.status ||
    error?.cause?.status ||
    0
  );
  const code = String(
    error?.response?.data?.error?.code ||
    error?.data?.error?.code ||
    error?.code ||
    ''
  ).toLowerCase();

  return status === 404 || code === 'not_found' || code === 'server_not_found';
}

async function markHetznerProviderMissing(userId, serverId, dcConfig) {
  const purchase = await getPurchaseForUserServer(
    userId,
    serverId,
    dcConfig?.key
  ).catch(() => null);

  if (!purchase) {
    return { changed: false, purchase: null };
  }

  const previousStatus = String(purchase.status || '').toLowerCase();
  const changed = previousStatus !== 'provider_missing' || Number(purchase.auto_renew ?? 1) !== 0;

  if (changed) {
    await setPurchaseAutoRenew(
      userId,
      serverId,
      purchase.datacenter || dcConfig.key,
      false
    ).catch(() => false);

    await updatePurchaseStatus(
      serverId,
      'provider_missing',
      Number(purchase.last_billed_traffic_gb || 0),
      purchase.last_billed_at || new Date()
    );

    await updatePurchaseSuspendReason(
      serverId,
      'provider_missing'
    ).catch(() => null);

    console.warn('[HETZNER_PROVIDER_MISSING]', {
      user_id: String(userId),
      server_id: String(serverId),
      datacenter: purchase.datacenter || dcConfig.key,
      previous_status: previousStatus,
      billing_stopped: true
    });
  }

  return { changed, purchase };
}

function formatTrafficBytesFa(bytes) {
  const value = Math.max(0, Number(bytes || 0));
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  if (value < 1024) return `${Math.round(value)} B`;
  const unitIndex = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const normalized = value / Math.pow(1024, unitIndex);
  const digits = normalized >= 100 ? 0 : normalized >= 10 ? 1 : 2;
  return `${normalized.toFixed(digits)} ${units[unitIndex]}`;
}

function hetznerTrafficRangeLabel(range) {
  return ({
    current: 'دوره جاری Hetzner',
    '24h': '۲۴ ساعت گذشته',
    '7d': '۷ روز گذشته',
    '30d': '۳۰ روز گذشته'
  })[range] || 'دوره جاری Hetzner';
}

async function handleHetznerTrafficInfo(chatId, userId, serverId, dcConfig, range = 'current') {
  const purchase = await getPurchaseForUserServer(userId, serverId, dcConfig?.key).catch(() => null);
  if (!purchase || String(purchase.telegram_id) !== String(userId)) {
    return sendMessage(chatId, '❌ این سرور متعلق به حساب شما نیست.');
  }

  try {
    const token = await openstackApi.getToken(dcConfig);
    const traffic = await openstackApi.getServerTraffic(dcConfig, token, serverId, range);
    const incoming = Number(traffic.period_incoming_traffic || 0);
    const outgoing = Number(traffic.period_outgoing_traffic || 0);
    const included = Number(traffic.included_traffic || 0);
    const quotaUsed = Number(traffic.outgoing_traffic || 0);
    const remaining = Math.max(0, included - quotaUsed);
    const percent = included > 0 ? Math.min(100, quotaUsed / included * 100) : 0;
    const selectedRange = traffic.range || range || 'current';

    let text =
      `<b>📊 مصرف ترافیک سرور</b>\n\n` +
      `🖥 <b>${htmlEscape(traffic.server_name || serverId)}</b>\n` +
      `🗓 بازه: ${htmlEscape(hetznerTrafficRangeLabel(selectedRange))}\n\n`;

    if (traffic.period_available) {
      text +=
        `⬇️ ورودی: <b>${htmlEscape(formatTrafficBytesFa(incoming))}</b>\n` +
        `⬆️ خروجی: <b>${htmlEscape(formatTrafficBytesFa(outgoing))}</b>\n` +
        `🔄 مجموع تبادل: <b>${htmlEscape(formatTrafficBytesFa(incoming + outgoing))}</b>\n\n`;
    } else {
      text += `⚠️ متریک جزئی این بازه موقتاً از Hetzner دریافت نشد.\n\n`;
    }

    text +=
      `<b>سهمیه دوره جاری</b>\n` +
      `🎁 سقف ترافیک: ${htmlEscape(formatTrafficBytesFa(included))}\n` +
      `📤 مصرف مشمول سهمیه: ${htmlEscape(formatTrafficBytesFa(quotaUsed))}\n` +
      `📉 باقی‌مانده: ${htmlEscape(formatTrafficBytesFa(remaining))}\n` +
      `📈 درصد مصرف: ${percent.toFixed(2)}%\n\n` +
      `<i>در Hetzner، ترافیک خروجی معیار مصرف سهمیه است و ورودی برای اطلاع نمایش داده می‌شود.</i>`;

    const short = (selected, label) => ({
      text: label,
      callback_data: makeShortCb(userId, {
        action: 'HETZNER_TRAFFIC',
        dcKey: dcConfig.key,
        serverId,
        range: selected
      })
    });

    return sendMessage(chatId, text, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [short('current', '📊 دوره جاری'), short('24h', '🕐 ۲۴ ساعت')],
          [short('7d', '📅 ۷ روز'), short('30d', '🗓 ۳۰ روز')],
          [short(selectedRange, '🔄 بروزرسانی')],
          [{
            text: '🔙 بازگشت',
            callback_data: makeShortCb(userId, {
              action: 'M',
              dcKey: dcConfig.key,
              serverId
            })
          }]
        ]
      }
    });
  } catch (error) {
    if (isHetznerProviderNotFound(error)) {
      await markHetznerProviderMissing(userId, serverId, dcConfig);
      return sendMessage(
        chatId,
        '⚠️ این سرور در زیرساخت ارائه‌دهنده پیدا نشد. محاسبه هزینه و تمدید خودکار آن متوقف شد و موضوع نیازمند بررسی پشتیبانی است.'
      );
    }

    console.error('[HETZNER_TRAFFIC_ERROR]', {
      server_id: String(serverId),
      datacenter: dcConfig?.key,
      status: error?.response?.status || error?.status || null,
      message: error?.message
    });
    return sendMessage(chatId, '❌ دریافت اطلاعات ترافیک در حال حاضر ممکن نیست. لطفاً کمی بعد دوباره تلاش کنید.');
  }
}
'''

if 'async function handleHetznerTrafficInfo(' not in index:
    marker = 'async function handleServerManagement('
    pos = index.find(marker)
    if pos < 0:
        raise SystemExit('MANAGEMENT_FUNCTION_NOT_FOUND')
    index = index[:pos] + index_helpers + '\n\n' + index[pos:]

if "case 'HETZNER_TRAFFIC':" not in index:
    marker = "      case 'GET_TRAFFIC': {"
    pos = index.find(marker)
    if pos < 0:
        marker = "case 'GET_TRAFFIC': {"
        pos = index.find(marker)
    if pos < 0:
        raise SystemExit('GET_TRAFFIC_CALLBACK_NOT_FOUND')
    callback_case = r'''      case 'HETZNER_TRAFFIC': {
        const dc = getUserEffectiveDCs(effectiveUserId)[payload.dcKey];
        if (!dc || !isHetznerDc(dc)) {
          return sendMessage(effectiveChatId, '❌ این قابلیت فقط برای سرورهای Hetzner فعال است.');
        }
        return handleHetznerTrafficInfo(
          effectiveChatId,
          effectiveUserId,
          payload.serverId,
          dc,
          payload.range || 'current'
        );
      }

'''
    index = index[:pos] + callback_case + index[pos:]

management_start = index.find('async function handleServerManagement(')
management_end = index.find('\nasync function ', management_start + 20)
if management_start < 0 or management_end < 0:
    raise SystemExit('MANAGEMENT_SLICE_NOT_FOUND')
management = index[management_start:management_end]

if "text: '📊 مصرف ترافیک'" not in management:
    short_marker = "    const short = (action, extra = {}) => makeShortCb(userId, { action, dcKey: dcConfig.key, serverId: srv.id, ...extra });\n"
    if short_marker not in management:
        raise SystemExit('MANAGEMENT_SHORT_MARKER_NOT_FOUND')
    button = "\n    if (isHetznerDc(dcConfig)) {\n      keyboard.push([{ text: '📊 مصرف ترافیک', callback_data: short('HETZNER_TRAFFIC', { range: 'current' }) }]);\n    }\n"
    management = management.replace(short_marker, short_marker + button, 1)

old_catch = """  } catch (e) {
    console.error(`Manage Server Error for ${serverId} in ${dcConfig.name}:`, e);
    sendMessage(chatId, `❌ خطا در دریافت اطلاعات سرور: ${escapeMarkdownV2(e.message)}`);
  }
}"""
new_catch = """  } catch (e) {
    if (isHetznerDc(dcConfig) && isHetznerProviderNotFound(e)) {
      await markHetznerProviderMissing(userId, serverId, dcConfig);
      return sendMessage(
        chatId,
        '⚠️ این سرور در زیرساخت ارائه‌دهنده پیدا نشد. محاسبه هزینه و تمدید خودکار آن متوقف شد و موضوع نیازمند بررسی پشتیبانی است.'
      );
    }

    console.error(`Manage Server Error for ${serverId} in ${dcConfig.name}:`, e);
    return sendMessage(chatId, '❌ دریافت اطلاعات سرور در حال حاضر ممکن نیست. لطفاً کمی بعد دوباره تلاش کنید.');
  }
}"""

if 'محاسبه هزینه و تمدید خودکار آن متوقف شد' not in management:
    if old_catch not in management:
        raise SystemExit('MANAGEMENT_CATCH_MARKER_NOT_FOUND')
    management = management.replace(old_catch, new_catch, 1)

index = index[:management_start] + management + index[management_end:]

if '[BILLING_HETZNER_PROVIDER_404]' not in index:
    billing_marker = "    const userId = String(telegram_id);\n"
    billing_start = index.find('// 💳 حلقه‌ی صورتحساب سرورها')
    if billing_start < 0:
        billing_start = index.find('for (const purchase of allPurchases)')
    marker_pos = index.find(billing_marker, billing_start)
    if marker_pos < 0:
        raise SystemExit('BILLING_USER_MARKER_NOT_FOUND')
    insert_at = marker_pos + len(billing_marker)
    billing_guard = r'''

    if (isHetznerDc(dcConfig)) {
      try {
        const providerToken = await openstackApi.getToken(dcConfig);
        await openstackApi.getServer(dcConfig, providerToken, server_id);
      } catch (providerError) {
        if (isHetznerProviderNotFound(providerError)) {
          await markHetznerProviderMissing(userId, server_id, dcConfig);
          console.warn('[BILLING_HETZNER_PROVIDER_404]', {
            user_id: userId,
            server_id: String(server_id),
            datacenter: purchase.datacenter,
            debit_skipped: true
          });
          await sendMessage(
            userId,
            `⚠️ سرور ${server_name || server_id} در زیرساخت Hetzner پیدا نشد. محاسبه هزینه و تمدید خودکار آن متوقف شد.`
          ).catch(() => null);
          continue;
        }

        console.warn('[BILLING_HETZNER_PREFLIGHT_WARNING]', {
          server_id: String(server_id),
          datacenter: purchase.datacenter,
          status: providerError?.response?.status || providerError?.status || null,
          message: providerError?.message
        });
      }
    }
'''
    index = index[:insert_at] + billing_guard + index[insert_at:]

required = {
    'api': [
        'async function getServerTraffic(',
        '.bandwidth.${direction}',
        '  getServerTraffic,'
    ],
    'cloud': ['getServerTraffic:'],
    'index': [
        "case 'HETZNER_TRAFFIC':",
        "text: '📊 مصرف ترافیک'",
        'async function handleHetznerTrafficInfo(',
        'async function markHetznerProviderMissing(',
        '[BILLING_HETZNER_PROVIDER_404]',
        "'provider_missing'",
        'محاسبه هزینه و تمدید خودکار آن متوقف شد'
    ]
}

for marker in required['api']:
    if marker not in api:
        raise SystemExit(f'API_PATCH_MISSING:{marker}')
for marker in required['cloud']:
    if marker not in cloud:
        raise SystemExit(f'CLOUD_PATCH_MISSING:{marker}')
for marker in required['index']:
    if marker not in index:
        raise SystemExit(f'INDEX_PATCH_MISSING:{marker}')

api_path.write_text(api, encoding='utf-8')
cloud_path.write_text(cloud, encoding='utf-8')
index_path.write_text(index, encoding='utf-8')
print('TRAFFIC_PROVIDER404_SOURCE_PATCH=SUCCESS')
PY

echo
 echo "===== CREATE ISOLATED STAGING ====="
mkdir -p "$STAGING"
rsync -a --exclude node_modules --exclude .git --exclude '*.log' "$PRODUCTION/" "$STAGING/"
ln -s "$PRODUCTION/node_modules" "$STAGING/node_modules"
python3 "$PATCHER" "$STAGING"
echo "TRAFFIC_PROVIDER404_STAGING=PATCHED"

echo
 echo "===== STAGING TESTS ====="
node --check "$STAGING/index.js"
node --check "$STAGING/cloud-api.js"
node --check "$STAGING/Hetzner/hetzner-api.js"
(
  cd "$STAGING"
  npm test
)
python3 - "$STAGING" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1])
checks = {
  'index.js': [
    "case 'HETZNER_TRAFFIC':",
    "text: '📊 مصرف ترافیک'",
    '[BILLING_HETZNER_PROVIDER_404]',
    "'provider_missing'",
  ],
  'cloud-api.js': ['getServerTraffic:'],
  'Hetzner/hetzner-api.js': [
    'async function getServerTraffic(',
    '/metrics',
    'included_traffic',
    'outgoing_traffic',
  ],
}
for rel, markers in checks.items():
    text = (root / rel).read_text(encoding='utf-8')
    for marker in markers:
        assert marker in text, (rel, marker)
print('TRAFFIC_PROVIDER404_STATIC_TEST=SUCCESS')
PY
echo "TRAFFIC_PROVIDER404_STAGING_TESTS=SUCCESS"

echo
 echo "===== READ-ONLY LIVE TRAFFIC API SMOKE TEST ====="
(
  cd "$STAGING"
  DB_AUTO_INIT=false DISABLE_AUTO_BILLING=1 node <<'NODE'
'use strict';
require('dotenv').config({ path: '/root/Hamoon/.env' });
const db = require('./db');
const datacenters = require('./datacenters');
const cloud = require('./cloud-api');

function isHetzner(dc, key) {
  const provider = String(dc?.provider || dc?.apiType || '').toLowerCase();
  return provider === 'hetzner' || key === 'hetzner' || String(key).startsWith('hetzner-');
}

(async () => {
  const [rows] = await db.pool.query(`
    SELECT server_id, datacenter
    FROM purchases
    WHERE status IN ('active', 'suspended')
      AND datacenter LIKE 'hetzner%'
    ORDER BY updated_at DESC
    LIMIT 20
  `);

  let tested = false;
  for (const row of rows || []) {
    const dc = datacenters[row.datacenter];
    if (!dc || !isHetzner(dc, row.datacenter)) continue;
    try {
      const data = await cloud.getServerTraffic(dc, null, row.server_id, 'current');
      console.log(`LIVE_TRAFFIC_INCLUDED_BYTES=${Number(data.included_traffic || 0)}`);
      console.log(`LIVE_TRAFFIC_OUTGOING_BYTES=${Number(data.outgoing_traffic || 0)}`);
      console.log('LIVE_HETZNER_TRAFFIC_TEST=SUCCESS');
      tested = true;
      break;
    } catch (error) {
      const status = Number(error?.response?.status || error?.status || 0);
      if (status === 404) continue;
      console.warn('[LIVE_TRAFFIC_TEST_SKIP]', status || 'unknown', error?.message);
    }
  }

  if (!tested) console.log('LIVE_HETZNER_TRAFFIC_TEST=SKIPPED_NO_REACHABLE_ACTIVE_SERVER');
  await db.pool.end();
})().catch(async error => {
  console.error(error);
  try { await db.pool.end(); } catch {}
  process.exit(1);
});
NODE
)

echo
 echo "===== STOP APPLICATIONS ====="
pm2 stop hamoonbot
pm2 stop dashboard-server
APPS_STOPPED=1
echo "APPLICATIONS_STOPPED=SUCCESS"

echo
 echo "===== INSTALL HOTFIX FILES ====="
install -m 0644 "$STAGING/index.js" "$PRODUCTION/index.js"
install -m 0644 "$STAGING/cloud-api.js" "$PRODUCTION/cloud-api.js"
install -m 0644 "$STAGING/Hetzner/hetzner-api.js" "$PRODUCTION/Hetzner/hetzner-api.js"
FILES_INSTALLED=1
echo "TRAFFIC_PROVIDER404_FILES=INSTALLED"

echo
 echo "===== TEST INSTALLED CODE ====="
cd "$PRODUCTION"
node --check index.js
node --check cloud-api.js
node --check Hetzner/hetzner-api.js
npm test
echo "INSTALLED_TRAFFIC_PROVIDER404_TESTS=SUCCESS"

echo
 echo "===== RECONCILE CURRENT HETZNER 404 RECORDS ====="
DB_AUTO_INIT=false DISABLE_AUTO_BILLING=1 node <<'NODE' | tee "$BACKUP/provider404-reconciliation.txt"
'use strict';
require('dotenv').config({ path: '/root/Hamoon/.env' });
const db = require('./db');
const datacenters = require('./datacenters');
const cloud = require('./cloud-api');

function is404(error) {
  const status = Number(error?.response?.status || error?.status || error?.cause?.response?.status || 0);
  const code = String(error?.response?.data?.error?.code || error?.data?.error?.code || error?.code || '').toLowerCase();
  return status === 404 || code === 'not_found' || code === 'server_not_found';
}

(async () => {
  const [rows] = await db.pool.query(`
    SELECT server_id, telegram_id, datacenter, status, auto_renew,
           last_billed_at, last_billed_traffic_gb
    FROM purchases
    WHERE status IN ('active', 'suspended')
      AND datacenter LIKE 'hetzner%'
    ORDER BY updated_at DESC
  `);

  require('fs').writeFileSync(
    process.env.RECON_BACKUP_FILE || '/tmp/hamoon-provider404-candidates.json',
    JSON.stringify(rows || [], null, 2),
    { mode: 0o600 }
  );

  let checked = 0;
  let marked = 0;
  let transient = 0;

  for (const row of rows || []) {
    const dc = datacenters[row.datacenter];
    if (!dc) continue;
    checked += 1;
    try {
      await cloud.getServer(dc, null, row.server_id);
    } catch (error) {
      if (!is404(error)) {
        transient += 1;
        continue;
      }

      await db.pool.query(`
        UPDATE purchases
        SET status = 'provider_missing',
            auto_renew = 0,
            auto_renew_disabled_at = COALESCE(auto_renew_disabled_at, NOW()),
            renewal_stopped_at = COALESCE(renewal_stopped_at, NOW()),
            suspend_reason = 'provider_missing',
            lifecycle_error_code = 'PROVIDER_NOT_FOUND_404',
            lifecycle_updated_at = NOW(),
            updated_at = NOW()
        WHERE server_id = ?
          AND telegram_id = ?
          AND datacenter = ?
          AND status IN ('active', 'suspended')
      `, [String(row.server_id), String(row.telegram_id), String(row.datacenter)]);
      marked += 1;
    }
  }

  console.log(`PROVIDER404_RECON_CHECKED=${checked}`);
  console.log(`PROVIDER404_RECON_MARKED=${marked}`);
  console.log(`PROVIDER404_RECON_TRANSIENT_SKIPS=${transient}`);
  console.log('PROVIDER404_RECONCILIATION=SUCCESS');
  await db.pool.end();
})().catch(async error => {
  console.error(error);
  try { await db.pool.end(); } catch {}
  process.exit(1);
});
NODE

cp -f /tmp/hamoon-provider404-candidates.json "$BACKUP/provider404-candidates-before.json" 2>/dev/null || true
rm -f /tmp/hamoon-provider404-candidates.json

echo
 echo "===== START APPLICATIONS ====="
restart_apps
APPS_STOPPED=0
POST_BOT="$(app_status hamoonbot)"
POST_DASH="$(app_status dashboard-server)"
POST_HTTP="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 http://127.0.0.1:3000/health 2>/dev/null || true)"
echo "POST_HAMOONBOT_STATUS=$POST_BOT"
echo "POST_DASHBOARD_SERVER_STATUS=$POST_DASH"
echo "FINAL_DASHBOARD_HTTP=$POST_HTTP"
if [ "$POST_BOT" != "online" ] || [ "$POST_DASH" != "online" ] || [ "$POST_HTTP" != "200" ]; then
  echo "ERROR: service health failed after hotfix"
  exit 1
fi

sha256sum index.js cloud-api.js Hetzner/hetzner-api.js | tee "$BACKUP/post-patch-files.sha256"

{
  echo "HAMOON_HETZNER_TRAFFIC_PROVIDER404_V1=SUCCESS"
  echo "HETZNER_TRAFFIC_BUTTON=ENABLED"
  echo "HETZNER_TRAFFIC_RANGES=current,24h,7d,30d"
  echo "HETZNER_404_STATUS=provider_missing"
  echo "HETZNER_404_AUTO_RENEW=DISABLED"
  echo "HETZNER_404_FUTURE_BILLING=BLOCKED"
  echo "WALLET_REFUND_APPLIED=NO"
  echo "HOTFIX_BACKUP=$BACKUP/original-files.tar.gz"
  echo "HOTFIX_REPORT=$REPORT"
  echo "NO_NPM_INSTALL_WAS_RUN"
  echo "NO_GIT_COMMANDS_WERE_RUN"
} | tee "$REPORT"

trap - ERR
cleanup

echo
 echo "HETZNER TRAFFIC + PROVIDER-404 HOTFIX v1 DEPLOYMENT COMPLETED"
'@

try {
    $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($LocalTemp, ($RemoteScript -replace "`r`n", "`n"), $Utf8NoBom)

    Write-Host ""
    Write-Host "===== UPLOAD HETZNER TRAFFIC / PROVIDER-404 HOTFIX =====" -ForegroundColor Cyan
    & $ScpPath @Options $LocalTemp "root@${ServerIP}:$RemotePath"
    if ($LASTEXITCODE -ne 0) {
        throw "Upload failed with exit code $LASTEXITCODE"
    }

    Write-Host ""
    Write-Host "===== DEPLOY HETZNER TRAFFIC / PROVIDER-404 HOTFIX =====" -ForegroundColor Cyan
    & $SshPath @Options "root@$ServerIP" "chmod 700 '$RemotePath' && bash '$RemotePath'; rc=`$?; rm -f '$RemotePath'; exit `$rc"
    if ($LASTEXITCODE -ne 0) {
        throw "Hetzner traffic/provider-404 hotfix failed with exit code $LASTEXITCODE. Review rollback markers above."
    }

    Write-Host ""
    Write-Host "HETZNER TRAFFIC + PROVIDER-404 HOTFIX v1 DEPLOYMENT COMPLETED" -ForegroundColor Green
}
finally {
    Remove-Item -LiteralPath $LocalTemp -Force -ErrorAction SilentlyContinue
}
