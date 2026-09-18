#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  selectReachableIp,
  isSafeConnectRetry,
  postToZibal
} = require('../services/zibal-gateway');

(async () => {
  const selected = await selectReachableIp(new Set(), {
    resolve4: async () => ['192.0.2.10', '192.0.2.20'],
    probeTcp: async ip => {
      if (ip === '192.0.2.10') throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
      return { ip, latencyMs: 5 };
    }
  });
  assert.strictEqual(selected.ip, '192.0.2.20');

  assert.strictEqual(
    isSafeConnectRetry(Object.assign(new Error('connect ETIMEDOUT 192.0.2.10:443'), { code: 'ETIMEDOUT' })),
    true
  );
  assert.strictEqual(
    isSafeConnectRetry(Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED' })),
    false
  );

  let calls = 0;
  const mockAxios = {
    async post(url, body, config) {
      calls += 1;
      assert.strictEqual(url, 'https://gateway.zibal.ir/v1/request');
      assert.deepStrictEqual(body, { test: true });
      assert(config.httpsAgent);
      return { data: { result: 102 } };
    }
  };
  const response = await postToZibal(mockAxios, '/v1/request', { test: true }, {
    resolve4: async () => ['192.0.2.20'],
    probeTcp: async ip => ({ ip, latencyMs: 1 })
  });
  assert.strictEqual(calls, 1);
  assert.strictEqual(response.zibalGatewayIp, '192.0.2.20');

  console.log('validate-zibal-gateway: ok');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
