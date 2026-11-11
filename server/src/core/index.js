'use strict';

/**
 * Builds the MessageGate core from a knex connection and plugin config.
 */
const { createContext } = require('./context');
const { createSettings } = require('./settings');
const { createAccounts } = require('./accounts');
const { createTemplates } = require('./templates');
const { createContacts } = require('./contacts');
const { createOutbox } = require('./outbox');
const { createSender } = require('./sender');
const { createWebhooks } = require('./webhooks');
const { createLookup } = require('./lookup');
const { createAnalytics } = require('./analytics');
const { ensureSchema } = require('../store/schema');

/**
 * @param {object} input - See createContext.
 * @returns {object} Core services.
 */
function createCore(input) {
  const ctx = createContext(input);
  const settings = createSettings(ctx);
  const accounts = createAccounts(ctx);
  const templates = createTemplates(ctx, { accounts });
  const contacts = createContacts(ctx);
  const outbox = createOutbox(ctx, { accounts, contacts });
  const sender = createSender(ctx, { settings, accounts, templates, contacts, outbox });
  outbox.setFailureHandler((row, code) => sender.onFailure(row, code));
  const webhooks = createWebhooks(ctx, { settings, accounts, templates, contacts, outbox });
  const lookup = createLookup(ctx, { settings, accounts });
  const analytics = createAnalytics(ctx);
  return {
    ctx,
    settings,
    accounts,
    templates,
    contacts,
    outbox,
    sender,
    webhooks,
    lookup,
    analytics,
    /** Creates missing tables. */
    init: () => ensureSchema(ctx.knex),
  };
}

module.exports = { createCore };
