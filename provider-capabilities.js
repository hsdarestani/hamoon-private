const DEFAULT_CAPABILITIES = {
  listServers: true,
  createServer: true,
  deleteServer: true,
  suspendServer: true,
  resumeServer: true,
  resetPassword: true,
  resetPasswordLabel: '🔑 ریست پسورد',
  privateKey: true,
  traffic: true,
  projectTraffic: true,
  rebuild: true,
  snapshot: true,
  listSnapshots: true,
  buildFromSnapshot: true,
  changeCycle: true,
  createKeyPair: true,
  deleteKeyPair: true
};

const PROVIDER_CAPABILITIES = {
  afracloud: {
    listServers: true,
    createServer: true,
    deleteServer: true,
    suspendServer: true,
    resumeServer: true,
    resetPassword: true,
    resetPasswordLabel: '🔑 دریافت رمز عبور',
    privateKey: false,
    traffic: false,
    projectTraffic: false,
    rebuild: false,
    snapshot: false,
    listSnapshots: false,
    buildFromSnapshot: false,
    changeCycle: false,
    createKeyPair: false,
    deleteKeyPair: false
  },
  hetzner: {
    // The current Hetzner adapter does not implement snapshot listing/building.
    // Keep these disabled so purchase flows never fall through to OpenStack-only calls.
    snapshot: false,
    listSnapshots: false,
    buildFromSnapshot: false
  },
  openstack: {}
};

function getProviderKey(dcConfig) {
  return dcConfig?.provider || dcConfig?.apiType || 'openstack';
}

function getCapabilities(dcConfig) {
  const providerKey = getProviderKey(dcConfig);
  return {
    ...DEFAULT_CAPABILITIES,
    ...(PROVIDER_CAPABILITIES[providerKey] || {}),
    ...(dcConfig?.capabilities || {})
  };
}

function hasCapability(dcConfig, feature) {
  return getCapabilities(dcConfig)[feature] === true;
}

function getCapabilityLabel(dcConfig, feature, fallback) {
  const caps = getCapabilities(dcConfig);
  const key = `${feature}Label`;
  return caps[key] || fallback;
}

module.exports = { DEFAULT_CAPABILITIES, PROVIDER_CAPABILITIES, getProviderKey, getCapabilities, hasCapability, getCapabilityLabel };
