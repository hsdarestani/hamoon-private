#!/usr/bin/env python3
from pathlib import Path


def replace_once(text, old, new, label):
    if new in text:
        return text
    if old not in text:
        raise SystemExit(f'{label}: marker not found')
    return text.replace(old, new, 1)


# Preserve original Hetzner root password and create action.
p = Path('Hetzner/hetzner-api.js')
s = p.read_text()
s = replace_once(
    s,
    "    const r = await c.post('/servers', attemptPayload);\n    return r.data.server;",
    "    const r = await c.post('/servers', attemptPayload);\n    const data = r.data || {};\n    const server = data.server || {};\n    server.action = data.action || null;\n    server.root_password = data.root_password || null;\n    return server;",
    'hetzner create response'
)
p.write_text(s)


# Enable health gate on real Hetzner DC configs.
p = Path('datacenters.js')
s = p.read_text()
if 'HETZNER_PURCHASE_HEALTH_GATE:' not in s:
    s = replace_once(
        s,
        "    HETZNER_PASSWORD_ONLY: true,\n",
        "    HETZNER_PASSWORD_ONLY: true,\n    HETZNER_PURCHASE_HEALTH_GATE: process.env.HETZNER_PURCHASE_HEALTH_GATE !== 'false',\n",
        'datacenter health gate'
    )
p.write_text(s)


# DB fields and helpers for quality retries.
p = Path('db.js')
s = p.read_text()
if "'ip_quality_attempts'" not in s:
    marker = "        await ensureColumn(connection, 'purchases', 'lifecycle_updated_at', 'DATETIME NULL');\n"
    s = replace_once(
        s,
        marker,
        marker +
        "        await ensureColumn(connection, 'purchases', 'ip_quality_attempts', 'INT NOT NULL DEFAULT 0');\n"
        "        await ensureColumn(connection, 'purchases', 'ip_quality_checked_at', 'DATETIME NULL');\n"
        "        await ensureColumn(connection, 'purchases', 'ip_quality_summary', 'VARCHAR(255) NULL');\n",
        'db quality columns'
    )
if "'pending_ip_quality',\n       'rebuilding'" not in s:
    s = replace_once(
        s,
        "       'pending_ip',\n       'pending_ssh',\n       'rebuilding'",
        "       'pending_ip',\n       'pending_ssh',\n       'pending_ip_quality',\n       'rebuilding'",
        'db pending provisioning statuses'
    )
if 'async function updateIpQualityResult(' not in s:
    marker = "\n\nasync function getAllActivePurchases() {"
    fn = r'''

async function updateIpQualityResult(
  telegramId,
  serverId,
  datacenter,
  summary,
  incrementAttempt = false
) {
  const [result] = await pool.execute(
    `UPDATE purchases
     SET ip_quality_checked_at = NOW(),
         ip_quality_summary = ?,
         ip_quality_attempts = ip_quality_attempts + ?,
         lifecycle_updated_at = NOW(),
         updated_at = NOW()
     WHERE telegram_id = ?
       AND server_id = ?
       AND datacenter = ?`,
    [
      String(summary || '').slice(0, 255) || null,
      incrementAttempt ? 1 : 0,
      String(telegramId),
      String(serverId),
      String(datacenter)
    ]
  );
  return result.affectedRows > 0;
}
'''
    if marker not in s:
        raise SystemExit('db quality helper insertion marker not found')
    s = s.replace(marker, fn + marker, 1)
s = s.replace(
    "const PENDING_SERVER_STATUSES = ['pending_ssh','pending_ip','provisioning','building','deletion_pending','manual_review','provider_missing','provisioning_failed'];",
    "const PENDING_SERVER_STATUSES = ['pending_ssh','pending_ip','pending_ip_quality','provisioning','building','deletion_pending','manual_review','provider_missing','provisioning_failed'];"
)
s = s.replace(
    "status NOT IN ('deleted','deletion_pending','provider_missing','provisioning','pending_ip','pending_ssh')",
    "status NOT IN ('deleted','deletion_pending','provider_missing','provisioning','pending_ip','pending_ssh','pending_ip_quality','manual_review')"
)
if '    updateIpQualityResult,\n' not in s:
    s = replace_once(s, '    markDelivered,\n', '    markDelivered,\n    updateIpQualityResult,\n', 'db quality export')
