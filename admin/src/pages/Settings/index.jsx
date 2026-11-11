import { useCallback, useState } from 'react';
import {
  Box,
  Button,
  Field,
  Flex,
  Grid,
  SingleSelect,
  SingleSelectOption,
  TextInput,
  Typography,
} from '@strapi/design-system';
import { ArrowClockwise, Check, Plus, Trash } from '@strapi/icons';
import { useNotification } from '@strapi/strapi/admin';

import { BooleanField } from '../../components/ui/BooleanField';
import { ConfirmAction } from '../../components/ui/ConfirmAction';
import { Notice } from '../../components/ui/Notice';
import { CopyField } from '../../components/ui/CopyField';
import { NumberField } from '../../components/ui/NumberField';
import { SectionCard } from '../../components/ui/SectionCard';
import { SectionFrame } from '../../components/ui/SectionFrame';
import { ErrorState, LoadingState } from '../../components/ui/States';
import { TagListField } from '../../components/ui/TagListField';
import { UnsavedBlocker } from '../../components/ui/UnsavedBlocker';
import { useAction } from '../../hooks/useAction';
import { useApi } from '../../hooks/useApi';
import { useLoad } from '../../hooks/useLoad';
import { useMgRBAC } from '../../hooks/useMgRBAC';
import { ToneBadge } from '../../components/ui/StatusBadge';
import { useT } from '../../hooks/useT';
import { apiError } from '../../utils/apiError';
import { BOUNDS, HOOK_EVENTS, newRule, validateSettings } from '../../utils/settings.mjs';
import { ChainEditor } from './ChainEditor';

const HEALTH_VARIANT = { ok: 'success', error: 'danger', unknown: 'neutral' };

/**
 * Sets a value at a dotted path immutably.
 *
 * @param {object} obj - Source.
 * @param {string} path - Path like `lookup.cacheDays`.
 * @param {any} value - Value.
 * @returns {object} Copy.
 */
const setPath = (obj, path, value) => {
  const [head, ...rest] = path.split('.');
  if (!rest.length) return { ...obj, [head]: value };
  return { ...obj, [head]: setPath(obj[head] || {}, rest.join('.'), value) };
};

/**
 * Plugin settings: routing and fallback, consent, number lookup budget,
 * retention, and the webhook URLs with their verification status.
 *
 * @returns {JSX.Element} Settings section.
 */
