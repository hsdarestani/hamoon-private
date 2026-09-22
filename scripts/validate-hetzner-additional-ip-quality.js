#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const quality = require('../services/hetzner-additional-ip-quality');
const bootstrap = require('../hetzner-additional-ip-quality-bootstrap');

async function run() {
  const floating = new Map();
  let created = 0;
  let deleted = 0;
  let qualityCalls = 0;
  const calls = [];

  const request = async (_dc, method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'GET' && path === '/servers/42') {
      return { server: {
        id: 42,
        public_net: { ipv4: { ip: '198.51.100.42' } },
        datacenter: { location: { name: 'nbg1' } }
      } };
    }
    if (method === 'GET' && path === '/floating_ips?per_page=50') {
      return { floating_ips: [] };
    }
    if (method === 'POST' && path === '/floating_ips') {
      created += 1;
      const item = {
        id: 100 + created,
        ip: created === 1 ? '192.0.2.10' : '192.0.3.10',
        type: 'ipv4',
        server: { id: 42 },
        home_location: { name: 'nbg1' }
      };
      floating.set(String(item.id), item);
      return { floating_ip: item, action: null };
    }
    if (method === 'GET' && path.startsWith('/floating_ips/')) {
      const id = path.split('/').pop();
      return { floating_ip: floating.get(String(id)) || null };
    }
    if (method === 'DELETE' && path.startsWith('/floating_ips/')) {
      const id = path.split('/').pop();
      floating.delete(String(id));
      deleted += 1;
      return {};
    }
    throw new Error(`Unexpected ${method} ${path}`);
  };

  const db = {
    getServerSecret: async () => 'secret',
    pool: {
      query: async sql => {
        const text = String(sql);
        if (text.includes('CREATE TABLE IF NOT EXISTS hetzner_bad_ipv4_ranges')) return [[], []];
        if (text.includes('SELECT range_prefix')) return [[], []];
        if (text.includes('INSERT INTO hetzner_bad_ipv4_ranges')) return [{ affectedRows: 1 }, []];
        throw new Error(`Unexpected DB query: ${text}`);
      }
    }
  };

  const execSsh = async args => {
    assert.strictEqual(args.host, '198.51.100.42');
    assert.strictEqual(args.password, 'secret');
    return true;
  };

  const result = await quality.createVerifiedAdditionalIpv4({
    dc: {},
    serverId: '42',
    telegramId: 'u',
    description: 'test',
    request,
    db,
    execSsh,
    checkQuality: async ip => {
      qualityCalls += 1;
      if (ip === '192.0.2.10') {
        return {
          ok: false,
          definitive: true,
          reason: 'failed_threshold',
          iran: { selected: 4, success: 0 },
          global: { selected: 6, success: 6 }
        };
      }
      return {
        ok: true,
        definitive: true,
        reason: 'ok',
        iran: { selected: 4, success: 4 },
        global: { selected: 6, success: 6 }
      };
    },
    maxAttempts: 3
  });

  assert.strictEqual(result.ip.ip, '192.0.3.10');
  assert.strictEqual(result.verified, true);
  assert.strictEqual(result.attempts, 2);
  assert.strictEqual(created, 2);
  assert.strictEqual(deleted, 1, 'dirty candidate must be deleted before retry');
  assert.strictEqual(qualityCalls, 2);

  await assert.rejects(
    quality.createVerifiedAdditionalIpv4({
      dc: {},
      serverId: '42',
      telegramId: 'u',
      request,
      db,
      getSecret: async () => null,
      execSsh,
      checkQuality: async () => ({ ok: true })
    }),
    error => error.code === 'ADDITIONAL_IP_QUALITY_VERIFY_UNAVAILABLE'
  );

  const core = fs.readFileSync(require.resolve('../index-core.js'), 'utf8');
  const patched = bootstrap.applyHetznerAdditionalIpQualityPatches(core);
  assert(patched.includes('additionalIpQuality.createVerifiedAdditionalIpv4'));
  assert(patched.includes('NO_CLEAN_ADDITIONAL_IPV4_AVAILABLE'));
  assert(patched.includes('additionalIpQuality.deleteVerifiedAdditionalIp'));
  new vm.Script(patched, { filename: 'index-core.additional-ip-quality.patched.js' });

  console.log('validate-hetzner-additional-ip-quality: ok');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