p.write_text(s)


# Replace purchase handler with guarded delivery flow.
p = Path('index-core.js')
s = p.read_text()
start = s.index('async function handlePurchaseConfirmation(')
end = s.index('\n\n\nasync function handleStartMySuspendedServers', start)
fn = r'''async function handlePurchaseConfirmation(chatId, userId, messageId, dcConfig) {
  if (state[userId]?.purchaseInProgress) return sendMessage(chatId, '⏳ در حال پردازش خرید قبلی هستیم...');
  state[userId] = { ...(state[userId] || {}), purchaseInProgress: true };
  await editOrSendMessage(chatId, messageId, '🚀 در حال ساخت سرور شما...').catch(() => {});

  let srv = null;
  let purchaseRecorded = false;
  let effectiveDc = dcConfig || state[userId]?.selectedDatacenterConfig;

  try {
    const { selectedFlavor, selectedImage, selectedCycle } = state[userId];
    if (!effectiveDc) return sendMessage(chatId, '❌ دیتاسنتر از state پیدا نشد. دوباره خرید را شروع کنید.');
    const allowedCycles = getAllowedCycles(effectiveDc);
    if (!selectedFlavor || !selectedImage) return sendMessage(chatId, '❌ اطلاعات خرید منقضی شده است. دوباره خرید را شروع کنید.');
    if (!allowedCycles.includes(selectedCycle)) return sendMessage(chatId, '❌ سیکل پرداخت انتخاب‌شده برای این دیتاسنتر مجاز نیست.');

    const finalPrice = getFlavorCyclePrice(selectedFlavor, selectedCycle);
    const amountForDb = finalPrice;
    const isHetzner = isHetznerDc(effectiveDc);
    const isAfra = effectiveDc.provider === 'afracloud' || effectiveDc.apiType === 'afracloud';
    const isTebyan = effectiveDc.key === 'tebyan';

    console.log('[PURCHASE]', { dcKey: effectiveDc.key, provider: effectiveDc.provider, apiType: effectiveDc.apiType, selectedFlavor: selectedFlavor?.id || selectedFlavor?.name, selectedCycle, finalPrice });

    const balance = await getUserWallet(userId);
    if (balance < finalPrice) {
      return sendMessage(chatId, `❌ موجودی شما برای خرید این سرور کافی نیست. حداقل موجودی مورد نیاز: ${formatToman(finalPrice)} تومان\n💰 لطفاً از منوی «افزایش اعتبار» کیف پول خود را شارژ کنید.`, mainMenu);
    }

    const serverName = `Srv-${getServerNamePrefix(effectiveDc)}-${crypto.randomBytes(3).toString('hex')}`;
    let rawPrivateKey = null, rootPassword = null, tok = null;
    let generatedRootPassword = null;
    let hetznerKeyId = null;

    if (!isHetzner) {
      tok = await openstackApi.getToken(effectiveDc);
      let keyName = null, kp = null;
      if (!isAfra) {
        keyName = `user-${userId}-${crypto.randomBytes(4).toString('hex')}`;
        kp = await openstackApi.createKeyPair(effectiveDc, tok, keyName);
      }
      const isSnapshot = selectedImage.type === 'snapshot';
      const serverMeta = { user: userId, type: 'purchased', datacenter: effectiveDc.key };
      let createOptions = {};
      let bootMethod = 'volume';
      if (isAfra || isTebyan) {
        generatedRootPassword = generateStrongPassword();
        serverMeta.passwordManagedByBot = true;
      }
      if (isAfra) serverMeta.rootPassword = generatedRootPassword;
      if (isTebyan) {
        bootMethod = effectiveDc.TEBYAN_ENABLE_BOOT_FROM_VOLUME === true ? 'volume' : 'image';
        const sgName = await openstackApi.ensureSshSecurityGroup(effectiveDc, tok);
        createOptions = { security_groups: [sgName], user_data: buildTebyanRootPasswordCloudInit(generatedRootPassword) };
      }
      srv = await openstackApi.createServer(effectiveDc, tok, serverName, selectedFlavor.id, selectedImage.id, keyName, serverMeta, selectedFlavor.disk, bootMethod, isSnapshot, createOptions);
      rawPrivateKey = kp?.private_key ? String(kp.private_key || '').replace(/-----BEGIN RSA PRIVATE KEY-----/g, '').replace(/-----END RSA PRIVATE KEY-----/g, '').trim() : null;
      rootPassword = (isAfra || isTebyan) ? generatedRootPassword : srv.adminPass;
    } else {
      const passwordOnly = !!effectiveDc.HETZNER_PASSWORD_ONLY;
      if (!passwordOnly) {
        const kp = await openstackApi.createKeyPair(effectiveDc, null, `user-${userId}`);
        hetznerKeyId = kp.key_id || null;
      }
      const userData = `#cloud-config
ssh_pwauth: true
disable_root: false
write_files:
  - path: /etc/ssh/sshd_config.d/99-hamoon.conf
    permissions: '0644'
    content: |
      PasswordAuthentication yes
      PermitRootLogin yes
runcmd:
  - systemctl reload ssh || systemctl restart ssh
`;
      srv = await openstackApi.createServer(effectiveDc, null, {
        name: serverName,
        serverType: selectedFlavor?.hetzner_type || selectedFlavor?.id,
        image: selectedImage?.name || selectedImage?.id,
        location: effectiveDc.HETZNER_LOCATION,
        key_id: passwordOnly ? null : hetznerKeyId,
        userLabel: userId,
        user_data: userData
      });
      rootPassword = srv.root_password || null;
    }

    if (!srv?.id) throw new Error('شناسه سرور از Provider دریافت نشد.');

    if ((isAfra || isTebyan) && generatedRootPassword) {
      try {
        await upsertServerSecret({ telegramId: userId, serverId: srv.id, datacenter: effectiveDc.key, secretType: 'root_password', secretValue: generatedRootPassword });
      } catch (secretErr) {
        logServerEvent({ type: 'server_secret_store_failed', user_id: userId, server_id: srv.id, datacenter: effectiveDc.key, message: secretErr.code || secretErr.message });
        if (SUPPORT_ID) await sendMessage(SUPPORT_ID, `🚨 Secret store failed\nuser_id=${userId}\nserver_id=${srv.id}\ndc=${effectiveDc.key}\nerror=${secretErr.code || secretErr.message}`).catch(() => null);
        return sendMessage(chatId, 'سرور ساخته شد اما ذخیره امن رمز عبور با خطا مواجه شد. لطفاً با پشتیبانی تماس بگیرید.', mainMenu);
      }
    }

    await debitUser(userId, finalPrice);
    const initialStatus = (isHetzner || isTebyan) ? 'provisioning' : 'active';
    const purchaseBootMethod = isTebyan ? (effectiveDc.TEBYAN_ENABLE_BOOT_FROM_VOLUME === true ? 'volume' : 'image') : 'volume';
    await recordPurchase(
      userId, srv.id, effectiveDc.key, serverName, selectedFlavor.id, amountForDb, selectedCycle,
      DEFAULT_PRICE_PER_GB, DEFAULT_DOWNLOAD_ONLY,
      purchaseBootMethod === 'volume' ? srv.id : null, purchaseBootMethod, selectedImage.label,
      0, 0, 0, 0, 0,
      isHetzner ? hetznerKeyId : null,
      initialStatus,
      isHetzner ? 2 : 1,
      { providerActionId: isHetzner ? (srv.action?.id || null) : null }
    );
    await recordWalletLog(userId, -finalPrice, `خرید سرور ${serverName} (${effectiveDc.name})`, 'purchase');
    purchaseRecorded = true;

    let ip = extractServerIp(srv);

    if (isHetzner) {
      if (!rootPassword) {
        await require('./db').updateScopedStatus(userId, srv.id, effectiveDc.key, 'manual_review').catch(() => null);
        logServerEvent({ type: 'hetzner_original_password_missing', user_id: userId, server_id: srv.id, datacenter: effectiveDc.key });
        if (SUPPORT_ID) await sendMessage(SUPPORT_ID, `🚨 Hetzner original password missing; no reset performed\nuser_id=${userId}\nserver_id=${srv.id}\ndc=${effectiveDc.key}`).catch(() => null);
        return sendMessage(chatId, '⏳ سرور ساخته شده اما رمز اولیه از Provider دریافت نشد. برای جلوگیری از تحویل رمز نامعتبر، سرور فعلاً تحویل نمی‌شود و پشتیبانی آن را بررسی می‌کند.', mainMenu);
      }
      try {
        await upsertServerSecret({ telegramId: userId, serverId: srv.id, datacenter: effectiveDc.key, secretType: 'root_password', secretValue: rootPassword });
      } catch (secretErr) {
        await require('./db').updateScopedStatus(userId, srv.id, effectiveDc.key, 'manual_review').catch(() => null);
        logServerEvent({ type: 'hetzner_password_store_failed', user_id: userId, server_id: srv.id, datacenter: effectiveDc.key, message: secretErr.code || secretErr.message });
        if (SUPPORT_ID) await sendMessage(SUPPORT_ID, `🚨 Hetzner password secure-store failed\nuser_id=${userId}\nserver_id=${srv.id}\ndc=${effectiveDc.key}\nerror=${secretErr.code || secretErr.message}`).catch(() => null);
        return sendMessage(chatId, '⏳ سرور ساخته شده اما ذخیره امن رمز اولیه کامل نشد؛ برای امنیت، اطلاعات ورود فعلاً تحویل داده نمی‌شود.', mainMenu);
      }

      const readiness = await hetznerLifecycle.waitForReadiness(effectiveDc, srv.id, {
        waitActionId: srv.action?.id,
        timeoutMs: Number(process.env.HETZNER_INITIAL_READY_TIMEOUT_MS || 45000)
      });
      ip = readiness.ip || ip;
      await require('./db').updateScopedStatus(userId, srv.id, effectiveDc.key, readiness.status);
      if (readiness.quality) {
        await require('./db').updateIpQualityResult(userId, srv.id, effectiveDc.key, hetznerLifecycle.qualitySummary(readiness.quality), false).catch(() => null);
      }
      if (!readiness.ready) {
        logServerEvent({ type: 'hetzner_delivery_pending', user_id: userId, server_id: srv.id, datacenter: effectiveDc.key, status: readiness.status, quality_reason: readiness.quality?.reason || null });
        return sendMessage(chatId, '⏳ سرور ساخته شد، اما قبل از تحویل نهایی باید روشن‌بودن، SSH و دسترسی IP از ایران و چند نقطه خارجی تأیید شود. اگر IP مناسب نباشد، سیستم آن را خودکار تعویض می‌کند. تا تأیید کامل، IP و رمز نمایش داده نمی‌شود.', mainMenu);
      }
      const newlyDelivered = await require('./db').markDelivered(userId, srv.id, effectiveDc.key, ip);
      if (!newlyDelivered) return;
    } else {
      if (!ip) ip = await pollForIp(effectiveDc, tok || await openstackApi.getToken(effectiveDc), srv.id, isAfra ? 3 : 24, isAfra ? 3000 : 5000);
      if (isTebyan) {
        const sshReady = ip ? await tcpCheck(ip, 22, 180000).catch(() => ({ reachable: false })) : { reachable: false };
        await updatePurchaseStatus(srv.id, sshReady.reachable ? 'active' : 'pending_ssh');
      }
    }

    const privateKeyText = rawPrivateKey ? `-----BEGIN RSA PRIVATE KEY-----\n${rawPrivateKey}\n-----END RSA PRIVATE KEY-----` : null;
    const planLabel = selectedFlavor.label || selectedFlavor.name || selectedFlavor.id;
    let msgHtml = [
      `✅ سرور شما در ${htmlEscape(effectiveDc.name)} با موفقیت ساخته و آماده شد!`,
      `🔹 نام: ${htmlEscape(serverName)}`,
      ip ? `🔹 IP: <code>${htmlEscape(ip)}</code>` : '🔹 IP: در حال تخصیص...',
      `🔹 سیستم‌عامل: ${htmlEscape(selectedImage.label || selectedImage.name || selectedImage.id)}`,
      `🔹 پلن: ${htmlEscape(planLabel)}`,
      `🔹 ${htmlEscape(formatBillingAmountLabel(finalPrice, selectedCycle))}`
    ].join('\n');
    if (isHetzner) msgHtml += '\n✅ دسترسی SSH و تست IP از ایران/چند نقطه خارجی تأیید شد.';
    if (rootPassword && isTebyan && ip) {
      msgHtml += '\n' + `IP: <code>${htmlEscape(ip)}</code>` + '\nSSH user: root' + '\nRoot password: ' + htmlCodeBlock(rootPassword) + '\nLogin command:' + `\n<code>ssh root@${htmlEscape(ip)}</code>` + '\nFallback:' + `\n<code>ssh ubuntu@${htmlEscape(ip)}</code>`;
    } else if (rootPassword) {
      msgHtml += '\n' + `🔑 <b>رمز عبور روت:</b>\n` + htmlCodeBlock(rootPassword) + '\nلطفاً رمز را در جای امن ذخیره کنید.';
    } else if (isAfra) {
      msgHtml += '\n' + serverSecretNotConfiguredMessage();
    }
    if (privateKeyText) msgHtml += '\n' + `🔑 <b>کلید خصوصی شما (SSH):</b>\n` + htmlCodeBlock(privateKeyText);

    const notifyResult = await notifyPurchaseSuccess(chatId, messageId, msgHtml, { inline_keyboard: [[{ text: '⚙️ مدیریت سرور', callback_data: makeShortCb(userId, { action: 'M', dcKey: effectiveDc.key, serverId: srv.id }) }]] });
    if (!notifyResult) logServerEvent({ type: 'purchase_notification_failed', user_id: userId, server_id: srv.id, datacenter: effectiveDc.key, message: 'sendMessage returned null' });
    logServerEvent({ type: 'server_created', server_id: srv.id, user_id: userId, datacenter: effectiveDc.key, password_provided: !!rootPassword, guarded_delivery: isHetzner });
  } catch (e) {
    const dcKey = effectiveDc?.key || dcConfig?.key || 'unknown';
    console.error(`Purchase Error in ${effectiveDc?.name || dcKey}:`, { message: e.message, server_id: srv?.id, purchaseRecorded });
    if (srv?.id && !purchaseRecorded) {
      logServerEvent({ type: 'CRITICAL_orphan_server_after_provider_create', user_id: userId, server_id: srv.id, datacenter: dcKey, message: e.message });
      if (SUPPORT_ID) await sendMessage(SUPPORT_ID, `🚨 CRITICAL: provider orphan server\nuser_id=${userId}\nserver_id=${srv.id}\ndc=${dcKey}\nerror=${e.message}`).catch(() => null);
      return sendMessage(chatId, '⚠️ سرور ساخته شد اما ثبت خرید با مشکل مواجه شد. لطفاً با پشتیبانی تماس بگیرید.', mainMenu);
    }
    if (srv?.id && purchaseRecorded) {
      logServerEvent({ type: 'purchase_post_create_warning', user_id: userId, server_id: srv.id, datacenter: dcKey, message: e.message });
      return sendMessage(chatId, '⚠️ سرور ساخته شد ولی هنوز تحویل نهایی نشده است. سیستم بررسی خودکار را ادامه می‌دهد؛ در صورت نیاز پشتیبانی بررسی می‌کند.', mainMenu);
    }
    return sendMessage(chatId, `❌ خطا در خرید سرور: ${escapeMarkdownV2(e.message)}`, mainMenu);
  } finally {
    if (state[userId]) { state[userId].purchaseInProgress = false; state[userId].step = 'READY'; }
  }
}
'''
s = s[:start] + fn + s[end:]

