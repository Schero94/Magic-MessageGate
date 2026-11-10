const action = (uid) => [{ action: `plugin::magic-messagegate.${uid}`, subject: null }];

export const permissions = {
  accountsRead: action('accounts.read'),
  accountsManage: action('accounts.manage'),
  templatesRead: action('templates.read'),
  templatesManage: action('templates.manage'),
  templatesSubmit: action('templates.submit'),
  messagesRead: action('messages.read'),
  messagesSend: action('messages.send'),
  messagesManage: action('messages.manage'),
  contactsRead: action('contacts.read'),
  contactsManage: action('contacts.manage'),
  contactsExport: action('contacts.export'),
  analyticsRead: action('analytics.read'),
  settingsRead: action('settings.read'),
  settingsUpdate: action('settings.update'),
};

/** Any of these opens the plugin page. */
export const menuPermissions = [
  ...permissions.messagesRead,
  ...permissions.templatesRead,
  ...permissions.accountsRead,
  ...permissions.analyticsRead,
];
