'use strict';

/**
 * Admin RBAC actions (Settings → Administration Panel → Roles → Plugins →
 * Magic MessageGate). Every admin route requires one of them through
 * `admin::hasPermissions`.
 */
const PLUGIN = 'magic-messagegate';

const ACTIONS = Object.freeze([
  { uid: 'accounts.read', displayName: 'Read accounts', subCategory: 'Accounts' },
  { uid: 'accounts.manage', displayName: 'Manage accounts', subCategory: 'Accounts' },
  { uid: 'templates.read', displayName: 'Read templates', subCategory: 'Templates' },
  { uid: 'templates.manage', displayName: 'Manage templates', subCategory: 'Templates' },
  { uid: 'templates.submit', displayName: 'Submit templates to Meta', subCategory: 'Templates' },
  { uid: 'messages.read', displayName: 'Read messages', subCategory: 'Messages' },
  { uid: 'messages.send', displayName: 'Send messages', subCategory: 'Messages' },
  { uid: 'messages.manage', displayName: 'Retry and discard messages', subCategory: 'Messages' },
  { uid: 'contacts.read', displayName: 'Read contacts', subCategory: 'Contacts' },
  { uid: 'contacts.manage', displayName: 'Manage contacts and consent', subCategory: 'Contacts' },
  { uid: 'contacts.export', displayName: 'Export contact data', subCategory: 'Contacts' },
  { uid: 'analytics.read', displayName: 'Read analytics', subCategory: 'Analytics' },
  { uid: 'settings.read', displayName: 'Read settings', subCategory: 'Settings' },
  { uid: 'settings.update', displayName: 'Update settings', subCategory: 'Settings' },
]);

/**
 * @param {string} action - e.g. `accounts.read`
 * @returns {string} Full action id.
 */
const actionId = (action) => `plugin::${PLUGIN}.${action}`;

/**
 * @param {object} strapi
 * @returns {Promise<void>}
 */
async function registerActions(strapi) {
  await strapi.service('admin::permission').actionProvider.registerMany(
    // The plugins section takes subCategory only; Strapi rejects `category` there
    // (@strapi/admin validation/action-provider: "category should only be defined for the settings section").
    ACTIONS.map((a) => ({ section: 'plugins', pluginName: PLUGIN, ...a }))
  );
}

module.exports = { ACTIONS, actionId, registerActions, PLUGIN };
