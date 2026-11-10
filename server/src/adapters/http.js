'use strict';

/**
 * Minimal HTTP client for provider APIs (Node's global fetch, no SDKs).
 *
 * Every call ends in one of four outcomes, which the outbox uses to decide
 * about retries without ever sending a message twice:
 *
 * - `accepted`  2xx response: the provider took the request.
 * - `rejected`  the provider answered and refused it for good (4xx except
 *               408/409/425/429, or a provider-specific permanent code).
 * - `transient` the provider certainly did NOT accept it: connection refused,
 *               DNS failure, TLS failure before sending, 429, 503 (and any
 *               provider code documented as "try again").
 * - `ambiguous` the request may have been processed: timeouts after the
 *               request was written, connection reset, 5xx other than 503.
 *               Never retried automatically.
 */

/** Error codes that prove nothing reached the provider. */
const PRE_SEND_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * @param {*} error
 * @returns {string}
 */
function causeCode(error) {
  // AbortSignal.timeout() rejects with a DOMException named TimeoutError
  // (numeric legacy code 23), so names are checked before codes.
  // https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static
  if (error?.name === 'TimeoutError') return 'TIMEOUT';
  if (error?.name === 'AbortError') return 'ABORTED';
  const code = error?.cause?.code || error?.code;
  return typeof code === 'string' ? code : String(error?.name || 'FETCH_ERROR');
}

/**
 * Performs one request and classifies the outcome.
 *
 * @param {object} options
 * @param {string} options.url
 * @param {string} [options.method]
 * @param {Record<string,string>} [options.headers]
 * @param {string|URLSearchParams|undefined} [options.body]
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.fetchImpl] - Injected for tests.
 * @returns {Promise<{outcome: 'accepted'|'rejected'|'transient'|'ambiguous', status: number, json: any, code: string|null, retryAfterMs: number|null}>}
 */
async function request({ url, method = 'POST', headers = {}, body, timeoutMs = 15_000, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;
  let response;
  try {
    response = await doFetch(url, {
      method,
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const code = causeCode(error);
    return {
      outcome: PRE_SEND_CODES.has(code) ? 'transient' : 'ambiguous',
      status: 0,
      json: null,
      code: code.slice(0, 64),
      retryAfterMs: null,
    };
  }
  let json = null;
  const text = await response.text().catch(() => '');
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  const status = response.status;
  const retryAfterHeader = Number(response.headers.get('retry-after'));
  const retryAfterMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader * 1000 : null;
  if (status >= 200 && status < 300) return { outcome: 'accepted', status, json, code: null, retryAfterMs: null };
  if (status === 429 || status === 503)
    return { outcome: 'transient', status, json, code: `HTTP_${status}`, retryAfterMs };
  if (status === 408 || status === 425 || status >= 500) {
    return { outcome: 'ambiguous', status, json, code: `HTTP_${status}`, retryAfterMs };
  }
  return { outcome: 'rejected', status, json, code: `HTTP_${status}`, retryAfterMs: null };
}

module.exports = { request, PRE_SEND_CODES };
