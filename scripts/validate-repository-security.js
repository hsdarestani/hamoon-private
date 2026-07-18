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

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const activeLines = fs.readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));

  if (activeLines.length) fail('.env contains active values and must not be committed');
  else pass('.env is a sanitized placeholder with no active values');
} else {
  pass('.env is not committed');
}

if (fs.existsSync(path.join(__dirname, '..', '.env.example'))) {
  const example = read('.env.example');
  pass('.env.example exists');
  if (/^ZIBAL_MERCHANT=$/m.test(example)) pass('.env.example documents ZIBAL_MERCHANT');
  else fail('.env.example is missing ZIBAL_MERCHANT');
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
const server = read('server.js');
const index = read('index.js');

const checks = [
  [datacenters, /\bOS_PASSWORD\s*:\s*['"][^'"]+['"]/, 'hard-coded OpenStack password'],
  [datacenters, /\bOS_USERNAME\s*:\s*['"][^'"]+['"]/, 'hard-coded OpenStack username'],
  [datacenters, /\bTRAFFIC_API_KEY\s*:\s*process\.env\.[A-Z0-9_]+\s*\|\|\s*['"][^'"]+['"]/, 'hard-coded traffic API key fallback'],
  [datacenters, /\b(?:TELEGRAM_BOT_TOKEN|HETZNER_API_TOKEN|AFRACLOUD_SECRET_KEY|DB_PASSWORD)\s*=\s*[^\s]+/, 'credential assignment in datacenter source'],
  [server + '\n' + index, /\bZIBAL_(?:MERCHANT|MERCHANT_ID|MERCHANT_KEY)\s*=\s*[^\s]+/, 'hard-coded Zibal merchant assignment'],
  [server, /merchant\s*:\s*['"][^'"]+['"]/, 'hard-coded Zibal merchant literal']
];

for (const [text, pattern, label] of checks) {
  if (pattern.test(text)) fail(label);
  else pass(`no ${label}`);
}

process.exit(process.exitCode || 0);
