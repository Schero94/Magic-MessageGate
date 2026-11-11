import { useRef, useState } from 'react';
import { Box, Button, Flex, LinkButton, Typography } from '@strapi/design-system';
import { Check, Pin } from '@strapi/icons';
import { useIntl } from 'react-intl';
import styled from 'styled-components';

import { RelativeTime } from '../../components/ui/RelativeTime';
import { MessageStatusBadge, ToneBadge } from '../../components/ui/StatusBadge';
import { useT } from '../../hooks/useT';
import { channelLabels } from '../../utils/channels';
import { coordinates, osmUrl } from '../../utils/inbox.mjs';
import { InboundMedia } from './InboundMedia';

/*
 * Chat bubble width: full width on phones, then 85 % from the DS small
 * breakpoint and 70 % from large, so inbound (left) and outbound (right)
 * stay apart. DS props cannot express a percentage max-width per breakpoint.
 */
const Bubble = styled(Box)`
  max-width: 100%;
  min-width: 0;

  ${({ theme }) => theme.breakpoints.small} {
    max-width: 85%;
  }

  ${({ theme }) => theme.breakpoints.large} {
    max-width: 70%;
  }
`;

/** Message text keeps the sender's line breaks and wraps long words and links. */
const MessageText = styled(Typography)`
  white-space: pre-wrap;
  overflow-wrap: anywhere;
`;

/**
 * Shared location: name, address, coordinates and an OpenStreetMap link.
 *
 * @param {{ location: {latitude: number, longitude: number, name?: string, address?: string} }} props - Location.
 * @returns {JSX.Element} Location block.
 */
const LocationView = ({ location }) => {
  const t = useT();
  const { formatNumber } = useIntl();
  const c = coordinates(location);
  const href = osmUrl(location);
  const fmt = (value) => formatNumber(value, { maximumFractionDigits: 6 });
  return (
    <Flex direction="column" alignItems="flex-start" gap={1} minWidth={0}>
      <Flex gap={2} alignItems="center">
        <Pin aria-hidden />
        <Typography textColor="neutral800" fontWeight="semiBold">
          {location?.name || t('inbox.location.shared', 'Shared location')}
        </Typography>
      </Flex>
      {location?.address ? <MessageText textColor="neutral800">{location.address}</MessageText> : null}
      <Typography variant="pi" textColor="neutral600">
        {c
          ? t('inbox.location.coordinates', 'Latitude {lat}, longitude {lon}', { lat: fmt(c.lat), lon: fmt(c.lon) })
          : t('inbox.location.invalid', 'No valid coordinates')}
      </Typography>
      {href ? (
        <LinkButton href={href} isExternal variant="tertiary" size="S">
          {t('inbox.location.open', 'Open in OpenStreetMap')}
        </LinkButton>
      ) : null}
    </Flex>
  );
};

/**
 * Content of an inbound message by kind: text, tapped button (payload as a
 * badge), stored file, location or an unsupported type.
 *
 * @param {{ item: object }} props - Conversation item.
 * @returns {JSX.Element} Content.
 */
const InboundContent = ({ item }) => {
  const t = useT();
  if (item.kind === 'button') {
    return (
      <Flex direction="column" alignItems="flex-start" gap={2}>
        <Typography variant="pi" textColor="neutral600">
          {t('inbox.button.tapped', 'Tapped a button')}
        </Typography>
        <Flex gap={2} wrap="wrap" alignItems="center">
          {item.buttonTitle ? <MessageText textColor="neutral800">{item.buttonTitle}</MessageText> : null}
          {item.buttonPayload ? <ToneBadge tone="primary">{item.buttonPayload}</ToneBadge> : null}
        </Flex>
      </Flex>
    );
  }
  if (item.kind === 'location' && item.location) return <LocationView location={item.location} />;
  if (item.kind === 'media' && item.media) {
    return (
      <Flex direction="column" alignItems="stretch" gap={2} minWidth={0}>
        <InboundMedia id={item.id} media={item.media} />
        {item.media.caption ? <MessageText textColor="neutral800">{item.media.caption}</MessageText> : null}
        {item.text && item.text !== item.media.caption ? (
          <MessageText textColor="neutral800">{item.text}</MessageText>
        ) : null}
      </Flex>
    );
  }
  if (item.text) return <MessageText textColor="neutral800">{item.text}</MessageText>;
  if (item.kind === 'other')
    return (
      <Typography textColor="neutral600">
        {t('inbox.other', 'This message type cannot be shown here. It is stored with the message.')}
      </Typography>
    );
  return <Typography textColor="neutral600">{t('inbox.noText', 'No text stored.')}</Typography>;
};

