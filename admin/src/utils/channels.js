/**
 * Channel, provider and status vocabulary shared by every view.
 */

export const CHANNELS = ['whatsapp', 'rcs', 'telegram', 'sms'];
export const CHAIN_CHANNELS = ['whatsapp', 'rcs', 'telegram', 'sms', 'email'];

export const PROVIDERS_BY_CHANNEL = {
  whatsapp: ['meta'],
  rcs: ['twilio'],
  telegram: ['telegram'],
  sms: ['seven', 'twilio'],
};

export const MESSAGE_STATUSES = ['queued', 'sent', 'delivered', 'read', 'failed', 'uncertain', 'expired', 'discarded'];

/** DS Badge/Status variant per message status. */
export const STATUS_VARIANT = {
  queued: 'secondary',
  sent: 'primary',
  delivered: 'success',
  read: 'success',
  failed: 'danger',
  uncertain: 'warning',
  expired: 'neutral',
  discarded: 'neutral',
};

/** Template approval statuses (Meta) plus local ones. */
export const APPROVAL_VARIANT = {
  APPROVED: 'success',
  PENDING: 'warning',
  IN_APPEAL: 'warning',
  REJECTED: 'danger',
  PAUSED: 'warning',
  DISABLED: 'danger',
  LIMIT_EXCEEDED: 'danger',
  PENDING_DELETION: 'neutral',
  DELETED: 'neutral',
  ARCHIVED: 'neutral',
  DRAFT: 'neutral',
};

/**
 * @param {(id: string, def: string) => string} t - Translator.
 * @returns {Record<string, string>} Channel labels.
 */
export const channelLabels = (t) => ({
  whatsapp: t('channel.whatsapp', 'WhatsApp'),
  rcs: t('channel.rcs', 'RCS'),
  telegram: t('channel.telegram', 'Telegram'),
  sms: t('channel.sms', 'SMS'),
  email: t('channel.email', 'Email (Magic Mail)'),
});

/**
 * @param {(id: string, def: string) => string} t - Translator.
 * @returns {Record<string, string>} Provider labels.
 */
export const providerLabels = (t) => ({
  meta: t('provider.meta', 'Meta WhatsApp Cloud API'),
  telegram: t('provider.telegram', 'Telegram Bot API'),
  seven: t('provider.seven', 'seven.io'),
  twilio: t('provider.twilio', 'Twilio'),
});

/**
 * @param {(id: string, def: string) => string} t - Translator.
 * @returns {Record<string, string>} Message status labels.
 */
export const statusLabels = (t) => ({
  queued: t('status.queued', 'Queued'),
  sent: t('status.sent', 'Sent'),
  delivered: t('status.delivered', 'Delivered'),
  read: t('status.read', 'Read'),
  failed: t('status.failed', 'Failed'),
  uncertain: t('status.uncertain', 'Uncertain'),
  expired: t('status.expired', 'Expired'),
  discarded: t('status.discarded', 'Discarded'),
});

/**
 * @param {(id: string, def: string) => string} t - Translator.
 * @returns {Record<string, string>} Approval labels.
 */
export const approvalLabels = (t) => ({
  APPROVED: t('approval.APPROVED', 'Approved'),
  PENDING: t('approval.PENDING', 'In review'),
  IN_APPEAL: t('approval.IN_APPEAL', 'In appeal'),
  REJECTED: t('approval.REJECTED', 'Rejected'),
  PAUSED: t('approval.PAUSED', 'Paused'),
  DISABLED: t('approval.DISABLED', 'Disabled'),
  LIMIT_EXCEEDED: t('approval.LIMIT_EXCEEDED', 'Limit exceeded'),
  PENDING_DELETION: t('approval.PENDING_DELETION', 'Being deleted'),
  DELETED: t('approval.DELETED', 'Deleted'),
  ARCHIVED: t('approval.ARCHIVED', 'Archived'),
  DRAFT: t('approval.DRAFT', 'Draft'),
});

/**
 * @param {(id: string, def: string) => string} t - Translator.
 * @returns {Record<string, string>} Timeline event labels.
 */
export const eventLabels = (t) => ({
  queued: t('event.queued', 'Queued'),
  sent: t('event.sent', 'Accepted by the provider'),
  delivered: t('event.delivered', 'Delivered to the phone'),
  read: t('event.read', 'Read by the recipient'),
  failed: t('event.failed', 'Failed'),
  'retry-scheduled': t('event.retryScheduled', 'Retry scheduled'),
  'retry-requested': t('event.retryRequested', 'Retried by an admin'),
  uncertain: t('event.uncertain', 'Outcome unknown'),
  expired: t('event.expired', 'Deadline passed'),
  discarded: t('event.discarded', 'Discarded by an admin'),
  'marked-sent': t('event.markedSent', 'Marked as sent by an admin'),
});
