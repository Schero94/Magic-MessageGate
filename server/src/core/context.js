'use strict';

/**
 * Dependency container for the MessageGate core. The core never reaches
 * into `strapi` directly, so the same code runs inside Strapi and in the
 * plain-knex tests (SQLite and PostgreSQL).
 */
const crypto = require('crypto');
const os = require('os');
const configModule = require('../config');
const { dialectOf } = require('../store/coordination');

/**
 * @typedef {object} CoreContext
 * @property {import('knex').Knex} knex
 * @property {'postgres'|'mysql'|'sqlite'} dialect
 * @property {object} config - Parsed plugin config with defaults.
 * @property {{info: Function, warn: Function, error: Function, debug: Function}} log
 * @property {(name: string, payload: object) => void} emit
 * @property {() => number} now
 * @property {() => number} random
 * @property {Function} [fetchImpl]
 * @property {string} nodeId
 * @property {object|null} magicMail - Magic Mail email-router service when installed.
 * @property {string} publicUrl
 * @property {string} [encryptionKey]
 */

/**
 * @param {object} input
 * @returns {CoreContext}
 */
function createContext(input) {
  const config = configModule.schema.parse(input.config || {});
  const silent = { info() {}, warn() {}, error() {}, debug() {} };
  return {
    knex: input.knex,
    dialect: dialectOf(input.knex),
    config,
    log: input.log || silent,
    emit: typeof input.emit === 'function' ? input.emit : () => {},
    now: typeof input.now === 'function' ? input.now : () => Date.now(),
    random: typeof input.random === 'function' ? input.random : Math.random,
    fetchImpl: input.fetchImpl,
    nodeId: input.nodeId || `${os.hostname().slice(0, 30)}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`,
    magicMail: input.magicMail || null,
    publicUrl: String(input.publicUrl || config.publicUrl || '').replace(/\/+$/, ''),
    encryptionKey: config.encryptionKey,
  };
}

/**
 * Short random id for public document ids.
 *
 * @returns {string} 24 lowercase alphanumerics.
 */
function newId() {
  return crypto
    .randomBytes(18)
    .toString('base64url')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase()
    .padEnd(24, '0')
    .slice(0, 24);
}

/**
 * @param {string|null|undefined} text
 * @param {*} fallback
 * @returns {*}
 */
function parseJson(text, fallback) {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

module.exports = { createContext, newId, parseJson };
