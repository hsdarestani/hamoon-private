'use strict';

const fs = require('fs');

function replaceOnce(path, oldText, newText, label) {
  const source = fs.readFileSync(path, 'utf8');
  if (source.includes(newText)) {
    console.log(`${path}: ${label} already patched`);
    return;
  }
  const first = source.indexOf(oldText);
  if (first < 0) throw new Error(`${path}: missing patch marker ${label}`);
  if (source.indexOf(oldText, first + oldText.length) >= 0) throw new Error(`${path}: duplicate patch marker ${label}`);
  fs.writeFileSync(path, source.slice(0, first) + newText + source.slice(first + oldText.length));
  console.log(`${path}: patched ${label}`);
}

const lifecycleOld = `async function deletePurchaseServer({ db, dc, telegramId, serverId, datacenter }) {
  if (!isHetznerConfig(dc)) throw new Error('NOT_HETZNER');
  const purchase = await db.getPurchaseForOwner?.(telegramId, serverId, datacenter);
  if (!purchase) { const e = new Error('NOT_FOUND'); e.code = 'NOT_FOUND'; throw e; }
  const previous = purchase.status || 'active';
  await db.markDeletionPending?.(telegramId, serverId, datacenter, previous);
  try {
    await cloud.deleteServer(dc, null, serverId);
    await db.markDeleted?.(telegramId, serverId, datacenter);
    return { status: 'deleted' };
  } catch (e) {
    if (isNotFound(e)) { await db.markDeleted?.(telegramId, serverId, datacenter); return { status: 'deleted' }; }
    await db.restorePurchaseStatus?.(telegramId, serverId, datacenter, previous);
    e.safeMessage = safeProviderMessage(e);
    throw e;
  }
}`;

const lifecycleNew = `async function deletePurchaseServer({ db, dc, telegramId, serverId, datacenter }) {
  if (!isHetznerConfig(dc)) throw new Error('NOT_HETZNER');
  const purchase = await db.getPurchaseForOwner?.(telegramId, serverId, datacenter);
  if (!purchase) { const e = new Error('NOT_FOUND'); e.code = 'NOT_FOUND'; throw e; }
  const previous = purchase.status || 'active';
  await db.markDeletionPending?.(telegramId, serverId, datacenter, previous);
  let providerDeleted = false;
  try {
    try {
      await cloud.deleteServer(dc, null, serverId);
      providerDeleted = true;
    } catch (providerError) {
      if (!isNotFound(providerError)) throw providerError;
      providerDeleted = true;
    }

    const refund = await require('../server-deletion-refund').refundUnusedServerCycle({
      db, telegramId, serverId, datacenter
    });
    await db.markDeleted?.(telegramId, serverId, datacenter);
    return { status: 'deleted', refund };
  } catch (e) {
    if (!providerDeleted) {
      await db.restorePurchaseStatus?.(telegramId, serverId, datacenter, previous);
      e.safeMessage = safeProviderMessage(e);
    } else {
      // Keep deletion_pending so the reconciler retries only the financial/DB
      // completion. Never restore an active state after the provider is gone.
      e.safeMessage = 'سرور حذف شده است اما ثبت نهایی بازگشت اعتبار در حال تکمیل است.';
    }
    throw e;
  }
}`;
replaceOnce('services/hetzner-lifecycle.js', lifecycleOld, lifecycleNew, 'delete refund');

const reconcileOld = `      if (isNotFound(e)) { await db.markDeleted?.(p.telegram_id, p.server_id, p.datacenter); out.push({ server_id: p.server_id, status: 'deleted' }); }
      else out.push({ server_id: p.server_id, status: 'check_failed' });`;
