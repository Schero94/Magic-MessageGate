import { useCallback, useState } from 'react';
import { Box, Button, Checkbox, Dialog, Flex, Grid, Modal, Typography } from '@strapi/design-system';
import { ArrowClockwise, Check, CheckCircle, Cross, Trash } from '@strapi/icons';
import { ConfirmDialog } from '@strapi/strapi/admin';

import { ConfirmAction } from '../../components/ui/ConfirmAction';
import { Notice } from '../../components/ui/Notice';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { ErrorState, LoadingState } from '../../components/ui/States';
import { MessageStatusBadge, ToneBadge } from '../../components/ui/StatusBadge';
import { useAction } from '../../hooks/useAction';
import { useApi } from '../../hooks/useApi';
import { useLoad } from '../../hooks/useLoad';
import { useMgRBAC } from '../../hooks/useMgRBAC';
import { useT } from '../../hooks/useT';
import { STATUS_VARIANT, channelLabels, eventLabels } from '../../utils/channels';
import { messageActions, progressSteps } from '../../utils/messages.mjs';
import { reasonText } from '../../utils/reasons';

const EVENT_VARIANT = {
  ...STATUS_VARIANT,
  'retry-scheduled': 'warning',
  'retry-requested': 'secondary',
  'marked-sent': 'primary',
};

/**
 * Label and value pair in the detail grid.
 *
 * @param {{ label: string, children: import('react').ReactNode }} props - Props.
 * @returns {JSX.Element} Fact.
 */
const Fact = ({ label, children }) => (
  <Flex direction="column" alignItems="flex-start" gap={1}>
    <Typography variant="sigma" textColor="neutral600" tag="dt">
      {label}
    </Typography>
    <Typography textColor="neutral800" tag="dd">
      {children}
    </Typography>
  </Flex>
);

/**
 * Retry with the duplicate-risk confirmation for uncertain messages: the
 * confirm button stays disabled until the risk is acknowledged.
 *
 * @param {{ needsConfirm: boolean, onRetry: (confirm: boolean) => Promise<void> }} props - Props.
 * @returns {JSX.Element} Retry action.
 */
const RetryAction = ({ needsConfirm, onRetry }) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await onRetry(needsConfirm);
      setOpen(false);
    } catch {
      // notified by useAction
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        setOpen(next);
        setAck(false);
      }}
    >
      <Dialog.Trigger>
        <Button variant="secondary" startIcon={<ArrowClockwise />}>
          {t('message.retry', 'Retry')}
        </Button>
      </Dialog.Trigger>
      <ConfirmDialog
        title={t('message.retry.title', 'Send this message again?')}
        variant={needsConfirm ? 'danger' : 'default'}
        endAction={
          <Button
            fullWidth
            variant={needsConfirm ? 'danger' : 'default'}
            onClick={run}
            loading={busy}
            disabled={needsConfirm && !ack}
          >
            {t('message.retry.confirm', 'Retry')}
          </Button>
        }
      >
        <Flex direction="column" alignItems="stretch" gap={4}>
          <Typography>
            {needsConfirm
              ? t(
                  'message.retry.uncertainBody',
                  'The provider did not confirm the first attempt. If it went through, the contact gets the message twice.'
                )
              : t('message.retry.body', 'MessageGate queues the message again with a fresh retry budget.')}
          </Typography>
          {needsConfirm ? (
            <Checkbox checked={ack} onCheckedChange={(value) => setAck(value === true)}>
              {t('message.retry.ack', 'I accept that the contact may get it twice')}
            </Checkbox>
          ) : null}
        </Flex>
      </ConfirmDialog>
    </Dialog.Root>
  );
};

/**
 * Message detail: recipient, routing, progress (sent, delivered, read),
 * the full event timeline with reason codes, fallbacks, and the recovery
 * actions the current status allows.
 *
 * @param {{ id: string, onClose: () => void, onChanged: () => void }} props - Props.
 * @returns {JSX.Element} Modal.
 */
