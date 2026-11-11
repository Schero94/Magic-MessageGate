import { useCallback, useState } from 'react';
import { Button, Flex, Grid, Modal, Typography } from '@strapi/design-system';
import { Download, Link as LinkIcon, Message, Trash } from '@strapi/icons';
import { useNavigate } from 'react-router-dom';

import { BooleanField } from '../../components/ui/BooleanField';
import { ConfirmAction } from '../../components/ui/ConfirmAction';
import { CopyField } from '../../components/ui/CopyField';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { ErrorState, LoadingState } from '../../components/ui/States';
import { ReachabilityBadge } from '../../components/ui/StatusBadge';
import { useAction } from '../../hooks/useAction';
import { useApi } from '../../hooks/useApi';
import { useLoad } from '../../hooks/useLoad';
import { useMgRBAC } from '../../hooks/useMgRBAC';
import { useT } from '../../hooks/useT';
import { PLUGIN_ID } from '../../pluginId';
import { CHANNELS, channelLabels } from '../../utils/channels';
import { NumberCheck, RcsBadge } from './NumberCheck';
import { exportFileName } from '../../utils/contacts.mjs';

/**
 * Small heading inside the modal.
 *
 * @param {{ children: string }} props - Text.
 * @returns {JSX.Element} Heading.
 */
const H3 = ({ children }) => (
  <Typography variant="delta" tag="h3">
    {children}
  </Typography>
);

/**
 * Contact detail: reachability, last activity, consent per channel,
 * blocks, Telegram link, GDPR export and erasure.
 *
 * @param {{ id: string, onClose: () => void, onChanged: () => void }} props - Props.
 * @returns {JSX.Element} Modal.
 */
