'use strict';
const assert = require('assert');
const service = require('../services/hetzner-additional-ips');
const billing = require('../services/hetzner-additional-ip-billing');

async function run() {
  assert.deepStrictEqual(billing.quote(), { amount: 750000, currency: 'TOMAN', cycle: 'monthly', cycle_hours: 720, provider_price_eur: 3, eur_rate_toman: 250000 });
  assert.strictEqual(billing.MONTHLY_PRICE_TOMAN, 750000);
  const calls = [];
  const request = async (_dc, method, path, body) => {
    calls.push({ method, path, body });
    if (path.startsWith('/servers/')) return { server: { id: 42 } };
    if (method === 'GET' && path === '/floating_ips?per_page=50') return { floating_ips: [
      { id: 1, ip: '192.0.2.1', type: 'ipv4', server: 42, home_location: { name: 'nbg1' } },
      { id: 2, ip: '192.0.2.2', type: 'ipv4', server: 7, home_location: { name: 'nbg1' } }
    ] };
    if (method === 'POST' && path === '/floating_ips') return { floating_ip: { id: 3, ip: '192.0.2.3', type: 'ipv4', server: 42 }, action: { id: 9 } };
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
    if (method === 'GET' && path === '/floating_ips/2') return { floating_ip: { id: 2, ip: '192.0.2.2', server: 7 } };
    throw new Error('Delete must not be called for another server');
  };
  await assert.rejects(
    service.deleteAdditionalIp({ dc: {}, serverId: '42', floatingIpId: '2', request: foreignRequest }),
    error => error.code === 'ADDITIONAL_IP_NOT_FOUND'
  );

  const deleteCalls = [];
  const deleteRequest = async (_dc, method, path, body) => {
    deleteCalls.push({ method, path, body });
    if (method === 'GET' && path === '/floating_ips/3') {
      return { floating_ip: { id: 3, ip: '192.0.2.3', server: 42, protection: { delete: false } } };
    }
    if (method === 'POST' && path === '/floating_ips/3/actions/unassign') {
      return { action: { id: 77 } };
    }
    if (method === 'DELETE' && path === '/floating_ips/3') return {};
    throw new Error(`Unexpected delete request: ${method} ${path}`);
  };
  let waitedFor = null;
  await service.deleteAdditionalIp({
    dc: {},
    serverId: '42',
    floatingIpId: '3',
    request: deleteRequest,
    waitAction: async actionId => { waitedFor = actionId; }
  });
  assert.strictEqual(waitedFor, 77);
  assert.deepStrictEqual(deleteCalls.map(x => [x.method, x.path]), [
    ['GET', '/floating_ips/3'],
    ['POST', '/floating_ips/3/actions/unassign'],
    ['DELETE', '/floating_ips/3']
  ]);

  assert.strictEqual(service.floatingIpServerId({ server: 42 }), '42');
  assert.strictEqual(service.floatingIpServerId({ server: { id: 42 } }), '42');
  console.log('Hetzner additional IP validation passed');
}

run().catch(error => { console.error(error); process.exit(1); });
