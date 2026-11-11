import { useCallback } from 'react';
import {
  Box,
  Button,
  Field,
  Flex,
  Grid,
  Link,
  SingleSelect,
  SingleSelectOption,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
  Typography,
} from '@strapi/design-system';
import { ArrowClockwise, Mail, Paperclip, Pin } from '@strapi/icons';
import { Pagination, useQueryParams } from '@strapi/strapi/admin';
import { NavLink, useNavigate } from 'react-router-dom';
import styled, { useTheme } from 'styled-components';

import { RelativeTime } from '../../components/ui/RelativeTime';
import { SectionFrame } from '../../components/ui/SectionFrame';
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/States';
import { ToneBadge } from '../../components/ui/StatusBadge';
import { useApi } from '../../hooks/useApi';
import { useT } from '../../hooks/useT';
import { PLUGIN_ID } from '../../pluginId';
import { CHANNELS, channelLabels } from '../../utils/channels';
import { INBOUND_KINDS, coordinates, excerpt, inboundParams, mediaPresentation } from '../../utils/inbox.mjs';
import { MediaStateBadge } from './InboundMedia';
import { kindLabels, mediaTypeLabels } from './labels';
import { useMediaQuery } from './useMediaQuery';
import { useSilentLoad } from './useSilentLoad';

const POLL_MS = 15_000;
const LIST_PATH = `/plugins/${PLUGIN_ID}/inbox`;

/** Excerpts wrap inside their cell or card instead of widening the page. */
const Wrap = styled(Typography)`
  overflow-wrap: anywhere;
`;

/** Plain list of cards for narrow screens. */
const CardList = styled(Flex)`
  margin: 0;
  padding: 0;
  list-style: none;
`;

/**
 * Short preview of an inbound message for the list: text excerpt, tapped
 * button payload, file type with its state, or the location name.
 *
 * @param {{ m: object }} props - Inbound DTO.
 * @returns {JSX.Element} Preview.
 */
const Preview = ({ m }) => {
  const t = useT();
  if (m.kind === 'button')
    return (
      <Flex gap={2} wrap="wrap" alignItems="center">
        {m.buttonPayload ? <ToneBadge tone="primary">{m.buttonPayload}</ToneBadge> : null}
        {m.buttonTitle ? <Wrap textColor="neutral800">{excerpt(m.buttonTitle, 60)}</Wrap> : null}
      </Flex>
    );
  if (m.kind === 'media' && m.media) {
    const type = mediaTypeLabels(t)[mediaPresentation(m.media.mime)];
    return (
      <Flex gap={2} wrap="wrap" alignItems="center">
        <Paperclip aria-hidden />
        <Wrap textColor="neutral800">
          {m.media.filename
            ? t('inbox.media.named', '{type}: {name}', { type, name: excerpt(m.media.filename, 40) })
            : type}
        </Wrap>
        {m.media.status !== 'ready' ? <MediaStateBadge status={m.media.status} code={m.media.code} /> : null}
      </Flex>
    );
  }
  if (m.kind === 'location') {
    const c = coordinates(m.location);
    return (
      <Flex gap={2} alignItems="center">
        <Pin aria-hidden />
        <Wrap textColor="neutral800">
          {m.location?.name ||
            (c
              ? t('inbox.location.short', 'Location {lat}, {lon}', { lat: c.lat.toFixed(4), lon: c.lon.toFixed(4) })
              : t('inbox.location.shared', 'Shared location'))}
        </Wrap>
      </Flex>
    );
  }
  if (m.text) return <Wrap textColor="neutral800">{excerpt(m.text)}</Wrap>;
  return <Typography textColor="neutral600">{t('inbox.noText', 'No text stored.')}</Typography>;
};

/**
 * Processing and read state badges. The read state is shown when the
 * server reports it (`seenAt`) or when the "Unread only" filter is active.
 *
 * @param {{ m: object, unreadFilter: boolean }} props - Props.
 * @returns {JSX.Element} Badges.
 */
const StateBadges = ({ m, unreadFilter }) => {
  const t = useT();
  const unread = m.seenAt === null || (m.seenAt === undefined && unreadFilter);
  return (
    <Flex gap={2} wrap="wrap">
      {unread ? <ToneBadge tone="primary">{t('inbox.state.unread', 'Unread')}</ToneBadge> : null}
      {m.processedAt ? (
        <ToneBadge tone="success">{t('inbox.state.processed', 'Processed')}</ToneBadge>
      ) : (
        <ToneBadge>{t('inbox.state.open', 'Not processed')}</ToneBadge>
      )}
    </Flex>
  );
};