const reconcileNew = `      if (isNotFound(e)) {
        try {
          const refund = await require('../server-deletion-refund').refundUnusedServerCycle({
            db,
            telegramId: p.telegram_id,
            serverId: p.server_id,
            datacenter: p.datacenter
          });
          await db.markDeleted?.(p.telegram_id, p.server_id, p.datacenter);
          out.push({ server_id: p.server_id, status: 'deleted', refund });
        } catch (refundError) {
          out.push({ server_id: p.server_id, status: 'refund_retry_failed', reason: refundError.code || refundError.message });
        }
      }
      else out.push({ server_id: p.server_id, status: 'check_failed' });`;
replaceOnce('services/hetzner-lifecycle.js', reconcileOld, reconcileNew, 'reconcile refund retry');

const apiOld = `      try {
        await db.recordPurchase(client.telegram_id, serverId, dcKey, createdServer.name || name, plan.id, price, duration, 0, 0, null, 'api', image, 0, 0, 0, 0, 0, keyId, 'provisioning');
        if (ip && db.updatePublicIp) await db.updatePublicIp(client.telegram_id, serverId, dcKey, ip).catch(() => {});
      } catch (recordError) {
        await cloud.deleteServer(dc, null, serverId).catch(() => {});
        throw recordError;
      }
      await db.recordWalletLog(client.telegram_id, 0, \`API server create \${serverId}\`, 'server_api_create').catch(() => {});`;
const apiNew = `      // API purchases are prepaid exactly like Telegram purchases. This also
      // makes prorated deletion refunds financially correct and prevents a free
      // first billing cycle on API-created servers.
      const initialDebited = await db.debitUser(client.telegram_id, price);
      if (!initialDebited) {
        await cloud.deleteServer(dc, null, serverId).catch(() => {});
        return apiError(res, 402, 'INSUFFICIENT_WALLET', 'موجودی کیف پول هم‌زمان تغییر کرده و برای ساخت سرور کافی نیست.');
      }
      try {
        await db.recordPurchase(client.telegram_id, serverId, dcKey, createdServer.name || name, plan.id, price, duration, 0, 0, null, 'api', image, 0, 0, 0, 0, 0, keyId, 'provisioning');
        if (ip && db.updatePublicIp) await db.updatePublicIp(client.telegram_id, serverId, dcKey, ip).catch(() => {});
        await db.recordWalletLog(client.telegram_id, -price, \`API server purchase \${serverId}\`, 'server_api_purchase');
      } catch (recordError) {
        await db.creditUser(client.telegram_id, price).catch(() => {});
        await db.recordWalletLog(client.telegram_id, price, \`Rollback API server purchase \${serverId}\`, 'server_api_purchase_rollback').catch(() => {});
        await cloud.deleteServer(dc, null, serverId).catch(() => {});
        throw recordError;
      }`;
replaceOnce('customer-api.js', apiOld, apiNew, 'API initial debit');

const botDeleteOld = `        if (isTestServer) {
            await deleteTestServer(serverId);
        } else {
            await updatePurchaseStatus(serverId, 'deleted');
        }

        sendMessage(chatId, '✅ سرور با موفقیت حذف شد.');`;
const botDeleteNew = `        let deletionRefund = null;
        if (isTestServer) {
            await deleteTestServer(serverId);
        } else {
            deletionRefund = await require('./server-deletion-refund').refundUnusedServerCycle({
                db: require('./db'),
                telegramId: userId,
                serverId,
                datacenter: dcConfig.key
            });
            await updatePurchaseStatus(serverId, 'deleted');
        }

        const refundAmount = Number(deletionRefund?.refunded || 0);
        const refundText = refundAmount > 0
          ? \`\\n💰 مبلغ \${refundAmount.toLocaleString('fa-IR')} تومان بابت مانده دوره به کیف پول شما برگشت داده شد.\`
          : '';
        sendMessage(chatId, \`✅ سرور با موفقیت حذف شد.\${refundText}\`);`;
replaceOnce('index-core.js', botDeleteOld, botDeleteNew, 'bot deletion refund');

console.log('apply-server-deletion-refund: ok');
