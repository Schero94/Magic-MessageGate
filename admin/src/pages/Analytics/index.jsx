import { useCallback } from 'react';
import {
  Box,
  Field,
  Flex,
  Grid,
  ProgressBar,
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
import { ChartPie } from '@strapi/icons';
import { useQueryParams } from '@strapi/strapi/admin';
import { useIntl } from 'react-intl';

import { SectionCard } from '../../components/ui/SectionCard';
import { SectionFrame } from '../../components/ui/SectionFrame';
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/States';
import { useApi } from '../../hooks/useApi';
import { useLoad } from '../../hooks/useLoad';
import { useT } from '../../hooks/useT';
import { channelLabels } from '../../utils/channels';
import { formatRate, rangeFor } from '../../utils/format.mjs';
import { reasonText } from '../../utils/reasons';

const RANGES = ['today', '7d', '30d', '90d'];

/**
 * KPI tile.
 *
 * @param {{ label: string, value: string, note?: string }} props - Props.
 * @returns {JSX.Element} Tile.
 */
const Kpi = ({ label, value, note }) => (
  <Box background="neutral0" hasRadius shadow="filterShadow" padding={5} height="100%">
    <Flex direction="column" alignItems="flex-start" gap={1}>
      <Typography variant="sigma" textColor="neutral600" tag="h2">
        {label}
      </Typography>
      <Typography variant="alpha" tag="p" textColor="neutral800">
        {value}
      </Typography>
      {note ? (
        <Typography variant="pi" textColor="neutral600">
          {note}
        </Typography>
      ) : null}
    </Flex>
  </Box>
);

/**
 * Rate cell with a bar.
 *
 * @param {{ rate: number | null, label: string, locale: string }} props - Rate in percent.
 * @returns {JSX.Element} Cell content.
 */
const Rate = ({ rate, label, locale }) => (
  <Flex direction="column" alignItems="stretch" gap={1} minWidth="9rem">
    <Typography textColor="neutral800">{formatRate(rate === null ? null : rate / 100, locale)}</Typography>
    {rate !== null ? (
      <ProgressBar value={rate} size="S">
        {label}
      </ProgressBar>
    ) : null}
  </Flex>
);

/**
 * Delivery and read rates per channel and template, failures with reasons,
 * fallback usage and WhatsApp pricing categories.
 *
 * @returns {JSX.Element} Analytics section.
 */
export const AnalyticsPage = () => {
  const t = useT();
  const api = useApi();
  const { locale, formatNumber } = useIntl();
  const [{ query }, setQuery] = useQueryParams();
  const range = RANGES.includes(query.range) ? query.range : '30d';
  const loader = useCallback(() => api.get('/analytics', rangeFor(range)), [api, range]);
  const { data, error, isLoading, reload } = useLoad(loader);
  const channels = channelLabels(t);
  const rangeLabels = {
    today: t('range.today', 'Today'),
    '7d': t('range.7d', 'Last 7 days'),
    '30d': t('range.30d', 'Last 30 days'),
    '90d': t('range.90d', 'Last 90 days'),
  };
  const totals = data?.totals;

  const rateHeaders = (
    <>
      <Th>
        <Typography variant="sigma">{t('analytics.col.total', 'Messages')}</Typography>
      </Th>
      <Th>
        <Typography variant="sigma">{t('analytics.col.delivery', 'Delivered')}</Typography>
      </Th>
      <Th>
        <Typography variant="sigma">{t('analytics.col.read', 'Read')}</Typography>
      </Th>
      <Th>
        <Typography variant="sigma">{t('analytics.col.failed', 'Failed')}</Typography>
      </Th>
    </>
  );
  const rateCells = (row, name) => (
    <>
      <Td>
        <Typography textColor="neutral800">{formatNumber(row.total)}</Typography>
      </Td>
      <Td>
        <Rate
          rate={row.deliveryRate}
          locale={locale}
          label={t('analytics.deliveryOf', 'Delivery rate of {name}', { name })}
        />
      </Td>
      <Td>
        <Rate rate={row.readRate} locale={locale} label={t('analytics.readOf', 'Read rate of {name}', { name })} />
      </Td>
      <Td>
        <Typography textColor={row.failed ? 'danger600' : 'neutral800'}>{formatNumber(row.failed)}</Typography>
      </Td>
    </>
  );

  return (
    <SectionFrame
      title={t('analytics.title', 'Analytics')}
      subtitle={t('analytics.subtitle', 'How many messages arrive and are read, per channel and template.')}
      busy={isLoading}
    >
      <Box background="neutral0" hasRadius shadow="filterShadow" padding={4}>
        <Grid.Root gap={4}>
          <Grid.Item col={4} s={6} xs={12} direction="column" alignItems="stretch">
            <Field.Root name="range">
              <Field.Label>{t('analytics.range', 'Period')}</Field.Label>
              <SingleSelect value={range} onChange={(value) => setQuery({ range: value })}>
                {RANGES.map((r) => (
                  <SingleSelectOption key={r} value={r}>
                    {rangeLabels[r]}
                  </SingleSelectOption>
                ))}
              </SingleSelect>
            </Field.Root>
          </Grid.Item>
        </Grid.Root>
      </Box>
      {error && !data ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !data ? (
        <LoadingState />
      ) : !totals.total ? (
        <EmptyState
          icon={<ChartPie width="6.4rem" height="6.4rem" aria-hidden />}
          content={t('analytics.empty', 'No messages in this period. Numbers appear after the first send.')}
        />
      ) : (
        <>
          <Grid.Root gap={4}>
            <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
              <Kpi
                label={t('analytics.kpi.total', 'Messages')}
                value={formatNumber(totals.total)}
                note={t('analytics.kpi.sent', '{sent} accepted by providers', { sent: formatNumber(totals.sent) })}
              />
            </Grid.Item>
            <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
              <Kpi
                label={t('analytics.kpi.delivery', 'Delivery rate')}
                value={formatRate(totals.deliveryRate === null ? null : totals.deliveryRate / 100, locale)}
                note={t('analytics.kpi.deliveryNote', 'Delivered of accepted')}
              />
            </Grid.Item>
            <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
              <Kpi
                label={t('analytics.kpi.read', 'Read rate')}
                value={formatRate(totals.readRate === null ? null : totals.readRate / 100, locale)}
                note={t('analytics.kpi.readNote', 'At least; not every recipient sends read receipts')}
              />
            </Grid.Item>
            <Grid.Item col={3} s={6} xs={12} direction="column" alignItems="stretch">
              <Kpi
                label={t('analytics.kpi.fallbacks', 'Fallbacks')}
                value={formatNumber(data.fallbacks?.total ?? 0)}
                note={t('analytics.kpi.failed', '{failed} failed, {queued} waiting', {
                  failed: formatNumber(totals.failed),
                  queued: formatNumber((data.queue?.queued ?? 0) + (data.queue?.uncertain ?? 0)),
                })}
              />
            </Grid.Item>
          </Grid.Root>

          <SectionCard title={t('analytics.byChannel', 'By channel')}>
            <Table colCount={5} rowCount={data.byChannel.length + 1}>
              <Thead>
                <Tr>
                  <Th>
                    <Typography variant="sigma">{t('analytics.col.channel', 'Channel')}</Typography>
                  </Th>
                  {rateHeaders}
                </Tr>
              </Thead>
              <Tbody>
                {data.byChannel.map((row) => (
                  <Tr key={row.channel}>
                    <Td>
                      <Flex direction="column" alignItems="flex-start">
                        <Typography fontWeight="semiBold" textColor="neutral800">
                          {channels[row.channel] || row.channel}
                        </Typography>
                        {data.fallbacks?.byChannel?.[row.channel] ? (
                          <Typography variant="pi" textColor="neutral600">
                            {t('analytics.fallbackCount', '{count} as fallback', {
                              count: formatNumber(data.fallbacks.byChannel[row.channel]),
                            })}
                          </Typography>
                        ) : null}
                      </Flex>
                    </Td>
                    {rateCells(row, channels[row.channel] || row.channel)}
                  </Tr>
                ))}
              </Tbody>
            </Table>
          </SectionCard>

          {data.byTemplate.length ? (
            <SectionCard title={t('analytics.byTemplate', 'By template')}>
              <Table colCount={5} rowCount={data.byTemplate.length + 1}>
                <Thead>
                  <Tr>
                    <Th>
                      <Typography variant="sigma">{t('analytics.col.template', 'Template')}</Typography>
                    </Th>
                    {rateHeaders}
                  </Tr>
                </Thead>
                <Tbody>
                  {data.byTemplate.map((row) => (
                    <Tr key={row.template_key}>
                      <Td>
                        <Typography fontWeight="semiBold" textColor="neutral800">
                          {row.template_key}
                        </Typography>
                      </Td>
                      {rateCells(row, row.template_key)}
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </SectionCard>
          ) : null}

          <Grid.Root gap={4}>
            <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
              <SectionCard title={t('analytics.failures', 'Most common failures')} fill>
                {data.failures.length ? (
                  <Flex tag="ol" direction="column" alignItems="stretch" gap={3}>
                    {data.failures.map((f) => (
                      <Flex tag="li" key={f.code} justifyContent="space-between" gap={3} alignItems="flex-start">
                        <Flex direction="column" alignItems="flex-start" minWidth={0}>
                          <Typography fontWeight="semiBold">{f.code}</Typography>
                          {reasonText(t, f.code) ? (
                            <Typography variant="pi" textColor="neutral600">
                              {reasonText(t, f.code)}
                            </Typography>
                          ) : null}
                        </Flex>
                        <Typography fontWeight="semiBold">{formatNumber(f.total)}</Typography>
                      </Flex>
                    ))}
                  </Flex>
                ) : (
                  <Typography textColor="neutral600">
                    {t('analytics.failures.none', 'No failures in this period.')}
                  </Typography>
                )}
              </SectionCard>
            </Grid.Item>
            <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
              <SectionCard
                title={t('analytics.costs', 'WhatsApp pricing categories')}
                subtitle={t(
                  'analytics.costs.subtitle',
                  'Meta bills per delivered template message by category. See your Meta invoice for prices.'
                )}
                fill
              >
                {Object.keys(data.costCategories || {}).length ? (
                  <Flex tag="ul" direction="column" alignItems="stretch" gap={3}>
                    {Object.entries(data.costCategories).map(([category, total]) => (
                      <Flex tag="li" key={category} justifyContent="space-between" gap={3}>
                        <Typography>
                          {{
                            marketing: t('editor.category.MARKETING', 'Marketing'),
                            utility: t('editor.category.UTILITY', 'Utility'),
                            authentication: t('editor.category.AUTHENTICATION', 'Authentication'),
                            service: t('analytics.costs.service', 'Service (free)'),
                          }[String(category).toLowerCase()] || category}
                        </Typography>
                        <Typography fontWeight="semiBold">{formatNumber(total)}</Typography>
                      </Flex>
                    ))}
                  </Flex>
                ) : (
                  <Typography textColor="neutral600">
                    {t('analytics.costs.none', 'No billable WhatsApp messages reported in this period.')}
                  </Typography>
                )}
              </SectionCard>
            </Grid.Item>
          </Grid.Root>
        </>
      )}
    </SectionFrame>
  );
};

export default AnalyticsPage;
