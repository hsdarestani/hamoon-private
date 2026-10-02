#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const quality = require('../services/hetzner-additional-ip-quality');
const bootstrap = require('../hetzner-additional-ip-quality-bootstrap');

async function run() {
  const floating = new Map();
  let created = 0;
  let deleted = 0;
  let qualityCalls = 0;
  const calls = [];
  const progressEvents = [];

  const request = async (_dc, method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'GET' && path === '/servers/42') {
      return { server: {
        id: 42,
        public_net: { ipv4: { ip: '198.51.100.42' } },
        datacenter: { location: { name: 'nbg1' } }
      } };
    }
    if (method === 'GET' && path === '/floating_ips?per_page=50') {
      return { floating_ips: [] };
    }
    if (method === 'POST' && path === '/floating_ips') {
      created += 1;
      const item = {
        id: 100 + created,
        ip: created === 1 ? '192.0.2.10' : '192.0.3.10',
        type: 'ipv4',
        server: 42,
        home_location: { name: 'nbg1' }
      };
      floating.set(String(item.id), item);
      return { floating_ip: item, action: null };
    }
    if (method === 'GET' && path.startsWith('/floating_ips/')) {
      const id = path.split('/').pop();
      return { floating_ip: floating.get(String(id)) || null };
    }
    if (method === 'POST' && path.endsWith('/actions/unassign')) {
      const id = path.split('/')[2];
      const item = floating.get(String(id));
      if (item) floating.set(String(id), { ...item, server: null });
      return { action: null };
    }
    if (method === 'DELETE' && path.startsWith('/floating_ips/')) {
      const id = path.split('/').pop();
      floating.delete(String(id));
      deleted += 1;
      return {};
    }
    throw new Error(`Unexpected ${method} ${path}`);
  };

  const db = {
    getServerSecret: async () => 'secret',
    pool: {
      query: async sql => {
        const text = String(sql);
        if (text.includes('CREATE TABLE IF NOT EXISTS hetzner_bad_ipv4_ranges')) return [[], []];
        if (text.includes('SELECT range_prefix')) return [[], []];
        if (text.includes('INSERT INTO hetzner_bad_ipv4_ranges')) return [{ affectedRows: 1 }, []];
        throw new Error(`Unexpected DB query: ${text}`);
      }
    }
  };

  const execSsh = async args => {
    assert.strictEqual(args.host, '198.51.100.42');
    assert.strictEqual(args.password, 'secret');
    return true;
  };

  const result = await quality.createVerifiedAdditionalIpv4({
    dc: {},
    serverId: '42',
    telegramId: 'u',
    description: 'test',
    request,
    db,
    execSsh,
    checkQuality: async ip => {
      qualityCalls += 1;
      if (ip === '192.0.2.10') {
        return {
          ok: false,
          definitive: true,
          reason: 'failed_threshold',
          iran: { selected: 4, success: 0 },
          global: { selected: 6, success: 6 }
        };
      }
      return {
        ok: true,
        definitive: true,
        reason: 'ok',
        iran: { selected: 4, success: 4 },
        global: { selected: 6, success: 6 }
      };
    },
    maxAttempts: 3,
    onProgress: async event => progressEvents.push(event)
  });

  assert.strictEqual(result.ip.ip, '192.0.3.10');
  assert.strictEqual(result.verified, true);
  assert.strictEqual(result.attempts, 2);
  assert.strictEqual(created, 2);
  assert.strictEqual(deleted, 1, 'dirty candidate must be deleted before retry');
  assert.strictEqual(qualityCalls, 2);
  assert(progressEvents.some(event => event.stage === 'quality_check' && event.attempt === 1));
  assert(progressEvents.some(event => event.stage === 'candidate_rejected' && event.attempt === 1));
  assert(progressEvents.some(event => event.stage === 'success' && event.attempt === 2));

  await assert.rejects(
    quality.createVerifiedAdditionalIpv4({
      dc: {},
      serverId: '42',
      telegramId: 'u',
      request,
      db,
      getSecret: async () => null,
      execSsh,
      checkQuality: async () => ({ ok: true })
    }),
    error => error.code === 'ADDITIONAL_IP_QUALITY_VERIFY_UNAVAILABLE'
  );

  const serviceSource = fs.readFileSync(require.resolve('../services/hetzner-additional-ip-quality.js'), 'utf8');
  assert(serviceSource.includes("ADDITIONAL_IP_SEARCH_TIMEOUT"));
  assert(serviceSource.includes("withTimeout("));
  assert(serviceSource.includes("stage: 'candidate_rejected'"));
  assert(serviceSource.includes("deadlineAt: deadline"));
  assert(serviceSource.includes("[HETZNER_ADDITIONAL_IP_CLEANUP_DEFERRED]"));

  const apiSource = fs.readFileSync(require.resolve('../Hetzner/hetzner-api.js'), 'utf8');
  assert(apiSource.includes("blockedUntil"));
  assert(apiSource.includes("HETZNER_API_DEADLINE_EXCEEDED"));
  assert(apiSource.includes("waitWithDeadline(sleep(delayMs), deadlineAt)"));
  assert(apiSource.includes("error.code = 'HETZNER_ACTION_TIMEOUT'"));
  assert(apiSource.includes("timeoutMs: Math.max(500, Math.min(10000, deadlineAt - Date.now()))"));

  assert(serviceSource.includes("[HETZNER_ADDITIONAL_IP_CREATED]"));
  assert(serviceSource.includes("createdServerId !== String(serverId)"));
  assert(serviceSource.includes("[HETZNER_ADDITIONAL_IP_BIND_START]"));
  assert(serviceSource.includes("[HETZNER_ADDITIONAL_IP_BIND_SUCCESS]"));
  assert(serviceSource.includes("[HETZNER_ADDITIONAL_IP_SSH_ROUTE_SELECTED]"));
  assert(serviceSource.includes("[HETZNER_ADDITIONAL_IP_SSH_ROUTE_FAILED]"));
  assert(serviceSource.includes("[HETZNER_ADDITIONAL_IP_BIND_RETRY]"));
  assert(serviceSource.includes("const maxProbeRounds = 2;"));
  assert(serviceSource.includes("const { Client } = require('ssh2');"));
  assert(serviceSource.includes("keepaliveInterval: 5000"));
  assert(serviceSource.includes("try { conn.destroy(); } catch (_) {}"));
  assert(serviceSource.includes("...existingAdditional.map(item => ipv4(item?.ip)).filter(Boolean)"));
  assert(serviceSource.includes("stage: 'os_config'"));

  const bootstrapSource = fs.readFileSync(require.resolve('../hetzner-additional-ip-quality-bootstrap.js'), 'utf8');
  assert(bootstrapSource.includes("progress?.stage === 'os_config'"));
  assert(bootstrapSource.includes("در حال فعال‌سازی آن روی سیستم‌عامل سرور"));

  const core = fs.readFileSync(require.resolve('../index-core.js'), 'utf8');
  assert(core.includes("const hetznerAdditionalIpCreateLocks = new Map();"));
  assert(core.includes("HETZNER_ADDITIONAL_IP_CREATE_LOCK_TTL_MS"));
  assert(core.includes("[HETZNER_ADDITIONAL_IP_STALE_LOCK_RELEASED]"));
  assert(core.includes("const recentCallbackQueries = new Map();"));
  assert(core.includes("[CALLBACK_DUPLICATE_IGNORED]"));
  assert(core.includes("CALLBACK_QUERY_DEDUPE_MS"));
  assert(core.includes("callbackData.startsWith('MS:')"));
  assert(core.includes("Math.max(CALLBACK_QUERY_DEDUPE_MS, 30000)"));
  assert(core.includes('async function handleResetPasswordConfirm(chatId, userId, serverId, dcConfig, messageId)'));
  assert(core.includes("await upsertServerSecret({"));
  assert(core.includes("secretType: 'root_password'"));
  assert(core.includes("secretValue: actualPass"));
  assert(core.includes("handleResetPasswordConfirm(effectiveChatId, effectiveUserId, payload.serverId, dc, q.message.message_id)"));
  assert(core.includes("handleResetPasswordConfirm(effectiveChatId, effectiveUserId, serverIdToReset, resetPwDcConfig, q.message.message_id)"));
  const patched = bootstrap.applyHetznerAdditionalIpQualityPatches(core);
  assert(patched.includes('additionalIpQuality.createVerifiedAdditionalIpv4'));
  assert(patched.includes('NO_CLEAN_ADDITIONAL_IPV4_AVAILABLE'));
  assert(patched.includes('ADDITIONAL_IP_SEARCH_TIMEOUT'));
  assert(patched.includes("progress?.stage === 'quality_check'"));
  assert(patched.includes('additionalIpQuality.deleteVerifiedAdditionalIp'));
  new vm.Script(patched, { filename: 'index-core.additional-ip-quality.patched.js' });

  console.log('validate-hetzner-additional-ip-quality: ok');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