if 'HETZNER_PROVISIONING_RECONCILE' not in s:
    marker = "\n\n// --- Cleanup expired test servers every 15 minutes ---"
    scheduler = r'''

// Hetzner delivery reconciler: never deliver credentials before SSH + Iran/global reachability pass.
cron.schedule('* * * * *', async () => {
  try {
    const db = require('./db');
    const results = await hetznerLifecycle.reconcileProvisioning({
      db,
      resolveDatacenter: datacenter => {
        const dc = baseDatacenters[datacenter];
        return dc ? { ...dc, key: datacenter } : null;
      },
      timeoutMs: Number(process.env.HETZNER_RECONCILE_READY_TIMEOUT_MS || 12000)
    });
    const changed = results.filter(item => item.ready || item.ip_rotated || item.status === 'manual_review' || item.status === 'provider_missing');
    if (changed.length) {
      console.log('[HETZNER_PROVISIONING_RECONCILE]', changed.map(x => ({ server_id: x.server_id, status: x.status, ready: !!x.ready, ip_rotated: !!x.ip_rotated, reason: x.reason || null })));
    }

    for (const item of results.filter(result => result.newly_delivered)) {
      const purchase = await getPurchaseByServerId(item.server_id).catch(() => null);
      const password = await getServerSecret(item.server_id, 'root_password').catch(() => null);
      if (!purchase || !password) {
        await db.updateScopedStatus(item.telegram_id, item.server_id, item.datacenter, 'manual_review').catch(() => null);
        continue;
      }
      const msgHtml = [
        `✅ سرور ${htmlEscape(purchase.server_name || item.server_id)} اکنون کاملاً آماده و قابل تحویل است.`,
        `🔹 IP: <code>${htmlEscape(item.ip || purchase.public_ip || '')}</code>`,
        '✅ SSH در دسترس است.',
        '✅ تست دسترسی IP از ایران و چند نقطه خارجی تأیید شد.',
        `🔑 <b>رمز عبور روت:</b>\n${htmlCodeBlock(password)}`
      ].join('\n');
      await sendMessage(item.telegram_id, msgHtml, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '⚙️ مدیریت سرور', callback_data: makeShortCb(item.telegram_id, { action: 'M', dcKey: item.datacenter, serverId: item.server_id }) }]] }
      }).catch(error => console.error('[HETZNER_DELIVERY_NOTIFY_FAILED]', { server_id: item.server_id, message: error.message }));
    }

    for (const item of results.filter(result => result.status === 'manual_review')) {
      await sendMessage(item.telegram_id, '⚠️ سرور هنوز شرایط تحویل امن را پاس نکرده و برای بررسی دستی نگه داشته شده است. IP و رمز تا رفع مشکل نمایش داده نمی‌شود.').catch(() => null);
      if (SUPPORT_ID) {
        await sendMessage(SUPPORT_ID, `🚨 Hetzner delivery manual review\nuser_id=${item.telegram_id}\nserver_id=${item.server_id}\ndc=${item.datacenter}\nreason=${item.reason || 'unknown'}`).catch(() => null);
      }
    }
  } catch (error) {
    console.error('[HETZNER_PROVISIONING_RECONCILE_FAILED]', error);
  }
});
'''
    if marker not in s:
        raise SystemExit('index scheduler insertion marker not found')
    s = s.replace(marker, scheduler + marker, 1)
