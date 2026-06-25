#!/usr/bin/env node
'use strict';
const fs = require('fs');
const src = fs.readFileSync('index.js','utf8');
const emitted = new Set([...src.matchAll(/action:\s*['"]([A-Z0-9_]+)['"]/g)].map(m=>m[1]));
for (const m of src.matchAll(/callback_data:\s*['"]([A-Z0-9_]+)['"]/g)) emitted.add(m[1]);
const missing = [...emitted].filter(a => {
  if (src.includes(`case '${a}'`) || src.includes(`case \"${a}\"`)) return false;
  const parts = a.split('_');
  if (parts.length > 1 && (src.includes(`case '${parts[0]}'`) || src.includes(`action === '${parts[0]}'`)) && parts.slice(1).every(p => src.includes(`params[`) && src.includes(`'${p}'`))) return false;
  return !new RegExp(`=== ['\"]${a}['\"]|startsWith\\(['\"]${a}`).test(src);
});
if (/handleRebuildAsk\(/.test(src) && !/async function handleRebuildAsk/.test(src)) throw new Error('handleRebuildAsk is referenced but not defined');
if (/async function handleFreeTrialRequest[\s\S]*?async function handleCycleSelection/.test(src) && /async function handleFreeTrialRequest[\s\S]*?async function handleCycleSelection/.exec(src)[0].includes("short('ASK_DELETE')")) throw new Error('undefined short in handleFreeTrialRequest');
if (missing.length) throw new Error(`Emitted Telegram actions without obvious handlers: ${missing.join(', ')}`);
console.log(`Telegram action validation passed (${emitted.size} actions checked).`);
