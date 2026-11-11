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
  Tbody,
  Td,
  TextInput,
  Th,
  Thead,
  Tr,
  Typography,
  VisuallyHidden,
} from '@strapi/design-system';
import { Feather, Pencil, Plus, Search, Trash } from '@strapi/icons';
import { useQueryParams } from '@strapi/strapi/admin';
import { useNavigate } from 'react-router-dom';

import { ConfirmAction } from '../../components/ui/ConfirmAction';
import { SectionFrame } from '../../components/ui/SectionFrame';
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/States';
import { ApprovalBadge } from '../../components/ui/StatusBadge';
import { useAction } from '../../hooks/useAction';
import { useApi } from '../../hooks/useApi';
import { useLoad } from '../../hooks/useLoad';
import { useMgRBAC } from '../../hooks/useMgRBAC';
import { useT } from '../../hooks/useT';
import { PLUGIN_ID } from '../../pluginId';
import { CHANNELS, channelLabels } from '../../utils/channels';

/**
 * Template list per channel with approval status. Opening a row edits it.
 *
 * @returns {JSX.Element} Templates section.
 */
export const TemplatesPage = () => {
  const t = useT();
  const api = useApi();
  const act = useAction();
  const rbac = useMgRBAC();
  const navigate = useNavigate();
  const [{ query }, setQuery] = useQueryParams();
  const [search, setSearch] = useState(query.search || '');
  const channel = query.channel || 'all';

  const loader = useCallback(() => {
    const params = {};
    if (channel !== 'all') params.channel = channel;
    if (query.search) params.search = query.search;
    return api.get('/templates', params);
  }, [api, channel, query.search]);
  const { data, error, isLoading, reload } = useLoad(loader);
  const channels = channelLabels(t);
  const open = (id) => navigate(`/plugins/${PLUGIN_ID}/templates/${id}`);
  const filtered = channel !== 'all' || Boolean(query.search);

  const create = rbac.templates.manage ? (
    <Button startIcon={<Plus />} onClick={() => open('new')}>
      {t('templates.create', 'Create template')}
    </Button>
  ) : null;

  return (
    <SectionFrame
      title={t('templates.title', 'Templates')}
      subtitle={t(
        'templates.subtitle',
        'Reusable messages with variables. WhatsApp templates need approval by Meta before they can be sent.'
      )}
      busy={isLoading}
      primaryAction={create}
    >
      <Box background="neutral0" hasRadius shadow="filterShadow" padding={4}>
        <Grid.Root gap={4}>
          <Grid.Item col={4} s={6} xs={12} direction="column" alignItems="stretch">
            <Field.Root name="channel">
              <Field.Label>{t('templates.filter.channel', 'Channel')}</Field.Label>
              <SingleSelect
                value={channel}
                onChange={(value) => setQuery({ channel: value === 'all' ? undefined : value })}
              >
                <SingleSelectOption value="all">{t('messages.filter.allChannels', 'All channels')}</SingleSelectOption>
                {CHANNELS.map((c) => (
                  <SingleSelectOption key={c} value={c}>
                    {channels[c]}
                  </SingleSelectOption>
                ))}
              </SingleSelect>
            </Field.Root>
          </Grid.Item>
          <Grid.Item col={8} s={6} xs={12} direction="column" alignItems="stretch">
            <form
              role="search"
              style={{ width: '100%' }}
              onSubmit={(event) => {
                event.preventDefault();
                setQuery({ search: search.trim() || undefined });
              }}
            >
              <Field.Root name="search">
                <Field.Label>{t('templates.filter.search', 'Search')}</Field.Label>
                <TextInput
                  type="search"
                  value={search}
                  startAction={<Search aria-hidden />}
                  placeholder={t('templates.filter.searchPlaceholder', 'Name or key, then Enter')}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    if (!event.target.value && query.search) setQuery({ search: undefined });
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
      ) : data.length === 0 ? (
        <EmptyState
          icon={<Feather width="6.4rem" height="6.4rem" aria-hidden />}
          content={
            filtered
              ? t('templates.empty.filtered', 'No template matches these filters.')
              : t(
                  'templates.empty',
                  'No templates yet. Create one, for example an order confirmation with the variables name and order number.'
                )
          }
          action={
            filtered ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setSearch('');
                  setQuery({ channel: undefined, search: undefined });
                }}
              >
                {t('messages.empty.reset', 'Reset filters')}
              </Button>
            ) : (
              create
            )
          }
        />
      ) : (
        <Table colCount={6} rowCount={data.length + 1}>
          <Thead>
            <Tr>
              <Th>
                <Typography variant="sigma">{t('templates.col.name', 'Name')}</Typography>
              </Th>
              <Th>
                <Typography variant="sigma">{t('templates.col.channel', 'Channel')}</Typography>
              </Th>
              <Th>
                <Typography variant="sigma">{t('templates.col.language', 'Language')}</Typography>
              </Th>
              <Th>
                <Typography variant="sigma">{t('templates.col.status', 'Status')}</Typography>
              </Th>
              <Th>
                <Typography variant="sigma">{t('templates.col.version', 'Version')}</Typography>
              </Th>
              <Th>
                <VisuallyHidden>{t('common.actions', 'Actions')}</VisuallyHidden>
              </Th>
            </Tr>
          </Thead>
          <Tbody>
            {data.map((tpl) => (
              <Tr key={tpl.id} onClick={() => open(tpl.id)} style={{ cursor: 'pointer' }}>
                <Td>
                  <Flex direction="column" alignItems="flex-start">
                    <Typography fontWeight="semiBold" textColor="neutral800">
                      {tpl.name}
                    </Typography>
                    <Typography variant="pi" textColor="neutral600">
                      {tpl.key}
                    </Typography>
                  </Flex>
                </Td>
                <Td>
                  <Typography textColor="neutral800">{channels[tpl.channel]}</Typography>
                </Td>
                <Td>
                  <Typography textColor="neutral800">{tpl.language}</Typography>
                </Td>
                <Td>
                  <Flex gap={2} wrap="wrap">
                    <ApprovalBadge status={tpl.approvalStatus} />
                    {!tpl.isActive ? (
                      <Typography variant="pi" textColor="neutral600">
                        {t('templates.inactive', 'inactive')}
                      </Typography>
                    ) : null}
                  </Flex>
                </Td>
                <Td>
                  <Typography textColor="neutral800">{tpl.version}</Typography>
                </Td>
                <Td onClick={(event) => event.stopPropagation()}>
                  <Flex justifyContent="flex-end" gap={1}>
                    <IconButton
                      variant="ghost"
                      label={t('templates.edit', 'Edit {name}', { name: tpl.name })}
                      onClick={() => open(tpl.id)}
                    >
                      <Pencil />
                    </IconButton>
                    {rbac.templates.manage ? (
                      <ConfirmAction
                        label={t('common.delete', 'Delete')}
                        startIcon={<Trash />}
                        size="S"
                        triggerVariant="ghost"
                        title={t('templates.delete.title', 'Delete "{name}"?', { name: tpl.name })}
                        body={t(
                          'templates.delete.body',
                          'Code that sends this template key fails afterwards. The template stays at Meta. This cannot be undone.'
                        )}
                        confirmLabel={t('templates.delete.confirm', 'Delete template')}
                        onConfirm={() =>
                          act(
                            () => api.del(`/templates/${tpl.id}`),
                            t('templates.delete.done', 'The template was deleted.')
                          ).then(reload)
                        }
                      />
                    ) : null}
                  </Flex>
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}
    </SectionFrame>
  );
};

export default TemplatesPage;
