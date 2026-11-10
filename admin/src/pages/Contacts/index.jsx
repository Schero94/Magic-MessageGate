import { useCallback, useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Field,
  Flex,
  IconButton,
  Table,
  Tbody,
  Td,
  TextInput,
  Th,
  Thead,
  Tr,
  Typography,
  VisuallyHidden,
} from '@strapi/design-system';
import { Eye, ListSearch, Search, User } from '@strapi/icons';
import { Pagination, useQueryParams } from '@strapi/strapi/admin';

import { RelativeTime } from '../../components/ui/RelativeTime';
import { ReachabilityBadge } from '../../components/ui/StatusBadge';
import { SectionFrame } from '../../components/ui/SectionFrame';
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/States';
import { useApi } from '../../hooks/useApi';
import { useLoad } from '../../hooks/useLoad';
import { useT } from '../../hooks/useT';
import { CHANNELS, channelLabels } from '../../utils/channels';
import { lastActivityAt } from '../../utils/contacts.mjs';
import { ContactDetailModal } from './ContactDetailModal';
import { LookupModal } from './LookupModal';

/**
 * Contacts: who can be reached on which channel, consent and last activity.
 *
 * @returns {JSX.Element} Contacts section.
 */
export const ContactsPage = () => {
  const t = useT();
  const api = useApi();
  const [{ query }, setQuery] = useQueryParams({ page: 1, pageSize: 25 });
  const [phoneInput, setPhoneInput] = useState(query.phone || '');
  const [openId, setOpenId] = useState(null);
  const [lookupOpen, setLookupOpen] = useState(false);
  const page = Number(query.page) || 1;
  const pageSize = Number(query.pageSize) || 25;
  const phone = query.phone || '';

  const loader = useCallback(
    () => api.get('/contacts', { page, pageSize, ...(phone ? { phone } : {}) }),
    [api, page, pageSize, phone]
  );
  const { data, error, isLoading, reload } = useLoad(loader);
  const channels = channelLabels(t);
  const results = data?.results || [];

  const lookupButton = (
    <Button startIcon={<ListSearch />} onClick={() => setLookupOpen(true)}>
      {t('contacts.lookup', 'Check a number')}
    </Button>
  );

  return (
    <SectionFrame
      title={t('contacts.title', 'Contacts')}
      subtitle={t(
        'contacts.subtitle',
        'Phone numbers MessageGate knows, with consent per channel and whether they are on WhatsApp.'
      )}
      busy={isLoading}
      primaryAction={lookupButton}
    >
      <Box background="neutral0" hasRadius shadow="filterShadow" padding={4}>
        <form
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery({ phone: phoneInput.trim() || undefined, page: 1 });
          }}
        >
          <Field.Root
            name="phone"
            hint={t('contacts.search.hint', 'Numbers are stored encrypted, so search needs the full number.')}
          >
            <Field.Label>{t('contacts.search', 'Find by phone number')}</Field.Label>
            <TextInput
              type="search"
              value={phoneInput}
              startAction={<Search aria-hidden />}
              placeholder={t('messages.filter.phonePlaceholder', '+49 151 …, then Enter')}
              onChange={(event) => {
                setPhoneInput(event.target.value);
                if (!event.target.value && phone) setQuery({ phone: undefined, page: 1 });
              }}
            />
            <Field.Hint />
          </Field.Root>
        </form>
      </Box>

      {error && !data ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !data ? (
        <LoadingState />
      ) : results.length === 0 ? (
        <EmptyState
          icon={<User width="6.4rem" height="6.4rem" aria-hidden />}
          content={
            phone
              ? t('contacts.empty.search', 'No contact has this number. Check it to see whether it can be reached.')
              : t(
                  'contacts.empty',
                  'No contacts yet. They are created on the first message, by consent from your app, or when you check a number.'
                )
          }
          action={lookupButton}
        />
      ) : (
        <Flex direction="column" alignItems="stretch" gap={4}>
          <Table colCount={5} rowCount={results.length + 1}>
            <Thead>
              <Tr>
                <Th>
                  <Typography variant="sigma">{t('contacts.col.phone', 'Phone number')}</Typography>
                </Th>
                <Th>
                  <Typography variant="sigma">{t('contacts.col.reach', 'Reachability')}</Typography>
                </Th>
                <Th>
                  <Typography variant="sigma">{t('contacts.col.consent', 'Consent')}</Typography>
                </Th>
                <Th>
                  <Typography variant="sigma">{t('contacts.col.activity', 'Last activity')}</Typography>
                </Th>
                <Th>
                  <VisuallyHidden>{t('common.actions', 'Actions')}</VisuallyHidden>
                </Th>
              </Tr>
            </Thead>
            <Tbody>
              {results.map((c) => {
                const last = lastActivityAt(c);
                const granted = CHANNELS.filter((ch) => c.consent?.[ch]?.status === 'granted');
                return (
                  <Tr key={c.id} onClick={() => setOpenId(c.id)} style={{ cursor: 'pointer' }}>
                    <Td>
                      <Typography fontWeight="semiBold" textColor="neutral800">
                        {c.phoneMasked || t('contacts.unreadable', 'Unreadable')}
                      </Typography>
                    </Td>
                    <Td>
                      <Flex gap={2} wrap="wrap">
                        <ReachabilityBadge value={c.whatsapp?.reachability} />
                        {c.telegramLinked ? <Badge variant="secondary">{channels.telegram}</Badge> : null}
                      </Flex>
                    </Td>
                    <Td>
                      <Typography textColor={granted.length ? 'neutral800' : 'neutral600'}>
                        {granted.length
                          ? granted.map((ch) => channels[ch]).join(', ')
                          : t('contacts.consent.none', 'None')}
                      </Typography>
                    </Td>
                    <Td>
                      <Typography textColor="neutral800">
                        {last ? <RelativeTime value={last} /> : t('contacts.activity.none', 'No activity yet')}
                      </Typography>
                    </Td>
                    <Td onClick={(event) => event.stopPropagation()}>
                      <Flex justifyContent="flex-end">
                        <IconButton
                          label={t('contacts.open', 'Open contact')}
                          variant="ghost"
                          onClick={() => setOpenId(c.id)}
                        >
                          <Eye />
                        </IconButton>
                      </Flex>
                    </Td>
                  </Tr>
                );
              })}
            </Tbody>
          </Table>
          <Pagination.Root pageCount={data.pagination.pageCount} total={data.pagination.total} defaultPageSize={25}>
            <Pagination.PageSize />
            <Pagination.Links />
          </Pagination.Root>
        </Flex>
      )}

      {openId ? <ContactDetailModal id={openId} onClose={() => setOpenId(null)} onChanged={reload} /> : null}
      {lookupOpen ? (
        <LookupModal
          onClose={() => setLookupOpen(false)}
          onOpenContact={(id) => {
            setLookupOpen(false);
            setOpenId(id);
          }}
          onChanged={reload}
        />
      ) : null}
    </SectionFrame>
  );
};

export default ContactsPage;
