import { useCallback, useState } from 'react';
import { Box, Button, Flex, Grid, Status, Typography } from '@strapi/design-system';
import { ArrowClockwise, Lightning, Pencil, Phone, Plus, Trash } from '@strapi/icons';
import { useNotification } from '@strapi/strapi/admin';

import { ConfirmAction } from '../../components/ui/ConfirmAction';
import { CopyField } from '../../components/ui/CopyField';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { SectionFrame } from '../../components/ui/SectionFrame';
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/States';
import { useAction } from '../../hooks/useAction';
import { useApi } from '../../hooks/useApi';
import { useLoad } from '../../hooks/useLoad';
import { useMgRBAC } from '../../hooks/useMgRBAC';
import { useReturnFocus } from '../../hooks/useReturnFocus';
import { ToneBadge } from '../../components/ui/StatusBadge';
import { useT } from '../../hooks/useT';
import { channelLabels, providerLabels } from '../../utils/channels';
import { reasonText } from '../../utils/reasons';
import { AccountWizard } from './AccountWizard';

const HEALTH_VARIANT = { ok: 'success', error: 'danger', unknown: 'neutral' };

/**
 * One connected account: provider, health, webhook URL and actions.
 *
 * @param {object} props - Props.
 * @param {object} props.account - Account DTO.
 * @param {object} props.rbac - Capabilities.
 * @param {() => void} props.onEdit - Opens the wizard in edit mode.
 * @param {() => Promise<void>} props.onChanged - Reload.
 * @returns {JSX.Element} Card.
 */
const AccountCard = ({ account, rbac, onEdit, onChanged }) => {
  const t = useT();
  const api = useApi();
  const act = useAction();
  const { toggleNotification } = useNotification();
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const channels = channelLabels(t);
  const providers = providerLabels(t);
  const health = account.health?.status || 'unknown';
  const healthLabel = {
    ok: t('accounts.health.ok', 'Connected'),
    error: t('accounts.health.error', 'Connection problem'),
    unknown: t('accounts.health.unknown', 'Not tested yet'),
  }[health];

  const test = async () => {
    setTesting(true);
    try {
      const result = await act(() => api.post(`/accounts/${account.id}/test`));
      toggleNotification(
        result?.ok
          ? { type: 'success', message: t('accounts.test.ok', 'The connection works.') }
          : {
              type: 'danger',
              message: t('accounts.test.failed', 'The provider refused the connection: {reason}', {
                reason: reasonText(t, result?.code) || result?.code || '-',
              }),
            }
      );
    } catch {
      // notified by useAction
    } finally {
      await onChanged();
      setTesting(false);
    }
  };

  const sync = async () => {
    setSyncing(true);
    try {
      const result = await act(() => api.post(`/accounts/${account.id}/sync-templates`));
      toggleNotification({
        type: 'success',
        message: t('accounts.sync.done', '{updated} template statuses updated from Meta.', {
          updated: result?.updated ?? 0,
        }),
      });
    } catch {
      // notified by useAction
    } finally {
      setSyncing(false);
    }
  };

  const remove = () =>
    act(() => api.del(`/accounts/${account.id}`), t('accounts.delete.done', 'The account was removed.')).then(
      onChanged
    );

  return (
    <Box
      tag="article"
      aria-labelledby={`account-${account.id}`}
      background="neutral0"
      hasRadius
      shadow="filterShadow"
      paddingTop={6}
      paddingBottom={6}
      paddingLeft={7}
      paddingRight={7}
      height="100%"
    >
      <Flex direction="column" alignItems="stretch" gap={4} height="100%">
        <Flex justifyContent="space-between" alignItems="flex-start" gap={3} wrap="wrap">
          <Flex direction="column" alignItems="flex-start" gap={1} minWidth={0}>
            <Typography id={`account-${account.id}`} variant="delta" tag="h2" style={{ overflowWrap: 'anywhere' }}>
              {account.name}
            </Typography>
            <Typography variant="pi" textColor="neutral600">
              {channels[account.channel]} · {providers[account.provider]}
            </Typography>
          </Flex>
          <Flex gap={2} wrap="wrap">
            {account.isDefault ? <ToneBadge tone="primary">{t('accounts.default', 'Default')}</ToneBadge> : null}
            {!account.isActive ? <ToneBadge>{t('accounts.inactive', 'Inactive')}</ToneBadge> : null}
            {account.config?.coexistence ? (
              <ToneBadge tone="secondary">{t('accounts.coexistence', 'Business App')}</ToneBadge>
            ) : null}
          </Flex>
        </Flex>

        <Status variant={HEALTH_VARIANT[health] || 'neutral'} size="S">
          <Flex direction="column" alignItems="flex-start" gap={1}>
            <Typography fontWeight="semiBold">{healthLabel}</Typography>
            {account.health?.code ? (
              <Typography variant="pi">
                {account.health.code}
                {reasonText(t, account.health.code) ? ` · ${reasonText(t, account.health.code)}` : ''}
              </Typography>
            ) : null}
            {account.health?.at ? (
              <Typography variant="pi" textColor="neutral600">
                {t('accounts.health.checked', 'Checked')} <RelativeTime value={account.health.at} />
              </Typography>
            ) : null}
          </Flex>
        </Status>

        {account.webhookUrl ? (
          <CopyField
            name={`webhook-${account.id}`}
            label={t('accounts.webhookUrl', 'Webhook URL')}
            value={account.webhookUrl}
            hint={
              account.provider === 'telegram'
                ? t('accounts.webhookUrl.telegram', 'Registered with Telegram automatically on "Test connection".')
                : t('accounts.webhookUrl.hint', 'Enter it in the provider console for delivery and read receipts.')
            }
          />
        ) : (
          <Typography variant="pi" textColor="neutral600">
            {t(
              'accounts.webhookUrl.missing',
              'No public URL configured (server.url), so no webhook URL can be shown. Delivery receipts need it.'
            )}
          </Typography>
        )}

        {rbac.accounts.manage || (rbac.templates.manage && account.provider === 'meta') ? (
          <Flex gap={2} wrap="wrap" marginTop="auto" paddingTop={2}>
            {rbac.accounts.manage ? (
              <Button variant="secondary" startIcon={<Lightning />} onClick={test} loading={testing}>
                {t('accounts.test', 'Test connection')}
              </Button>
            ) : null}
            {rbac.templates.manage && account.provider === 'meta' ? (
              <Button variant="tertiary" startIcon={<ArrowClockwise />} onClick={sync} loading={syncing}>
                {t('accounts.sync', 'Sync templates')}
              </Button>
            ) : null}
            {rbac.accounts.manage ? (
              <>
                <Button variant="tertiary" startIcon={<Pencil />} onClick={onEdit}>
                  {t('common.edit', 'Edit')}
                </Button>
                <ConfirmAction
                  label={t('common.delete', 'Delete')}
                  startIcon={<Trash />}
                  title={t('accounts.delete.title', 'Delete "{name}"?', { name: account.name })}
                  body={t(
                    'accounts.delete.body',
                    'Messages can no longer be sent with this account and its credentials are erased. Queued messages use another account of the channel or fail. This cannot be undone.'
                  )}
                  confirmLabel={t('accounts.delete.confirm', 'Delete account')}
                  onConfirm={remove}
                />
              </>
            ) : null}
          </Flex>
        ) : null}
      </Flex>
    </Box>
  );
};

