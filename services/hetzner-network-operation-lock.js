'use strict';

const active = new Map();

function keyOf({ dc, datacenter, serverId }) {
  const providerKey = String(datacenter || dc?.key || dc?.name || dc?.HETZNER_LOCATION || 'hetzner').trim();
  return `${providerKey}:${String(serverId)}`;
}

function acquire({ dc, datacenter, serverId, operation }) {
  const key = keyOf({ dc, datacenter, serverId });
  const existing = active.get(key);
  if (existing) {
    const error = new Error('OPERATION_IN_PROGRESS');
    error.code = 'OPERATION_IN_PROGRESS';
    error.operation = existing.operation;
    error.startedAt = existing.startedAt;
    throw error;
  }
  const token = Symbol(key);
  active.set(key, {
    token,
    operation: String(operation || 'network_operation'),
    startedAt: Date.now()
  });
  return { key, token };
}

function release(lock) {
  if (!lock?.key || !lock?.token) return false;
  const existing = active.get(lock.key);
  if (!existing || existing.token !== lock.token) return false;
  active.delete(lock.key);
  return true;
}

function current({ dc, datacenter, serverId }) {
  return active.get(keyOf({ dc, datacenter, serverId })) || null;
}

module.exports = { acquire, release, current, keyOf };
