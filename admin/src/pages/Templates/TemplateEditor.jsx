import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  Field,
  Flex,
  Grid,
  IconButton,
  SingleSelect,
  SingleSelectOption,
  Textarea,
  TextInput,
  Typography,
} from '@strapi/design-system';
import { Check, PaperPlane, Plus, Trash } from '@strapi/icons';
import { BackButton, ConfirmDialog, Layouts, Page, useNotification } from '@strapi/strapi/admin';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { BooleanField } from '../../components/ui/BooleanField';
import { Notice } from '../../components/ui/Notice';
import { SectionCard } from '../../components/ui/SectionCard';
import { ErrorState, LoadingState } from '../../components/ui/States';
import { ApprovalBadge } from '../../components/ui/StatusBadge';
import { UnsavedBlocker } from '../../components/ui/UnsavedBlocker';
import { useAction } from '../../hooks/useAction';
import { useApi } from '../../hooks/useApi';
import { useLoad } from '../../hooks/useLoad';
import { useMgRBAC } from '../../hooks/useMgRBAC';
import { useT } from '../../hooks/useT';
import { PLUGIN_ID } from '../../pluginId';
import { apiError } from '../../utils/apiError';
import { CHANNELS, channelLabels } from '../../utils/channels';
import { keyFromName } from '../../utils/templatePreview.mjs';
import {
  BUTTON_TYPES,
  CATEGORIES,
  HEADER_FORMATS,
  LIMITS,
  emptyTemplate,
  switchChannel,
  syncVariables,
  templatePayload,
  validateTemplate,
} from '../../utils/templates.mjs';
import { TemplatePreview } from './TemplatePreview';

const BASE = `/plugins/${PLUGIN_ID}/templates`;

/**
 * Character counter shown in a field hint.
 *
 * @param {string} value - Text.
 * @param {number} max - Limit.
 * @returns {string} "12 / 60".
 */
const count = (value, max) => `${String(value || '').length} / ${max}`;

/**
 * Submit-to-Meta dialog with the account choice.
 *
 * @param {{ accounts: object[], disabled: boolean, onSubmit: (accountId: string) => Promise<void> }} props - Props.
 * @returns {JSX.Element} Trigger and dialog.
 */
const SubmitAction = ({ accounts, disabled, onSubmit }) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [accountId, setAccountId] = useState(() => (accounts.find((a) => a.isDefault) || accounts[0])?.id);
  const run = async () => {
    setBusy(true);
    try {
      await onSubmit(accountId);
      setOpen(false);
    } catch {
      // notified
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !busy && setOpen(next)}>
      <Dialog.Trigger>
        <Button variant="secondary" startIcon={<PaperPlane />} disabled={disabled}>
          {t('editor.submit', 'Submit to Meta')}
        </Button>
      </Dialog.Trigger>
      <ConfirmDialog
        title={t('editor.submit.title', 'Submit this template to Meta for review?')}
        variant="default"
        endAction={
          <Button fullWidth onClick={run} loading={busy} disabled={!accountId}>
            {t('editor.submit.confirm', 'Submit')}
          </Button>
        }
      >
        <Flex direction="column" alignItems="stretch" gap={4}>
          <Typography>
            {t(
              'editor.submit.body',
              'Meta usually decides within minutes, sometimes up to 24 hours. The status updates here by webhook or with "Sync templates".'
            )}
          </Typography>
          {accounts.length > 1 ? (
            <Field.Root name="accountId">
              <Field.Label>{t('editor.submit.account', 'WhatsApp account')}</Field.Label>
              <SingleSelect value={accountId} onChange={setAccountId}>
                {accounts.map((a) => (
                  <SingleSelectOption key={a.id} value={a.id}>
                    {a.name}
                  </SingleSelectOption>
                ))}
              </SingleSelect>
            </Field.Root>
          ) : null}
        </Flex>
      </ConfirmDialog>
    </Dialog.Root>
  );
};

/**
 * Template editor: content per channel with live preview, variables with
 * examples, save with inline validation, and submission to Meta.
 *
 * @returns {JSX.Element} Editor page.
 */
