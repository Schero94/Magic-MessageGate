import { useCallback, useState } from 'react';
import {
  Box,
  Button,
  Field,
  Flex,
  Grid,
  IconButton,
  SingleSelect,
  SingleSelectOption,
  Table,
  TextInput,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
  Typography,
  VisuallyHidden,
} from '@strapi/design-system';
import { ArrowClockwise, Eye, Message, PaperPlane, Search } from '@strapi/icons';
import { Pagination, useQueryParams } from '@strapi/strapi/admin';

import { RelativeTime } from '../../components/ui/RelativeTime';
import { SectionFrame } from '../../components/ui/SectionFrame';
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/States';
import { MessageStatusBadge } from '../../components/ui/StatusBadge';
import { useApi } from '../../hooks/useApi';
import { useLoad } from '../../hooks/useLoad';
import { useMgRBAC } from '../../hooks/useMgRBAC';
import { useT } from '../../hooks/useT';
import { CHANNELS, MESSAGE_STATUSES, channelLabels, statusLabels } from '../../utils/channels';
import { rangeFor } from '../../utils/format.mjs';
import { MessageDetailModal } from './MessageDetailModal';
import { SendMessageModal } from './SendMessageModal';

const RANGES = ['today', '7d', '30d', 'all'];

/**
 * Outbox: every message with status, filters and a detail view with the
 * delivery timeline and recovery actions.
 *
 * @returns {JSX.Element} Messages section.
 */
