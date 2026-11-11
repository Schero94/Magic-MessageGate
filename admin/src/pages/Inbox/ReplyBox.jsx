import { useId, useState } from 'react';
import { Box, Button, Field, Flex, LinkButton, Textarea, Typography } from '@strapi/design-system';
import { PaperPlane } from '@strapi/icons';
import { useNotification } from '@strapi/strapi/admin';
import { useIntl } from 'react-intl';
import { NavLink } from 'react-router-dom';

import { Notice } from '../../components/ui/Notice';
import { useAction } from '../../hooks/useAction';
import { useApi } from '../../hooks/useApi';
import { useT } from '../../hooks/useT';
import { PLUGIN_ID } from '../../pluginId';
import { channelLabels } from '../../utils/channels';
import { REPLY_MAX_LENGTH, canReplyFreeText } from '../../utils/inbox.mjs';

/**
 * Free-text reply to the contact's newest inbound message, sent on that
 * message's channel and account. On WhatsApp free text is only allowed
 * within 24 hours of the contact's last message; outside that window the box
 * is disabled and points to the Messages page, where templates are sent.
 *
 * @param {object} props - Props.
 * @param {{id: string, channel: string} | null} props.target - Newest inbound message, or null.
 * @param {boolean} props.whatsappWindowOpen - WhatsApp customer service window state.
 * @param {number | null} props.windowClosesAt - Epoch ms when the WhatsApp window closes.
 * @param {() => Promise<void> | void} props.onSent - Refreshes the conversation (after success and error).
 * @returns {JSX.Element} Reply section.
 */
export const ReplyBox = ({ target, whatsappWindowOpen, windowClosesAt, onSent }) => {
  const t = useT();
  const api = useApi();
  const act = useAction();
  const { formatDate } = useIntl();
  const { toggleNotification } = useNotification();
  const headingId = useId();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const channels = channelLabels(t);

  const allowed = canReplyFreeText(target, whatsappWindowOpen);
  const blocked = Boolean(target) && !allowed;
  const empty = !text.trim();
  const channelName = target ? channels[target.channel] || target.channel : '';

  const send = async () => {
    if (!target || !allowed || empty || sending) return;
    setSending(true);
    try {
      const result = await act(() =>
        api.post(`/inbound/${encodeURIComponent(target.id)}/reply`, { text: text.trim() })
      );
      if (result?.duplicate)
        toggleNotification({ type: 'info', message: t('inbox.reply.duplicate', 'This reply was already sent.') });
      else toggleNotification({ type: 'success', message: t('inbox.reply.sent', 'Reply queued for sending.') });
      setText('');
    } catch {
      // useAction showed the reason; the text stays in the box.
    } finally {
      setSending(false);
      await onSent();
    }
  };

  const windowHint =
    target?.channel === 'whatsapp' && whatsappWindowOpen && windowClosesAt
      ? t('inbox.reply.windowOpen', 'Free text is possible until {time}.', {
          time: formatDate(windowClosesAt, { dateStyle: 'medium', timeStyle: 'short' }),
        })
      : null;

  return (
    <Box
      tag="section"
      aria-labelledby={headingId}
      background="neutral0"
      hasRadius
      shadow="filterShadow"
      padding={{ initial: 4, medium: 6 }}
    >
      <Flex direction="column" alignItems="stretch" gap={4}>
        <Flex direction="column" alignItems="flex-start" gap={1}>
          <Typography variant="delta" tag="h2" id={headingId}>
            {t('inbox.reply.title', 'Reply')}
          </Typography>
          <Typography variant="pi" textColor="neutral600">
            {target
              ? t('inbox.reply.subtitle', 'Answers the newest message of the contact on {channel}.', {
                  channel: channelName,
                })
              : t(
                  'inbox.reply.noTarget',
                  'A reply answers a message from the contact. This contact has not sent one yet; use the Messages page to write first.'
                )}
          </Typography>
        </Flex>

        {blocked ? (
          <Notice
            variant="warning"
            title={t('inbox.reply.closedTitle', 'The 24-hour window is closed')}
            action={
              <LinkButton tag={NavLink} to={`/plugins/${PLUGIN_ID}`} variant="secondary" size="S">
                {t('inbox.reply.useTemplate', 'Send a template')}
              </LinkButton>
            }
          >
            {t(
              'inbox.reply.closedBody',
              'WhatsApp allows free text only within 24 hours of the last message from the contact. Send an approved template from the Messages page instead.'
            )}
          </Notice>
        ) : null}

        {target ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            <Flex direction="column" alignItems="stretch" gap={4}>
              <Field.Root
                name="reply"
                hint={[
                  windowHint,
                  t('inbox.reply.count', '{count} of {max} characters', {
                    count: text.length,
                    max: REPLY_MAX_LENGTH,
                  }),
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <Field.Label>{t('inbox.reply.label', 'Message')}</Field.Label>
                <Textarea
                  value={text}
                  disabled={blocked}
                  maxLength={REPLY_MAX_LENGTH}
                  placeholder={t('inbox.reply.placeholder', 'Write a reply…')}
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      send();
                    }
                  }}
                />
                <Field.Hint />
              </Field.Root>
              <Flex justifyContent="flex-end" gap={2} wrap="wrap">
                <Typography variant="pi" textColor="neutral600">
                  {t('inbox.reply.shortcut', 'Ctrl or Cmd + Enter sends.')}
                </Typography>
                <Button type="submit" startIcon={<PaperPlane />} loading={sending} disabled={blocked || empty}>
                  {t('inbox.reply.send', 'Send reply')}
                </Button>
              </Flex>
            </Flex>
          </form>
        ) : null}
      </Flex>
    </Box>
  );
};
