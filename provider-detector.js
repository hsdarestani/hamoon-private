function norm(v) { return String(v || '').trim().toLowerCase(); }
function fields(dc = {}) { return [dc.provider, dc.apiType, dc.type, dc.key, dc.__baseKey, dc.name, dc.slug].map(norm); }
function hasPrefix(values, prefix) { return values.some(v => v === prefix || v.startsWith(`${prefix}-`) || v.startsWith(`${prefix}_`)); }
function isHetznerConfig(dc = {}) {
  const v = fields(dc);
  return hasPrefix(v, 'hetzner') || !!(dc.HETZNER_LOCATION || dc.HETZNER_API_TOKEN || dc.HETZNER_TOKEN || dc.HCLOUD_TOKEN);
}
function isAfraCloudConfig(dc = {}) {
  const v = fields(dc);
  return hasPrefix(v, 'afracloud') || hasPrefix(v, 'afra') || !!(dc.AFRA_API_KEY || dc.AFRACLOUD_API_KEY || dc.AFRA_API_BASE_URL);
}
function isOpenStackConfig(dc = {}) {
  const v = fields(dc);
  return hasPrefix(v, 'openstack') || hasPrefix(v, 'tebyan') || !!(dc.OS_AUTH_URL || dc.OS_PROJECT_ID || dc.OS_USERNAME);
}
function providerName(dc = {}) {
  if (isHetznerConfig(dc)) return 'hetzner';
  if (isAfraCloudConfig(dc)) return 'afracloud';
  if (isOpenStackConfig(dc)) return 'openstack';
  return 'openstack';
}
module.exports = { isHetznerConfig, isAfraCloudConfig, isOpenStackConfig, providerName };
