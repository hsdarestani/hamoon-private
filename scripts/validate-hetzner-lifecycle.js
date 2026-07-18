#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const lifecycle = require('../services/hetzner-lifecycle');
const detector = require('../provider-detector');
const cloud = require('../cloud-api');
const hetzner = require('../Hetzner/hetzner-api');

(async () => {
  assert(
    detector.isHetznerConfig({
      apiType: 'hetzner',
      key: 'hetzner-fsn1'
    })
  );
  assert(
    detector.isHetznerConfig({
      HETZNER_LOCATION: 'nbg1'
    })
  );
  assert(
    detector.isAfraCloudConfig({
      key: 'afracloud-ir'
    })
  );
  assert(
    detector.isOpenStackConfig({
      OS_AUTH_URL: 'https://example.invalid'
    })
  );

  assert.strictEqual(
    cloud.pick({ apiType: 'hetzner' }),
    require('../Hetzner/hetzner-api')
  );

  assert.strictEqual(
    lifecycle.isBillablePurchase({ status: 'deleted' }),
    false
  );
  assert.strictEqual(
    lifecycle.isBillablePurchase({
      status: 'deletion_pending'
    }),
    false
  );
  assert.strictEqual(
    lifecycle.isBillablePurchase({
      status: 'provisioning'
    }),
    false
  );
  assert.strictEqual(
    lifecycle.isBillablePurchase({ status: 'active' }),
    true
  );
  assert.strictEqual(
    lifecycle.isBillablePurchase({
      status: 'suspended'
    }),
    true
  );

  const plan = {
    amount_hourly: 1000,
    amount_monthly: 500000,
    id: 'cax11'
  };

  assert.strictEqual(
    lifecycle.getFlavorCyclePrice(plan, 'hourly'),
    1000
  );
  assert.strictEqual(
    lifecycle.getFlavorCyclePrice(plan, 'daily'),
    24000
  );
  assert.strictEqual(
    lifecycle.getFlavorCyclePrice(plan, 'weekly'),
    168000
  );
  assert.strictEqual(
    lifecycle.getFlavorCyclePrice(plan, 'monthly'),
    500000
  );

  assert.strictEqual(
    lifecycle.getPurchaseCycleAmount({
      amount: 1000,
      duration: 'daily',
      billing_amount_version: 1
    }),
    24000
  );
  assert.strictEqual(
    lifecycle.getPurchaseCycleAmount({
      amount: 24000,
      duration: 'daily',
      billing_amount_version: 2
    }),
    24000
  );

  const proration = lifecycle.calculateCycleChange({
    currentAmount: 24000,
    currentCycle: 'daily',
    targetAmount: 168000,
    lastBilledAt: new Date(
      Date.now() - 12 * 3600000
    ),
    now: new Date()
  });

  assert(proration.credit > 11000);
  assert(proration.credit < 13000);
  assert(proration.difference > 150000);

  assert.strictEqual(
    lifecycle.architectureForServerType('cax11'),
    'arm'
  );
  assert.strictEqual(
    lifecycle.architectureForServerType('cx23'),
    'x86'
  );
  assert.deepStrictEqual(
    lifecycle
      .filterCompatibleImages(
        [
          {
            id: 'ubuntu-x86',
            architecture: 'x86'
          },
          {
            id: 'ubuntu-arm',
            architecture: 'arm'
          }
        ],
        'cax11'
      )
      .map(image => image.id),
    ['ubuntu-arm']
  );

  hetzner.markServerTypeUnavailable(
    'fsn1',
    'cax11',
    10000
  );
  assert(
    hetzner.isServerTypeTemporarilyUnavailable(
      'fsn1',
      'cax11'
    )
  );
  assert.deepStrictEqual(
    hetzner
      .filterConfiguredServerTypes(
        [
          { id: 'cax11' },
          { id: 'cx23' }
        ],
        {
          HETZNER_LOCATION: 'fsn1'
        }
      )
      .map(item => item.id),
    ['cx23']
  );

  const operationLog = [];
  const original = {
    getServer: cloud.getServer,
    powerOffHetznerServer:
      cloud.powerOffHetznerServer,
    powerOnHetznerServer:
      cloud.powerOnHetznerServer,
    createPrimaryIpv4:
      cloud.createPrimaryIpv4,
    unassignPrimaryIp:
      cloud.unassignPrimaryIp,
    assignPrimaryIp:
      cloud.assignPrimaryIp,
    deletePrimaryIp:
      cloud.deletePrimaryIp,
    waitHetznerAction:
      cloud.waitHetznerAction
  };

  let serverReadCount = 0;

  cloud.getServer = async () => {
    serverReadCount += 1;

    return {
      id: '42',
      status:
        serverReadCount === 1
          ? 'running'
          : 'running',
      server_type: 'cx23',
      location: 'fsn1',
      primary_ipv4_id: 'old-ip-id',
      public_ip:
        serverReadCount === 1
          ? '1.1.1.1'
          : '2.2.2.2'
    };
  };
  cloud.powerOffHetznerServer = async () => {
    operationLog.push('poweroff');
    return { id: 'poweroff-action' };
  };
  cloud.powerOnHetznerServer = async () => {
    operationLog.push('poweron');
    return { id: 'poweron-action' };
  };
  cloud.createPrimaryIpv4 = async () => {
    operationLog.push('create-new-ip');
    return {
      id: 'new-ip-id',
      ip: '2.2.2.2'
    };
  };
  cloud.unassignPrimaryIp = async (_dc, id) => {
    operationLog.push(`unassign:${id}`);
    return { id: `unassign-${id}` };
  };
  cloud.assignPrimaryIp = async (
    _dc,
    id,
    serverId
  ) => {
    operationLog.push(`assign:${id}:${serverId}`);
    return { id: `assign-${id}` };
  };
  cloud.deletePrimaryIp = async (_dc, id) => {
    operationLog.push(`delete:${id}`);
  };
  cloud.waitHetznerAction = async () => {};

  const db = {
    getPurchaseForOwner: async () => ({
      status: 'active'
    }),
    updateScopedStatus: async (
      _user,
      _server,
      _dc,
      status
    ) => {
      operationLog.push(`status:${status}`);
    },
    updatePublicIp: async (
      _user,
      _server,
      _dc,
      ip
    ) => {
      operationLog.push(`db-ip:${ip}`);
    }
  };

  const changeResult =
    await lifecycle.changePublicIpLifecycle({
      db,
      dc: {
        provider: 'hetzner',
        HETZNER_LOCATION: 'fsn1'
      },
      telegramId: 'user',
      serverId: '42',
      datacenter: 'hetzner',
      waitOptions: {
        timeoutMs: 100,
        waitTcp: async () => true
      }
    });

  assert.strictEqual(
    changeResult.new_ip,
    '2.2.2.2'
  );
  assert.deepStrictEqual(
    operationLog,
    [
      'status:changing_ip',
      'poweroff',
      'create-new-ip',
      'unassign:old-ip-id',
      'assign:new-ip-id:42',
      'poweron',
      'delete:old-ip-id',
      'db-ip:2.2.2.2',
      'status:active'
    ]
  );

  Object.assign(cloud, original);

  const indexText = fs.readFileSync(
    'index.js',
    'utf8'
  );
  const customerText = fs.readFileSync(
    'customer-api.js',
    'utf8'
  );
  const apiText = fs.readFileSync(
    'Hetzner/hetzner-api.js',
    'utf8'
  );

  assert(
    indexText.includes(
      'hetznerLifecycle.deletePurchaseServer'
    )
  );
  assert(
    indexText.includes(
      'hetznerLifecycle.changePublicIpLifecycle'
    )
  );
  assert(
    indexText.includes(
      'hetznerLifecycle.waitForReadiness'
    )
  );
  assert(
    indexText.includes(
      'if (!hetznerLifecycle.isBillablePurchase(purchase)) continue;'
    )
  );
  assert(
    customerText.includes(
      'lifecycle.changePublicIpLifecycle'
    )
  );
  assert(
    !customerText.includes(
      "operation:'change_ip_started'"
    )
  );
  assert(
    apiText.includes(
      "location: String(location)"
    )
  );
  assert(
    !/console\.log\([^)]*root_password/i.test(
      [
        indexText,
        customerText,
        apiText
      ].join('\n')
    )
  );

  console.log(
    'validate-hetzner-lifecycle: ok'
  );
})().catch(error => {
  console.error(error);
  process.exit(1);
});
