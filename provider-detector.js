'use strict';

function norm(value) {
  return String(value || '').trim().toLowerCase();
}

function fields(dc = {}) {
  return [
    dc.provider,
    dc.apiType,
    dc.type,
    dc.key,
    dc.__baseKey,
    dc.name,
    dc.slug
  ].map(norm);
}

function hasPrefix(values, prefix) {
  return values.some(value =>
    value === prefix ||
    value.startsWith(`${prefix}-`) ||
    value.startsWith(`${prefix}_`)
  );
}

function isHetznerConfig(dc = {}) {
  const values = fields(dc);
  return hasPrefix(values, 'hetzner') || Boolean(
    dc.HETZNER_LOCATION ||
    dc.HETZNER_API_TOKEN ||
    dc.HETZNER_TOKEN ||
    dc.HCLOUD_TOKEN
  );
}

function isAfraCloudConfig(dc = {}) {
  const values = fields(dc);
  return hasPrefix(values, 'afracloud') ||
    hasPrefix(values, 'afra') ||
    Boolean(dc.AFRA_API_KEY || dc.AFRACLOUD_API_KEY || dc.AFRA_API_BASE_URL);
}

function isOpenStackConfig(dc = {}) {
  const values = fields(dc);
  return hasPrefix(values, 'openstack') ||
    hasPrefix(values, 'tebyan') ||
    Boolean(dc.OS_AUTH_URL || dc.OS_PROJECT_ID || dc.OS_USERNAME);
}

function providerName(dc = {}) {
  if (isHetznerConfig(dc)) return 'hetzner';
  if (isAfraCloudConfig(dc)) return 'afracloud';
  if (isOpenStackConfig(dc)) return 'openstack';
  return 'openstack';
}

module.exports = {
  isHetznerConfig,
  isAfraCloudConfig,
  isOpenStackConfig,
  providerName
};
