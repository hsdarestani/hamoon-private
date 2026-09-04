const assert = require('assert');
const { getCapabilities } = require('../provider-capabilities');

const afraCaps = getCapabilities({ provider: 'afracloud' });
for (const feature of ['traffic', 'projectTraffic', 'rebuild', 'snapshot', 'buildFromSnapshot', 'changeCycle']) {
  assert.strictEqual(afraCaps[feature], false, `afracloud ${feature} must be disabled`);
}
for (const feature of ['resetPassword', 'deleteServer', 'suspendServer', 'resumeServer']) {
  assert.strictEqual(afraCaps[feature], true, `afracloud ${feature} must be enabled`);
}

const hetznerCaps = getCapabilities({ provider: 'hetzner' });
for (const feature of ['snapshot', 'listSnapshots', 'buildFromSnapshot']) {
  assert.strictEqual(hetznerCaps[feature], false, `hetzner ${feature} must be disabled until the adapter implements it`);
}

console.log('Provider capability validation passed.');