export const TemplateEditorPage = () => {
  const t = useT();
  const api = useApi();
  const act = useAction();
  const rbac = useMgRBAC();
  const navigate = useNavigate();
  const { toggleNotification } = useNotification();
  const { id } = useParams();
  const [params] = useSearchParams();
  const isNew = id === 'new';
  const channels = channelLabels(t);
  const bodyRef = useRef(null);

  const loader = useCallback(() => (isNew ? Promise.resolve(null) : api.get(`/templates/${id}`)), [api, id, isNew]);
  const { data: loaded, error, reload } = useLoad(loader);
  const accountsLoader = useCallback(() => api.get('/accounts'), [api]);
  const { data: accounts } = useLoad(accountsLoader, { enabled: rbac.accounts.read });

  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState(null);
  const [errors, setErrors] = useState({});
  const [keyTouched, setKeyTouched] = useState(false);
  const [busy, setBusy] = useState(false);

  // Reset the form when another template (or "new") is loaded; done during
  // render as React recommends for state derived from changing input.
  const source = isNew ? 'new' : loaded;
  const [seen, setSeen] = useState(undefined);
  if (source && source !== seen) {
    setSeen(source);
    const channel = CHANNELS.includes(params.get('channel')) ? params.get('channel') : 'whatsapp';
    const next = isNew ? emptyTemplate(channel, 'en') : loaded;
    setSaved(next);
    setDraft(next);
  }

  const variables = useMemo(() => (draft ? syncVariables(draft) : []), [draft]);
  const metaAccounts = (accounts || []).filter((a) => a.provider === 'meta' && a.isActive);
  const dirty =
    draft && saved && JSON.stringify(templatePayload(draft, true)) !== JSON.stringify(templatePayload(saved, true));
  const readOnly = !rbac.templates.manage;

  const messages = {
    required: t('form.required', 'This field is required.'),
    invalid: t('editor.error.invalid', 'This value does not have the expected format.'),
    tooLong: t('editor.error.tooLong', 'This text is too long.'),
    https: t('editor.error.https', 'Use a full https:// address.'),
    example: t('editor.error.example', 'Meta needs an example for every variable.'),
  };

  const update = (patch) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setErrors((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(patch)) delete next[key];
      return next;
    });
  };
  const updateContent = (patch, errorKeys = []) => {
    setDraft((prev) => ({ ...prev, content: { ...prev.content, ...patch } }));
    setErrors((prev) => {
      const next = { ...prev };
      for (const key of errorKeys) delete next[key];
      return next;
    });
  };
  const updateVariable = (name, patch) =>
    setDraft((prev) => {
      const list = syncVariables(prev).map((v) => (v.name === name ? { ...v, ...patch } : v));
      return { ...prev, variables: list };
    });
  const updateButton = (index, patch) =>
    updateContent(
      { buttons: draft.content.buttons.map((b, i) => (i === index ? { ...b, ...patch } : b)) },
      Object.keys(patch).map((k) => `content.buttons.${index}.${k}`)
    );

  const showErrors = (found) => {
    setErrors(Object.fromEntries(Object.entries(found).map(([k, code]) => [k, messages[code]])));
    const first = Object.keys(found)[0];
    requestAnimationFrame(() => document.querySelector(`[name="${first}"]`)?.focus());
    toggleNotification({
      type: 'warning',
      message: t('editor.error.fix', 'Fix the highlighted fields first.'),
    });
  };

  const save = async () => {
    const found = validateTemplate(draft);
    if (Object.keys(found).length) return showErrors(found);
    setBusy(true);
    try {
      const body = templatePayload(draft, isNew);
      const result = await act(
        () => (isNew ? api.post('/templates', body) : api.put(`/templates/${id}`, body)),
        t('editor.saved', 'The template was saved.')
      );
      setSaved(result);
      setDraft(result);
      // After the Blocker has seen the saved state, so the redirect is not blocked.
      if (isNew) setTimeout(() => navigate(`${BASE}/${result.id}`, { replace: true }), 0);
    } catch (err) {
      const { code, details } = apiError(err);
      if (code === 'CONFIG_INVALID' && details.field) setErrors({ [details.field]: messages.invalid });
    } finally {
      setBusy(false);
    }
  };

  const submit = async (accountId) => {
    const found = validateTemplate(draft, { forSubmit: true });
    if (Object.keys(found).length) {
      showErrors(found);
      throw new Error('invalid');
    }
    const result = await act(
      () => api.post(`/templates/${id}/submit`, { accountId }),
      t('editor.submitted', 'Submitted. Meta reviews the template now.')
    );
    setSaved(result);
    setDraft(result);
  };

  const insertVariable = () => {
    const names = variables.map((v) => v.name);
    let name;
    if (draft.parameterFormat === 'positional') name = String(names.length + 1);
    else {
      let n = names.length + 1;
      while (names.includes(`variable_${n}`)) n += 1;
      name = `variable_${n}`;
    }
    const token = `{{${name}}}`;
    const el = bodyRef.current;
    const field = draft.channel === 'whatsapp' ? 'body' : 'text';
    const text = draft.content[field] || '';
    const at = el && typeof el.selectionStart === 'number' ? el.selectionStart : text.length;
    updateContent({ [field]: `${text.slice(0, at)}${token}${text.slice(at)}` }, [`content.${field}`]);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(at + token.length, at + token.length);
    });
  };

  if (error && !loaded) {
    return (
      <Layouts.Content>
        <Box paddingTop={8}>
          <ErrorState error={error} onRetry={reload} />
        </Box>
      </Layouts.Content>
    );
  }
  if (!draft) return <LoadingState />;

  const c = draft.content || {};
  const isWa = draft.channel === 'whatsapp';
  const header = c.header?.format || 'NONE';
  const textField = isWa ? 'body' : 'text';
  const textMax = isWa ? LIMITS.body : draft.channel === 'telegram' ? LIMITS.telegram : LIMITS.sms;
  const title = isNew ? t('editor.newTitle', 'New template') : saved?.name || draft.name;
  const approved = !isNew && saved?.approvalStatus;

  return (
    <>
      <Page.Title>{`${title} | MessageGate`}</Page.Title>
      <Layouts.Header
        navigationAction={<BackButton fallback={BASE} />}
        title={title}
        subtitle={
          isNew
            ? t('editor.newSubtitle', 'Write the message once, then send it from code with its key and variables.')
            : `${channels[draft.channel]} · ${draft.language} · ${draft.key}`
        }
        primaryAction={
          readOnly ? null : (
            <Button startIcon={<Check />} onClick={save} loading={busy} disabled={!dirty && !isNew}>
              {t('common.save', 'Save')}
            </Button>
          )
        }
        secondaryAction={
          !isNew && isWa && rbac.templates.submit && metaAccounts.length ? (
            <SubmitAction accounts={metaAccounts} disabled={Boolean(dirty)} onSubmit={submit} />
          ) : null
        }
      />
      <Layouts.Content>
        <Flex direction="column" alignItems="stretch" gap={6}>
          {approved ? (
            <Flex gap={3} alignItems="center" wrap="wrap">
              <ApprovalBadge status={saved.approvalStatus} />
              {isWa && saved.approvalStatus === 'DRAFT' ? (
                <Typography variant="pi" textColor="neutral600">
                  {dirty
                    ? t('editor.status.saveFirst', 'Save, then submit to Meta.')
                    : metaAccounts.length
                      ? t('editor.status.draft', 'Not submitted yet. Meta must approve it before it can be sent.')
                      : t('editor.status.noAccount', 'Connect a WhatsApp account to submit it to Meta.')}
                </Typography>
              ) : null}
              {isWa && saved.approvalStatus === 'APPROVED' && dirty ? (
                <Typography variant="pi" textColor="warning700">
                  {t('editor.status.changed', 'Saving changes resets it to draft; submit it again afterwards.')}
                </Typography>
              ) : null}
            </Flex>
          ) : null}
          {saved?.rejectionReason ? (
            <Notice variant="danger" title={t('editor.rejected', 'Meta rejected this template')}>
              {saved.rejectionReason}
            </Notice>
          ) : null}

          <Grid.Root gap={6}>
            <Grid.Item col={7} s={12} direction="column" alignItems="stretch">
              <Flex direction="column" alignItems="stretch" gap={6}>
                <SectionCard title={t('editor.basics', 'Basics')}>
                  <Grid.Root gap={4}>
                    <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                      <Field.Root name="name" required error={errors.name}>
                        <Field.Label>{t('editor.name', 'Name')}</Field.Label>
                        <TextInput
                          name="name"
                          value={draft.name}
                          maxLength={160}
                          disabled={readOnly}
                          onChange={(e) => {
                            const name = e.target.value;
                            update(isNew && !keyTouched ? { name, key: keyFromName(name) } : { name });
                          }}
                        />
                        <Field.Error />
                      </Field.Root>
                    </Grid.Item>
                    <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                      <Field.Root
                        name="key"
                        required
                        error={errors.key}
                        hint={
                          isNew
                            ? t(
                                'editor.key.hint',
                                'Used in code. Lowercase letters, numbers and "_". Cannot change later.'
                              )
                            : t('editor.key.fixed', 'Fixed after creation.')
                        }
                      >
                        <Field.Label>{t('editor.key', 'Key')}</Field.Label>
                        <TextInput
                          name="key"
                          value={draft.key}
                          maxLength={120}
                          disabled={!isNew || readOnly}
                          onChange={(e) => {
                            setKeyTouched(true);
                            update({ key: e.target.value });
                          }}
                        />
                        <Field.Hint />
                        <Field.Error />
                      </Field.Root>
                    </Grid.Item>
                    <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                      <Field.Root name="channel">
                        <Field.Label>{t('editor.channel', 'Channel')}</Field.Label>
                        <SingleSelect
                          value={draft.channel}
                          disabled={!isNew || readOnly}
                          onChange={(value) => setDraft((prev) => switchChannel(prev, value))}
                        >
                          {CHANNELS.map((ch) => (
                            <SingleSelectOption key={ch} value={ch}>
                              {channels[ch]}
                            </SingleSelectOption>
                          ))}
                        </SingleSelect>
                      </Field.Root>
                    </Grid.Item>
                    <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                      <Field.Root
                        name="language"
                        required
                        error={errors.language}
                        hint={t('editor.language.hint', 'Like de, en or pt_BR. One template per key and language.')}
                      >
                        <Field.Label>{t('editor.language', 'Language')}</Field.Label>
                        <TextInput
                          name="language"
                          value={draft.language}
                          maxLength={6}
                          disabled={!isNew || readOnly}
                          onChange={(e) => update({ language: e.target.value })}
                        />
                        <Field.Hint />
                        <Field.Error />
                      </Field.Root>
                    </Grid.Item>
                    {isWa ? (
                      <>
                        <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                          <Field.Root
                            name="category"
                            hint={t('editor.category.hint', 'Utility: updates the contact expects. Marketing: offers.')}
                          >
                            <Field.Label>{t('editor.category', 'Category')}</Field.Label>
                            <SingleSelect
                              value={draft.category}
                              disabled={readOnly}
                              onChange={(value) => update({ category: value })}
                            >
                              {CATEGORIES.map((cat) => (
                                <SingleSelectOption key={cat} value={cat}>
                                  {
                                    {
                                      UTILITY: t('editor.category.UTILITY', 'Utility'),
                                      MARKETING: t('editor.category.MARKETING', 'Marketing'),
                                      AUTHENTICATION: t('editor.category.AUTHENTICATION', 'Authentication'),
                                    }[cat]
                                  }
                                </SingleSelectOption>
                              ))}
                            </SingleSelect>
                            <Field.Hint />
                          </Field.Root>
                        </Grid.Item>
                        <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                          <Field.Root
                            name="parameterFormat"
                            hint={t('editor.format.hint', 'Named: {named}. Numbered: {numbered}.', {
                              named: '{{first_name}}',
                              numbered: '{{1}}',
                            })}
                          >
                            <Field.Label>{t('editor.format', 'Variable style')}</Field.Label>
                            <SingleSelect
                              value={draft.parameterFormat}
                              disabled={readOnly}
                              onChange={(value) => update({ parameterFormat: value })}
                            >
                              <SingleSelectOption value="named">{t('editor.format.named', 'Named')}</SingleSelectOption>
                              <SingleSelectOption value="positional">
                                {t('editor.format.positional', 'Numbered')}
                              </SingleSelectOption>
                            </SingleSelect>
                            <Field.Hint />
                          </Field.Root>
                        </Grid.Item>
                      </>
                    ) : null}
                  </Grid.Root>
                  <BooleanField
                    name="isActive"
                    label={t('editor.active', 'Active')}
                    hint={t('editor.active.hint', 'Inactive templates cannot be sent.')}
                    checked={draft.isActive}
                    disabled={readOnly}
                    onCheckedChange={(value) => update({ isActive: value })}
                  />
                </SectionCard>

                <SectionCard
                  title={t('editor.content', 'Content')}
                  subtitle={t(
                    'editor.content.subtitle',
                    'Write variables in double curly braces. They are filled when sending.'
                  )}
                >
                  {isWa ? (
                    <Grid.Root gap={4}>
                      <Grid.Item col={header === 'NONE' ? 12 : 6} xs={12} direction="column" alignItems="stretch">
                        <Field.Root name="content.header.format">
                          <Field.Label>{t('editor.header', 'Header')}</Field.Label>
                          <SingleSelect
                            value={header}
                            disabled={readOnly}
                            onChange={(value) =>
                              updateContent({
                                header: value === 'NONE' ? undefined : { format: value, text: c.header?.text },
                              })
                            }
                          >
                            {HEADER_FORMATS.map((f) => (
                              <SingleSelectOption key={f} value={f}>
                                {
                                  {
                                    NONE: t('editor.header.NONE', 'None'),
                                    TEXT: t('editor.header.TEXT', 'Text'),
                                    IMAGE: t('editor.header.IMAGE', 'Image'),
                                    DOCUMENT: t('editor.header.DOCUMENT', 'Document'),
                                    VIDEO: t('editor.header.VIDEO', 'Video'),
                                  }[f]
                                }
                              </SingleSelectOption>
                            ))}
                          </SingleSelect>
                        </Field.Root>
                      </Grid.Item>
                      {header === 'TEXT' ? (
                        <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                          <Field.Root
                            name="content.header.text"
                            required
                            error={errors['content.header.text']}
                            hint={count(c.header?.text, LIMITS.header)}
                          >
                            <Field.Label>{t('editor.header.text', 'Header text')}</Field.Label>
                            <TextInput
                              name="content.header.text"
                              value={c.header?.text || ''}
                              maxLength={LIMITS.header}
                              disabled={readOnly}
                              onChange={(e) =>
                                updateContent({ header: { ...c.header, text: e.target.value } }, [
                                  'content.header.text',
                                ])
                              }
                            />
                            <Field.Hint />
                            <Field.Error />
                          </Field.Root>
                        </Grid.Item>
                      ) : null}
                      {['IMAGE', 'DOCUMENT', 'VIDEO'].includes(header) ? (
                        <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                          <Field.Root
                            name="content.header.mediaId"
                            error={errors['content.header.mediaId']}
                            hint={t(
                              'editor.header.media.hint',
                              'Optional sample media ID from Meta. Real media is sent per message.'
                            )}
                          >
                            <Field.Label>{t('editor.header.media', 'Sample media ID')}</Field.Label>
                            <TextInput
                              name="content.header.mediaId"
                              value={c.header?.mediaId || ''}
                              disabled={readOnly}
                              onChange={(e) =>
                                updateContent({ header: { ...c.header, mediaId: e.target.value } }, [
                                  'content.header.mediaId',
                                ])
                              }
                            />
                            <Field.Hint />
                            <Field.Error />
                          </Field.Root>
                        </Grid.Item>
                      ) : null}
                    </Grid.Root>
                  ) : null}

                  <Field.Root
                    name={`content.${textField}`}
                    required
                    error={errors[`content.${textField}`]}
                    hint={count(c[textField], textMax)}
                  >
                    <Flex justifyContent="space-between" alignItems="flex-end" gap={2}>
                      <Field.Label>{isWa ? t('editor.body', 'Body') : t('editor.text', 'Text')}</Field.Label>
                      {!readOnly ? (
                        <Button variant="tertiary" size="S" startIcon={<Plus />} onClick={insertVariable}>
                          {t('editor.insertVariable', 'Insert variable')}
                        </Button>
                      ) : null}
                    </Flex>
                    <Textarea
                      ref={bodyRef}
                      name={`content.${textField}`}
                      value={c[textField] || ''}
                      maxLength={textMax}
                      disabled={readOnly}
                      onChange={(e) => updateContent({ [textField]: e.target.value }, [`content.${textField}`])}
                    />
                    <Field.Hint />
                    <Field.Error />
                  </Field.Root>

                  {isWa ? (
                    <>
                      <Field.Root
                        name="content.footer"
                        error={errors['content.footer']}
                        hint={count(c.footer, LIMITS.footer)}
                      >
                        <Field.Label>{t('editor.footer', 'Footer (optional)')}</Field.Label>
                        <TextInput
                          name="content.footer"
                          value={c.footer || ''}
                          maxLength={LIMITS.footer}
                          disabled={readOnly}
                          onChange={(e) => updateContent({ footer: e.target.value }, ['content.footer'])}
                        />
                        <Field.Hint />
                        <Field.Error />
                      </Field.Root>

                      <Flex direction="column" alignItems="stretch" gap={3}>
                        <Typography variant="sigma" textColor="neutral600" tag="h3">
                          {t('editor.buttons', 'Buttons')}
                        </Typography>
                        {(c.buttons || []).map((b, i) => (
                          <Box key={i} background="neutral100" hasRadius padding={4}>
                            <Grid.Root gap={3}>
                              <Grid.Item col={4} xs={12} direction="column" alignItems="stretch">
                                <Field.Root name={`content.buttons.${i}.type`}>
                                  <Field.Label>{t('editor.button.type', 'Type')}</Field.Label>
                                  <SingleSelect
                                    value={b.type}
                                    disabled={readOnly}
                                    onChange={(value) => updateButton(i, { type: value })}
                                  >
                                    {BUTTON_TYPES.map((type) => (
                                      <SingleSelectOption key={type} value={type}>
                                        {
                                          {
                                            QUICK_REPLY: t('editor.button.QUICK_REPLY', 'Quick reply'),
                                            URL: t('editor.button.URL', 'Link'),
                                            COPY_CODE: t('editor.button.COPY_CODE', 'Copy code'),
                                          }[type]
                                        }
                                      </SingleSelectOption>
                                    ))}
                                  </SingleSelect>
                                </Field.Root>
                              </Grid.Item>
                              <Grid.Item col={7} xs={10} direction="column" alignItems="stretch">
                                <Field.Root
                                  name={`content.buttons.${i}.text`}
                                  required
                                  error={errors[`content.buttons.${i}.text`]}
                                >
                                  <Field.Label>{t('editor.button.text', 'Label')}</Field.Label>
                                  <TextInput
                                    name={`content.buttons.${i}.text`}
                                    value={b.text || ''}
                                    maxLength={LIMITS.button}
                                    disabled={readOnly}
                                    onChange={(e) => updateButton(i, { text: e.target.value })}
                                  />
                                  <Field.Error />
                                </Field.Root>
                              </Grid.Item>
                              <Grid.Item
                                col={1}
                                xs={2}
                                direction="column"
                                alignItems="flex-end"
                                justifyContent="flex-end"
                              >
                                {!readOnly ? (
                                  <Box paddingTop={6}>
                                    <IconButton
                                      label={t('editor.button.remove', 'Remove button {n}', { n: i + 1 })}
                                      variant="ghost"
                                      onClick={() => updateContent({ buttons: c.buttons.filter((_, j) => j !== i) })}
                                    >
                                      <Trash />
                                    </IconButton>
                                  </Box>
                                ) : null}
                              </Grid.Item>
                              {b.type === 'URL' ? (
                                <Grid.Item col={12} direction="column" alignItems="stretch">
                                  <Field.Root
                                    name={`content.buttons.${i}.url`}
                                    required
                                    error={errors[`content.buttons.${i}.url`]}
                                    hint={t('editor.button.url.hint', 'May end with one variable, e.g. {example}.', {
                                      example: 'https://shop.example/orders/{{order_id}}',
                                    })}
                                  >
                                    <Field.Label>{t('editor.button.url', 'Address')}</Field.Label>
                                    <TextInput
                                      name={`content.buttons.${i}.url`}
                                      type="url"
                                      value={b.url || ''}
                                      disabled={readOnly}
                                      onChange={(e) => updateButton(i, { url: e.target.value })}
                                    />
                                    <Field.Hint />
                                    <Field.Error />
                                  </Field.Root>
                                </Grid.Item>
                              ) : null}
                              {b.type === 'COPY_CODE' ? (
                                <Grid.Item col={12} direction="column" alignItems="stretch">
                                  <Field.Root
                                    name={`content.buttons.${i}.variable`}
                                    hint={t(
                                      'editor.button.variable.hint',
                                      'Variable that holds the code, e.g. coupon_code.'
                                    )}
                                  >
                                    <Field.Label>{t('editor.button.variable', 'Code variable')}</Field.Label>
                                    <TextInput
                                      name={`content.buttons.${i}.variable`}
                                      value={b.variable || ''}
                                      maxLength={60}
                                      disabled={readOnly}
                                      onChange={(e) => updateButton(i, { variable: e.target.value })}
                                    />
                                    <Field.Hint />
                                  </Field.Root>
                                </Grid.Item>
                              ) : null}
                            </Grid.Root>
                          </Box>
                        ))}
                        {!readOnly && (c.buttons || []).length < LIMITS.buttons ? (
                          <Box>
                            <Button
                              variant="secondary"
                              startIcon={<Plus />}
                              onClick={() =>
                                updateContent({ buttons: [...(c.buttons || []), { type: 'QUICK_REPLY', text: '' }] })
                              }
                            >
                              {t('editor.button.add', 'Add button')}
                            </Button>
                          </Box>
                        ) : null}
                      </Flex>
                    </>
                  ) : null}
                </SectionCard>

                <SectionCard
                  title={t('editor.variables', 'Variables')}
                  subtitle={t(
                    'editor.variables.subtitle',
                    'Found in the content automatically. Examples fill the preview and are required by Meta for review.'
                  )}
                >
                  {variables.length === 0 ? (
                    <Typography textColor="neutral600">
                      {t('editor.variables.none', 'No variables yet. Use "Insert variable" or type {example}.', {
                        example: '{{first_name}}',
                      })}
                    </Typography>
                  ) : (
                    <Flex direction="column" alignItems="stretch" gap={4}>
                      {variables.map((v) => (
                        <Grid.Root key={v.name} gap={3}>
                          <Grid.Item col={12}>
                            <Typography fontWeight="bold" textColor="neutral800">{`{{${v.name}}}`}</Typography>
                          </Grid.Item>
                          <Grid.Item col={5} xs={12} direction="column" alignItems="stretch">
                            <Field.Root name={`variables.${v.name}.label`}>
                              <Field.Label>{t('editor.variable.label', 'Label')}</Field.Label>
                              <TextInput
                                value={v.label || ''}
                                maxLength={80}
                                disabled={readOnly}
                                onChange={(e) => updateVariable(v.name, { label: e.target.value })}
                              />
                            </Field.Root>
                          </Grid.Item>
                          <Grid.Item col={5} xs={12} direction="column" alignItems="stretch">
                            <Field.Root
                              name={`variables.${v.name}.example`}
                              error={errors[`variables.${v.name}.example`]}
                            >
                              <Field.Label>{t('editor.variable.example', 'Example')}</Field.Label>
                              <TextInput
                                name={`variables.${v.name}.example`}
                                value={v.example || ''}
                                maxLength={200}
                                disabled={readOnly}
                                onChange={(e) => {
                                  updateVariable(v.name, { example: e.target.value });
                                  setErrors((prev) => ({ ...prev, [`variables.${v.name}.example`]: undefined }));
                                }}
                              />
                              <Field.Error />
                            </Field.Root>
                          </Grid.Item>
                          <Grid.Item
                            col={2}
                            xs={12}
                            direction="column"
                            alignItems="flex-start"
                            justifyContent="flex-end"
                          >
                            <Box paddingTop={{ initial: 0, medium: 6 }}>
                              <Checkbox
                                checked={v.required !== false}
                                disabled={readOnly}
                                onCheckedChange={(value) => updateVariable(v.name, { required: value === true })}
                              >
                                {t('editor.variable.required', 'Required')}
                              </Checkbox>
                            </Box>
                          </Grid.Item>
                        </Grid.Root>
                      ))}
                    </Flex>
                  )}
                </SectionCard>
              </Flex>
            </Grid.Item>
            <Grid.Item col={5} s={12} direction="column" alignItems="stretch">
              <Box position="sticky" top={4} width="100%">
                <SectionCard title={t('editor.preview', 'Preview')}>
                  <TemplatePreview draft={{ ...draft, variables }} />
                </SectionCard>
              </Box>
            </Grid.Item>
          </Grid.Root>
        </Flex>
      </Layouts.Content>
      {!readOnly ? <UnsavedBlocker saved={saved} draft={draft} /> : null}
    </>
  );
};

export default TemplateEditorPage;
