#!/usr/bin/env node
'use strict';
// Prevent startup crashes caused by exporting database helpers that are not declared.
const fs = require('fs');
const source = fs.readFileSync('db.js', 'utf8');
const m = source.match(/module\.exports\s*=\s*\{([\s\S]*?)\}\s*;?\s*$/);
if (!m) { console.error('FAIL module.exports not found'); process.exit(1); }
const exported = m[1].split('\n').map(x => x.replace(/\/\/.*$/, '').trim().replace(/,$/, '')).filter(x => /^[A-Za-z_$][\w$]*$/.test(x));
const missing = exported.filter(name => {
  const e = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return ![
    new RegExp('\\basync\\s+function\\s+' + e + '\\s*\\('),
    new RegExp('\\bfunction\\s+' + e + '\\s*\\('),
    new RegExp('\\b(?:const|let|var)\\s+' + e + '\\b'),
    new RegExp('\\bclass\\s+' + e + '\\b')
  ].some(re => re.test(source));
});
if (missing.length) { console.error('FAIL undeclared db exports:', missing.join(', ')); process.exit(1); }
console.log('OK all db exports are declared:', exported.length);
