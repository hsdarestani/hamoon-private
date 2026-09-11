#!/usr/bin/env python3
from pathlib import Path


def replace_once(path: str, old: str, new: str):
    p = Path(path)
    text = p.read_text()
    if new in text:
        print(f"{path}: already patched")
        return
    if old not in text:
        raise SystemExit(f"{path}: expected source marker not found")
    p.write_text(text.replace(old, new, 1))
    print(f"{path}: patched")


# 1) Hetzner reset_password can briefly return 423 while create/power actions settle.
replace_once(
    'cloud-api.js',
    "  resetServerPassword:   (dc, ...a) => pick(dc).resetServerPassword ? pick(dc).resetServerPassword(dc, ...a) : Promise.reject(new Error('reset password not supported')),",
    """  resetServerPassword:   (dc, ...a) => {
    const provider = pick(dc);
    const call = () => provider.resetServerPassword
      ? provider.resetServerPassword(dc, ...a)
      : Promise.reject(new Error('reset password not supported'));
    return callWithHetznerLockedRetry(dc, 'reset_password', call);
  },"""
)

# 2) Persist (or safely recover) the Hetzner password BEFORE the purchase becomes visible
# to the one-minute reconciler. This closes the bot provisioning -> password_missing race.
index_path = Path('index-core.js')
index_text = index_path.read_text()
marker = 'HETZNER_PASSWORD_PRESTORE_V1'
if marker not in index_text:
    needle = """    if ((isAfra || isTebyan) && generatedRootPassword) {
"""
    if needle not in index_text:
        raise SystemExit('index-core.js: purchase secret-store marker not found')
    insert = """    // HETZNER_PASSWORD_PRESTORE_V1
    // The reconciler runs every minute. Make the credential durable before recordPurchase()
    // so it can never observe a provisioning row without its password.
    if (isHetzner) {
      if (!rootPassword) {
        try {
          if (srv?.action?.id) {
            await openstackApi.waitHetznerAction(
              effectiveDc,
              srv.action.id,
              Number(process.env.HETZNER_PASSWORD_RECOVERY_ACTION_TIMEOUT_MS || 120000)
            );
          }
          rootPassword = await openstackApi.resetServerPassword(effectiveDc, null, srv.id);
          if (rootPassword) {
            logServerEvent({ type: 'hetzner_initial_password_recovered', user_id: userId, server_id: srv.id, datacenter: effectiveDc.key });
          }
        } catch (passwordRecoveryError) {
          logServerEvent({
            type: 'hetzner_initial_password_recovery_failed',
            user_id: userId,
            server_id: srv.id,
            datacenter: effectiveDc.key,
            message: passwordRecoveryError.code || passwordRecoveryError.message
          });
        }
      }

      if (rootPassword) {
        try {
          await upsertServerSecret({
            telegramId: userId,
            serverId: srv.id,
            datacenter: effectiveDc.key,
            secretType: 'root_password',
            secretValue: rootPassword
          });
        } catch (secretErr) {
          logServerEvent({
            type: 'hetzner_password_prestore_failed',
            user_id: userId,
            server_id: srv.id,
            datacenter: effectiveDc.key,
            message: secretErr.code || secretErr.message
          });
        }
      }
    }

"""
    index_path.write_text(index_text.replace(needle, insert + needle, 1))
    print('index-core.js: patched')
else:
    print('index-core.js: already patched')


