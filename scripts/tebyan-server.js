'use strict';

require('dotenv').config();

const path = require('path');
const openstackApi = require(path.join('..', 'openstack-api'));
const datacenters = require(path.join('..', 'datacenters'));

const serverId = process.argv[2];
const action = process.argv[3];

if (!serverId) {
  console.error('Usage: node scripts/tebyan-server.js SERVER_ID [--delete]');
  process.exit(2);
}

const dc = datacenters.tebyan || Object.values(datacenters).find(x => x && x.key === 'tebyan');

if (!dc) {
  console.error('TEBYAN_DATACENTER_NOT_FOUND');
  process.exit(1);
}

(async () => {
  const token = await openstackApi.getToken(dc);

  if (action === '--delete') {
    console.log('Deleting:', serverId);
    const result = await openstackApi.deleteServer(dc, token, serverId);
    console.log('DELETE_RESULT:', result || 'OK');
    return;
  }

  const srv = await openstackApi.getServer(dc, token, serverId);

  const addresses = srv.addresses || {};
  const ips = [];

  for (const entries of Object.values(addresses)) {
    if (!Array.isArray(entries)) continue;
    for (const item of entries) {
      if (item && item.addr) ips.push(item.addr);
    }
  }

  console.log(JSON.stringify({
    id: srv.id,
    name: srv.name,
    status: srv.status,
    taskState: srv['OS-EXT-STS:task_state'],
    vmState: srv['OS-EXT-STS:vm_state'],
    powerState: srv['OS-EXT-STS:power_state'],
    addresses,
    ips,
    created: srv.created,
    updated: srv.updated,
    fault: srv.fault || null,
    metadata: srv.metadata || {}
  }, null, 2));
})().catch(error => {
  const status = error?.response?.status;
  const data = error?.response?.data;

  if (status === 404) {
    console.error(JSON.stringify({
      status: 404,
      message: 'PROVIDER_SERVER_NOT_FOUND',
      serverId
    }, null, 2));
    process.exit(4);
  }

  console.error('FATAL:', error.message);
  if (data) console.error(JSON.stringify(data, null, 2));
  process.exit(1);
});
