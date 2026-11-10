import { useCallback, useState } from 'react';
import { Box, Button, Field, Flex, Grid, Modal, ProgressBar, TextInput, Typography } from '@strapi/design-system';
import { ListSearch, PaperPlane, Plus } from '@strapi/icons';

import { Notice } from '../../components/ui/Notice';
import { ReachabilityBadge, ToneBadge } from '../../components/ui/StatusBadge';
import { useAction } from '../../hooks/useAction';
import { useApi } from '../../hooks/useApi';
import { useLoad } from '../../hooks/useLoad';
import { useMgRBAC } from '../../hooks/useMgRBAC';
import { useT } from '../../hooks/useT';
import { apiError } from '../../utils/apiError';
import { SendMessageModal } from '../Messages/SendMessageModal';

/**
 * Pre-check of a phone number before sending: format and country locally
 * (free), what MessageGate learned about WhatsApp, and optionally a Twilio
 * line-type lookup that counts against the monthly budget.
 *
 * @param {{ onClose: () => void, onOpenContact: (id: string) => void, onChanged: () => void }} props - Props.
 * @returns {JSX.Element} Modal.
 */
export const LookupModal = ({ onClose, onOpenContact, onChanged }) => {
  const t = useT();
  const api = useApi();
  const act = useAction();
  const rbac = useMgRBAC();
  const [phone, setPhone] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [sendOpen, setSendOpen] = useState(false);
  const budgetLoader = useCallback(() => api.get('/lookup/budget'), [api]);
  const { data: budget, reload: reloadBudget } = useLoad(budgetLoader);

  const check = async (remote) => {
    if (!phone.trim()) {
      setError(t('form.required', 'This field is required.'));
      return;
    }
    setBusy(remote ? 'remote' : 'local');
    try {
      setResult(await act(() => api.post('/lookup', { phone: phone.trim(), remote })));
      setError(null);
      if (remote) reloadBudget();
    } catch (err) {
      if (apiError(err).code === 'INVALID_PHONE')
        setError(t('error.INVALID_PHONE', 'The phone number is not a valid mobile number.'));
    } finally {
      setBusy(null);
    }
  };

  const addContact = async () => {
    try {
      const contact = await act(
        () => api.post('/contacts', { phone: result.e164 }),
        t('lookup.added', 'The contact was added.')
      );
      onChanged();
      onOpenContact(contact.id);
    } catch {
      // notified
    }
  };

  const left = budget ? Math.max(0, budget.budget - budget.used) : 0;
  const typeLabel = {
    MOBILE: t('lookup.type.mobile', 'Mobile'),
    FIXED_LINE: t('lookup.type.fixed', 'Landline'),
    FIXED_LINE_OR_MOBILE: t('lookup.type.either', 'Landline or mobile'),
    VOIP: t('lookup.type.voip', 'VoIP'),
  };

  if (sendOpen)
    return (
      <SendMessageModal defaultPhone={result?.e164 || phone} onClose={() => setSendOpen(false)} onSent={onChanged} />
    );

  return (
    <Modal.Root open onOpenChange={(open) => !open && !busy && onClose()}>
      <Modal.Content>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            check(false);
          }}
          noValidate
        >
          <Modal.Header>
            <Modal.Title>{t('lookup.title', 'Check a number')}</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <Flex direction="column" alignItems="stretch" gap={5}>
              <Field.Root
                name="phone"
                required
                error={error}
                hint={t('lookup.hint', 'The free check validates the number and shows what MessageGate already knows.')}
              >
                <Field.Label>{t('send.to', 'Phone number')}</Field.Label>
                <TextInput
                  type="tel"
                  value={phone}
                  placeholder="+49 151 23456789"
                  autoFocus
                  onChange={(event) => {
                    setPhone(event.target.value);
                    setError(null);
                  }}
                />
                <Field.Hint />
                <Field.Error />
              </Field.Root>

              {budget?.enabled ? (
                <Box background="neutral100" hasRadius padding={4}>
                  <Flex direction="column" alignItems="stretch" gap={2}>
                    <Flex justifyContent="space-between" gap={2} wrap="wrap">
                      <Typography variant="sigma" textColor="neutral600">
                        {t('lookup.budget', 'Twilio lookups in {month}', { month: budget.month })}
                      </Typography>
                      <Typography variant="pi" textColor="neutral700">
                        {t('lookup.budget.value', '{used} of {budget} used, {left} left', {
                          used: budget.used,
                          budget: budget.budget,
                          left,
                        })}
                      </Typography>
                    </Flex>
                    <ProgressBar value={budget.budget ? Math.min(100, (budget.used / budget.budget) * 100) : 100}>
                      {t('lookup.budget.progress', '{used} of {budget} lookups used', {
                        used: budget.used,
                        budget: budget.budget,
                      })}
                    </ProgressBar>
                    <Typography variant="pi" textColor="neutral600">
                      {t('lookup.budget.cache', 'Results are reused for {days} days without cost.', {
                        days: budget.cacheDays,
                      })}
                    </Typography>
                    <Box>
                      <Button
                        variant="secondary"
                        onClick={() => check(true)}
                        loading={busy === 'remote'}
                        disabled={left <= 0 || Boolean(busy)}
                      >
                        {t('lookup.remote', 'Check with Twilio')}
                      </Button>
                    </Box>
                  </Flex>
                </Box>
              ) : null}

              {result ? (
                <Flex direction="column" alignItems="stretch" gap={4} role="status">
                  {!result.valid ? (
                    <Notice variant="danger">{t('lookup.invalid', 'This is not a valid phone number.')}</Notice>
                  ) : (
                    <>
                      <Grid.Root gap={4}>
                        <Grid.Item col={6} xs={12} direction="column" alignItems="flex-start">
                          <Typography variant="sigma" textColor="neutral600">
                            {t('lookup.number', 'Number')}
                          </Typography>
                          <Typography fontWeight="semiBold">{result.e164}</Typography>
                        </Grid.Item>
                        <Grid.Item col={6} xs={12} direction="column" alignItems="flex-start">
                          <Typography variant="sigma" textColor="neutral600">
                            {t('lookup.type', 'Type')}
                          </Typography>
                          <Flex gap={2}>
                            <Typography>{typeLabel[result.type] || result.type || '–'}</Typography>
                            {result.country ? <ToneBadge>{result.country}</ToneBadge> : null}
                          </Flex>
                        </Grid.Item>
                        <Grid.Item col={6} xs={12} direction="column" alignItems="flex-start">
                          <Typography variant="sigma" textColor="neutral600">
                            {t('lookup.whatsapp', 'WhatsApp')}
                          </Typography>
                          <ReachabilityBadge value={result.whatsapp} />
                        </Grid.Item>
                        {result.remote ? (
                          <Grid.Item col={6} xs={12} direction="column" alignItems="flex-start">
                            <Typography variant="sigma" textColor="neutral600">
                              {t('lookup.carrier', 'Line type (Twilio)')}
                            </Typography>
                            <Typography>
                              {result.remote.ok
                                ? `${result.remote.lineType || '–'}${result.remote.cached ? ` · ${t('lookup.cached', 'cached')}` : ''}`
                                : result.remote.code}
                            </Typography>
                          </Grid.Item>
                        ) : null}
                      </Grid.Root>
                      {!result.mobile ? (
                        <Notice variant="warning">
                          {t(
                            'lookup.notMobile',
                            'This looks like a landline. WhatsApp and SMS usually do not reach it.'
                          )}
                        </Notice>
                      ) : null}
                      <Typography variant="pi" textColor="neutral600">
                        {t(
                          'lookup.whatsappHint',
                          'WhatsApp offers no lookup. MessageGate learns it from the first message: if Meta reports the number is not on WhatsApp, the routing falls back to the next channel.'
                        )}
                      </Typography>
                      <Flex gap={2} wrap="wrap">
                        {rbac.contacts.manage ? (
                          <Button variant="secondary" startIcon={<Plus />} onClick={addContact}>
                            {t('lookup.add', 'Add as contact')}
                          </Button>
                        ) : null}
                        {rbac.messages.send ? (
                          <Button variant="secondary" startIcon={<PaperPlane />} onClick={() => setSendOpen(true)}>
                            {t('messages.send', 'Send message')}
                          </Button>
                        ) : null}
                      </Flex>
                    </>
                  )}
                </Flex>
              ) : null}
            </Flex>
          </Modal.Body>
          <Modal.Footer>
            <Modal.Close>
              <Button variant="tertiary" disabled={Boolean(busy)}>
                {t('common.close', 'Close')}
              </Button>
            </Modal.Close>
            <Flex gap={2} wrap="wrap" justifyContent="flex-end">
              <Button type="submit" startIcon={<ListSearch />} loading={busy === 'local'} disabled={Boolean(busy)}>
                {t('lookup.check', 'Check')}
              </Button>
            </Flex>
          </Modal.Footer>
        </form>
      </Modal.Content>
    </Modal.Root>
  );
};
