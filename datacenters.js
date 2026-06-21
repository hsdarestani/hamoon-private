// datacenters.js
// این فایل مرکزی، اطلاعات تمام دیتاسنترها، پلن‌ها و ایمیج‌های مخصوص هرکدام را نگهداری می‌کند.
// لیست نام‌های پلن‌ها و ایمیج‌های مورد تایید که در تمام دیتاسنترها مشترک هستند
const approvedFlavorNames = [
    "Cloud basic - 1 Core - 1 GB RAM - 20 GB SSD",
    "Cloud Medium - 2 Cores - 2 GB RAM - 40 GB SSD",
    "Cloud advance - 2 Cores - 4 GB RAM - 50 GB SSD",
    "Thunder basic- 4 Cores - 4 GB RAM - 80 GB SSD",
    "Thunder Medium- 4 Cores - 4 GB RAM - 80 GB SSD",
    "Thunder Pro - 6 Cores - 6 GB RAM - 120 GB SSD",
    "Thunder  Medium- 4 Cores - 8 GB RAM - 100 GB SSD",
    "Thunder basic - 4 Cores - 8 GB RAM - 100 GB SSD"
];

const approvedImageMap = {
    "Debian-12": ["Debian-12", "debian-12", "debian-12-final"],
    "Debian-11": ["Debian-11", "debian-11", "debian-11-final"],
    "Mikrotik": ["Mikrotik", "mikrotik"],
    "Ubuntu-24.04": ["Ubuntu-24.04", "ubuntu-24.04", "ubuntu-2404-final", "ubuntu-24"],
    "Ubuntu-22.04": ["Ubuntu-22.04", "ubuntu-22.04", "ubuntu-2204-final", "ubuntu-22"],
    "Ubuntu-20.04": ["Ubuntu-20.04", "ubuntu-20.04", "ubuntu-2004-final", "ubuntu-20"],
    "Fedora": ["Fedora", "fedora"],
    "Alma-9": ["Alma-9", "alma-9", "almalinux-9-final"],
    "Alma-8": ["Alma-8", "alma-8", "almalinux-8-final"],
    "Rocky-9": ["Rocky-9", "rocky-9", "rocky-9-generic-final"],
    "Rocky-8": ["Rocky-8", "rocky-8", "rocky-8-generic-final"],
    "pfSense-CE-2.7.2": ["pfSense-CE-2.7.2", "pfSense-2.7.2"],
};

const {
  usdMonthlyToTomanWithMargin,
  monthlyTomanToHourly,
} = require('./prices');

