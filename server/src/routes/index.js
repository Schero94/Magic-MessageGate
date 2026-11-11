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
      admin('POST', '/accounts/embedded-signup', 'completeEmbeddedSignup', 'accounts.manage'),
      admin('PUT', '/accounts/:id', 'updateAccount', 'accounts.manage'),
      admin('DELETE', '/accounts/:id', 'deleteAccount', 'accounts.manage'),
      admin('GET', '/accounts/embedded-signup', 'embeddedSignupConfig', 'accounts.read'),
      admin('POST', '/accounts/:id/test', 'testAccount', 'accounts.manage'),
      admin('POST', '/accounts/:id/verify-token', 'revealVerifyToken', 'accounts.manage'),
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
      admin('POST', '/messages/preview', 'previewMessage', 'messages.send'),
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

      admin('GET', '/inbound', 'listInbound', 'inbound.read'),
      admin('GET', '/inbound/unread', 'inboundUnread', 'inbound.read'),
      admin('GET', '/inbound/:id', 'getInbound', 'inbound.read'),
      admin('GET', '/inbound/:id/media', 'inboundMedia', 'inbound.read'),
      admin('POST', '/inbound/:id/processed', 'inboundProcessed', 'inbound.manage'),
      admin('POST', '/inbound/:id/reply', 'replyInbound', 'messages.send'),
      admin('GET', '/conversations/:id', 'conversation', 'inbound.read'),

      admin('POST', '/lookup', 'lookup', 'contacts.read'),
      admin('GET', '/lookup/budget', 'lookupBudget', 'contacts.read'),
      admin('GET', '/analytics', 'analytics', 'analytics.read'),
      admin('GET', '/settings', 'getSettings', 'settings.read'),
      admin('PUT', '/settings', 'updateSettings', 'settings.update'),
      admin('POST', '/settings/webhook-secret', 'rotateWebhookSecret', 'settings.update'),
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
      { method: 'POST', path: '/capabilities', handler: 'content-api.capabilities', config: { policies: [] } },
      { method: 'POST', path: '/templates/render', handler: 'content-api.renderTemplate', config: { policies: [] } },
      // Inbound text and files: separate controller = separate token permissions.
      { method: 'GET', path: '/inbound', handler: 'inbound-api.list', config: { policies: [] } },
      { method: 'GET', path: '/inbound/:id', handler: 'inbound-api.get', config: { policies: [] } },
      { method: 'POST', path: '/inbound/:id/processed', handler: 'inbound-api.processed', config: { policies: [] } },
      { method: 'GET', path: '/inbound/:id/media', handler: 'inbound-api.media', config: { policies: [] } },
      { method: 'POST', path: '/inbound/:id/media-url', handler: 'inbound-api.mediaUrl', config: { policies: [] } },
      { method: 'POST', path: '/inbound/:id/reply', handler: 'inbound-api.reply', config: { policies: [] } },
      { method: 'GET', path: '/conversations/:id', handler: 'inbound-api.conversation', config: { policies: [] } },
      { method: 'POST', path: '/sandbox/inbound', handler: 'inbound-api.simulate', config: { policies: [] } },
      // Signed, expiring download links (SMS attachments, inbound media URLs).
      { method: 'GET', path: '/files/:token', handler: 'files.download', config: { auth: false, policies: [] } },
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
