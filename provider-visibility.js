'use strict';

function isOpenStackConfig(dc = {}) {
  const provider = String(dc.provider || '').toLowerCase();
  const apiType = String(dc.apiType || '').toLowerCase();
  return !!dc.OS_AUTH_URL || provider === 'openstack' || apiType === 'openstack';
}

function appendSharedNonOpenStackProviders(out, baseDatacenters) {
  const target = out && typeof out === 'object' ? out : {};
  const bases = baseDatacenters && typeof baseDatacenters === 'object' ? baseDatacenters : {};

  for (const key of Object.keys(bases)) {
    const base = bases[key];
    if (!base || isOpenStackConfig(base)) continue;
    if (target[key]) continue;
    target[key] = { ...base, key, sharedProject: true };
  }

  return target;
}

module.exports = {
  isOpenStackConfig,
  appendSharedNonOpenStackProviders
};
