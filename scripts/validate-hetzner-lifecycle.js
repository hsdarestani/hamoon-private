#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const lifecycle = require('../services/hetzner-lifecycle');
const detector = require('../provider-detector');
const cloud = require('../cloud-api');

(async () => {
  assert(detector.isHetznerConfig({ apiType: 'hetzner', key: 'hetzner-fsn1' }));
  assert.strictEqual(cloud.pick({ apiType: 'hetzner' }).getHetznerApiToken ? 'hetzner' : 'other', 'hetzner');
  assert(detector.isAfraCloudConfig({ key: 'afracloud-ir' }));
  assert(detector.isOpenStackConfig({ OS_AUTH_URL: 'https://example.invalid' }));

  const lockedError = Object.assign(new Error('Request failed with status code 423'), {
    response: { status: 423, data: { error: { code: 'locked' } } }
  });
  assert(cloud.isHetznerLockedError(lockedError));
  assert(!cloud.isHetznerLockedError(Object.assign(new Error('bad request'), { response: { status: 400 } })));

  let lockedAttempts = 0;
  const retryResult = await cloud.retryHetznerLockedOperation(
    { apiType: 'hetzner', key: 'hetzner' },
    'test-start',
    async () => {
      lockedAttempts += 1;
      if (lockedAttempts < 3) throw lockedError;
      return 'ok';
    },
    { delays: [0, 0], sleep: async () => {} }
  );
  assert.strictEqual(retryResult, 'ok');
  assert.strictEqual(lockedAttempts, 3);

  let exhaustedAttempts = 0;
  await assert.rejects(
    cloud.retryHetznerLockedOperation(
      { apiType: 'hetzner', key: 'hetzner' },
      'test-start',
      async () => {
        exhaustedAttempts += 1;
        throw lockedError;
      },
      { delays: [0], sleep: async () => {} }
    ),
    err => err?.code === 'OPERATION_IN_PROGRESS' && err?.status === 423
  );
  assert.strictEqual(exhaustedAttempts, 2);

  let nonLockedAttempts = 0;
  await assert.rejects(
    cloud.retryHetznerLockedOperation(
      { apiType: 'hetzner', key: 'hetzner' },
      'test-start',
      async () => {
        nonLockedAttempts += 1;
        throw Object.assign(new Error('forbidden'), { response: { status: 403 } });
      },
      { delays: [0, 0], sleep: async () => {} }
    ),
    /forbidden/
  );
  assert.strictEqual(nonLockedAttempts, 1);

  assert(!lifecycle.isBillablePurchase({ status: 'deleted' }));
  assert(!lifecycle.isBillablePurchase({ status: 'deletion_pending' }));
  assert(!lifecycle.isBillablePurchase({ status: 'provisioning' }));
  assert(lifecycle.isBillablePurchase({ status: 'active' }));
  const plan = { amount_hourly: 10, amount_monthly: 6000, id: 'cax11' };
  assert.strictEqual(lifecycle.getFlavorCyclePrice(plan, 'hourly'), 10);
  assert.strictEqual(lifecycle.getFlavorCyclePrice(plan, 'daily'), 240);
  assert.strictEqual(lifecycle.getFlavorCyclePrice(plan, 'weekly'), 1680);
  assert.strictEqual(lifecycle.getFlavorCyclePrice(plan, 'monthly'), 6000);
  assert.throws(() => lifecycle.getFlavorCyclePrice(plan, 'yearly'), /INVALID_BILLING_CYCLE/);
  const pr = lifecycle.calculateCycleChange({ currentAmount: 240, currentCycle: 'daily', targetAmount: 1680, lastBilledAt: new Date(Date.now() - 12*3600000), now: new Date() });
  assert(pr.credit > 110 && pr.credit < 130 && pr.difference > 1500);
  assert.strictEqual(lifecycle.architectureForServerType('cax11'), 'arm');
  assert.strictEqual(lifecycle.architectureForServerType('cx22'), 'x86');
  assert.deepStrictEqual(lifecycle.filterCompatibleImages([{ id:'ubuntu-x86', architecture:'x86' }, { id:'ubuntu-arm', architecture:'arm' }], 'cax11').map(i=>i.id), ['ubuntu-arm']);
  lifecycle.markPlanUnavailable('fsn1','cax11', 10000);
  assert(lifecycle.isPlanTemporarilyUnavailable('fsn1','cax11'));
  assert(!lifecycle.filterSellablePlans([{ id:'cax11' }, { id:'cx22' }], { location:'fsn1', image:{ architecture:'arm' } }).some(p=>p.id==='cax11'));
  const ops=[];
  const provider={ getServer:async()=>({ primary_ipv4_id:'old', public_ip:'1.1.1.1', location:'fsn1' }), createPrimaryIpv4:async()=>{ops.push('create');return {id:'new',ip:'2.2.2.2'}}, powerOff:async()=>ops.push('poweroff'), waitAction:async()=>ops.push('wait'), unassignPrimaryIp:async id=>ops.push(`unassign:${id}`), assignPrimaryIp:async(id)=>ops.push(`assign:${id}`), deletePrimaryIp:async(id,o)=>{assert(o.onlyIfUnassigned);ops.push(`delete:${id}`)}, powerOn:async()=>ops.push('poweron') };
  const db={ getPurchaseForOwner:async()=>({status:'active'}), updatePublicIp:async()=>ops.push('dbip') };
  const origGet=cloud.getServer, origWait=cloud.waitHetznerAction; cloud.getServer=async()=>({status:'running', public_ip:'2.2.2.2'}); cloud.waitHetznerAction=async()=>{};
  await lifecycle.changePublicIpLifecycle({ db, dc:{apiType:'hetzner'}, telegramId:'u', serverId:'s', datacenter:'hetzner', provider, waitOptions:{waitTcp:async()=>true, timeoutMs:10} });
  cloud.getServer=origGet; cloud.waitHetznerAction=origWait;
  assert.deepStrictEqual(ops, ['create','poweroff','wait','unassign:old','assign:new','delete:old','poweron','dbip']);
  const text = ['customer-api.js','index.js','Hetzner/hetzner-api.js','services/hetzner-lifecycle.js'].map(f=>fs.readFileSync(f,'utf8')).join('\n');
  assert(!/console\.log\([^)]*root_password/i.test(text));
  assert(/deletePurchaseServer/.test(fs.readFileSync('customer-api.js','utf8')));
  assert(/handleRebuildAsk/.test(fs.readFileSync('index.js','utf8')) && /handleRebuildConfirm/.test(fs.readFileSync('index.js','utf8')));
  console.log('validate-hetzner-lifecycle: ok');
})().catch(e => { console.error(e); process.exit(1); });
