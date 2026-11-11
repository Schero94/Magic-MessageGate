/* Layout mirrors plugin-io admin/src/components/widgets/StatsWidget.jsx (native KeyStatisticsWidget). */
import { useCallback } from 'react';
import { BaseLink, Box, Flex, Grid, Typography } from '@strapi/design-system';
import { CheckCircle, Eye, Message, WarningCircle } from '@strapi/icons';
import { useIntl } from 'react-intl';
import { Link } from 'react-router-dom';

import { useApi } from '../../hooks/useApi';
import { useLoad } from '../../hooks/useLoad';
import { useT } from '../../hooks/useT';
import { PLUGIN_ID } from '../../pluginId';
import { formatRate, rangeFor } from '../../utils/format.mjs';
import { WidgetError, WidgetLoading, WidgetNoData } from './WidgetStates';

/**
 * Homepage widget "Messages today": volume, delivery rate, read rate and
 * failures, each linking to the matching plugin view.
 *
 * @returns {JSX.Element} Widget body.
 */
const OverviewWidget = () => {
  const t = useT();
  const api = useApi();
  const { formatNumber, locale } = useIntl();
  const loader = useCallback(() => api.get('/analytics', rangeFor('today')), [api]);
  const { data, error, reload } = useLoad(loader);

  if (error && !data)
    return (
      <WidgetError
        label={t('widget.error', 'The numbers could not be loaded.')}
        retryLabel={t('common.retry', 'Try again')}
        onRetry={reload}
      />
    );
  if (!data) return <WidgetLoading label={t('widget.loading', 'Loading messages')} />;
  if (!data.totals.total) return <WidgetNoData label={t('widget.empty', 'No messages sent today.')} />;

  const base = `/plugins/${PLUGIN_ID}`;
  const rate = (value) => formatRate(value === null ? null : value / 100, locale);
  const cells = [
    {
      id: 'total',
      label: t('widget.total', 'Messages today'),
      value: formatNumber(data.totals.total, { notation: 'compact', maximumFractionDigits: 1 }),
      icon: <Message />,
      tone: 'primary',
      to: `${base}?range=today`,
    },
    {
      id: 'delivered',
      label: t('widget.delivered', 'Delivered'),
      value: rate(data.totals.deliveryRate),
      icon: <CheckCircle />,
      tone: 'success',
      to: `${base}/analytics?range=today`,
    },
    {
      id: 'read',
      label: t('widget.read', 'Read'),
      value: rate(data.totals.readRate),
      icon: <Eye />,
      tone: 'secondary',
      to: `${base}/analytics?range=today`,
    },
    {
      id: 'failed',
      label: t('widget.failed', 'Failed'),
      value: formatNumber(data.totals.failed),
      icon: <WarningCircle />,
      tone: 'danger',
      to: `${base}?range=today&status=failed`,
    },
  ];

  return (
    <Box borderColor="neutral200" borderStyle="solid" borderWidth="1px" hasRadius overflow="hidden">
      <Grid.Root gap={0}>
        {cells.map((cell, index) => (
          <Grid.Item key={cell.id} col={6} direction="column" alignItems="stretch">
            <BaseLink
              tag={Link}
              to={cell.to}
              padding={3}
              height="100%"
              borderColor="neutral200"
              borderStyle="solid"
              borderWidth={`0 ${index % 2 === 0 ? '1px' : '0'} ${index < cells.length - 2 ? '1px' : '0'} 0`}
            >
              <Flex alignItems="center" gap={2}>
                <Flex padding={2} borderRadius={1} background={`${cell.tone}100`} color={`${cell.tone}600`}>
                  {cell.icon}
                </Flex>
                <Flex direction="column" alignItems="flex-start">
                  <Typography variant="pi" fontWeight="bold" textColor="neutral600">
                    {cell.label}
                  </Typography>
                  <Typography variant="omega" fontWeight="bold" textColor="neutral800">
                    {cell.value}
                  </Typography>
                </Flex>
              </Flex>
            </BaseLink>
          </Grid.Item>
        ))}
      </Grid.Root>
    </Box>
  );
};

export { OverviewWidget };
export default OverviewWidget;
