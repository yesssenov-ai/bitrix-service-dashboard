/**
 * Shared Bitrix24 API client
 * Single source of truth for all B24 calls across modules
 */
const fetch = require('node-fetch');

const BITRIX_WEBHOOK = process.env.BITRIX_WEBHOOK;

function flattenInto(parts, obj, prefix) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === 'object') flattenInto(parts, item, `${key}[${i}]`);
        else parts.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(item)}`);
      });
    } else if (typeof v === 'object') {
      flattenInto(parts, v, key);
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
    }
  }
}

async function b24(method, params = {}, retries = 3) {
  if (!BITRIX_WEBHOOK) throw new Error('BITRIX_WEBHOOK not configured');
  const parts = [];
  flattenInto(parts, params, '');
  const body = parts.join('&');
  const url = `${BITRIX_WEBHOOK}${method}.json`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept-Encoding': 'identity',
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`Bitrix API HTTP ${res.status}`);
      return await res.json();
    } catch(e) {
      clearTimeout(timeout);
      if (attempt === retries) throw e;
      console.warn(`b24 ${method} attempt ${attempt} failed: ${e.message}, retrying in ${attempt}s...`);
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

module.exports = { b24, flattenInto };
