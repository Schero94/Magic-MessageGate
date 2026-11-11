'use strict';

/**
 * SSRF guard for URLs that come from callers (attachment URLs) or that the
 * server fetches itself (template sample files on a remote upload provider).
 *
 * Policy: `https:` only, no credentials in the URL, default port, and a host
 * that is neither a local name nor an address in a private, loopback,
 * link-local, CGNAT, multicast or reserved range. `resolvesPublic` also
 * resolves the name and checks every address, so a public-looking name that
 * points inside the network is refused before anything is fetched.
 *
 * @see https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
 * @see https://nodejs.org/api/net.html#class-netblocklist
 */
const dns = require('node:dns/promises');
const net = require('node:net');

const blocked = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  blocked.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
]) {
  blocked.addSubnet(address, prefix, 'ipv6');
}

const LOCAL_NAMES = /(^|\.)(localhost|local|internal|localdomain|home|lan|intranet|corp)$/i;

/**
 * @param {string} address - IPv4 or IPv6 literal.
 * @returns {boolean} Whether the address is private, loopback or reserved.
 */
function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return blocked.check(mapped[1], 'ipv4');
    return blocked.check(address, 'ipv6');
  }
  return true;
}

/**
 * Synchronous checks (scheme, credentials, port, host name or literal).
 *
 * @param {string} value
 * @returns {{ok: true, url: URL}|{ok: false, reason: string}}
 */
function checkUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'scheme' };
  if (url.username || url.password) return { ok: false, reason: 'credentials' };
  if (url.port && url.port !== '443') return { ok: false, reason: 'port' };
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || !host.includes('.') || LOCAL_NAMES.test(host)) {
    if (!net.isIP(host)) return { ok: false, reason: 'host' };
  }
  if (net.isIP(host) && isBlockedAddress(host)) return { ok: false, reason: 'host' };
  return { ok: true, url };
}

/**
 * Resolves the host name and refuses it when any address is internal.
 *
 * @param {string} value
 * @param {{lookup?: Function}} [options] - Injected resolver for tests.
 * @returns {Promise<boolean>}
 */
async function resolvesPublic(value, { lookup = dns.lookup } = {}) {
  const checked = checkUrl(value);
  if (!checked.ok) return false;
  const host = checked.url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return !isBlockedAddress(host);
  try {
    const addresses = await lookup(host, { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every((a) => !isBlockedAddress(a.address));
  } catch {
    return false;
  }
}

module.exports = { checkUrl, resolvesPublic, isBlockedAddress };