export const SettingsPage = () => {
  const t = useT();
  const api = useApi();
  const act = useAction();
  const rbac = useMgRBAC();
  const { toggleNotification } = useNotification();
  const loader = useCallback(() => api.get('/settings'), [api]);
  const { data, error, isLoading, reload } = useLoad(loader);
  const accountsLoader = useCallback(() => api.get('/accounts'), [api]);
  const { data: accounts } = useLoad(accountsLoader, { enabled: rbac.accounts.read });
  const budgetLoader = useCallback(() => api.get('/lookup/budget'), [api]);
  const { data: budget } = useLoad(budgetLoader, { enabled: rbac.contacts.read });

  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState(null);
  const [revision, setRevision] = useState(0);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [secret, setSecret] = useState(null);

  // Adopt freshly loaded settings (first load and after a conflict reload).
  const [seen, setSeen] = useState(null);
  if (data && data !== seen) {
    setSeen(data);
    setSaved(data.settings);
    setDraft(data.settings);
    setRevision(data.revision);
  }

  const readOnly = !rbac.settings.update;
  const dirty = draft && saved && JSON.stringify(draft) !== JSON.stringify(saved);
  const set = (path, value) => {
    setDraft((prev) => setPath(prev, path, value));
    setErrors((prev) => ({ ...prev, [path]: undefined }));
  };
  const updateRule = (index, patch) =>
    setDraft((prev) =>
      setPath(
        prev,
        'routing.rules',
        prev.routing.rules.map((r, j) => (j === index ? { ...r, ...patch } : r))
      )
    );
  const range = (key) =>
    t('settings.error.range', 'Use a whole number from {min} to {max}.', { min: BOUNDS[key][0], max: BOUNDS[key][1] });
  const messages = {
    required: t('form.required', 'This field is required.'),
    invalid: t('settings.error.country', 'Use a two-letter country code like DE.'),
    emptyChain: t('settings.error.chain', 'Add at least one channel.'),
    duplicate: t('settings.error.duplicate', 'Two rules have the same id.'),
    https: t('settings.error.https', 'Use a public https address.'),
  };

  const save = async () => {
    const found = validateSettings(draft);
    if (Object.keys(found).length) {
      setErrors(
        Object.fromEntries(
          Object.entries(found).map(([path, code]) => [
            path,
            code === 'range' ? range(path.split('.').pop()) : messages[code],
          ])
        )
      );
      requestAnimationFrame(() => document.querySelector(`[name="${Object.keys(found)[0]}"]`)?.focus());
      toggleNotification({ type: 'warning', message: t('editor.error.fix', 'Fix the highlighted fields first.') });
      return;
    }
    setSaving(true);
    try {
      const result = await act(
        () => api.put('/settings', { settings: draft, revision }),
        t('settings.saved', 'The settings were saved.')
      );
      setSaved(result.value);
      setDraft(result.value);
      setRevision(result.revision);
    } catch (err) {
      const { code, details } = apiError(err);
      if (code === 'STATE_CHANGED') reload();
      if (code === 'CONFIG_INVALID' && details.path) setErrors({ [details.path]: messages.required });
      if (code === 'WEBHOOK_URL_INVALID') setErrors({ 'outgoingWebhook.url': messages.https });
    } finally {
      setSaving(false);
    }
  };

  const twilio = (accounts || []).filter((a) => a.provider === 'twilio');
  const seven = (accounts || []).filter((a) => a.provider === 'seven');
  const eventLabels = {
    'message.received': t('settings.hook.event.received', 'Inbound message received'),
    'message.status': t('settings.hook.event.status', 'Delivery status changed'),
    'media.ready': t('settings.hook.event.mediaReady', 'Inbound file stored'),
    'media.failed': t('settings.hook.event.mediaFailed', 'Inbound file refused or failed'),
  };
  const rotate = async () => {
    const result = await act(
      () => api.post('/settings/webhook-secret'),
      t('settings.hook.secret.done', 'A new signing secret was created. Copy it now; it is shown only once.')
    );
    setSecret(result.secret);
  };
  const hooks = (accounts || []).filter((a) => a.webhookUrl);

  return (
    <SectionFrame
      title={t('settings.title', 'Settings')}
      subtitle={t('settings.subtitle', 'Routing, consent, number checks, inbox, data retention and webhooks.')}
      busy={isLoading}
      primaryAction={
        readOnly || !draft ? null : (
          <Button startIcon={<Check />} onClick={save} loading={saving} disabled={!dirty}>
            {t('common.save', 'Save')}
          </Button>
        )
      }
    >
      {error && !data ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !draft ? (
        <LoadingState />
      ) : (
        <>
          {data.sandbox ? (
            <Notice variant="warning" title={t('settings.sandbox.title', 'Sandbox mode')}>
              {t(
                'settings.sandbox.body',
                'providers.mode is sandbox: no message leaves this server and every status is simulated by test numbers. Turn it off in config/plugins for production.'
              )}
            </Notice>
          ) : null}
          <SectionCard
            title={t('settings.routing', 'Routing and fallback')}
            subtitle={t(
              'settings.routing.subtitle',
              'Messages with channel "auto" try the channels in this order. The next one is used when a contact cannot be reached.'
            )}
          >
            <ChainEditor
              name="routing.defaultChain"
              label={t('settings.chain', 'Default order')}
              error={errors['routing.defaultChain']}
              value={draft.routing.defaultChain}
              emailAvailable={data.magicMailInstalled}
              disabled={readOnly}
              onChange={(chain) => set('routing.defaultChain', chain)}
            />
            <Flex direction="column" alignItems="stretch" gap={4}>
              <Typography variant="delta" tag="h3">
                {t('settings.rules', 'Rules')}
              </Typography>
              <Typography variant="pi" textColor="neutral600">
                {t(
                  'settings.rules.hint',
                  'The first matching rule wins. A rule matches when every filled list contains the message value.'
                )}
              </Typography>
              {draft.routing.rules.map((rule, i) => (
                <Box key={rule.id} background="neutral100" hasRadius padding={5}>
                  <Flex direction="column" alignItems="stretch" gap={4}>
                    <Flex gap={4} alignItems="flex-end" wrap="wrap">
                      <Box flex="1 1 24rem" minWidth={0}>
                        <Field.Root name={`routing.rules.${i}.name`} required error={errors[`routing.rules.${i}.name`]}>
                          <Field.Label>{t('settings.rule.name', 'Rule name')}</Field.Label>
                          <TextInput
                            name={`routing.rules.${i}.name`}
                            value={rule.name}
                            maxLength={80}
                            disabled={readOnly}
                            onChange={(e) => {
                              const name = e.target.value;
                              updateRule(i, { name });
                              setErrors((prev) => ({ ...prev, [`routing.rules.${i}.name`]: undefined }));
                            }}
                          />
                          <Field.Error />
                        </Field.Root>
                      </Box>
                      {!readOnly ? (
                        <Button
                          variant="danger-light"
                          startIcon={<Trash />}
                          onClick={() =>
                            set(
                              'routing.rules',
                              draft.routing.rules.filter((_, j) => j !== i)
                            )
                          }
                        >
                          {t('settings.rule.remove', 'Remove rule')}
                        </Button>
                      ) : null}
                    </Flex>
                    <Grid.Root gap={4}>
                      <Grid.Item col={4} xs={12} s={12} direction="column" alignItems="stretch">
                        <TagListField
                          name={`routing.rules.${i}.templateKeys`}
                          kind="templateKey"
                          label={t('settings.rule.templates', 'Template keys')}
                          placeholder="order_shipped"
                          value={rule.templateKeys}
                          disabled={readOnly}
                          onChange={(list) => updateRule(i, { templateKeys: list })}
                        />
                      </Grid.Item>
                      <Grid.Item col={4} xs={12} s={12} direction="column" alignItems="stretch">
                        <TagListField
                          name={`routing.rules.${i}.countries`}
                          kind="country"
                          label={t('settings.rule.countries', 'Countries')}
                          placeholder="DE"
                          value={rule.countries}
                          disabled={readOnly}
                          onChange={(list) => updateRule(i, { countries: list })}
                        />
                      </Grid.Item>
                      <Grid.Item col={4} xs={12} s={12} direction="column" alignItems="stretch">
                        <TagListField
                          name={`routing.rules.${i}.tags`}
                          kind="tag"
                          label={t('settings.rule.tags', 'Tags')}
                          placeholder="urgent"
                          value={rule.tags}
                          disabled={readOnly}
                          onChange={(list) => updateRule(i, { tags: list })}
                        />
                      </Grid.Item>
                    </Grid.Root>
                    <ChainEditor
                      name={`routing.rules.${i}.chain`}
                      label={t('settings.rule.chain', 'Order for this rule')}
                      error={errors[`routing.rules.${i}.chain`]}
                      value={rule.chain}
                      emailAvailable={data.magicMailInstalled}
                      disabled={readOnly}
                      onChange={(chain) => updateRule(i, { chain })}
                    />
                  </Flex>
                </Box>
              ))}
              {!readOnly ? (
                <Box>
                  <Button
                    variant="secondary"
                    startIcon={<Plus />}
                    onClick={() => set('routing.rules', [...draft.routing.rules, newRule(draft.routing.rules)])}
                  >
                    {t('settings.rule.add', 'Add rule')}
                  </Button>
                </Box>
              ) : null}
            </Flex>
            <Grid.Root gap={4}>
              <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                <BooleanField
                  name="fallback.emailEnabled"
                  label={t('settings.email', 'Email as last fallback')}
                  hint={
                    data.magicMailInstalled
                      ? t('settings.email.hint', 'Sends a Magic Mail template when no message channel works.')
                      : t('settings.email.missing', 'Install Magic Mail to use email as fallback.')
                  }
                  checked={draft.fallback.emailEnabled}
                  disabled={readOnly || !data.magicMailInstalled}
                  onCheckedChange={(value) => set('fallback.emailEnabled', value)}
                />
              </Grid.Item>
              {draft.fallback.emailEnabled ? (
                <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                  <NumberField
                    name="fallback.emailTemplateReferenceId"
                    label={t('settings.email.template', 'Magic Mail template reference ID')}
                    hint={t('settings.email.template.hint', 'Shown in Magic Mail next to each template.')}
                    error={errors['fallback.emailTemplateReferenceId']}
                    value={draft.fallback.emailTemplateReferenceId ?? undefined}
                    disabled={readOnly}
                    onChange={(value) => set('fallback.emailTemplateReferenceId', value ?? null)}
                  />
                </Grid.Item>
              ) : null}
            </Grid.Root>
          </SectionCard>

          <SectionCard
            title={t('settings.consent', 'Consent and opt-out')}
            subtitle={t('settings.consent.subtitle', 'Who may be contacted, and how contacts stop messages.')}
          >
            <Grid.Root gap={4}>
              <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                <BooleanField
                  name="requireConsent"
                  label={t('settings.requireConsent', 'Require consent before sending')}
                  hint={t(
                    'settings.requireConsent.hint',
                    'Every message needs recorded consent for its channel. Only transactional login codes (authentication templates) are exempt.'
                  )}
                  checked={draft.requireConsent}
                  disabled={readOnly}
                  onCheckedChange={(value) => set('requireConsent', value)}
                />
              </Grid.Item>
              <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                <Field.Root
                  name="defaultCountry"
                  required
                  error={errors.defaultCountry}
                  hint={t('settings.country.hint', 'Used for numbers without country code.')}
                >
                  <Field.Label>{t('settings.country', 'Default country')}</Field.Label>
                  <TextInput
                    name="defaultCountry"
                    value={draft.defaultCountry}
                    maxLength={2}
                    disabled={readOnly}
                    onChange={(e) => set('defaultCountry', e.target.value.toUpperCase())}
                  />
                  <Field.Hint />
                  <Field.Error />
                </Field.Root>
              </Grid.Item>
            </Grid.Root>
            <TagListField
              name="optOutKeywords"
              kind="keyword"
              label={t('settings.optOut', 'Opt-out keywords')}
              hint={t('settings.optOut.hint', 'A reply with only one of these words revokes consent for that channel.')}
              placeholder="STOP"
              value={draft.optOutKeywords}
              disabled={readOnly}
              onChange={(list) => set('optOutKeywords', list)}
            />
          </SectionCard>

          <SectionCard
            title={t('settings.lookup', 'Number lookup')}
            subtitle={t(
              'settings.lookup.subtitle',
              'Optional paid check of the line type with Twilio Lookup before the first message.'
            )}
          >
            <Grid.Root gap={4}>
              <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                <BooleanField
                  name="lookup.enabled"
                  label={t('settings.lookup.enabled', 'Use Twilio Lookup')}
                  checked={draft.lookup.enabled}
                  disabled={readOnly}
                  onCheckedChange={(value) => set('lookup.enabled', value)}
                />
              </Grid.Item>
              <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                <Field.Root
                  name="lookup.accountId"
                  error={errors['lookup.accountId']}
                  hint={
                    twilio.length
                      ? t('settings.lookup.account.hint', 'Lookups are billed to this Twilio account.')
                      : t('settings.lookup.account.none', 'Connect a Twilio account first.')
                  }
                >
                  <Field.Label>{t('settings.lookup.account', 'Twilio account')}</Field.Label>
                  <SingleSelect
                    value={draft.lookup.accountId ?? undefined}
                    placeholder={t('settings.lookup.account.placeholder', 'Choose an account')}
                    disabled={readOnly || !twilio.length}
                    onChange={(value) => set('lookup.accountId', value)}
                  >
                    {twilio.map((a) => (
                      <SingleSelectOption key={a.id} value={a.id}>
                        {a.name}
                      </SingleSelectOption>
                    ))}
                  </SingleSelect>
                  <Field.Hint />
                  <Field.Error />
                </Field.Root>
              </Grid.Item>
              <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                <NumberField
                  name="lookup.monthlyBudget"
                  label={t('settings.lookup.budget', 'Monthly budget')}
                  hint={
                    budget
                      ? t('settings.lookup.budget.used', '{used} used in {month}. Lookups stop when it is reached.', {
                          used: budget.used,
                          month: budget.month,
                        })
                      : t('settings.lookup.budget.hint', 'Lookups stop when it is reached.')
                  }
                  unit={t('settings.unit.lookups', 'lookups')}
                  error={errors['lookup.monthlyBudget']}
                  value={draft.lookup.monthlyBudget}
                  disabled={readOnly}
                  onChange={(value) => set('lookup.monthlyBudget', value)}
                />
              </Grid.Item>
              <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                <NumberField
                  name="lookup.cacheDays"
                  label={t('settings.lookup.cache', 'Reuse results for')}
                  hint={t('settings.lookup.cache.hint', 'A number is not looked up again within this time.')}
                  unit={t('settings.unit.days', 'days')}
                  error={errors['lookup.cacheDays']}
                  value={draft.lookup.cacheDays}
                  disabled={readOnly}
                  onChange={(value) => set('lookup.cacheDays', value)}
                />
              </Grid.Item>
              <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                <BooleanField
                  name="lookup.hlrEnabled"
                  label={t('settings.lookup.hlr', 'Use seven.io HLR check')}
                  hint={t(
                    'settings.lookup.hlr.hint',
                    'Asks the mobile network whether the number is assigned. Paid per check, shares the budget.'
                  )}
                  checked={draft.lookup.hlrEnabled}
                  disabled={readOnly}
                  onCheckedChange={(value) => set('lookup.hlrEnabled', value)}
                />
              </Grid.Item>
              <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                <Field.Root
                  name="lookup.hlrAccountId"
                  error={errors['lookup.hlrAccountId']}
                  hint={
                    seven.length
                      ? t('settings.lookup.hlrAccount.hint', 'HLR checks are billed to this seven.io account.')
                      : t('settings.lookup.hlrAccount.none', 'Connect a seven.io account first.')
                  }
                >
                  <Field.Label>{t('settings.lookup.hlrAccount', 'seven.io account')}</Field.Label>
                  <SingleSelect
                    value={draft.lookup.hlrAccountId ?? undefined}
                    placeholder={t('settings.lookup.account.placeholder', 'Choose an account')}
                    disabled={readOnly || !seven.length}
                    onChange={(value) => set('lookup.hlrAccountId', value)}
                  >
                    {seven.map((a) => (
                      <SingleSelectOption key={a.id} value={a.id}>
                        {a.name}
                      </SingleSelectOption>
                    ))}
                  </SingleSelect>
                  <Field.Hint />
                  <Field.Error />
                </Field.Root>
              </Grid.Item>
              <Grid.Item col={12} direction="column" alignItems="stretch">
                <BooleanField
                  name="lookup.blockInactiveNumbers"
                  label={t('settings.lookup.block', 'Stop sends to unassigned numbers')}
                  hint={t(
                    'settings.lookup.block.hint',
                    'Before sending, the HLR result decides: unassigned numbers fail with NUMBER_INACTIVE and cost nothing. Without a result the message is sent.'
                  )}
                  checked={draft.lookup.blockInactiveNumbers}
                  disabled={readOnly || !draft.lookup.hlrEnabled}
                  onCheckedChange={(value) => set('lookup.blockInactiveNumbers', value)}
                />
              </Grid.Item>
            </Grid.Root>
          </SectionCard>

          <SectionCard
            title={t('settings.inbox', 'Inbox and files')}
            subtitle={t(
              'settings.inbox.subtitle',
              'Replies from contacts, files they send, and download links for attachments sent by SMS.'
            )}
          >
            <Grid.Root gap={4}>
              <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                <NumberField
                  name="inbound.retentionDays"
                  label={t('settings.inbox.retention', 'Keep inbound messages')}
                  hint={t('settings.inbox.retention.hint', 'Texts and stored files are deleted after this time.')}
                  unit={t('settings.unit.days', 'days')}
                  error={errors['inbound.retentionDays']}
                  value={draft.inbound.retentionDays}
                  disabled={readOnly}
                  onChange={(value) => set('inbound.retentionDays', value)}
                />
              </Grid.Item>
              <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                <NumberField
                  name="inbound.replyWindowHours"
                  label={t('settings.inbox.replyWindow', 'Reply window for SMS')}
                  hint={t(
                    'settings.inbox.replyWindow.hint',
                    'SMS has no reply reference, so an answer within this time belongs to the last message sent.'
                  )}
                  unit={t('settings.unit.hours', 'hours')}
                  error={errors['inbound.replyWindowHours']}
                  value={draft.inbound.replyWindowHours}
                  disabled={readOnly}
                  onChange={(value) => set('inbound.replyWindowHours', value)}
                />
              </Grid.Item>
              <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                <Field.Root
                  name="inboundMedia.storage"
                  hint={t(
                    'settings.inbox.storage.hint',
                    'Files go to the folder "MessageGate inbound" of your upload provider, or are not downloaded at all.'
                  )}
                >
                  <Field.Label>{t('settings.inbox.storage', 'Inbound files')}</Field.Label>
                  <SingleSelect
                    value={draft.inboundMedia.storage}
                    disabled={readOnly}
                    onChange={(value) => set('inboundMedia.storage', value)}
                  >
                    <SingleSelectOption value="media-library">
                      {t('settings.inbox.storage.library', 'Store in the media library')}
                    </SingleSelectOption>
                    <SingleSelectOption value="none">
                      {t('settings.inbox.storage.none', 'Do not store (metadata only)')}
                    </SingleSelectOption>
                  </SingleSelect>
                  <Field.Hint />
                </Field.Root>
              </Grid.Item>
              <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                <NumberField
                  name="inboundMedia.maxMb"
                  label={t('settings.inbox.maxMb', 'Largest inbound file')}
                  hint={t('settings.inbox.maxMb.hint', 'Larger files are refused while downloading.')}
                  unit={t('settings.unit.mb', 'MB')}
                  error={errors['inboundMedia.maxMb']}
                  value={draft.inboundMedia.maxMb}
                  disabled={readOnly}
                  onChange={(value) => set('inboundMedia.maxMb', value)}
                />
              </Grid.Item>
              <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                <NumberField
                  name="attachments.linkTtlHours"
                  label={t('settings.inbox.linkTtl', 'Download links in SMS are valid for')}
                  hint={t(
                    'settings.inbox.linkTtl.hint',
                    'SMS cannot carry files, so they get a signed link that expires after this time.'
                  )}
                  unit={t('settings.unit.hours', 'hours')}
                  error={errors['attachments.linkTtlHours']}
                  value={draft.attachments.linkTtlHours}
                  disabled={readOnly}
                  onChange={(value) => set('attachments.linkTtlHours', value)}
                />
              </Grid.Item>
            </Grid.Root>
          </SectionCard>

          <SectionCard
            title={t('settings.hook', 'Outgoing webhook')}
            subtitle={t(
              'settings.hook.subtitle',
              'MessageGate posts selected events to your own https URL, signed with HMAC-SHA256. No phone numbers or message text are sent.'
            )}
          >
            <Grid.Root gap={4}>
              <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                <BooleanField
                  name="outgoingWebhook.enabled"
                  label={t('settings.hook.enabled', 'Send events to a webhook')}
                  checked={draft.outgoingWebhook.enabled}
                  disabled={readOnly}
                  onCheckedChange={(value) => set('outgoingWebhook.enabled', value)}
                />
              </Grid.Item>
              <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                <Field.Root
                  name="outgoingWebhook.url"
                  error={errors['outgoingWebhook.url']}
                  hint={t('settings.hook.url.hint', 'Public https address. Redirects are not followed.')}
                >
                  <Field.Label>{t('settings.hook.url', 'Webhook URL')}</Field.Label>
                  <TextInput
                    type="url"
                    value={draft.outgoingWebhook.url || ''}
                    placeholder="https://app.example.com/hooks/messagegate"
                    disabled={readOnly}
                    onChange={(e) => set('outgoingWebhook.url', e.target.value.trim() || null)}
                  />
                  <Field.Hint />
                  <Field.Error />
                </Field.Root>
              </Grid.Item>
              {HOOK_EVENTS.map((event) => (
                <Grid.Item key={event} col={6} xs={12} direction="column" alignItems="stretch">
                  <BooleanField
                    name={`outgoingWebhook.events.${event}`}
                    label={eventLabels[event]}
                    checked={draft.outgoingWebhook.events.includes(event)}
                    disabled={readOnly}
                    onCheckedChange={(on) =>
                      set(
                        'outgoingWebhook.events',
                        on
                          ? [...draft.outgoingWebhook.events, event]
                          : draft.outgoingWebhook.events.filter((e) => e !== event)
                      )
                    }
                  />
                </Grid.Item>
              ))}
              <Grid.Item col={12} direction="column" alignItems="stretch" gap={3}>
                <Typography textColor="neutral600">
                  {data.webhookSecretSet || secret
                    ? t(
                        'settings.hook.secret.set',
                        'A signing secret exists. Verify X-MessageGate-Signature with it (see AGENTS.md).'
                      )
                    : t('settings.hook.secret.none', 'No signing secret yet. Deliveries start after you create one.')}
                </Typography>
                {secret ? (
                  <CopyField
                    name="webhook-secret"
                    label={t('settings.hook.secret', 'Signing secret')}
                    value={secret}
                    hint={t('settings.hook.secret.once', 'Shown only now. Store it in your receiver.')}
                  />
                ) : null}
                {!readOnly ? (
                  <Box>
                    <ConfirmAction
                      label={
                        data.webhookSecretSet || secret
                          ? t('settings.hook.secret.rotate', 'Replace signing secret')
                          : t('settings.hook.secret.create', 'Create signing secret')
                      }
                      startIcon={<ArrowClockwise />}
                      triggerVariant="secondary"
                      variant="default"
                      title={t('settings.hook.secret.title', 'Create a new signing secret?')}
                      body={t(
                        'settings.hook.secret.body',
                        'The old secret stops working at once. Update your receiver right after copying the new one.'
                      )}
                      confirmLabel={t('settings.hook.secret.confirm', 'Create secret')}
                      onConfirm={rotate}
                    />
                  </Box>
                ) : null}
              </Grid.Item>
            </Grid.Root>
          </SectionCard>

          <SectionCard
            title={t('settings.retention', 'Data retention')}
            subtitle={t('settings.retention.subtitle', 'Older data is deleted automatically every night.')}
          >
            <Grid.Root gap={4}>
              <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                <NumberField
                  name="retention.messageDays"
                  label={t('settings.retention.messages', 'Keep messages')}
                  hint={t('settings.retention.messages.hint', 'Message contents and history. Statistics stay.')}
                  unit={t('settings.unit.days', 'days')}
                  error={errors['retention.messageDays']}
                  value={draft.retention.messageDays}
                  disabled={readOnly}
                  onChange={(value) => set('retention.messageDays', value)}
                />
              </Grid.Item>
              <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                <NumberField
                  name="retention.receiptDays"
                  label={t('settings.retention.receipts', 'Keep raw webhook receipts')}
                  hint={t('settings.retention.receipts.hint', 'Used to ignore duplicate provider callbacks.')}
                  unit={t('settings.unit.days', 'days')}
                  error={errors['retention.receiptDays']}
                  value={draft.retention.receiptDays}
                  disabled={readOnly}
                  onChange={(value) => set('retention.receiptDays', value)}
                />
              </Grid.Item>
            </Grid.Root>
          </SectionCard>

          <SectionCard
            title={t('settings.webhooks', 'Webhooks')}
            subtitle={t(
              'settings.webhooks.subtitle',
              'Providers report delivery, read receipts and replies to these URLs. Each request is verified with its signature.'
            )}
          >
            {!data.publicUrl ? (
              <Typography textColor="warning700">
                {t(
                  'settings.webhooks.noUrl',
                  'Set server.url in config/server so MessageGate can build public webhook URLs.'
                )}
              </Typography>
            ) : null}
            {data.embeddedSignup?.webhookUrl ? (
              <CopyField
                name="webhook-meta-app"
                label={t('settings.webhooks.metaApp', 'Meta app (Embedded Signup numbers)')}
                value={data.embeddedSignup.webhookUrl}
                hint={t(
                  'settings.webhooks.metaApp.hint',
                  'Meta App Dashboard > WhatsApp > Configuration, with the verify token from the server config.'
                )}
              />
            ) : null}
            {hooks.map((a) => (
              <Flex key={a.id} direction="column" alignItems="stretch" gap={2}>
                <Flex gap={2} wrap="wrap">
                  <Typography fontWeight="semiBold">{a.name}</Typography>
                  <ToneBadge tone={HEALTH_VARIANT[a.health?.status] || 'neutral'}>
                    {
                      {
                        ok: t('accounts.health.ok', 'Connected'),
                        error: t('accounts.health.error', 'Connection problem'),
                        unknown: t('accounts.health.unknown', 'Not tested yet'),
                      }[a.health?.status || 'unknown']
                    }
                  </ToneBadge>
                </Flex>
                <CopyField
                  name={`webhook-${a.id}`}
                  label={t('accounts.webhookUrl', 'Webhook URL')}
                  value={a.webhookUrl}
                />
              </Flex>
            ))}
            {rbac.accounts.read && !hooks.length && data.publicUrl ? (
              <Typography textColor="neutral600">
                {t('settings.webhooks.none', 'Connect an account to get its webhook URL.')}
              </Typography>
            ) : null}
          </SectionCard>
          {!readOnly ? <UnsavedBlocker saved={saved} draft={draft} /> : null}
        </>
      )}
    </SectionFrame>
  );
};

export default SettingsPage;
