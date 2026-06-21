const axios = require('axios');

function normalizeMobile(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  let normalized = digits;
  if (normalized.startsWith('98')) normalized = `0${normalized.slice(2)}`;
  if (!/^09\d{9}$/.test(normalized)) throw new Error('Invalid Iranian mobile number');
  return normalized;
}

function normalizeNationalCode(nationalCode) {
  const code = String(nationalCode || '').replace(/\D/g, '');
  if (!/^\d{10}$/.test(code)) throw new Error('Invalid national code');
  if (/^(\d)\1{9}$/.test(code)) throw new Error('Invalid national code');
  const check = Number(code[9]);
  const sum = code.slice(0, 9).split('').reduce((acc, digit, idx) => acc + Number(digit) * (10 - idx), 0);
  const remainder = sum % 11;
  const valid = remainder < 2 ? check === remainder : check === 11 - remainder;
  if (!valid) throw new Error('Invalid national code');
  return code;
}

function findMatchValue(value) {
  if (value == null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['true', 'yes', 'ok', 'matched', 'match', '1'].includes(v)) return true;
    if (['false', 'no', 'mismatch', 'notmatched', '0'].includes(v)) return false;
  }
  return undefined;
}

function detectMatch(data) {
  const queue = [data];
  const keys = new Set(['isMatched', 'matched', 'result', 'success', 'match', 'is_match', 'isMatched'.toLowerCase()]);
  while (queue.length) {
    const item = queue.shift();
    if (!item || typeof item !== 'object') continue;
    for (const [key, value] of Object.entries(item)) {
      if (keys.has(key) || keys.has(key.toLowerCase())) {
        const parsed = findMatchValue(value);
        if (parsed !== undefined) return parsed;
      }
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return false;
}

async function verifyShahkarLite({ nationalCode, mobile }) {
  const token = process.env.APIIR_TOKEN;
  if (!token) throw new Error('APIIR_TOKEN is not configured');
  const normalizedNationalCode = normalizeNationalCode(nationalCode);
  const normalizedMobile = normalizeMobile(mobile);
  const baseURL = process.env.APIIR_BASE_URL || 'https://s.api.ir';
  try {
    const response = await axios.post(`${baseURL}/api/sw1/ShahkarLite`, {
      nationalCode: normalizedNationalCode,
      mobile: normalizedMobile
    }, {
      timeout: 30000,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      }
    });
    return { ok: detectMatch(response.data), raw: response.data };
  } catch (error) {
    console.error('[ShahkarLite] API error:', error.response?.status || error.code || error.message);
    const safe = new Error('Shahkar verification failed');
    safe.cause = error;
    throw safe;
  }
}

module.exports = { normalizeMobile, normalizeNationalCode, verifyShahkarLite, detectMatch };
