'use strict';

const fs = require('fs');
const path = require('path');

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

function pass(message) {
  console.log(`OK: ${message}`);
}

function read(file) {
  return fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
}

if (fs.existsSync(path.join(__dirname, '..', '.env'))) {
  fail('.env must not be committed');
} else {
  pass('.env is not committed');
}

if (fs.existsSync(path.join(__dirname, '..', '.env.example'))) {
  pass('.env.example exists');
} else {
  fail('.env.example is missing');
}

if (fs.existsSync(path.join(__dirname, '..', '.gitignore'))) {
  const gitignore = read('.gitignore');
  if (/^\.env$/m.test(gitignore) && /^node_modules\/$/m.test(gitignore)) {
    pass('.gitignore protects environment files and dependencies');
  } else {
    fail('.gitignore does not protect .env and node_modules');
  }
} else {
  fail('.gitignore is missing');
}

const datacenters = read('datacenters.js');
const forbiddenPatterns = [
  [/\bOS_PASSWORD\s*:\s*['"][^'"]+['"]/, 'hard-coded OpenStack password'],
  [/\bOS_USERNAME\s*:\s*['"][^'"]+['"]/, 'hard-coded OpenStack username'],
  [/\bTRAFFIC_API_KEY\s*:\s*process\.env\.[A-Z0-9_]+\s*\|\|\s*['"][^'"]+['"]/, 'hard-coded traffic API key fallback'],
  [/\b(?:TELEGRAM_BOT_TOKEN|HETZNER_API_TOKEN|AFRACLOUD_SECRET_KEY|DB_PASSWORD)\s*=\s*[^\s]+/, 'credential assignment in source']
];

for (const [pattern, label] of forbiddenPatterns) {
  if (pattern.test(datacenters)) fail(label);
  else pass(`no ${label}`);
}

process.exit(process.exitCode || 0);
