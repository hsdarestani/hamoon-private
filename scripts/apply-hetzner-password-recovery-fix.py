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
# to the one-minute reconciler. This closes the provisioning -> password_missing race.
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

# 3) Do not collapse missing encryption key / decrypt failures into password_missing.
lifecycle_path = Path('services/hetzner-lifecycle.js')
lifecycle_text = lifecycle_path.read_text()
old = """      if (isDelivery && dc.HETZNER_PASSWORD_ONLY) {
        const stored = await db.getServerSecret?.(purchase.server_id, 'root_password').catch(() => null);
        if (!stored) {
          await db.updateScopedStatus?.(purchase.telegram_id, purchase.server_id, purchase.datacenter, 'manual_review');
          results.push({ server_id: purchase.server_id, telegram_id: purchase.telegram_id, datacenter: purchase.datacenter, status: 'manual_review', reason: 'password_missing' });
          continue;
        }
      }
"""
new = """      if (isDelivery && dc.HETZNER_PASSWORD_ONLY) {
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
if new in lifecycle_text:
    print('services/hetzner-lifecycle.js: already patched')
elif old in lifecycle_text:
    lifecycle_path.write_text(lifecycle_text.replace(old, new, 1))
    print('services/hetzner-lifecycle.js: patched')
else:
    raise SystemExit('services/hetzner-lifecycle.js: password guard marker not found')
