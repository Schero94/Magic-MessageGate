'use strict';

/**
 * Size-capped downloads. The body is read chunk by chunk and the request is
 * aborted as soon as it passes `maxBytes`, so an oversized or endless
 * response never fills memory. Redirects are refused (a redirect could lead
 * to an internal host); callers check the host before calling.
 */

/**
 * @param {{url: string, headers?: Record<string,string>, maxBytes: number, timeoutMs?: number, fetchImpl?: Function, redirect?: 'error'|'manual'}} input
 * @returns {Promise<{ok: true, bytes: Buffer, contentType: string|null}|{ok: false, code: 'TOO_LARGE'|'HTTP_ERROR'|'NETWORK'|'EXPIRED'|'REDIRECT', status?: number, location?: string|null}>}
 */
async function fetchLimited({ url, headers = {}, maxBytes, timeoutMs = 30_000, fetchImpl, redirect = 'error' }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    let response;
    try {
      response = await doFetch(url, { method: 'GET', headers, redirect, signal: controller.signal });
    } catch {
      return { ok: false, code: 'NETWORK' };
    }
    if (redirect === 'manual' && response.status >= 300 && response.status < 400) {
      return { ok: false, code: 'REDIRECT', location: response.headers.get('location') };
    }
    if (response.status === 404 || response.status === 410)
      return { ok: false, code: 'EXPIRED', status: response.status };
    if (!response.ok) return { ok: false, code: 'HTTP_ERROR', status: response.status };
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      controller.abort();
      return { ok: false, code: 'TOO_LARGE' };
    }
    const chunks = [];
    let size = 0;
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      for (;;) {
        let part;
        try {
          part = await reader.read();
        } catch {
          return { ok: false, code: 'NETWORK' };
        }
        if (part.done) break;
        size += part.value.length;
        if (size > maxBytes) {
          controller.abort();
          return { ok: false, code: 'TOO_LARGE' };
        }
        chunks.push(Buffer.from(part.value));
      }
    } else {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > maxBytes) return { ok: false, code: 'TOO_LARGE' };
      chunks.push(buffer);
    }
    return { ok: true, bytes: Buffer.concat(chunks), contentType: response.headers.get('content-type') };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether a URL is https (or the configured test base) on an allowed host.
 *
 * @param {string} value
 * @param {Array<string|RegExp>} hosts - Exact host names or patterns.
 * @param {string} [testBase] - Configured provider base URL (fake servers in tests).
 * @returns {boolean}
 */
function onHost(value, hosts, testBase) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (testBase) {
    try {
      const base = new URL(testBase);
      if (url.origin === base.origin) return true;
    } catch {
      // ignore
    }
  }
  if (url.protocol !== 'https:' || (url.port && url.port !== '443')) return false;
  return hosts.some((h) => (typeof h === 'string' ? url.hostname === h : h.test(url.hostname)));
}

module.exports = { fetchLimited, onHost };
