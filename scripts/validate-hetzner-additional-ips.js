'use strict';
const assert = require('assert');
const service = require('../services/hetzner-additional-ips');

async function run() {
  const calls = [];
  const request = async (_dc, method, path, body) => {
    calls.push({ method, path, body });
    if (path.startsWith('/servers/')) return { server: { id: 42 } };
    if (method === 'GET' && path === '/floating_ips?per_page=50') return { floating_ips: [
      { id: 1, ip: '192.0.2.1', type: 'ipv4', server: { id: 42 }, home_location: { name: 'nbg1' } },
      { id: 2, ip: '192.0.2.2', type: 'ipv4', server: { id: 7 }, home_location: { name: 'nbg1' } }
    ] };
    if (method === 'POST' && path === '/floating_ips') return { floating_ip: { id: 3, ip: '192.0.2.3', type: 'ipv4', server: { id: 42 } }, action: { id: 9 } };
    throw new Error(`Unexpected request: ${method} ${path}`);
  };
  assert.deepStrictEqual((await service.listAdditionalIps({ dc: {}, serverId: '42', request })).map(x => x.id), ['1']);
  const created = await service.addAdditionalIpv4({ dc: {}, serverId: '42', description: '  API\ncustomer  ', maxIps: 2, request });
  assert.strictEqual(created.ip.ip, '192.0.2.3');
  assert.deepStrictEqual(calls.at(-1).body, { type: 'ipv4', server: 42, description: 'API customer' });

  await assert.rejects(
    service.addAdditionalIpv4({ dc: {}, serverId: '42', maxIps: 1, request }),
    error => error.code === 'ADDITIONAL_IP_LIMIT_REACHED' && error.limit === 1
  );

  const foreignRequest = async (_dc, method, path) => {
    if (method === 'GET' && path === '/floating_ips/2') return { floating_ip: { id: 2, ip: '192.0.2.2', server: { id: 7 } } };
    throw new Error('Delete must not be called for another server');
  };
  await assert.rejects(
    service.deleteAdditionalIp({ dc: {}, serverId: '42', floatingIpId: '2', request: foreignRequest }),
    error => error.code === 'ADDITIONAL_IP_NOT_FOUND'
  );
  console.log('Hetzner additional IP validation passed');
}

run().catch(error => { console.error(error); process.exit(1); });
