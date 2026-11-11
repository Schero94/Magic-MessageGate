'use strict';

const { makeCore, addAccount, PHONE } = require('./core');
const { DEFAULTS } = require('../../server/src/core/settings');

/**
 * A ready core: WhatsApp (Meta) and SMS (seven.io) accounts, an approved
 * WhatsApp template and an SMS template with the same key, consent granted.
 *
 * @param {object} fake - Fake providers.
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function scenario(fake, options = {}) {
  const clock = { t: 1_800_000_000_000 };
  const core = await makeCore({ providers: fake.providers, now: () => clock.t, ...options });
  core.clock = clock;
  core.advance = (ms) => {
    clock.t += ms;
  };
  if (options.settings) await core.settings.save({ ...DEFAULTS, ...options.settings }, 0);
  core.wa = await addAccount(core, 'meta');
  core.sms = await addAccount(core, 'seven');
  await core.templates.create({
    key: 'order_shipped',
    channel: 'whatsapp',
    language: 'de',
    name: 'Order shipped',
    content: { body: 'Hallo {{name}}, Bestellung {{order}} ist unterwegs.' },
  });
  await core.templates.applyProviderStatus({ name: 'order_shipped', language: 'de', status: 'APPROVED' });
  await core.templates.create({
    key: 'order_shipped',
    channel: 'sms',
    language: 'de',
    name: 'Order shipped (SMS)',
    content: { text: 'Hallo {{name}}, Bestellung {{order}} ist unterwegs.' },
  });
  const { row } = await core.contacts.upsertByPhone(PHONE, { country: 'DE' });
  core.contact = row;
  for (const channel of ['whatsapp', 'sms', 'telegram'])
    await core.contacts.setConsent(row.id, channel, 'granted', 'test');
  core.vars = { name: 'Ana', order: 'A-1' };
  /** Runs worker rounds until nothing is claimed. */
  core.drain = async (rounds = 10) => {
    const all = [];
    for (let i = 0; i < rounds; i += 1) {
      const r = await core.outbox.tick();
      all.push(...r.results);
      if (!r.claimed) break;
    }
    return all;
  };
  return core;
}

module.exports = { scenario };
