const assert = require('assert');
const { getCapabilities } = require('../provider-capabilities');
const caps = getCapabilities({ provider: 'afracloud' });
for (const feature of ['traffic', 'projectTraffic', 'rebuild', 'snapshot', 'buildFromSnapshot', 'changeCycle']) {
  assert.strictEqual(caps[feature], false, `${feature} must be disabled`);
}
for (const feature of ['resetPassword', 'deleteServer', 'suspendServer', 'resumeServer']) {
  assert.strictEqual(caps[feature], true, `${feature} must be enabled`);
}
console.log('Provider capability validation passed.');
