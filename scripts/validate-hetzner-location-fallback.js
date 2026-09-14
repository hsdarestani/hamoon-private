'use strict';

const assert = require('assert');
const {
  MIGRATION_TABLES,
  providerLocation,
  buildForcedLocationDc,
  shouldRelocateToFsn
} = require('../services/hetzner-location-fallback');

const pending = {
  telegram_id: '1',
  server_id: '100',
  datacenter: 'hetzner',
  status: 'pending_ip_quality',
  delivered_at: null,
  ip_quality_attempts: 2
};
const result = {
  telegram_id: '1',
  server_id: '100',
  datacenter: 'hetzner',
  status: 'pending_ip_quality',
  ready: false
};

assert.strictEqual(shouldRelocateToFsn({ result, purchase: pending, threshold: 2 }), true);
assert.strictEqual(shouldRelocateToFsn({ result, purchase: { ...pending, ip_quality_attempts: 1 }, threshold: 2 }), false);
assert.strictEqual(shouldRelocateToFsn({ result: { ...result, ready: true }, purchase: pending, threshold: 2 }), false);
assert.strictEqual(shouldRelocateToFsn({ result, purchase: { ...pending, delivered_at: new Date() }, threshold: 2 }), false);
assert.strictEqual(shouldRelocateToFsn({ result: { ...result, datacenter: 'hetzner-finland' }, purchase: { ...pending, datacenter: 'hetzner-finland' }, threshold: 2 }), false);

const forced = buildForcedLocationDc({ HETZNER_LOCATION: 'nbg1', HETZNER_LOCATION_FALLBACKS: 'fsn1,nbg1' }, 'fsn1');
assert.strictEqual(forced.HETZNER_LOCATION, 'fsn1');
assert.strictEqual(forced.HETZNER_LOCATION_FALLBACKS, 'fsn1');
assert.strictEqual(providerLocation({ datacenter: { location: { name: 'NBG1' } } }, {}), 'nbg1');
assert.strictEqual(providerLocation({ location: { name: 'FSN1' } }, {}), 'fsn1');

for (const table of [
  'billing_events',
  'hetzner_traffic_billing',
  'key_pairs',
  'server_display_names',
  'server_ip_history',
  'test_servers'
]) {
  assert(MIGRATION_TABLES.includes(table), `missing migration table: ${table}`);
}
assert(!MIGRATION_TABLES.includes('server_secrets'), 'server_secrets must keep the pre-stored replacement password');
assert(!MIGRATION_TABLES.includes('console_sessions'), 'console sessions must be invalidated, not migrated');

console.log('validate-hetzner-location-fallback: ok');
