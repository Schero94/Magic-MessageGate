import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { Box, Button, Flex, Link, Typography } from '@strapi/design-system';
import { ArrowClockwise, ArrowLeft, Message } from '@strapi/icons';
import { NavLink } from 'react-router-dom';
import styled from 'styled-components';

import { SectionFrame } from '../../components/ui/SectionFrame';
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/States';
import { ReachabilityBadge, ToneBadge } from '../../components/ui/StatusBadge';
import { useAction } from '../../hooks/useAction';
import { useApi } from '../../hooks/useApi';
import { useMgRBAC } from '../../hooks/useMgRBAC';
import { useT } from '../../hooks/useT';
import { PLUGIN_ID } from '../../pluginId';
import { CHANNELS, channelLabels } from '../../utils/channels';
import { replyTarget } from '../../utils/inbox.mjs';
import { MessageBubble } from './MessageBubble';
import { ReplyBox } from './ReplyBox';
import { notifyInboxSeen } from './useInboxUnread';
import { useSilentLoad } from './useSilentLoad';

const POLL_MS = 15_000;
const LIST_PATH = `/plugins/${PLUGIN_ID}/inbox`;

/*
 * The message history scrolls inside its own region (a chat log), so the
 * reply box stays close to the newest message. 60vh keeps the region inside
 * the viewport on every width; the region is focusable for keyboard scrolling.
 */
const LogRegion = styled(Box)`
  max-height: 60vh;
  overflow-y: auto;
  overscroll-behavior: contain;

  &:focus-visible {
    outline: none;
    box-shadow: ${({ theme }) => theme.shadows.focus};
  }
`;

/** Plain ordered list for the bubbles (the DS reset already removes markers). */
const MessageList = styled(Flex)`
  margin: 0;
  padding: 0;
  list-style: none;
`;

/**
 * One conversation with a contact: chronological bubbles (inbound left,
 * outbound right), "Mark processed" per inbound message and a reply box.
 * Loading the conversation marks the contact's inbound messages as read on
 * the server. Refreshes every 15 seconds while the tab is visible.
 *
 * @param {{ contactId: string }} props - Contact document id from the route.
 * @returns {JSX.Element} Conversation section.
 */
export const ConversationView = ({ contactId }) => {
  const t = useT();
  const api = useApi();
  const act = useAction();
  const rbac = useMgRBAC();
  const region = useRef(null);
  const nearBottom = useRef(true);
  const shownCount = useRef(0);

  const loader = useCallback(() => api.get(`/conversations/${encodeURIComponent(contactId)}`), [api, contactId]);
  const { data, error, isLoading, reload, refresh } = useSilentLoad(loader, POLL_MS);
  const channels = channelLabels(t);
  const items = data?.items || [];
  const contact = data?.contact || null;
  const target = replyTarget(items);
  const phone = contact?.phoneMasked || t('inbox.contact.unknown', 'Unknown contact');

  // Loading the conversation marked its messages as read: update the tab badge.
  const loaded = Boolean(data);
  useEffect(() => {
    if (loaded) notifyInboxSeen();
  }, [loaded]);

  // Start at the newest message, and follow new ones while the reader is at the bottom.
  useLayoutEffect(() => {
    const el = region.current;
    if (!el) return;
    if (items.length !== shownCount.current && (shownCount.current === 0 || nearBottom.current))
      el.scrollTop = el.scrollHeight;
    shownCount.current = items.length;
  }, [items.length]);

  const markProcessed = async (id) => {
    await act(
      () => api.post(`/inbound/${encodeURIComponent(id)}/processed`),
      t('inbox.processed.done', 'Marked as processed.')
    );
    await refresh();
  };

  const granted = CHANNELS.filter((ch) => contact?.consent?.[ch]?.status === 'granted');
  const backLink = (
    <Link tag={NavLink} to={LIST_PATH} startIcon={<ArrowLeft />}>
      {t('inbox.back', 'Back to the inbox')}
    </Link>
  );

  return (
    <SectionFrame
      title={
        data
          ? t('inbox.conversation.title', 'Conversation with {phone}', { phone })
          : t('inbox.conversation.loadingTitle', 'Conversation')
      }
      subtitle={t(
        'inbox.conversation.subtitle',
        'Messages from and to this contact, oldest first. Opening the conversation marks its messages as read.'
      )}
      navigationAction={backLink}
      busy={isLoading}
      secondaryAction={
        <Button variant="tertiary" startIcon={<ArrowClockwise />} onClick={reload} loading={isLoading}>
          {t('common.refresh', 'Refresh')}
        </Button>
      }
    >
      {error && !data ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !data ? (
        <LoadingState />
      ) : (
        <>
          <Box background="neutral0" hasRadius shadow="filterShadow" padding={4}>
            <Flex gap={3} wrap="wrap" alignItems="center">
              <Typography fontWeight="semiBold" textColor="neutral800">
                {phone}
              </Typography>
              <ReachabilityBadge value={contact?.whatsapp?.reachability} />
              {target?.channel === 'whatsapp' ? (
                data.whatsappWindowOpen ? (
                  <ToneBadge tone="success">{t('inbox.window.open', '24-hour window open')}</ToneBadge>
                ) : (
                  <ToneBadge>{t('inbox.window.closed', '24-hour window closed')}</ToneBadge>
                )
              ) : null}
              <Typography variant="pi" textColor="neutral600">
                {granted.length
                  ? t('inbox.consent', 'Consent: {channels}', {
                      channels: granted.map((ch) => channels[ch]).join(', '),
                    })
                  : t('inbox.consent.none', 'No consent recorded')}
              </Typography>
            </Flex>
          </Box>

          {items.length === 0 ? (
            <EmptyState
              icon={<Message width="6.4rem" height="6.4rem" aria-hidden />}
              content={t('inbox.conversation.empty', 'No messages with this contact yet.')}
            />
          ) : (
            <LogRegion
              ref={region}
              role="log"
              tabIndex={0}
              aria-label={t('inbox.conversation.log', 'Messages with {phone}', { phone })}
              background="neutral100"
              hasRadius
              padding={{ initial: 2, medium: 4 }}
              onScroll={(event) => {
                const el = event.currentTarget;
                nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
              }}
            >
              <MessageList tag="ol" direction="column" alignItems="stretch" gap={3}>
                {items.map((item) => (
                  <MessageBubble
                    key={`${item.direction}-${item.id}`}
                    item={item}
                    canManage={rbac.inbound.manage}
                    onMarkProcessed={markProcessed}
                  />
                ))}
              </MessageList>
            </LogRegion>
          )}

          {rbac.messages.send ? (
            <ReplyBox
              target={target}
              whatsappWindowOpen={data.whatsappWindowOpen === true}
              windowClosesAt={data.windowClosesAt ?? null}
              onSent={refresh}
            />
          ) : null}
        </>
      )}
    </SectionFrame>
  );
};
