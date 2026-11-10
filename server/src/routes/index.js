'use strict';

/**
 * Routes.
 * - admin: `/magic-messagegate/...`, admin JWT + RBAC on every route.
 * - content-api: `/api/magic-messagegate/...`, API token or users-permissions
 *   with the plugin's permissions; webhooks are public but signed.
 */
const { actionId } = require('../permissions');

/**
 * @param {string} method
 * @param {string} path
 * @param {string} handler
 * @param {string} action
 * @returns {object}
 */
const admin = (method, path, handler, action) => ({
  method,
  path,
  handler: `admin.${handler}`,
  config: {
    policies: [
      'admin::isAuthenticatedAdmin',
      { name: 'admin::hasPermissions', config: { actions: [actionId(action)] } },
    ],
  },
});

module.exports = {
  admin: {
    type: 'admin',
    routes: [
      admin('GET', '/accounts', 'listAccounts', 'accounts.read'),
      admin('POST', '/accounts', 'createAccount', 'accounts.manage'),
      admin('PUT', '/accounts/:id', 'updateAccount', 'accounts.manage'),
      admin('DELETE', '/accounts/:id', 'deleteAccount', 'accounts.manage'),
      admin('POST', '/accounts/:id/test', 'testAccount', 'accounts.manage'),
      admin('POST', '/accounts/:id/sync-templates', 'syncTemplates', 'templates.manage'),

      admin('GET', '/templates', 'listTemplates', 'templates.read'),
      admin('GET', '/templates/:id', 'getTemplate', 'templates.read'),
      admin('POST', '/templates', 'createTemplate', 'templates.manage'),
      admin('PUT', '/templates/:id', 'updateTemplate', 'templates.manage'),
      admin('DELETE', '/templates/:id', 'deleteTemplate', 'templates.manage'),
      admin('POST', '/templates/:id/preview', 'previewTemplate', 'templates.read'),
      admin('POST', '/templates/:id/submit', 'submitTemplate', 'templates.submit'),

      admin('GET', '/messages', 'listMessages', 'messages.read'),
      admin('GET', '/messages/:id', 'getMessage', 'messages.read'),
      admin('POST', '/messages', 'sendMessage', 'messages.send'),
      admin('POST', '/messages/:id/retry', 'retryMessage', 'messages.manage'),
      admin('POST', '/messages/:id/discard', 'discardMessage', 'messages.manage'),
      admin('POST', '/messages/:id/mark-sent', 'markMessageSent', 'messages.manage'),

      admin('GET', '/contacts', 'listContacts', 'contacts.read'),
      admin('GET', '/contacts/:id', 'getContact', 'contacts.read'),
      admin('POST', '/contacts', 'upsertContact', 'contacts.manage'),
      admin('PUT', '/contacts/:id/consent', 'setConsent', 'contacts.manage'),
      admin('DELETE', '/contacts/:id/suppressions/:channel', 'removeSuppression', 'contacts.manage'),
      admin('POST', '/contacts/:id/telegram-link', 'telegramLink', 'contacts.manage'),
      admin('GET', '/contacts/:id/export', 'exportContact', 'contacts.export'),
      admin('DELETE', '/contacts/:id', 'eraseContact', 'contacts.manage'),

      admin('POST', '/lookup', 'lookup', 'contacts.read'),
      admin('GET', '/analytics', 'analytics', 'analytics.read'),
      admin('GET', '/settings', 'getSettings', 'settings.read'),
      admin('PUT', '/settings', 'updateSettings', 'settings.update'),
    ],
  },
  'content-api': {
    type: 'content-api',
    routes: [
      { method: 'POST', path: '/messages', handler: 'content-api.send', config: { policies: [] } },
      { method: 'GET', path: '/messages/:id', handler: 'content-api.status', config: { policies: [] } },
      { method: 'POST', path: '/consent', handler: 'content-api.consent', config: { policies: [] } },
      { method: 'POST', path: '/telegram-link', handler: 'content-api.telegramLink', config: { policies: [] } },
      { method: 'POST', path: '/lookup', handler: 'content-api.lookup', config: { policies: [] } },
      {
        method: 'GET',
        path: '/webhooks/:provider/:path',
        handler: 'webhooks.receive',
        config: { auth: false, policies: [] },
      },
      {
        method: 'POST',
        path: '/webhooks/:provider/:path',
        handler: 'webhooks.receive',
        config: { auth: false, policies: [] },
      },
    ],
  },
};