module.exports = {


hetzner: {
  key: 'hetzner',
  name: 'آلمان',
  provider: 'hetzner',

  HETZNER_PASSWORD_ONLY: true,
  HETZNER_API_TOKEN: process.env.HETZNER_API_TOKEN,
  HETZNER_LOCATION: process.env.HETZNER_LOCATION || 'nbg1',

  allowTest: false,
  BILL_TRAFFIC: false,

  // ===== قیمت‌ها =====
  flavors: (() => {
    const plansUSD = [
      // CX family (shared vCPU)
      { id: 'CX23', hetzner_type: 'cx23', cores: 2, memory: 4,  disk: 40,  label: 'CX23 (2vCPU / 4GB / 40GB)',  usdMonthly: 4.9 },
      { id: 'CX33', hetzner_type: 'cx33', cores: 4, memory: 8,  disk: 80,  label: 'CX33 (4vCPU / 8GB / 80GB)',  usdMonthly: 9.4 },

      // ARM
      { id: 'CAX11', hetzner_type: 'cax11', cores: 2, memory: 4,  disk: 40,  label: 'CAX11 (2vCPU / 4GB / 40GB, ARM)', usdMonthly: 4.7 },

      // Dedicated vCPU
      { id: 'CCX13', hetzner_type: 'ccx13', cores: 2, memory: 8,  disk: 80,  label: 'CCX13 (2ded vCPU / 8GB / 80GB)', usdMonthly: 14.3 },
    ];

    return plansUSD.map(p => {
      const monthlyToman = usdMonthlyToTomanWithMargin(p.usdMonthly);
      const hourlyToman  = monthlyTomanToHourly(monthlyToman);
      return {
        id: p.id,
        hetzner_type: p.hetzner_type,
        label: p.label,
        price: hourlyToman,
        monthly_toman: monthlyToman,
        usd_monthly_raw: p.usdMonthly,
        disk: p.disk,
        cores: p.cores,
        memory: p.memory,
      };
    });
  })(),

  images: [],
  apiType: 'hetzner',

  TRAFFIC_API_BASE_URL: null,
  TRAFFIC_API_KEY: null,
},



afracloud: {
  key: 'afracloud',
  name: 'افراکلود',
  provider: 'afracloud',

  API_BASE_URL: 'https://panel.afracloud.net',
  API_KEY: process.env.AFRACLOUD_API_KEY,
  SECRET_KEY: process.env.AFRACLOUD_SECRET_KEY,

  ZONE_UUID: '55a14e1b-024c-4ea4-8dcc-826eacde15e0',
  NETWORK_UUID: 'd292caad-3d08-4ac1-b91a-695c499b39f8',

  allowTest: false,
  BILL_TRAFFIC: false,
  allowedCycles: ['monthly'],
  authPolicy: {
    buy: 'shahkar'
  },
  capabilities: {
    listServers: true,
    createServer: true,
    deleteServer: true,
    suspendServer: true,
    resumeServer: true,
    resetPassword: true,
    resetPasswordLabel: '🔑 دریافت رمز عبور',
    privateKey: true,
    traffic: false,
    projectTraffic: false,
    rebuild: false,
    snapshot: false,
    listSnapshots: false,
    buildFromSnapshot: false,
    changeCycle: false,
    createKeyPair: true,
    deleteKeyPair: true
  },

  flavors: [],

  images: [
    { name: "Ubuntu-24.04", id: "7bf8c5fc-a9e9-4d94-abe7-5a93f17745b3" },
    { name: "Ubuntu-22.04", id: "6cd297d9-a9a5-4960-8b15-07d846628de9" },
    { name: "Debian-12", id: "b9775e7a-ceda-43a5-9b34-59f872c6a1e0" }
  ],

  apiType: 'afracloud'
},



  tebyan: {
    key: 'tebyan',
    name: 'تبیان',
    OS_AUTH_URL: 'http://94.232.171.61:5000',
    OS_PROJECT_ID: '0098ed7d85d04a298a79cc9a1ae30947',
    OS_USER_DOMAIN_NAME: 'Default',
    OS_PROJECT_DOMAIN_ID: 'default',
    OS_USERNAME: 'hb_client_3199_3',
    OS_PASSWORD: 'ivbrLrp1',
    OS_NETWORK_ID:'6a7c5354-d64d-41f7-aa90-7f76bd788087',
    OS_TEST_FLAVOR_ID: 'b9885607-6b52-401f-856d-c5e743336435', // 2-2-40
    OS_TEST_IMAGE_ID: 'f24e6327-450b-4339-b79a-1abb08083c95', // Ubuntu 24
    TRAFFIC_API_BASE_URL: 'https://netbill.tebyansmart.com/traffic/',
    TRAFFIC_API_KEY: '107Y1f1W5bNHvV7nNUtN7RN3Q27n9bJdXYDRp6wvzGn52FIeByRn7oWZVKvE6TEN',
    flavors: [
        { name: "Cloud basic - 1 Core - 1 GB RAM - 20 GB SSD", id: "5fbbf7e9-7326-41b1-81db-fdca847a83e1", monthly_price: 340000 },
        { name: "Cloud Medium - 2 Cores - 2 GB RAM - 40 GB SSD", id: "b9885607-6b52-401f-856d-c5e743336435", monthly_price: 600000 },
        { name: "Cloud advance - 2 Cores - 4 GB RAM - 50 GB SSD", id: "2162d6cc-305c-415f-b4b7-7bd0bc5575f0", monthly_price: 770625 },
        { name: "Thunder basic- 4 Cores - 4 GB RAM - 80 GB SSD", id: "72955761-999f-4bb3-bf58-f24e73fe4b47", monthly_price: 1120000 },
        { name: "Thunder Pro - 6 Cores - 6 GB RAM - 120 GB SSD", id: "16f7cfbb-4502-41bc-985f-6f12386f2dd3", monthly_price: 1640000 },
        { name: "Thunder  Medium- 4 Cores - 8 GB RAM - 100 GB SSD", id: "5b444500-5a08-4a9b-808d-bd913014d0da", monthly_price: 1461250 },
        { name: "Thunder  Advanced- 16 Cores - 64 GB RAM - 750 GB SSD", id: "a44c6d5d-9b69-483d-9ac6-906add8b0228", monthly_price: 9230375 },
    ],
    images: [
        { name: "Debian-12", id: "a10db8cb-5831-4a96-b826-2f21886ed694" },
        { name: "Debian-11", id: "24903df2-90f7-4bf4-ba28-5ad8931ba86b" },
        { name: "Mikrotik", id: "78e950c1-58cc-4c35-8f3c-76270c6241f3" },
        { name: "Ubuntu-24.04", id: "f24e6327-450b-4339-b79a-1abb08083c95" },
        { name: "Ubuntu-22.04", id: "58e1c167-94cc-4537-8fca-68cb79f0f602" },
        { name: "Ubuntu-20.04", id: "af76b2b6-f017-46c3-a38e-5dec6daa344c" },
        { name: "Fedora", id: "65409c35-3989-4775-8f17-471ee4a7e82d" },
        // No Alma-9 in Tebyan list
        { name: "Alma-8", id: "b76d0cc9-4f7e-4f59-af5b-39e26944f8e2" },
        { name: "Rocky-9", id: "e5ab87f0-abfa-4586-a716-f5bdc4862e42" },
        { name: "Rocky-8", id: "9e753d09-19d5-4b8f-820b-5c3b381207a7" },
        // No pfSense in Tebyan list
    ]
  }
};
