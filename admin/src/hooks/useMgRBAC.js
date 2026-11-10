import { useRBAC } from '@strapi/strapi/admin';
import { permissions } from '../permissions';

/*
 * useRBAC names each capability after the last segment of the action
 * (`accounts.read` -> `canRead`), so actions that share a segment are checked
 * in separate calls, one per group. Hooks run in a fixed order.
 */
const GROUPS = {
  accounts: [...permissions.accountsRead, ...permissions.accountsManage],
  templates: [...permissions.templatesRead, ...permissions.templatesManage, ...permissions.templatesSubmit],
  messages: [...permissions.messagesRead, ...permissions.messagesSend, ...permissions.messagesManage],
  contacts: [...permissions.contactsRead, ...permissions.contactsManage, ...permissions.contactsExport],
  analytics: [...permissions.analyticsRead],
  settings: [...permissions.settingsRead, ...permissions.settingsUpdate],
};

/**
 * Single source of truth for UI gating. The API routes stay authoritative;
 * this only keeps unavailable controls out of the interface. While
 * permissions load (or fail to load) every capability is false.
 *
 * @returns {{
 *   isLoading: boolean,
 *   accounts: {read: boolean, manage: boolean},
 *   templates: {read: boolean, manage: boolean, submit: boolean},
 *   messages: {read: boolean, send: boolean, manage: boolean},
 *   contacts: {read: boolean, manage: boolean, export: boolean},
 *   analytics: {read: boolean},
 *   settings: {read: boolean, update: boolean},
 * }} Capabilities.
 */
export function useMgRBAC() {
  const accounts = useRBAC(GROUPS.accounts);
  const templates = useRBAC(GROUPS.templates);
  const messages = useRBAC(GROUPS.messages);
  const contacts = useRBAC(GROUPS.contacts);
  const analytics = useRBAC(GROUPS.analytics);
  const settings = useRBAC(GROUPS.settings);
  const all = [accounts, templates, messages, contacts, analytics, settings];
  const ok = (r, key) => !r?.isLoading && !r?.error && r?.allowedActions?.[key] === true;
  return {
    isLoading: all.some((r) => r?.isLoading),
    accounts: { read: ok(accounts, 'canRead'), manage: ok(accounts, 'canManage') },
    templates: {
      read: ok(templates, 'canRead'),
      manage: ok(templates, 'canManage'),
      submit: ok(templates, 'canSubmit'),
    },
    messages: { read: ok(messages, 'canRead'), send: ok(messages, 'canSend'), manage: ok(messages, 'canManage') },
    contacts: {
      read: ok(contacts, 'canRead'),
      manage: ok(contacts, 'canManage'),
      export: ok(contacts, 'canExport'),
    },
    analytics: { read: ok(analytics, 'canRead') },
    settings: { read: ok(settings, 'canRead'), update: ok(settings, 'canUpdate') },
  };
}