/**
 * Content of an outbound message. The server removes the text after
 * delivery (privacy by design): then the template key or a note is shown.
 *
 * @param {{ item: object }} props - Conversation item.
 * @returns {JSX.Element} Content.
 */
const OutboundContent = ({ item }) => {
  const t = useT();
  if (item.text) return <MessageText textColor="neutral800">{item.text}</MessageText>;
  if (item.templateKey)
    return (
      <Flex direction="column" alignItems="flex-start" gap={1}>
        <Typography textColor="neutral800" fontWeight="semiBold">
          {t('inbox.outbound.template', 'Template {key}', { key: item.templateKey })}
        </Typography>
        <Typography variant="pi" textColor="neutral600">
          {t('inbox.outbound.removed', 'Content removed after delivery.')}
        </Typography>
      </Flex>
    );
  return (
    <Typography variant="pi" textColor="neutral600">
      {t('inbox.outbound.removed', 'Content removed after delivery.')}
    </Typography>
  );
};

/**
 * One message of a conversation: inbound on the left (neutral surface),
 * outbound on the right (primary tint). Inbound messages show whether an
 * admin processed them and, with the manage permission, a "Mark processed"
 * action.
 *
 * @param {object} props - Props.
 * @param {object} props.item - Conversation item (`direction`, `id`, `channel`, `kind`, `text`, `media`, `status`, `at`, …).
 * @param {boolean} props.canManage - The admin may mark inbound messages processed.
 * @param {(id: string) => Promise<void>} props.onMarkProcessed - Marks it processed; throws on failure.
 * @returns {JSX.Element} List item.
 */
export const MessageBubble = ({ item, canManage, onMarkProcessed }) => {
  const t = useT();
  const channels = channelLabels(t);
  const [busy, setBusy] = useState(false);
  const statusRef = useRef(null);
  const inbound = item.direction === 'inbound';
  const processed = inbound && item.status === 'processed';

  const markProcessed = async () => {
    setBusy(true);
    try {
      await onMarkProcessed(item.id);
      // The button is replaced by the processed badge; keep focus nearby.
      setTimeout(() => statusRef.current?.focus(), 50);
    } catch {
      // useAction already reported the error; the button stays.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Flex tag="li" justifyContent={inbound ? 'flex-start' : 'flex-end'} minWidth={0}>
      <Bubble
        background={inbound ? 'neutral0' : 'primary100'}
        borderColor={inbound ? 'neutral200' : 'primary200'}
        hasRadius
        padding={4}
      >
        <Flex direction="column" alignItems="stretch" gap={3} minWidth={0}>
          <Typography variant="pi" textColor="neutral600">
            {inbound ? t('inbox.from.contact', 'Contact') : t('inbox.from.us', 'Sent')}
            {' · '}
            {channels[item.channel] || item.channel}
            {' · '}
            <RelativeTime value={item.at} />
          </Typography>

          {inbound ? <InboundContent item={item} /> : <OutboundContent item={item} />}

          {inbound && item.replyTo ? (
            <Typography variant="pi" textColor="neutral600">
              {t('inbox.replyTo', 'Answer to a message sent from MessageGate')}
            </Typography>
          ) : null}

          <Flex gap={2} wrap="wrap" alignItems="center">
            {inbound ? (
              processed ? (
                <Box ref={statusRef} tabIndex={-1}>
                  <ToneBadge tone="success">{t('inbox.state.processed', 'Processed')}</ToneBadge>
                </Box>
              ) : canManage ? (
                <Button variant="secondary" size="S" startIcon={<Check />} loading={busy} onClick={markProcessed}>
                  {t('inbox.markProcessed', 'Mark processed')}
                </Button>
              ) : (
                <ToneBadge>{t('inbox.state.open', 'Not processed')}</ToneBadge>
              )
            ) : (
              <MessageStatusBadge status={item.status} />
            )}
          </Flex>
        </Flex>
      </Bubble>
    </Flex>
  );
};
