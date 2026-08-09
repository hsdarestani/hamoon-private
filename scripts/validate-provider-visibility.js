#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { appendSharedNonOpenStackProviders } = require('../provider-visibility');
const { applyProviderVisibilityPatches } = require('../provider-visibility-bootstrap');
const { applyPatches: applyRuntimePatches } = require('../runtime-bootstrap');

function assert(name, ok) {
  if (!ok) {
    console.error('FAIL', name);
    process.exitCode = 1;
  } else {
    console.log('OK', name);
  }
}

const fakeBase = {
  'custom-openstack-base': { key: 'custom-openstack-base', provider: 'openstack', OS_AUTH_URL: 'https://example.invalid' },
  'hetzner-finland': { key: 'hetzner-finland', provider: 'hetzner', apiType: 'hetzner', HETZNER_LOCATION: 'hel1', namePrefix: 'FIN' },
  afracloud: { key: 'afracloud', provider: 'afracloud', apiType: 'afracloud' }
};
const out = {
  'custom-openstack-base__user-project': { key: 'custom-openstack-base__user-project', provider: 'openstack', sharedProject: false }
};
appendSharedNonOpenStackProviders(out, fakeBase);

assert('custom OpenStack project is preserved', !!out['custom-openstack-base__user-project']);
assert('shared Hetzner Finland remains visible', !!out['hetzner-finland']);
assert('Hetzner Finland is marked shared', out['hetzner-finland']?.sharedProject === true);
assert('shared Afracloud remains visible', !!out.afracloud);
assert('base OpenStack project is not re-added', !out['custom-openstack-base']);
assert('FIN location config preserved', out['hetzner-finland']?.namePrefix === 'FIN' && out['hetzner-finland']?.HETZNER_LOCATION === 'hel1');

const core = fs.readFileSync('index-core.js', 'utf8');
let visibilityPatched = '';
try {
  visibilityPatched = applyProviderVisibilityPatches(core);
  console.log('OK provider visibility patch applies exactly once');
} catch (error) {
  console.error('FAIL provider visibility patch', error.message);
  process.exit(1);
}
assert('effective DC function appends shared non-OpenStack providers', visibilityPatched.includes("appendSharedNonOpenStackProviders(out, baseDatacenters)"));
assert('management list falls back to owned purchases', visibilityPatched.includes('provider list missed owned server; using purchase fallback'));
assert('purchase fallback preserves purchase object', visibilityPatched.includes('purchase: p'));
assert('purchase fallback only uses effective datacenters', visibilityPatched.includes('!userDCs[dcKey]'));
assert('purchase fallback deduplicates provider results', visibilityPatched.includes('managedServerKeys.has(managedKey)'));

try {
  const fullyPatched = applyRuntimePatches(core);
  new Function(fullyPatched);
  console.log('OK full production runtime source parses');
  assert('rename patches remain active', fullyPatched.includes("case 'RENAME_SERVER':"));
  assert('Hetzner console patches remain active', fullyPatched.includes("case 'HCONSOLE':"));
  assert('provider visibility patch remains active', fullyPatched.includes('appendSharedNonOpenStackProviders(out, baseDatacenters)'));
  assert('DB purchase fallback remains active', fullyPatched.includes('provider list missed owned server; using purchase fallback'));
} catch (error) {
  console.error('FAIL full runtime patches', error.message);
  process.exitCode = 1;
}

process.exit(process.exitCode || 0);