export const MessagesPage = () => {
  const t = useT();
  const api = useApi();
  const rbac = useMgRBAC();
  const [{ query }, setQuery] = useQueryParams({ page: 1, pageSize: 25 });
  const [phoneInput, setPhoneInput] = useState(query.phone || '');
  const [openId, setOpenId] = useState(null);
  const [sendOpen, setSendOpen] = useState(false);

  const status = query.status || 'all';
  const channel = query.channel || 'all';
  const range = query.range || '30d';
  const page = Number(query.page) || 1;
  const pageSize = Number(query.pageSize) || 25;
  const phone = query.phone || '';

  const loader = useCallback(() => {
    const params = { page, pageSize };
    if (status !== 'all') params.status = status;
    if (channel !== 'all') params.channel = channel;
    if (phone) params.phone = phone;
    if (range !== 'all') params.from = rangeFor(range).from;
    return api.get('/messages', params);
  }, [api, page, pageSize, status, channel, range, phone]);
  const { data, error, isLoading, reload } = useLoad(loader);

  const setFilter = (key, value) => setQuery({ [key]: value === 'all' ? undefined : value, page: 1 });
  const channels = channelLabels(t);
  const statuses = statusLabels(t);
  const rangeLabels = {
    today: t('range.today', 'Today'),
    '7d': t('range.7d', 'Last 7 days'),
    '30d': t('range.30d', 'Last 30 days'),
    all: t('range.all', 'All time'),
  };
  const results = data?.results || [];
  const filtered = status !== 'all' || channel !== 'all' || Boolean(phone) || range !== '30d';

  return (
    <SectionFrame
      title={t('messages.title', 'Messages')}
      subtitle={t('messages.subtitle', 'Every message with its delivery status. Open one to see the timeline.')}
      busy={isLoading}
      primaryAction={
        rbac.messages.send ? (
          <Button startIcon={<PaperPlane />} onClick={() => setSendOpen(true)}>
            {t('messages.send', 'Send message')}
          </Button>
        ) : null
      }
      secondaryAction={
        <Button variant="tertiary" startIcon={<ArrowClockwise />} onClick={reload} loading={isLoading}>
          {t('common.refresh', 'Refresh')}
        </Button>
      }
    >
      <Box background="neutral0" hasRadius shadow="filterShadow" padding={4}>
        <Grid.Root gap={4}>
          <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
            <Field.Root name="status">
              <Field.Label>{t('messages.filter.status', 'Status')}</Field.Label>
              <SingleSelect value={status} onChange={(value) => setFilter('status', value)}>
                <SingleSelectOption value="all">{t('messages.filter.allStatuses', 'All statuses')}</SingleSelectOption>
                {MESSAGE_STATUSES.map((s) => (
                  <SingleSelectOption key={s} value={s}>
                    {statuses[s]}
                  </SingleSelectOption>
                ))}
              </SingleSelect>
            </Field.Root>
          </Grid.Item>
          <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
            <Field.Root name="channel">
              <Field.Label>{t('messages.filter.channel', 'Channel')}</Field.Label>
              <SingleSelect value={channel} onChange={(value) => setFilter('channel', value)}>
                <SingleSelectOption value="all">{t('messages.filter.allChannels', 'All channels')}</SingleSelectOption>
                {CHANNELS.map((c) => (
                  <SingleSelectOption key={c} value={c}>
                    {channels[c]}
                  </SingleSelectOption>
                ))}
              </SingleSelect>
            </Field.Root>
          </Grid.Item>
          <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
            <Field.Root name="range">
              <Field.Label>{t('messages.filter.range', 'Created')}</Field.Label>
              <SingleSelect value={range} onChange={(value) => setQuery({ range: value, page: 1 })}>
                {RANGES.map((r) => (
                  <SingleSelectOption key={r} value={r}>
                    {rangeLabels[r]}
                  </SingleSelectOption>
                ))}
              </SingleSelect>
            </Field.Root>
          </Grid.Item>
          <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
            <form
              role="search"
              style={{ width: '100%' }}
              onSubmit={(event) => {
                event.preventDefault();
                setFilter('phone', phoneInput.trim() || 'all');
              }}
            >
              <Field.Root name="phone">
                <Field.Label>{t('messages.filter.phone', 'Phone number')}</Field.Label>
                <TextInput
                  type="search"
                  value={phoneInput}
                  startAction={<Search aria-hidden />}
                  placeholder={t('messages.filter.phonePlaceholder', '+49 151 …, then Enter')}
                  onChange={(event) => {
                    setPhoneInput(event.target.value);
                    if (!event.target.value && phone) setFilter('phone', 'all');
                  }}
                />
              </Field.Root>
            </form>
          </Grid.Item>
        </Grid.Root>
      </Box>

      {error && !data ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !data ? (
        <LoadingState />
      ) : results.length === 0 ? (
        <EmptyState
          icon={<Message width="6.4rem" height="6.4rem" aria-hidden />}
          content={
            filtered
              ? t('messages.empty.filtered', 'No message matches these filters.')
              : t(
                  'messages.empty',
                  'No messages yet. Send a test message, or send from your code with strapi.plugin("magic-messagegate").service("messages").send().'
                )
          }
          action={
            filtered ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setPhoneInput('');
                  setQuery({ page: 1, status: undefined, channel: undefined, phone: undefined, range: undefined });
                }}
              >
                {t('messages.empty.reset', 'Reset filters')}
              </Button>
            ) : rbac.messages.send ? (
              <Button startIcon={<PaperPlane />} onClick={() => setSendOpen(true)}>
                {t('messages.sendTest', 'Send a test message')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Flex direction="column" alignItems="stretch" gap={4}>
          <Table colCount={6} rowCount={results.length + 1}>
            <Thead>
              <Tr>
                <Th>
                  <Typography variant="sigma">{t('messages.col.recipient', 'Recipient')}</Typography>
                </Th>
                <Th>
                  <Typography variant="sigma">{t('messages.col.channel', 'Channel')}</Typography>
                </Th>
                <Th>
                  <Typography variant="sigma">{t('messages.col.template', 'Template')}</Typography>
                </Th>
                <Th>
                  <Typography variant="sigma">{t('messages.col.status', 'Status')}</Typography>
                </Th>
                <Th>
                  <Typography variant="sigma">{t('messages.col.created', 'Created')}</Typography>
                </Th>
                <Th>
                  <VisuallyHidden>{t('common.actions', 'Actions')}</VisuallyHidden>
                </Th>
              </Tr>
            </Thead>
            <Tbody>
              {results.map((m) => (
                <Tr key={m.id} onClick={() => setOpenId(m.id)} style={{ cursor: 'pointer' }}>
                  <Td>
                    <Typography textColor="neutral800" fontWeight="semiBold">
                      {m.recipient?.phoneMasked || t('messages.erased', 'Erased contact')}
                    </Typography>
                  </Td>
                  <Td>
                    <Typography textColor="neutral800">
                      {channels[m.channel] || m.channel}
                      {m.fallbackOf ? ` · ${t('messages.fallback', 'fallback')}` : ''}
                    </Typography>
                  </Td>
                  <Td>
                    <Typography textColor="neutral800">
                      {m.templateKey || t('messages.freeText', 'Free text')}
                    </Typography>
                  </Td>
                  <Td>
                    <Flex gap={2} wrap="wrap">
                      <MessageStatusBadge status={m.status} />
                      {m.errorCode ? (
                        <Typography variant="pi" textColor="neutral600">
                          {m.errorCode}
                        </Typography>
                      ) : null}
                    </Flex>
                  </Td>
                  <Td>
                    <Typography textColor="neutral800">
                      <RelativeTime value={m.createdAt} />
                    </Typography>
                  </Td>
                  <Td onClick={(event) => event.stopPropagation()}>
                    <Flex justifyContent="flex-end">
                      <IconButton
                        label={t('messages.open', 'Open details')}
                        variant="ghost"
                        onClick={() => setOpenId(m.id)}
                      >
                        <Eye />
                      </IconButton>
                    </Flex>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
          <Pagination.Root pageCount={data.pagination.pageCount} total={data.pagination.total} defaultPageSize={25}>
            <Pagination.PageSize />
            <Pagination.Links />
          </Pagination.Root>
        </Flex>
      )}

      {openId ? <MessageDetailModal id={openId} onClose={() => setOpenId(null)} onChanged={reload} /> : null}
      {sendOpen ? <SendMessageModal onClose={() => setSendOpen(false)} onSent={reload} /> : null}
    </SectionFrame>
  );
};

export default MessagesPage;
