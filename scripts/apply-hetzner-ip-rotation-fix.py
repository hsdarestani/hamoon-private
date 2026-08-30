#!/usr/bin/env python3
from pathlib import Path


def replace_once(path: str, old: str, new: str):
    p = Path(path)
    text = p.read_text()
    if new in text:
        print(f"{path}: already patched")
        return
    if old not in text:
        raise SystemExit(f"{path}: expected marker not found")
    p.write_text(text.replace(old, new, 1))
    print(f"{path}: patched")


# Clean wrapper must honor the lifecycle's stronger provisioning verifier instead of
# silently replacing it with its short manual-change probe.
replace_once(
    'services/hetzner-clean-ip-change.js',
    """        verifyCandidate: async ({ ip }) => verifyCleanCandidate(ip, args)
""",
    """        verifyCandidate: typeof args.verifyCandidate === 'function'
          ? args.verifyCandidate
          : async ({ ip }) => verifyCleanCandidate(ip, args)
"""
)

# Manual Change-IP also needs enough guest-network settle time before declaring SSH dead.
p = Path('services/hetzner-clean-ip-change.js')
text = p.read_text()
start_marker = 'async function probeSshReachability(ip, options = {}) {'
end_marker = 'async function probeIranQuality(ip) {'
start = text.find(start_marker)
end = text.find(end_marker, start + 1)
if start < 0 or end < 0:
    raise SystemExit('services/hetzner-clean-ip-change.js: SSH probe section not found')
new_probe = """async function probeSshReachability(ip, options = {}) {
  const attempts = clampInt(options.attempts ?? process.env.HETZNER_CHANGE_IP_SSH_PROBE_ATTEMPTS, 6, 1, 12);
  const timeoutMs = clampInt(options.timeoutMs ?? process.env.HETZNER_CHANGE_IP_SSH_PROBE_TIMEOUT_MS, 8000, 1000, 15000);
  const settleMs = clampInt(options.settleMs ?? process.env.HETZNER_CHANGE_IP_SSH_SETTLE_MS, 6000, 0, 30000);
  const retryDelayMs = clampInt(options.retryDelayMs ?? process.env.HETZNER_CHANGE_IP_SSH_RETRY_DELAY_MS, 5000, 500, 15000);
  const port = clampInt(options.port ?? process.env.HETZNER_CHANGE_IP_SSH_PORT, 22, 1, 65535);
  let last = null;

  // Hetzner can report the server running with the new Primary IPv4 before the guest
  // network stack/sshd has fully settled after the power cycle. Give it a short grace period.
  if (settleMs > 0) await sleep(settleMs);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await tcpProbeOnce(ip, port, timeoutMs);
    if (last.ok) return { ...last, attempts: attempt, port };
    if (attempt < attempts) await sleep(retryDelayMs);
  }
  return { ...(last || { ok: false, reason: 'unknown' }), attempts, port };
}

"""
if 'HETZNER_CHANGE_IP_SSH_SETTLE_MS' not in text[start:end]:
    p.write_text(text[:start] + new_probe + text[end:])
    print('services/hetzner-clean-ip-change.js: SSH probe patched')
else:
    print('services/hetzner-clean-ip-change.js: SSH probe already patched')

# Rollback must be state-aware. The old code used `await innerCall` inside a `.catch()`
# expression, so a provider 422 from the inner call escaped before the catch handler existed.
p = Path('services/hetzner-change-ip.js')
text = p.read_text()
start_marker = 'async function rollbackSwap(dc, { serverId, oldPrimaryId, newPrimaryId, oldIp }) {'
end_marker = 'async function changeHetznerPublicIp({ db, dc, telegramId, serverId, datacenter, verifyCandidate = null }) {'
start = text.find(start_marker)
end = text.find(end_marker, start + 1)
if start < 0 or end < 0:
    raise SystemExit('services/hetzner-change-ip.js: rollback section not found')
new_rollback = """async function rollbackSwap(dc, { serverId, oldPrimaryId, newPrimaryId, oldIp }) {
  const oldId = oldPrimaryId == null ? null : String(oldPrimaryId);
  const newId = newPrimaryId == null ? null : String(newPrimaryId);
  const refresh = () => hetznerApi.getHetznerServer(dc, serverId).catch(() => null);

  try {
    let raw = await refresh();
    if (String(raw?.status || '').toLowerCase() === 'running') {
      await waitAction(dc, await cloud.powerOffHetznerServer(dc, serverId));
    }

    raw = await refresh();
    let attachedId = primaryIpv4Id(raw);

    // Only unassign the candidate if it is still the attached Primary IPv4.
    if (newId && attachedId === newId) {
      try {
        const action = await cloud.unassignPrimaryIp(dc, null, newId);
        await waitAction(dc, action);
      } catch (error) {
        // 422 can mean the assignment already changed. Re-read provider state and only
        // fail rollback if the rejected candidate is still attached.
        raw = await refresh();
        attachedId = primaryIpv4Id(raw);
        if (attachedId === newId) throw error;
      }
    }

    raw = await refresh();
    attachedId = primaryIpv4Id(raw);

    // Reattach the original IP only when it is not already restored.
    if (oldId && attachedId !== oldId) {
      try {
        const action = await cloud.assignPrimaryIp(dc, null, oldId, serverId);
        await waitAction(dc, action);
      } catch (error) {
        raw = await refresh();
        attachedId = primaryIpv4Id(raw);
        if (attachedId !== oldId) throw error;
      }
    }

    raw = await refresh();
    if (String(raw?.status || '').toLowerCase() !== 'running') {
      await waitAction(dc, await cloud.powerOnHetznerServer(dc, serverId));
    }

    if (oldIp) await waitForNewIp(dc, serverId, oldIp);
    if (newId) await deletePrimaryIpWithRetry(dc, newId).catch(() => {});
    return true;
  } catch (rollbackError) {
    console.error('[HETZNER_CHANGE_IP_ROLLBACK_FAILED]', {
      server_id: String(serverId),
      message: rollbackError?.message || String(rollbackError)
    });
    return false;
  }
}

"""
if 'Only unassign the candidate if it is still the attached Primary IPv4.' not in text[start:end]:
    p.write_text(text[:start] + new_rollback + text[end:])
    print('services/hetzner-change-ip.js: rollback patched')
else:
    print('services/hetzner-change-ip.js: rollback already patched')
