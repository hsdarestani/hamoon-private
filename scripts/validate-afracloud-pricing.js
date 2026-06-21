const assert = require('assert');
const { AFRA_CLOUD_PLANS, MONTHLY_HOURS } = require('../Afracloud/afracloud-prices');

const expected = {
  small: [1, 4, 832000], medium: [2, 8, 1139374], large: [4, 16, 2278748], xlarge: [6, 24, 3418122],
  '2xlarge': [8, 32, 4557496], '3xlarge': [10, 40, 5696870], '4xlarge': [12, 48, 6836244],
  '5xlarge': [14, 56, 7975619], '6xlarge': [16, 64, 9114993], '7xlarge': [18, 72, 10254367],
  '8xlarge': [20, 80, 11393741], '9xlarge': [22, 88, 12533115], '10xlarge': [24, 96, 13672489],
  '11xlarge': [26, 104, 14811863], '12xlarge': [28, 112, 15951237], '13xlarge': [30, 120, 17090611],
  '14xlarge': [32, 128, 18229985]
};

assert.strictEqual(MONTHLY_HOURS, 720);
assert.strictEqual(AFRA_CLOUD_PLANS.length, Object.keys(expected).length);
assert.strictEqual(new Set(AFRA_CLOUD_PLANS.map(p => p.name)).size, AFRA_CLOUD_PLANS.length);
for (const plan of AFRA_CLOUD_PLANS) {
  assert.ok(plan.monthlyPrice > 0);
  assert.ok(plan.cpu > 0);
  assert.ok(plan.memoryGb > 0);
  assert.deepStrictEqual([plan.cpu, plan.memoryGb, plan.monthlyPrice], expected[plan.name]);
  const hourly = plan.monthlyPrice / MONTHLY_HOURS;
  assert.strictEqual(plan.monthlyPrice, plan.monthlyPrice, 'exact monthly price is direct source of truth');
  if (!Number.isInteger(hourly)) assert.notStrictEqual(Math.round(hourly) * MONTHLY_HOURS, plan.monthlyPrice);
}
console.log('AfraCloud pricing validation passed.');
