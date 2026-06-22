const fs = require('fs');
const path = require('path');

function read(file) { return fs.readFileSync(path.join(__dirname, '..', file), 'utf8'); }
function assert(name, ok) { if (!ok) throw new Error(`Validation failed: ${name}`); console.log(`✓ ${name}`); }

const db = read('db.js');
const index = read('index.js');
const afra = read('Afracloud/afracloud-api.js');
const pkg = JSON.parse(read('package.json'));
const sshReset = read('services/ssh-reset-password.js');

assert('server_secrets table exists', /CREATE TABLE IF NOT EXISTS server_secrets/.test(db));
assert('server secret helpers exported', /upsertServerSecret/.test(db) && /getServerSecret/.test(db));
assert('generateStrongPassword exists', fs.existsSync(path.join(__dirname, '..', 'services/passwords.js')) && /generateStrongPassword/.test(read('services/passwords.js')));
assert('cloud-init builder exists', fs.existsSync(path.join(__dirname, '..', 'services/cloud-init.js')) && /buildRootPasswordCloudInit/.test(read('services/cloud-init.js')));
assert('Afra createServer reads rootPassword and sends userData', /meta\?\.rootPassword/.test(afra) && /USERDATA_FIELD/.test(afra) && /userData/.test(afra));
assert('purchase passes rootPassword for AfraCloud', /generatedRootPassword\s*=\s*generateStrongPassword/.test(index) && /serverMeta\.rootPassword/.test(index));
assert('purchase stores generated password after create', /upsertServerSecret\(\{ telegramId: userId, serverId: srv\.id/.test(index));
const retrieval = index.slice(index.indexOf('async function handleGetStoredPassword'), index.indexOf('async function resetAfraPasswordBySsh'));
assert('Afra retrieval reads DB before API', retrieval.indexOf('getServerSecret(serverId') !== -1 && retrieval.indexOf('getAfraPasswordFromApiOnce') > retrieval.indexOf('getServerSecret(serverId'));
assert('ssh reset service exists', fs.existsSync(path.join(__dirname, '..', 'services/ssh-reset-password.js')));
assert('package includes ssh2', !!pkg.dependencies.ssh2);
assert('ssh reset uses chpasswd via stdin', /conn\.exec\('chpasswd'/.test(sshReset) && /stream\.write\(`root:\$\{newPassword\}\\n`\)/.test(sshReset));
assert('Afra UI includes stored and SSH reset actions', /GET_STORED_PASSWORD/.test(index) && /RESET_PASSWORD_SSH/.test(index));
assert('/set_server_password exists', /\/set_server_password/.test(index));
assert('/attach_afra supports --password', /--password=/.test(index));
assert('/reset_afra_password_ssh exists', /\/reset_afra_password_ssh/.test(index));
assert('no obvious console.log of password variables', !/console\.log\([^\n]*(password|Password|rootPassword|newPassword|oldPassword|secretValue)/.test(index + db + afra + sshReset));
