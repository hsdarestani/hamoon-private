const MONTHLY_HOURS = 720;

const AFRA_CLOUD_PLANS = [
  { name: 'small', cpu: 1, memoryGb: 4, monthlyPrice: 832000 },
  { name: 'medium', cpu: 2, memoryGb: 8, monthlyPrice: 1139374 },
  { name: 'large', cpu: 4, memoryGb: 16, monthlyPrice: 2278748 },
  { name: 'xlarge', cpu: 6, memoryGb: 24, monthlyPrice: 3418122 },
  { name: '2xlarge', cpu: 8, memoryGb: 32, monthlyPrice: 4557496 },
  { name: '3xlarge', cpu: 10, memoryGb: 40, monthlyPrice: 5696870 },
  { name: '4xlarge', cpu: 12, memoryGb: 48, monthlyPrice: 6836244 },
  { name: '5xlarge', cpu: 14, memoryGb: 56, monthlyPrice: 7975619 },
  { name: '6xlarge', cpu: 16, memoryGb: 64, monthlyPrice: 9114993 },
  { name: '7xlarge', cpu: 18, memoryGb: 72, monthlyPrice: 10254367 },
  { name: '8xlarge', cpu: 20, memoryGb: 80, monthlyPrice: 11393741 },
  { name: '9xlarge', cpu: 22, memoryGb: 88, monthlyPrice: 12533115 },
  { name: '10xlarge', cpu: 24, memoryGb: 96, monthlyPrice: 13672489 },
  { name: '11xlarge', cpu: 26, memoryGb: 104, monthlyPrice: 14811863 },
  { name: '12xlarge', cpu: 28, memoryGb: 112, monthlyPrice: 15951237 },
  { name: '13xlarge', cpu: 30, memoryGb: 120, monthlyPrice: 17090611 },
  { name: '14xlarge', cpu: 32, memoryGb: 128, monthlyPrice: 18229985 },
];

module.exports = { AFRA_CLOUD_PLANS, MONTHLY_HOURS };