# 3) API-created Hetzner servers must persist a verified root password before recordPurchase().
api_path = Path('customer-api.js')
api_text = api_path.read_text()
api_marker = 'HETZNER_API_PASSWORD_PRESTORE_V1'
if api_marker not in api_text:
    api_old = """      const serverId = String(createdServer.id);
      const ip = publicIpFromServer(createdServer);
      try {
        await db.recordPurchase(client.telegram_id, serverId, dcKey, createdServer.name || name, plan.id, price, duration, 0, 0, null, 'api', image, 0, 0, 0, 0, 0, keyId, 'provisioning');
"""
    api_new = """      const serverId = String(createdServer.id);
      const ip = publicIpFromServer(createdServer);

      // HETZNER_API_PASSWORD_PRESTORE_V1
      // API provisioning shares the same safe-delivery requirement as Telegram purchases.
      // Persist and read-back the credential before exposing the purchase to the reconciler.
      let rootPassword = createdServer?.root_password || null;
      if (!rootPassword) {
        if (createdServer?.action?.id) {
          await cloud.waitHetznerAction(
            dc,
            createdServer.action.id,
            Number(process.env.HETZNER_PASSWORD_RECOVERY_ACTION_TIMEOUT_MS || 120000)
          );
        }
        rootPassword = await cloud.resetServerPassword(dc, null, serverId);
      }
      if (!rootPassword) {
        const passwordError = new Error('HETZNER_PASSWORD_RECOVERY_EMPTY');
        passwordError.code = 'HETZNER_PASSWORD_RECOVERY_EMPTY';
        throw passwordError;
      }
      await db.upsertServerSecret({
        telegramId: client.telegram_id,
        serverId,
        datacenter: dcKey,
        secretType: 'root_password',
        secretValue: rootPassword
      });
      const verifiedRootPassword = await db.getServerSecret(serverId, 'root_password');
      if (!verifiedRootPassword || verifiedRootPassword !== rootPassword) {
        const passwordError = new Error('HETZNER_PASSWORD_SECRET_VERIFY_FAILED');
        passwordError.code = 'HETZNER_PASSWORD_SECRET_VERIFY_FAILED';
        throw passwordError;
      }

      try {
        await db.recordPurchase(client.telegram_id, serverId, dcKey, createdServer.name || name, plan.id, price, duration, 0, 0, null, 'api', image, 0, 0, 0, 0, 0, keyId, 'provisioning');
"""
    if api_old not in api_text:
        raise SystemExit('customer-api.js: Hetzner create marker not found')
    api_path.write_text(api_text.replace(api_old, api_new, 1))
    print('customer-api.js: patched')
else:
    print('customer-api.js: already patched')


# 4) Runtime reconciler automatically repairs a missing password for every delivery path
# (Telegram, Customer API, or future callers) before escalating to manual review.
lifecycle_path = Path('services/hetzner-lifecycle.js')
lifecycle_text = lifecycle_path.read_text()

legacy_original = """      if (isDelivery && dc.HETZNER_PASSWORD_ONLY) {
        const stored = await db.getServerSecret?.(purchase.server_id, 'root_password').catch(() => null);
        if (!stored) {
          await db.updateScopedStatus?.(purchase.telegram_id, purchase.server_id, purchase.datacenter, 'manual_review');
          results.push({ server_id: purchase.server_id, telegram_id: purchase.telegram_id, datacenter: purchase.datacenter, status: 'manual_review', reason: 'password_missing' });
          continue;
        }
      }
"""

legacy_guarded = """      if (isDelivery && dc.HETZNER_PASSWORD_ONLY) {
        let stored = null;
        try {
          stored = await db.getServerSecret?.(purchase.server_id, 'root_password');
        } catch (secretError) {
          const secretCode = String(secretError?.code || secretError?.message || 'secret_decrypt_failed');
          const reason = secretCode === 'SERVER_SECRET_KEY_MISSING'
            ? 'secret_key_missing'
            : 'secret_decrypt_failed';
          await db.updateScopedStatus?.(purchase.telegram_id, purchase.server_id, purchase.datacenter, 'manual_review');
          results.push({
            server_id: purchase.server_id,
            telegram_id: purchase.telegram_id,
            datacenter: purchase.datacenter,
            status: 'manual_review',
            reason,
            secret_error: secretCode.slice(0, 80)
          });
          continue;
        }
        if (!stored) {
          await db.updateScopedStatus?.(purchase.telegram_id, purchase.server_id, purchase.datacenter, 'manual_review');
          results.push({ server_id: purchase.server_id, telegram_id: purchase.telegram_id, datacenter: purchase.datacenter, status: 'manual_review', reason: 'password_missing' });
          continue;
        }
      }
"""