export const MessageDetailModal = ({ id, onClose, onChanged }) => {
  const t = useT();
  const api = useApi();
  const act = useAction();
  const rbac = useMgRBAC();
  const loader = useCallback(() => api.get(`/messages/${id}`), [api, id]);
  const { data: m, error, reload } = useLoad(loader);
  const channels = channelLabels(t);
  const events = eventLabels(t);

  const after = async () => {
    await reload();
    onChanged();
  };
  const retry = (confirmDuplicateRisk) =>
    act(
      () => api.post(`/messages/${id}/retry`, { confirmDuplicateRisk }),
      t('message.retry.done', 'The message is queued again.')
    ).then(after, async (err) => {
      await after();
      throw err;
    });
  const discard = () =>
    act(() => api.post(`/messages/${id}/discard`), t('message.discard.done', 'The message was discarded.')).then(
      after,
      async (err) => {
        await after();
        throw err;
      }
    );
  const markSent = () =>
    act(() => api.post(`/messages/${id}/mark-sent`), t('message.markSent.done', 'The message is marked as sent.')).then(
      after,
      async (err) => {
        await after();
        throw err;
      }
    );

  const allowed = m ? messageActions(m) : null;
  const canManage = rbac.messages.manage;
  const stepLabels = {
    sent: t('message.step.sent', 'Sent'),
    delivered: t('message.step.delivered', 'Delivered'),
    read: t('message.step.read', 'Read'),
  };
  const reason = m ? reasonText(t, m.errorCode) : null;

  return (
    <Modal.Root open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content>
        <Modal.Header>
          <Modal.Title>{t('message.title', 'Message details')}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {error && !m ? (
            <ErrorState error={error} onRetry={reload} />
          ) : !m ? (
            <LoadingState />
          ) : (
            <Flex direction="column" alignItems="stretch" gap={6}>
              <Flex gap={2} wrap="wrap" alignItems="center">
                <MessageStatusBadge status={m.status} />
                <Typography variant="omega" textColor="neutral600">
                  {channels[m.channel] || m.channel} · {m.templateKey || t('messages.freeText', 'Free text')}
                </Typography>
              </Flex>

              {m.errorCode ? (
                <Notice variant={m.status === 'failed' ? 'danger' : 'warning'} title={m.errorCode}>
                  {reason || t('message.reasonUnknown', 'The provider gave no further explanation.')}
                </Notice>
              ) : null}

              <Box tag="ol" aria-label={t('message.progress', 'Delivery progress')}>
                <Grid.Root gap={2}>
                  {progressSteps(m).map((step) => (
                    <Grid.Item key={step.key} col={4} xs={12} tag="li">
                      <Flex
                        gap={2}
                        padding={3}
                        hasRadius
                        width="100%"
                        background={step.done ? 'success100' : 'neutral100'}
                        borderColor={step.done ? 'success200' : 'neutral200'}
                      >
                        {step.done ? (
                          <CheckCircle fill="success600" aria-hidden />
                        ) : (
                          <Cross fill="neutral500" aria-hidden />
                        )}
                        <Flex direction="column" alignItems="flex-start">
                          <Typography fontWeight="semiBold" textColor={step.done ? 'success700' : 'neutral700'}>
                            {stepLabels[step.key]}
                          </Typography>
                          <Typography variant="pi" textColor="neutral600">
                            {step.at ? <RelativeTime value={step.at} /> : t('message.step.pending', 'Not yet')}
                          </Typography>
                        </Flex>
                      </Flex>
                    </Grid.Item>
                  ))}
                </Grid.Root>
              </Box>
              {m.channel === 'whatsapp' && m.deliveredAt && !m.readAt ? (
                <Typography variant="pi" textColor="neutral600">
                  {t(
                    'message.readHint',
                    'WhatsApp reports "read" only when the recipient has read receipts switched on.'
                  )}
                </Typography>
              ) : null}

              <Box tag="dl">
                <Grid.Root gap={4}>
                  <Grid.Item col={6} xs={12}>
                    <Fact label={t('message.recipient', 'Recipient')}>
                      {m.recipient?.phoneMasked || t('messages.erased', 'Erased contact')}
                    </Fact>
                  </Grid.Item>
                  <Grid.Item col={6} xs={12}>
                    <Fact label={t('message.created', 'Created')}>
                      <RelativeTime value={m.createdAt} />
                    </Fact>
                  </Grid.Item>
                  <Grid.Item col={6} xs={12}>
                    <Fact label={t('message.attempts', 'Attempts')}>
                      {t('message.attemptsValue', '{attempts} of {max}', { attempts: m.attempts, max: m.maxAttempts })}
                    </Fact>
                  </Grid.Item>
                  <Grid.Item col={6} xs={12}>
                    <Fact label={t('message.deadline', 'Deadline')}>
                      <RelativeTime value={m.notAfter} />
                    </Fact>
                  </Grid.Item>
                  <Grid.Item col={6} xs={12}>
                    <Fact label={t('message.type', 'Type')}>
                      {m.transactional
                        ? t('message.transactional', 'Transactional')
                        : t('message.notTransactional', 'Notification')}
                    </Fact>
                  </Grid.Item>
                  <Grid.Item col={6} xs={12}>
                    <Fact label={t('message.source', 'Source')}>{m.source}</Fact>
                  </Grid.Item>
                </Grid.Root>
              </Box>

              <Flex direction="column" alignItems="stretch" gap={3}>
                <Typography variant="delta" tag="h3">
                  {t('message.timeline', 'Timeline')}
                </Typography>
                <Flex tag="ol" direction="column" alignItems="stretch" gap={2}>
                  {m.timeline.map((event, index) => (
                    <Flex
                      tag="li"
                      key={`${event.type}-${event.at}-${index}`}
                      gap={3}
                      wrap="wrap"
                      alignItems="center"
                      paddingBottom={2}
                      borderStyle="none none solid none"
                      borderWidth="1px"
                      borderColor="neutral150"
                    >
                      <ToneBadge tone={EVENT_VARIANT[event.type] || 'neutral'}>
                        {events[event.type] || event.type}
                      </ToneBadge>
                      {event.code ? (
                        <Typography variant="pi" textColor="neutral700">
                          {event.code}
                          {reasonText(t, event.code) ? ` · ${reasonText(t, event.code)}` : ''}
                        </Typography>
                      ) : null}
                      <Box marginLeft="auto">
                        <Typography variant="pi" textColor="neutral600">
                          <RelativeTime value={event.at} />
                        </Typography>
                      </Box>
                    </Flex>
                  ))}
                </Flex>
              </Flex>

              {m.fallbacks?.length ? (
                <Flex direction="column" alignItems="stretch" gap={2}>
                  <Typography variant="delta" tag="h3">
                    {t('message.fallbacks', 'Fallback messages')}
                  </Typography>
                  {m.fallbacks.map((f) => (
                    <Flex key={f.id} gap={2}>
                      <Typography>{channels[f.channel] || f.channel}</Typography>
                      <MessageStatusBadge status={f.status} />
                    </Flex>
                  ))}
                </Flex>
              ) : null}

              {allowed?.retryBlockedBy === 'payload' ? (
                <Typography variant="pi" textColor="neutral600">
                  {t(
                    'message.payloadGone',
                    'The content of this message was already removed (retention or erasure), so it cannot be retried.'
                  )}
                </Typography>
              ) : null}
            </Flex>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Modal.Close>
            <Button variant="tertiary">{t('common.close', 'Close')}</Button>
          </Modal.Close>
          {m && canManage ? (
            <Flex gap={2} wrap="wrap" justifyContent="flex-end">
              {allowed.discard ? (
                <ConfirmAction
                  label={t('message.discard', 'Discard')}
                  startIcon={<Trash />}
                  title={t('message.discard.title', 'Discard this message?')}
                  body={t(
                    'message.discard.body',
                    'MessageGate stops trying and deletes the stored content. This cannot be undone.'
                  )}
                  confirmLabel={t('message.discard.confirm', 'Discard')}
                  onConfirm={discard}
                />
              ) : null}
              {allowed.markSent ? (
                <ConfirmAction
                  label={t('message.markSent', 'Mark as sent')}
                  startIcon={<Check />}
                  triggerVariant="secondary"
                  variant="default"
                  title={t('message.markSent.title', 'Mark this message as sent?')}
                  body={t(
                    'message.markSent.body',
                    'Use this when you know the contact received it, for example after checking the provider console. MessageGate will not retry it.'
                  )}
                  confirmLabel={t('message.markSent.confirm', 'Mark as sent')}
                  onConfirm={markSent}
                />
              ) : null}
              {allowed.retry ? <RetryAction needsConfirm={allowed.retryNeedsConfirm} onRetry={retry} /> : null}
            </Flex>
          ) : null}
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
};