p.write_text(s)


# Validator assertions for the regression.
p = Path('scripts/validate-hetzner-lifecycle.js')
s = p.read_text()
if "status: 'pending_ip_quality'" not in s:
    s = s.replace(
        "  assert(!lifecycle.isBillablePurchase({ status: 'provisioning' }));\n",
        "  assert(!lifecycle.isBillablePurchase({ status: 'provisioning' }));\n  assert(!lifecycle.isBillablePurchase({ status: 'pending_ip_quality' }));\n",
        1
    )
if 'const originalRootPasswordFlow' not in s:
    marker = "  const text = ['customer-api.js','index.js','Hetzner/hetzner-api.js','services/hetzner-lifecycle.js'].map(f=>fs.readFileSync(f,'utf8')).join('\\n');\n"
    add = (
        "  const originalRootPasswordFlow = fs.readFileSync('index-core.js','utf8');\n"
        "  assert(/rootPassword = srv\\.root_password \\|\\| null/.test(originalRootPasswordFlow));\n"
        "  assert(!/rootPassword = await openstackApi\\.resetServerPassword\\(effectiveDc, null, srv\\.id\\)/.test(originalRootPasswordFlow));\n"
        "  assert(/HETZNER_PROVISIONING_RECONCILE/.test(originalRootPasswordFlow));\n"
        "  assert.strictEqual(lifecycle.pingNodeSuccess([[['OK', 0.04], ['TIMEOUT', 3]]]), true);\n"
        "  assert.strictEqual(lifecycle.pingNodeSuccess([[['TIMEOUT', 3]]]), false);\n"
    )
    if marker not in s:
        raise SystemExit('lifecycle validator marker not found')
    s = s.replace(marker, add + marker, 1)
p.write_text(s)

print('apply-hetzner-delivery-guard: patched')