export const ContactDetailModal = ({ id, onClose, onChanged }) => {
  const t = useT();
  const api = useApi();
  const act = useAction();
  const rbac = useMgRBAC();
  const navigate = useNavigate();
  const loader = useCallback(() => api.get(`/contacts/${id}`), [api, id]);
  const { data: c, error, reload, setData } = useLoad(loader);
  const [busyChannel, setBusyChannel] = useState(null);
  const [link, setLink] = useState(null);
  const [openedAt] = useState(() => Date.now());
  const channels = channelLabels(t);

  const setConsent = async (channel, granted) => {
    setBusyChannel(channel);
    try {
      const next = await act(
        () => api.put(`/contacts/${id}/consent`, { channel, status: granted ? 'granted' : 'revoked' }),
        granted
          ? t('contact.consent.granted', 'Consent for {channel} recorded.', { channel: channels[channel] })
          : t('contact.consent.revoked', 'Consent for {channel} revoked.', { channel: channels[channel] })
      );
      setData(next);
      onChanged();
    } catch {
      // notified
    } finally {
      setBusyChannel(null);
    }
  };

  const unblock = async (channel) => {
    try {
      const next = await act(
        () => api.del(`/contacts/${id}/suppressions/${channel}`),
        t('contact.unblocked', '{channel} is allowed again.', { channel: channels[channel] })
      );
      setData(next);
      onChanged();
    } catch {
      // notified
    }
  };

  const createLink = async () => {
    try {
      setLink(await act(() => api.post(`/contacts/${id}/telegram-link`)));
    } catch {
      // notified
    }
  };

  const exportData = async () => {
    try {
      const data = await act(() => api.get(`/contacts/${id}/export`));
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = exportFileName(c);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      // notified
    }
  };

  const erase = () =>
    act(
      () => api.del(`/contacts/${id}`),
      t('contact.erased', 'The contact and its message contents were erased.')
    ).then(() => {
      onChanged();
      onClose();
    });

  const activity = c?.lastActivity || {};
  const consentSource = (entry) =>
    entry?.status === 'none' || !entry
      ? t('contact.consent.never', 'Never given')
      : ({
          admin: t('contact.consent.by.admin', 'Set by an admin'),
          keyword: t('contact.consent.by.keyword', 'Revoked by an opt-out reply'),
          api: t('contact.consent.by.api', 'Set by your app'),
          'telegram-start': t('contact.consent.by.telegram', 'Started the Telegram bot'),
        }[entry.source] ??
        entry.source ??
        '');

  return (
    <Modal.Root open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content>
        <Modal.Header>
          <Modal.Title>{c?.phoneMasked || t('contact.title', 'Contact')}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {error && !c ? (
            <ErrorState error={error} onRetry={reload} />
          ) : !c ? (
            <LoadingState />
          ) : (
            <Flex direction="column" alignItems="stretch" gap={6}>
              <Flex gap={2} wrap="wrap" alignItems="center">
                <ReachabilityBadge value={c.whatsapp?.reachability} />
                <RcsBadge value={c.rcs?.capability} />
                <NumberCheck contact={c} />
                {c.country ? (
                  <Typography variant="pi" textColor="neutral600">
                    {c.country}
                  </Typography>
                ) : null}
              </Flex>
              {c.phone ? (
                <Typography textColor="neutral800" fontWeight="semiBold">
                  {c.phone}
                </Typography>
              ) : null}

              <Flex direction="column" alignItems="stretch" gap={3}>
                <H3>{t('contact.activity', 'Last activity')}</H3>
                <Grid.Root gap={3}>
                  {[
                    ['inboundAt', t('contact.activity.inbound', 'Last reply from the contact')],
                    ['deliveredAt', t('contact.activity.delivered', 'Last delivered message')],
                    ['readAt', t('contact.activity.read', 'Last read message')],
                  ].map(([key, label]) => (
                    <Grid.Item key={key} col={4} xs={12} direction="column" alignItems="flex-start">
                      <Typography variant="sigma" textColor="neutral600">
                        {label}
                      </Typography>
                      <Typography textColor="neutral800">
                        {activity[key] ? <RelativeTime value={activity[key]} /> : t('message.step.pending', 'Not yet')}
                      </Typography>
                    </Grid.Item>
                  ))}
                </Grid.Root>
                {activity.inboundAt && openedAt - activity.inboundAt < 24 * 3600_000 ? (
                  <Typography variant="pi" textColor="success700">
                    {t('contact.window', 'The 24-hour window is open: free text is allowed on WhatsApp.')}
                  </Typography>
                ) : null}
              </Flex>

              <Flex direction="column" alignItems="stretch" gap={3}>
                <H3>{t('contact.consent', 'Consent')}</H3>
                <Grid.Root gap={4}>
                  {CHANNELS.map((channel) => (
                    <Grid.Item key={channel} col={4} xs={12} direction="column" alignItems="stretch">
                      <BooleanField
                        name={`consent-${channel}`}
                        label={channels[channel]}
                        hint={consentSource(c.consent?.[channel])}
                        checked={c.consent?.[channel]?.status === 'granted'}
                        disabled={!rbac.contacts.manage || busyChannel === channel}
                        onCheckedChange={(value) => setConsent(channel, value)}
                      />
                    </Grid.Item>
                  ))}
                </Grid.Root>
                <Typography variant="pi" textColor="neutral600">
                  {t(
                    'contact.consent.hint',
                    'Record consent only when the contact gave it, for example at checkout. Changes are logged with "admin" as source.'
                  )}
                </Typography>
              </Flex>

              {c.suppressions?.length ? (
                <Flex direction="column" alignItems="stretch" gap={3}>
                  <H3>{t('contact.blocks', 'Blocked channels')}</H3>
                  {c.suppressions.map((s) => (
                    <Flex key={s.channel} gap={3} wrap="wrap" justifyContent="space-between">
                      <Flex direction="column" alignItems="flex-start">
                        <Typography fontWeight="semiBold">{channels[s.channel]}</Typography>
                        <Typography variant="pi" textColor="neutral600">
                          {{
                            blocked_bot: t('contact.block.blockedBot', 'The contact blocked the Telegram bot.'),
                          }[s.reason] || s.reason}
                        </Typography>
                      </Flex>
                      {rbac.contacts.manage ? (
                        <ConfirmAction
                          label={t('contact.unblock', 'Allow again')}
                          triggerVariant="tertiary"
                          variant="default"
                          size="S"
                          title={t('contact.unblock.title', 'Allow {channel} again?', { channel: channels[s.channel] })}
                          body={t('contact.unblock.body', 'MessageGate will try this channel again for this contact.')}
                          confirmLabel={t('contact.unblock.confirm', 'Allow again')}
                          onConfirm={() => unblock(s.channel)}
                        />
                      ) : null}
                    </Flex>
                  ))}
                </Flex>
              ) : null}

              <Flex direction="column" alignItems="stretch" gap={3}>
                <H3>{t('contact.telegram', 'Telegram')}</H3>
                {c.telegramLinked ? (
                  <Typography textColor="neutral800">
                    {t('contact.telegram.linked', 'Linked. Telegram messages reach this contact.')}
                  </Typography>
                ) : link?.url ? (
                  <CopyField
                    name="telegramLink"
                    label={t('contact.telegram.link', 'Link for the contact')}
                    value={link.url}
                    hint={t(
                      'contact.telegram.linkHint',
                      'Valid for {minutes} minutes. The contact opens it and taps Start.',
                      {
                        minutes: link.expiresInMinutes,
                      }
                    )}
                  />
                ) : (
                  <Flex gap={3} wrap="wrap" alignItems="center">
                    <Typography textColor="neutral600">
                      {t(
                        'contact.telegram.notLinked',
                        'Not linked. Telegram bots can only write to people who started them.'
                      )}
                    </Typography>
                    {rbac.contacts.manage ? (
                      <Button variant="secondary" startIcon={<LinkIcon />} onClick={createLink}>
                        {t('contact.telegram.create', 'Create a link')}
                      </Button>
                    ) : null}
                  </Flex>
                )}
                {link && !link.url ? (
                  <Typography variant="pi" textColor="warning700">
                    {t('contact.telegram.noBot', 'Test the Telegram account first so the bot name is known.')}
                  </Typography>
                ) : null}
              </Flex>
            </Flex>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Modal.Close>
            <Button variant="tertiary">{t('common.close', 'Close')}</Button>
          </Modal.Close>
          {c ? (
            <Flex gap={2} wrap="wrap" justifyContent="flex-end">
              {rbac.messages.read && c.phone ? (
                <Button
                  variant="tertiary"
                  startIcon={<Message />}
                  onClick={() => navigate(`/plugins/${PLUGIN_ID}?phone=${encodeURIComponent(c.phone)}&range=all`)}
                >
                  {t('contact.messages', 'Messages')}
                </Button>
              ) : null}
              {rbac.contacts.export ? (
                <Button variant="secondary" startIcon={<Download />} onClick={exportData}>
                  {t('contact.export', 'Export (GDPR)')}
                </Button>
              ) : null}
              {rbac.contacts.manage ? (
                <ConfirmAction
                  label={t('contact.erase', 'Erase')}
                  startIcon={<Trash />}
                  title={t('contact.erase.title', 'Erase this contact?')}
                  body={t(
                    'contact.erase.body',
                    'The number, consents, blocks and all message contents are deleted. Statistics stay without personal data. This cannot be undone.'
                  )}
                  confirmLabel={t('contact.erase.confirm', 'Erase contact')}
                  size="S"
                  onConfirm={erase}
                />
              ) : null}
            </Flex>
          ) : null}
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
};
