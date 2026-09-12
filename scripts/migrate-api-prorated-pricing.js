'use strict';

const db = require('../db');
const { ensureApiProratedPricingSchema } = require('../api-prorated-pricing');

(async () => {
  await ensureApiProratedPricingSchema(db);
  const [clientCols] = await db.pool.execute(
    "SELECT COLUMN_NAME, COLUMN_DEFAULT, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'api_clients' AND COLUMN_NAME = 'monthly_prorated_pricing'"
  );
  const [purchaseCols] = await db.pool.execute(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchases' AND COLUMN_NAME IN ('api_monthly_prorated_pricing','api_monthly_price') ORDER BY COLUMN_NAME"
  );
  if (clientCols.length !== 1 || purchaseCols.length !== 2) throw new Error('API_PRORATED_MIGRATION_VERIFY_FAILED');
  if (Number(clientCols[0].COLUMN_DEFAULT || 0) !== 0 || String(clientCols[0].IS_NULLABLE).toUpperCase() !== 'NO') {
    throw new Error('API_PRORATED_DEFAULT_VERIFY_FAILED');
  }
  console.log('api-prorated-pricing migration: ok');
  await db.pool.end();
})().catch(async error => {
  console.error(error);
  try { await db.pool?.end?.(); } catch (_) {}
  process.exitCode = 1;
});
