'use strict';

const fs = require('fs');
const path = 'runtime-bootstrap.js';
let source = fs.readFileSync(path, 'utf8');

const importNeedle = "const { applyBillingSettlementPatches } = require('./billing-settlement-bootstrap');";
const importLine = "const { applyBillingRenewalTickPatches } = require('./billing-renewal-tick-bootstrap');";
if (!source.includes(importLine)) {
  if (!source.includes(importNeedle)) throw new Error('runtime bootstrap settlement import not found');
  source = source.replace(importNeedle, `${importNeedle}\n${importLine}`);
}

const returnNeedle = '  return applyResumeTransactionalPatches(baseline);';
const returnReplacement = '  return applyBillingRenewalTickPatches(applyResumeTransactionalPatches(baseline));';
if (!source.includes(returnReplacement)) {
  if (!source.includes(returnNeedle)) throw new Error('runtime bootstrap return marker not found');
  source = source.replace(returnNeedle, returnReplacement);
}

fs.writeFileSync(path, source);
console.log('minute renewal tick wired into runtime bootstrap');
