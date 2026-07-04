// prices.js
// This file contains factors for calculating server prices based on billing cycle.
// Base price is assumed to be monthly.

const prices = {
    // Factors to multiply the monthly base price for other billing cycles
    // Example: weekly price = monthly_base_price * weeklyFactor
    weeklyFactor: 0.30, // 30% of monthly for a week
    dailyFactor: 0.08,  // 8% of monthly for a day
    hourlyFactor: 0.005 // 0.5% of monthly for an hour
};
// prices.js
// ورودی: قیمت‌ها به دلار (ماهانه)
// خروجی کمکی: تبدیل دلار به تومان با اعمال حاشیه سود

// نرخ دلار به تومان و درصد سود (مقدار پیش‌فرض؛ قابل override با .env)
const USD_TO_TOMAN = parseFloat(process.env.USD_TO_TOMAN || '65000'); // مثلا 65هزار
const USD_MARGIN   = parseFloat(process.env.USD_MARGIN   || '0.15');  // 15% سود

// گرد کردن به تومان (عدد صحیح)
const roundToman = (v) => Math.max(0, Math.round(v));

// تبدیل «ماهانه دلار» → «ماهانه تومان با سود»
function usdMonthlyToTomanWithMargin(usdMonthly) {
  const base = usdMonthly * USD_TO_TOMAN;
  const withMargin = base * (1 + USD_MARGIN);
  return roundToman(withMargin);
}

// از ماهانه به ساعتی (ساعت ماه 720)
function monthlyTomanToHourly(tomanMonthly) {
  return Math.ceil((tomanMonthly / 720));
}

async function getHetznerPlanCatalog(config) {
  const { getHetznerSellablePlans } = require('./Hetzner/hetzner-api');
  return getHetznerSellablePlans(config);
}

module.exports = {
  USD_TO_TOMAN,
  USD_MARGIN,
  usdMonthlyToTomanWithMargin,
  monthlyTomanToHourly,
prices,
getHetznerPlanCatalog,
buildHetznerFlavorCatalog: getHetznerPlanCatalog,
};