/**
 * Channel accounts (WhatsApp numbers, Telegram bots, SMS providers) with a
 * guided wizard to connect new ones.
 *
 * @returns {JSX.Element} Accounts section.
 */
export const AccountsPage = () => {
  const t = useT();
  const api = useApi();
  const rbac = useMgRBAC();
  const [wizard, setWizard] = useState(null);
  const focus = useReturnFocus();
  const loader = useCallback(() => api.get('/accounts'), [api]);
  const { data, error, isLoading, reload } = useLoad(loader);

  const connect = rbac.accounts.manage ? (
    <Button
      startIcon={<Plus />}
      onClick={() => {
        focus.remember();
        setWizard({ mode: 'create' });
      }}
    >
      {t('accounts.connect', 'Connect a channel')}
    </Button>
  ) : null;

  return (
    <SectionFrame
      title={t('accounts.title', 'Accounts')}
      subtitle={t('accounts.subtitle', 'WhatsApp numbers, Telegram bots and SMS providers that send your messages.')}
      busy={isLoading}
      primaryAction={connect}
    >
      {error && !data ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !data ? (
        <LoadingState />
      ) : data.length === 0 ? (
        <EmptyState
          icon={<Phone width="6.4rem" height="6.4rem" aria-hidden />}
          content={t(
            'accounts.empty',
            'No channel connected yet. Connect WhatsApp, Telegram or SMS to start sending. It takes about two minutes.'
          )}
          action={connect}
        />
      ) : (
        <Grid.Root gap={4}>
          {data.map((account) => (
            <Grid.Item key={account.id} col={6} xs={12} direction="column" alignItems="stretch">
              <AccountCard
                account={account}
                rbac={rbac}
                onEdit={() => {
                  focus.remember();
                  setWizard({ mode: 'edit', account });
                }}
                onChanged={reload}
              />
            </Grid.Item>
          ))}
        </Grid.Root>
      )}
      {wizard ? (
        <AccountWizard
          mode={wizard.mode}
          account={wizard.account}
          hasDefault={(channel) => (data || []).some((a) => a.channel === channel && a.isDefault)}
          onClose={() => {
            setWizard(null);
            focus.restore();
          }}
          onSaved={reload}
        />
      ) : null}
    </SectionFrame>
  );
};

export default AccountsPage;