/**
 * Contact cell: a link to the conversation, or a note for erased contacts.
 *
 * @param {{ m: object }} props - Inbound DTO.
 * @returns {JSX.Element} Contact.
 */
const ContactLink = ({ m }) => {
  const t = useT();
  const phone = m.contact?.phoneMasked || t('inbox.contact.unknown', 'Unknown contact');
  if (!m.contactId)
    return <Typography textColor="neutral600">{t('inbox.contact.erased', 'Erased contact')}</Typography>;
  return (
    <Link
      tag={NavLink}
      to={`${LIST_PATH}/${encodeURIComponent(m.contactId)}`}
      onClick={(event) => event.stopPropagation()}
      aria-label={t('inbox.openConversation', 'Open the conversation with {phone}', { phone })}
    >
      {phone}
    </Link>
  );
};

/**
 * Inbox list: every inbound message, newest first, with channel, kind,
 * processing state and read state filters. A table from the DS large
 * breakpoint, stacked cards below it. Refreshes every 15 seconds.
 *
 * @returns {JSX.Element} Inbox section.
 */
export const InboxList = () => {
  const t = useT();
  const api = useApi();
  const theme = useTheme();
  const navigate = useNavigate();
  const wide = useMediaQuery(theme.breakpoints.large);
  const [{ query }, setQuery] = useQueryParams({ page: 1, pageSize: 25 });

  const channel = query.channel || 'all';
  const kind = query.kind || 'all';
  const state = query.state || 'all';
  const read = query.read || 'all';
  const page = Number(query.page) || 1;
  const pageSize = Number(query.pageSize) || 25;

  const loader = useCallback(
    () => api.get('/inbound', inboundParams({ page, pageSize, channel, kind, state, read })),
    [api, page, pageSize, channel, kind, state, read]
  );
  const { data, error, isLoading, reload } = useSilentLoad(loader, POLL_MS);

  const setFilter = (key, value) => setQuery({ [key]: value === 'all' ? undefined : value, page: 1 });
  const channels = channelLabels(t);
  const kinds = kindLabels(t);
  const results = data?.results || [];
  const filtered = channel !== 'all' || kind !== 'all' || state !== 'all' || read !== 'all';
  const unreadFilter = read === 'unread';
  const open = (m) => {
    if (m.contactId) navigate(`${LIST_PATH}/${encodeURIComponent(m.contactId)}`);
  };

  return (
    <SectionFrame
      title={t('inbox.title', 'Inbox')}
      subtitle={t(
        'inbox.subtitle',
        'Messages, button replies, files and locations from your contacts. Open one to see the conversation and reply.'
      )}
      busy={isLoading}
      secondaryAction={
        <Button variant="tertiary" startIcon={<ArrowClockwise />} onClick={reload} loading={isLoading}>
          {t('common.refresh', 'Refresh')}
        </Button>
      }
    >
      <Box background="neutral0" hasRadius shadow="filterShadow" padding={4}>
        <Grid.Root gap={4}>
          <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
            <Field.Root name="channel">
              <Field.Label>{t('inbox.filter.channel', 'Channel')}</Field.Label>
              <SingleSelect value={channel} onChange={(value) => setFilter('channel', value)}>
                <SingleSelectOption value="all">{t('inbox.filter.allChannels', 'All channels')}</SingleSelectOption>
                {CHANNELS.map((c) => (
                  <SingleSelectOption key={c} value={c}>
                    {channels[c]}
                  </SingleSelectOption>
                ))}
              </SingleSelect>
            </Field.Root>
          </Grid.Item>
          <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
            <Field.Root name="kind">
              <Field.Label>{t('inbox.filter.kind', 'Type')}</Field.Label>
              <SingleSelect value={kind} onChange={(value) => setFilter('kind', value)}>
                <SingleSelectOption value="all">{t('inbox.filter.allKinds', 'All types')}</SingleSelectOption>
                {INBOUND_KINDS.map((k) => (
                  <SingleSelectOption key={k} value={k}>
                    {kinds[k]}
                  </SingleSelectOption>
                ))}
              </SingleSelect>
            </Field.Root>
          </Grid.Item>
          <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
            <Field.Root name="state">
              <Field.Label>{t('inbox.filter.state', 'Processing')}</Field.Label>
              <SingleSelect value={state} onChange={(value) => setFilter('state', value)}>
                <SingleSelectOption value="all">{t('inbox.filter.allStates', 'All')}</SingleSelectOption>
                <SingleSelectOption value="open">{t('inbox.state.open', 'Not processed')}</SingleSelectOption>
                <SingleSelectOption value="processed">{t('inbox.state.processed', 'Processed')}</SingleSelectOption>
              </SingleSelect>
            </Field.Root>
          </Grid.Item>
          <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
            <Field.Root name="read">
              <Field.Label>{t('inbox.filter.read', 'Read status')}</Field.Label>
              <SingleSelect value={read} onChange={(value) => setFilter('read', value)}>
                <SingleSelectOption value="all">{t('inbox.filter.allRead', 'Read and unread')}</SingleSelectOption>
                <SingleSelectOption value="unread">{t('inbox.filter.unread', 'Unread only')}</SingleSelectOption>
              </SingleSelect>
            </Field.Root>
          </Grid.Item>
        </Grid.Root>
      </Box>

      {error && !data ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !data ? (
        <LoadingState />
      ) : results.length === 0 ? (
        <EmptyState
          icon={<Mail width="6.4rem" height="6.4rem" aria-hidden />}
          content={
            filtered
              ? t('inbox.empty.filtered', 'No inbound message matches these filters.')
              : t(
                  'inbox.empty',
                  'No inbound messages yet. Replies, button taps, files and locations from contacts appear here once the provider webhooks are set up.'
                )
          }
          action={
            filtered ? (
              <Button
                variant="secondary"
                onClick={() =>
                  setQuery({ page: 1, channel: undefined, kind: undefined, state: undefined, read: undefined })
                }
              >
                {t('inbox.empty.reset', 'Reset filters')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Flex direction="column" alignItems="stretch" gap={4}>
          {wide ? (
            <Table colCount={6} rowCount={results.length + 1}>
              <Thead>
                <Tr>
                  <Th>
                    <Typography variant="sigma">{t('inbox.col.received', 'Received')}</Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma">{t('inbox.col.contact', 'Contact')}</Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma">{t('inbox.col.channel', 'Channel')}</Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma">{t('inbox.col.kind', 'Type')}</Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma">{t('inbox.col.message', 'Message')}</Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma">{t('inbox.col.state', 'State')}</Typography>
                  </Th>
                </Tr>
              </Thead>
              <Tbody>
                {results.map((m) => (
                  <Tr key={m.id} onClick={() => open(m)} style={m.contactId ? { cursor: 'pointer' } : undefined}>
                    <Td>
                      <Typography textColor="neutral800">
                        <RelativeTime value={m.receivedAt} />
                      </Typography>
                    </Td>
                    <Td>
                      <ContactLink m={m} />
                    </Td>
                    <Td>
                      <ToneBadge tone="secondary">{channels[m.channel] || m.channel}</ToneBadge>
                    </Td>
                    <Td>
                      <Typography textColor="neutral800">{kinds[m.kind] || m.kind}</Typography>
                    </Td>
                    <Td>
                      <Box maxWidth="40rem">
                        <Preview m={m} />
                      </Box>
                    </Td>
                    <Td>
                      <StateBadges m={m} unreadFilter={unreadFilter} />
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          ) : (
            <CardList
              tag="ul"
              direction="column"
              alignItems="stretch"
              gap={3}
              aria-label={t('inbox.listLabel', 'Inbound messages')}
            >
              {results.map((m) => (
                <Box key={m.id} tag="li" background="neutral0" hasRadius shadow="tableShadow" padding={4} minWidth={0}>
                  <Flex direction="column" alignItems="stretch" gap={3} minWidth={0}>
                    <Flex justifyContent="space-between" alignItems="flex-start" gap={2} wrap="wrap">
                      <ContactLink m={m} />
                      <Typography variant="pi" textColor="neutral600">
                        <RelativeTime value={m.receivedAt} />
                      </Typography>
                    </Flex>
                    <Preview m={m} />
                    <Flex gap={2} wrap="wrap" alignItems="center">
                      <ToneBadge tone="secondary">{channels[m.channel] || m.channel}</ToneBadge>
                      <ToneBadge>{kinds[m.kind] || m.kind}</ToneBadge>
                      <StateBadges m={m} unreadFilter={unreadFilter} />
                    </Flex>
                  </Flex>
                </Box>
              ))}
            </CardList>
          )}
          <Pagination.Root pageCount={data.pagination.pageCount} total={data.pagination.total} defaultPageSize={25}>
            <Pagination.PageSize />
            <Pagination.Links />
          </Pagination.Root>
        </Flex>
      )}
    </SectionFrame>
  );
};
