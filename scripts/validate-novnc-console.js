#!/usr/bin/env node
'use strict';

const fs = require('fs');

function read(path) {
  return fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '';
}
function assert(name, ok) {
  if (!ok) {
    console.error('FAIL', name);
    process.exitCode = 1;
  } else {
    console.log('OK', name);
  }
}

const server = read('server.js');
const sessions = read('console-session.js');
const html = read('public/console/index.html');
const app = read('public/console/app.js');
const bootstrap = read('hetzner-console-bootstrap.js');
const pkg = JSON.parse(read('package.json') || '{}');

assert('noVNC dependency pinned', String(pkg.dependencies?.['@novnc/novnc'] || '').startsWith('1.7.'));
assert('console viewer route exists', /app\.get\(\['\/console'/.test(server));
assert('console exchange route exists', /app\.post\('\/console\/session'/.test(server));
assert('noVNC vendor is self hosted', /node_modules['"], ['"]@novnc['"], ['"]novnc/.test(server));
assert('console page blocks referrers', /Referrer-Policy|no-referrer/.test(server) && /name="referrer" content="no-referrer"/.test(html));
assert('console response is no-store', /Cache-Control[^\n]*no-store/.test(server));
assert('one-time session uses consumed_at', /consumed_at IS NULL/.test(sessions) && /SET consumed_at = NOW\(\)/.test(sessions));
assert('session token is hashed', /sha256/.test(sessions) && /token_hash/.test(sessions));
assert('console credentials are encrypted at rest', /aes-256-gcm/.test(sessions) && /payload_enc/.test(sessions));
assert('console session secret required', /CONSOLE_SESSION_SECRET_MISSING/.test(sessions));
assert('browser imports local RFB', /import RFB from '\/console\/vendor\/core\/rfb\.js'/.test(app));
assert('browser uses RFB credentials', /credentials:\s*\{\s*password:\s*data\.password/.test(app));
assert('browser scales viewport', /rfb\.scaleViewport\s*=\s*true/.test(app));
assert('browser supports Ctrl Alt Del', /sendCtrlAltDel/.test(app));
assert('bot creates server-side console session', /createConsoleSession/.test(bootstrap));
assert('bot sends HTTPS viewer URL', /CONSOLE_PUBLIC_BASE_URL/.test(bootstrap) && /\/console#/.test(bootstrap));
assert('bot no longer sends raw WSS/password copy buttons', !/کپی آدرس کنسول|کپی رمز کنسول/.test(bootstrap));
assert('bot does not put credentials in console URL', !/consoleUrl\s*=.*wssUrl|consoleUrl\s*=.*password/.test(bootstrap));

for (const file of ['console-session.js', 'public/console/app.js']) {
  try {
    new Function(read(file).replace(/^import[^\n]+\n/, ''));
    console.log('OK parses', file);
  } catch (e) {
    console.error('FAIL parses', file, e.message);
    process.exitCode = 1;
  }
}

process.exit(process.exitCode || 0);
