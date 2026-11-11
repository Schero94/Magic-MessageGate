import { useCallback, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Field,
  Flex,
  Grid,
  Modal,
  SingleSelect,
  SingleSelectOption,
  Textarea,
  TextInput,
  Typography,
} from '@strapi/design-system';
import { PaperPlane } from '@strapi/icons';

import { BooleanField } from '../../components/ui/BooleanField';
import { useAction } from '../../hooks/useAction';
import { useApi } from '../../hooks/useApi';
import { useLoad } from '../../hooks/useLoad';
import { useMgRBAC } from '../../hooks/useMgRBAC';
import { useT } from '../../hooks/useT';
import { apiError } from '../../utils/apiError';
import { CHANNELS, channelLabels } from '../../utils/channels';
import { renderText, templateVariables } from '../../utils/templatePreview.mjs';
import { validateSend } from '../../utils/send.mjs';

const FREE_TEXT = '__text';

/**
 * Send one message by hand (tests, support replies). The same rules apply
 * as for code: consent, routing, templates outside the 24-hour window.
 *
 * @param {{ onClose: () => void, onSent: () => void, defaultPhone?: string }} props - Props.
 * @returns {JSX.Element} Modal.
 */
export const SendMessageModal = ({ onClose, onSent, defaultPhone = '' }) => {
  const t = useT();
  const api = useApi();
  const act = useAction();
  const rbac = useMgRBAC();
  const [form, setForm] = useState({
    to: defaultPhone,
    channel: 'auto',
    template: '',
    language: '',
    text: '',
    variables: {},
    transactional: true,
  });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);

  const loader = useCallback(() => api.get('/templates'), [api]);
  const { data: templates } = useLoad(loader, { enabled: rbac.templates.read });
  const channels = channelLabels(t);

  const usable = useMemo(
    () =>
      (templates || []).filter(
        (tpl) =>
          tpl.isActive && tpl.approvalStatus === 'APPROVED' && (form.channel === 'auto' || tpl.channel === form.channel)
      ),
    [templates, form.channel]
  );
  const keys = [...new Set(usable.map((tpl) => tpl.key))];
  // A key can exist per channel and language. Languages are offered once;
  // the preview shows the variant of the first channel in routing order and
  // the form asks for the variables of every channel variant of that language.
  const byChannel = (a, b) => CHANNELS.indexOf(a.channel) - CHANNELS.indexOf(b.channel);
  const variants = usable.filter((tpl) => tpl.key === form.template).sort(byChannel);
  const languages = [...new Set(variants.map((tpl) => tpl.language))];
  const language = languages.includes(form.language) ? form.language : languages[0];
  const sameLanguage = variants.filter((tpl) => tpl.language === language);
  const selected = sameLanguage[0] || null;
  const variables = [];
  for (const tpl of sameLanguage) {
    const defs = tpl.variables?.length
      ? tpl.variables
      : templateVariables(tpl).map((name) => ({ name, required: true }));
    for (const v of defs) if (!variables.some((x) => x.name === v.name)) variables.push(v);
  }
  const isText = form.template === FREE_TEXT || !rbac.templates.read;

  const set = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: undefined }));
  };

  const messages = {
    required: t('form.required', 'This field is required.'),
    phone: t('send.error.phone', 'Enter the number with country code, for example +49 151 23456789.'),
    content: t('send.error.content', 'Choose a template or write a text.'),
  };

  const submit = async (event) => {
    event.preventDefault();
    const found = validateSend({ ...form, isText, variables: form.variables }, variables);
    if (Object.keys(found).length) {
      setErrors(Object.fromEntries(Object.entries(found).map(([k, code]) => [k, messages[code] || messages.required])));
      return;
    }
    const body = {
      to: form.to.trim(),
      channel: form.channel,
      transactional: form.transactional,
    };
    if (isText) body.text = form.text.trim();
    else {
      body.template = form.template;
      if (language) body.language = language;
      body.variables = Object.fromEntries(
        variables.map((v) => [v.name, String(form.variables[v.name] ?? '').trim()]).filter(([, value]) => value)
      );
    }
    setBusy(true);
    try {
      await act(
        () => api.post('/messages', body),
        t('send.done', 'The message is queued. Its status updates in the list.')
      );
      onSent();
      onClose();
    } catch (error) {
      const { code, details } = apiError(error);
      if (code === 'INVALID_PHONE') setErrors({ to: messages.phone });
      if ((code === 'MISSING_VARIABLE' || code === 'INVALID_VARIABLE') && details.variable)
        setErrors({ [`var.${details.variable}`]: messages.required });
    } finally {
      setBusy(false);
    }
  };

  const preview = selected
    ? renderText(
        selected.content?.body ?? selected.content?.text ?? '',
        form.variables,
        Object.fromEntries((selected.variables || []).map((v) => [v.name, v.example || ''])),
        selected.parameterFormat === 'positional' ? 'positional' : 'named'
      )
    : form.text;

  return (
    <Modal.Root open onOpenChange={(open) => !open && !busy && onClose()}>
      <Modal.Content>
        <form onSubmit={submit} noValidate>
          <Modal.Header>
            <Modal.Title>{t('send.title', 'Send a message')}</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <Flex direction="column" alignItems="stretch" gap={5}>
              <Grid.Root gap={4}>
                <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                  <Field.Root
                    name="to"
                    required
                    error={errors.to}
                    hint={t('send.to.hint', 'With country code. Numbers without one use the default country.')}
                  >
                    <Field.Label>{t('send.to', 'Phone number')}</Field.Label>
                    <TextInput
                      type="tel"
                      autoComplete="off"
                      value={form.to}
                      placeholder="+49 151 23456789"
                      onChange={(event) => set('to', event.target.value)}
                    />
                    <Field.Hint />
                    <Field.Error />
                  </Field.Root>
                </Grid.Item>
                <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                  <Field.Root
                    name="channel"
                    hint={t('send.channel.hint', 'Automatic follows the routing chain from the settings.')}
                  >
                    <Field.Label>{t('send.channel', 'Channel')}</Field.Label>
                    <SingleSelect value={form.channel} onChange={(value) => set('channel', value)}>
                      <SingleSelectOption value="auto">{t('send.channel.auto', 'Automatic')}</SingleSelectOption>
                      {CHANNELS.map((c) => (
                        <SingleSelectOption key={c} value={c}>
                          {channels[c]}
                        </SingleSelectOption>
                      ))}
                    </SingleSelect>
                    <Field.Hint />
                  </Field.Root>
                </Grid.Item>
                {rbac.templates.read ? (
                  <Grid.Item col={languages.length > 1 ? 6 : 12} xs={12} direction="column" alignItems="stretch">
                    <Field.Root name="template" required error={errors.template}>
                      <Field.Label>{t('send.template', 'Content')}</Field.Label>
                      <SingleSelect
                        value={form.template}
                        placeholder={t('send.template.placeholder', 'Choose a template')}
                        onChange={(value) => {
                          set('template', value);
                          set('language', '');
                          set('variables', {});
                        }}
                      >
                        {keys.map((key) => (
                          <SingleSelectOption key={key} value={key}>
                            {usable.filter((tpl) => tpl.key === key).sort(byChannel)[0]?.name || key}
                          </SingleSelectOption>
                        ))}
                        <SingleSelectOption value={FREE_TEXT}>
                          {t('send.freeText', 'Free text (only within 24 hours of a reply on WhatsApp)')}
                        </SingleSelectOption>
                      </SingleSelect>
                      <Field.Error />
                    </Field.Root>
                  </Grid.Item>
                ) : null}
                {languages.length > 1 ? (
                  <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                    <Field.Root name="language">
                      <Field.Label>{t('send.language', 'Language')}</Field.Label>
                      <SingleSelect value={language} onChange={(value) => set('language', value)}>
                        {languages.map((code) => (
                          <SingleSelectOption key={code} value={code}>
                            {code}
                          </SingleSelectOption>
                        ))}
                      </SingleSelect>
                    </Field.Root>
                  </Grid.Item>
                ) : null}
                {variables.map((v) => (
                  <Grid.Item key={v.name} col={6} xs={12} direction="column" alignItems="stretch">
                    <Field.Root name={`var.${v.name}`} required={v.required !== false} error={errors[`var.${v.name}`]}>
                      <Field.Label>{v.label || v.name}</Field.Label>
                      <TextInput
                        value={form.variables[v.name] ?? ''}
                        placeholder={v.example || ''}
                        maxLength={v.maxLength || 1024}
                        onChange={(event) => {
                          setForm((prev) => ({
                            ...prev,
                            variables: { ...prev.variables, [v.name]: event.target.value },
                          }));
                          setErrors((prev) => ({ ...prev, [`var.${v.name}`]: undefined }));
                        }}
                      />
                      <Field.Error />
                    </Field.Root>
                  </Grid.Item>
                ))}
                {isText ? (
                  <Grid.Item col={12} direction="column" alignItems="stretch">
                    <Field.Root name="text" required error={errors.text}>
                      <Field.Label>{t('send.text', 'Text')}</Field.Label>
                      <Textarea
                        value={form.text}
                        maxLength={4096}
                        onChange={(event) => set('text', event.target.value)}
                      />
                      <Field.Error />
                    </Field.Root>
                  </Grid.Item>
                ) : null}
              </Grid.Root>
              <BooleanField
                name="transactional"
                label={t('send.transactional', 'Transactional')}
                hint={t(
                  'send.transactional.hint',
                  'Order updates, codes and reminders the contact asked for. With an authentication template it is sent without recorded consent.'
                )}
                checked={form.transactional}
                onCheckedChange={(value) => set('transactional', value)}
              />
              {preview ? (
                <Box background="neutral100" hasRadius padding={4}>
                  <Typography variant="sigma" textColor="neutral600" tag="p">
                    {t('send.preview', 'Preview')}
                  </Typography>
                  <Box paddingTop={2}>
                    <Typography textColor="neutral800" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                      {preview}
                    </Typography>
                  </Box>
                </Box>
              ) : null}
            </Flex>
          </Modal.Body>
          <Modal.Footer>
            <Modal.Close>
              <Button variant="tertiary" disabled={busy}>
                {t('common.cancel', 'Cancel')}
              </Button>
            </Modal.Close>
            <Button type="submit" startIcon={<PaperPlane />} loading={busy}>
              {t('send.submit', 'Send')}
            </Button>
          </Modal.Footer>
        </form>
      </Modal.Content>
    </Modal.Root>
  );
};
