const fs = require('fs');
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const index = fs.readFileSync('index.js', 'utf8');
const db = fs.readFileSync('db.js', 'utf8');
const caps = fs.readFileSync('provider-capabilities.js', 'utf8');
const dcs = fs.readFileSync('datacenters.js', 'utf8');
const afraText = caps + '\n' + dcs;
assert(index.includes("setDefaultResultOrder('ipv4first')"), 'DNS ipv4first setup missing');
for (const needle of ['traffic: false', 'projectTraffic: false', 'rebuild: false', 'snapshot: false', 'changeCycle: false']) {
  assert(afraText.includes(needle), `AfraCloud capability missing: ${needle}`);
}
assert(db.includes('async function getUserActivePurchases') && db.includes('getUserActivePurchases,'), 'getUserActivePurchases is not exported');
assert(index.includes('/attach_afra'), 'attach_afra command missing');
assert(index.includes('purchaseIds.has(String(s.id))') && index.includes('purchaseIds.has(String(s.uuid))'), 'management purchaseIds fallback missing');
assert(index.includes('editOrSendMessage') && index.includes('notifyPurchaseSuccess'), 'robust purchase notification missing');
console.log('validate-afracloud-flow OK');
