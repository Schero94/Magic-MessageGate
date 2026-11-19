'use strict';

/**
 * Offline fetch for the contract tests: records every request an adapter
 * makes and answers with queued responses. Nothing leaves the process.
 */

/**
 * @returns {{fetchImpl: Function, requests: object[], answer: (status: number, json?: *, headers?: object) => void, binary: (status: number, bytes: Buffer, type: string) => void}}
 */
function capture() {
  const requests = [];
  const answers = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const headers = Object.fromEntries(
      Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)])
    );
    let body = init.body;
    if (Buffer.isBuffer(body)) body = { bytes: body.length };
    const type = headers['content-type'] || '';
    const record = {
      method: String(init.method || 'GET').toUpperCase(),
      url,
      headers,
      json: typeof body === 'string' && type.includes('json') ? JSON.parse(body) : null,
      form: typeof body === 'string' && type.includes('x-www-form-urlencoded') ? new URLSearchParams(body) : null,
    };
    requests.push(record);
    const next = answers.shift() || { status: 200, json: {} };
    if (next.bytes) {
      return new Response(next.bytes, { status: next.status, headers: { 'content-type': next.type } });
    }
    return new Response(next.json === undefined ? null : JSON.stringify(next.json), {
      status: next.status,
      headers: { 'content-type': 'application/json', ...(next.headers || {}) },
    });
  };
  return {
    fetchImpl,
    requests,
    answer: (status, json, headers) => answers.push({ status, json, headers }),
    binary: (status, bytes, type) => answers.push({ status, bytes, type }),
  };
}

module.exports = { capture };
