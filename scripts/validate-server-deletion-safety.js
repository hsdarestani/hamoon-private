'use strict';

const assert = require('assert');
const safety = require('../services/server-deletion-safety');

async function main() {
  assert.equal(safety.isDefiniteNotFound({ response: { status: 404 } }), true);
  assert.equal(safety.isDefiniteNotFound(new Error('temporary timeout')), false);

  assert.deepStrictEqual(
    safety.attachedVolumeIds({
      'os-extended-volumes:volumes_attached': [{ id: 'vol-a' }, { id: 'vol-b' }, { id: 'vol-a' }]
    }),
    ['vol-a', 'vol-b']
  );

  assert.equal(
    safety.openStackVolumeBaseUrl({
      OS_AUTH_URL: 'http://127.0.0.1:5000',
      OS_PROJECT_ID: 'project-1'
    }),
    'http://127.0.0.1:8776/v3/project-1'
  );

  let serverChecks = 0;
  const fakeCloud = {
    async getServer() {
      serverChecks += 1;
      if (serverChecks < 3) return { id: 'srv-1' };
      const error = new Error('not found');
      error.response = { status: 404 };
      throw error;
    }
  };
  const serverResult = await safety.waitForServerDeletion({
    cloud: fakeCloud,
    dc: {},
    token: 'x',
    serverId: 'srv-1',
    timeoutMs: 10000,
    pollMs: 1,
    sleeper: async () => {}
  });
  assert.equal(serverResult.confirmed, true);
  assert.equal(serverChecks, 3);

  let volumeExists = true;
  let deleteCalls = 0;
  let sleeps = 0;
  const fakeGetVolume = async (_dc, _token, id) => {
    if (!volumeExists) {
      const error = new Error('not found');
      error.response = { status: 404 };
      throw error;
    }
    return { id, bootable: 'true', attachments: [] };
  };
  const fakeDeleteVolume = async () => {
    deleteCalls += 1;
    volumeExists = false;
    return true;
  };
  const fakeSleep = async () => {
    sleeps += 1;
    if (sleeps >= 2) {
      // Keep it present long enough to exercise explicit delete path.
    }
  };

  // Use a custom sleeper that advances Date.now-driven grace by removing the
  // volume only after the explicit delete call. The function should still issue
  // exactly one delete request and confirm 404 afterwards.
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => (now += 6000);
  try {
    const confirmed = await safety.ensureBootVolumesDeleted({
      dc: {
        apiType: 'openstack',
        OS_AUTH_URL: 'http://127.0.0.1:5000',
        OS_PROJECT_ID: 'project-1'
      },
      token: 'x',
      volumeIds: ['vol-a'],
      getVolume: fakeGetVolume,
      deleteVolume: fakeDeleteVolume,
      sleeper: fakeSleep
    });
    assert.deepStrictEqual(confirmed, ['vol-a']);
    assert.equal(deleteCalls, 1);
  } finally {
    Date.now = originalNow;
  }

  console.log('validate-server-deletion-safety: ok');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