auto_recovery = """      if (isDelivery && dc.HETZNER_PASSWORD_ONLY) {
        let stored = null;
        try {
          stored = await db.getServerSecret?.(purchase.server_id, 'root_password');
        } catch (secretError) {
          const secretCode = String(secretError?.code || secretError?.message || 'secret_decrypt_failed');
          const reason = secretCode === 'SERVER_SECRET_KEY_MISSING'
            ? 'secret_key_missing'
            : 'secret_decrypt_failed';
          await db.updateScopedStatus?.(purchase.telegram_id, purchase.server_id, purchase.datacenter, 'manual_review');
          results.push({
            server_id: purchase.server_id,
            telegram_id: purchase.telegram_id,
            datacenter: purchase.datacenter,
            status: 'manual_review',
            reason,
            secret_error: secretCode.slice(0, 80)
          });
          continue;
        }

        // HETZNER_PASSWORD_AUTORECOVERY_V2
        // A missing provider password is recoverable and should not notify the user/admin
        // until the automatic reset + encrypted store + read-back has actually failed.
        if (!stored) {
          try {
            await cloud.getServer(dc, null, purchase.server_id);
            const recoveredPassword = await cloud.resetServerPassword(dc, null, purchase.server_id);
            if (!recoveredPassword) {
              const err = new Error('RESET_PASSWORD_RETURNED_EMPTY');
              err.code = 'RESET_PASSWORD_RETURNED_EMPTY';
              throw err;
            }
            if (typeof db.upsertServerSecret !== 'function') {
              const err = new Error('SERVER_SECRET_STORE_UNAVAILABLE');
              err.code = 'SERVER_SECRET_STORE_UNAVAILABLE';
              throw err;
            }
            await db.upsertServerSecret({
              telegramId: purchase.telegram_id,
              serverId: purchase.server_id,
              datacenter: purchase.datacenter,
              secretType: 'root_password',
              secretValue: recoveredPassword
            });
            const verified = await db.getServerSecret?.(purchase.server_id, 'root_password');
            if (!verified || verified !== recoveredPassword) {
              const err = new Error('SERVER_SECRET_READBACK_MISMATCH');
              err.code = 'SERVER_SECRET_READBACK_MISMATCH';
              throw err;
            }
            stored = verified;
          } catch (recoveryError) {
            const recoveryCode = String(recoveryError?.code || recoveryError?.message || 'password_recovery_failed').slice(0, 100);
            await db.updateScopedStatus?.(purchase.telegram_id, purchase.server_id, purchase.datacenter, 'manual_review');
            results.push({
              server_id: purchase.server_id,
              telegram_id: purchase.telegram_id,
              datacenter: purchase.datacenter,
              status: 'manual_review',
              reason: 'password_recovery_failed',
              recovery_error: recoveryCode
            });
            continue;
          }
        }
      }
"""

if 'HETZNER_PASSWORD_AUTORECOVERY_V2' in lifecycle_text:
    print('services/hetzner-lifecycle.js: already patched')
elif legacy_guarded in lifecycle_text:
    lifecycle_path.write_text(lifecycle_text.replace(legacy_guarded, auto_recovery, 1))
    print('services/hetzner-lifecycle.js: patched from guarded flow')
elif legacy_original in lifecycle_text:
    lifecycle_path.write_text(lifecycle_text.replace(legacy_original, auto_recovery, 1))
    print('services/hetzner-lifecycle.js: patched from legacy flow')
else:
    raise SystemExit('services/hetzner-lifecycle.js: password guard marker not found')
