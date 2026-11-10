import { useCallback, useRef, useState } from 'react';
import { Box, Button, Field, Flex, Grid, Modal, TextInput, Typography } from '@strapi/design-system';
import { ArrowLeft, Check, Cross, Eye, Message, Paperclip, PaperPlane, Phone } from '@strapi/icons';

import { BooleanField } from '../../components/ui/BooleanField';
import { CopyField } from '../../components/ui/CopyField';
import { Notice } from '../../components/ui/Notice';
import { useAction } from '../../hooks/useAction';
import { useApi } from '../../hooks/useApi';
import { useEmbeddedSignup } from '../../hooks/useEmbeddedSignup';
import { useLoad } from '../../hooks/useLoad';
import { ToneBadge } from '../../components/ui/StatusBadge';
import { useT } from '../../hooks/useT';
import { apiError, errorMessage } from '../../utils/apiError';
import { providerLabels } from '../../utils/channels';
import { PROVIDER_CHANNEL, PROVIDER_FIELDS, credentialPayload, validateCredentials } from '../../utils/providers.mjs';
import { reasonText } from '../../utils/reasons';

/**
 * Translated label and hint per credential field. Hints say where the value is found.
 *
 * @param {(id: string, def: string) => string} t - Translator.
 * @returns {Record<string, {label: string, hint: string}>} Texts.
 */
const fieldTexts = (t) => ({
  phoneNumberId: {
    label: t('accounts.field.phoneNumberId', 'Phone number ID'),
    hint: t('accounts.field.phoneNumberId.hint', 'Meta App Dashboard > WhatsApp > API Setup.'),
  },
  wabaId: {
    label: t('accounts.field.wabaId', 'WhatsApp Business Account ID'),
    hint: t('accounts.field.wabaId.hint', 'Shown next to the phone number ID in API Setup.'),
  },
  accessToken: {
    label: t('accounts.field.accessToken', 'Access token'),
    hint: t('accounts.field.accessToken.hint', 'A permanent system user token with whatsapp_business_messaging.'),
  },
  appSecret: {
    label: t('accounts.field.appSecret', 'App secret'),
    hint: t('accounts.field.appSecret.hint', 'App settings > Basic. Used to verify webhook signatures.'),
  },
  botToken: {
    label: t('accounts.field.botToken', 'Bot token'),
    hint: t('accounts.field.botToken.hint', 'From @BotFather after /newbot.'),
  },
  apiKey: {
    label: t('accounts.field.apiKey', 'API key'),
    hint: t('accounts.field.apiKey.hint', 'seven.io dashboard > Developer > API keys.'),
  },
  signingKey: {
    label: t('accounts.field.signingKey', 'Signing key'),
    hint: t('accounts.field.signingKey.hint', 'seven.io dashboard > Developer > Webhooks. Verifies delivery reports.'),
  },
  senderId: {
    label: t('accounts.field.senderId', 'Sender ID'),
    hint: t('accounts.field.senderId.hint', 'Up to 11 letters or a phone number. Optional.'),
  },
  accountSid: {
    label: t('accounts.field.accountSid', 'Account SID'),
    hint: t('accounts.field.accountSid.hint', 'Twilio Console > Account info.'),
  },
  authToken: {
    label: t('accounts.field.authToken', 'Auth token'),
    hint: t('accounts.field.authToken.hint', 'Twilio Console > Account info. Also verifies status callbacks.'),
  },
  from: {
    label: t('accounts.field.from', 'Sender number or name'),
    hint: t('accounts.field.from.hint', 'A Twilio number in E.164 format, or set a messaging service below.'),
  },
  messagingServiceSid: {
    label: t('accounts.field.messagingServiceSid', 'Messaging service SID'),
    hint: t('accounts.field.messagingServiceSid.hint', 'Optional instead of a sender number.'),
  },
});

/**
 * Large choice tile (native button) for the first wizard step.
 *
 * @param {{ icon: JSX.Element, title: string, text: string, onClick: () => void, autoFocus?: boolean }} props - Props.
 * @returns {JSX.Element} Tile.
 */
const ChoiceTile = ({ icon, title, text, onClick, autoFocus }) => (
  <Box
    tag="button"
    type="button"
    onClick={onClick}
    autoFocus={autoFocus}
    width="100%"
    height="100%"
    padding={5}
    hasRadius
    background="neutral0"
    borderColor="neutral200"
    textAlign="left"
    cursor="pointer"
  >
    <Flex gap={4} alignItems="flex-start">
      <Flex
        shrink={0}
        width="4rem"
        height="4rem"
        hasRadius
        background="primary100"
        justifyContent="center"
        alignItems="center"
        aria-hidden
      >
        {icon}
      </Flex>
      <Flex direction="column" alignItems="flex-start" gap={1}>
        <Typography fontWeight="bold" textColor="neutral800">
          {title}
        </Typography>
        <Typography variant="pi" textColor="neutral600">
          {text}
        </Typography>
      </Flex>
    </Flex>
  </Box>
);

/**
 * Wizard to connect or edit an account: choose the channel, connect
 * (Embedded Signup for WhatsApp, credentials otherwise), then the connection
 * is tested and the webhook URL shown.
 *
 * @param {object} props - Props.
 * @param {'create' | 'edit'} props.mode - Mode.
 * @param {object} [props.account] - Account DTO in edit mode.
 * @param {(channel: string) => boolean} props.hasDefault - Whether the channel already has a default account.
 * @param {() => void} props.onClose - Close.
 * @param {() => void} props.onSaved - Reload the list.
 * @returns {JSX.Element} Modal.
 */
export const AccountWizard = ({ mode, account, hasDefault, onClose, onSaved }) => {
  const t = useT();
  const api = useApi();
  const act = useAction();
  const providers = providerLabels(t);
  const texts = fieldTexts(t);
  const [current, setCurrent] = useState(mode === 'edit' ? account : null);
  const editing = Boolean(current);
  const [step, setStep] = useState(editing ? 'credentials' : 'channel');
  const [provider, setProvider] = useState(account?.provider || null);
  const [form, setForm] = useState(() => ({
    name: account?.name || '',
    isDefault: account?.isDefault ?? false,
    isActive: account?.isActive ?? true,
    values: { ...(account?.config || {}) },
  }));
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [signupError, setSignupError] = useState(null);
  const [verifyToken, setVerifyToken] = useState(null);
  const titleRef = useRef(null);

  const signupLoader = useCallback(() => api.get('/accounts/embedded-signup'), [api]);
  const { data: signupConfig } = useLoad(signupLoader, { enabled: mode === 'create' });
  const signup = useEmbeddedSignup(signupConfig || { enabled: false });

  const go = (next) => {
    setStep(next);
    setErrors({});
    requestAnimationFrame(() => titleRef.current?.focus());
  };

  const choose = (next) => {
    setProvider(next);
    setForm((prev) => ({
      ...prev,
      name: prev.name || providers[next],
      isDefault: !hasDefault(PROVIDER_CHANNEL[next]),
    }));
    go(next === 'meta' && signupConfig?.enabled ? 'whatsapp' : 'credentials');
  };

  const messages = {
    required: t('form.required', 'This field is required.'),
    invalid: t('accounts.error.format', 'This value does not have the expected format.'),
  };

  const testAndFinish = async (saved, extra = {}) => {
    let test;
    try {
      test = await api.post(`/accounts/${saved.id}/test`);
    } catch (error) {
      test = { ok: false, code: apiError(error).code };
    }
    onSaved();
    setCurrent(saved);
    setResult({ account: saved, test, ...extra });
    go('result');
  };

  const save = async (event) => {
    event.preventDefault();
    const found = validateCredentials(provider, form.values, current?.secretsSet);
    if (!form.name.trim()) found.name = 'required';
    if (Object.keys(found).length) {
      setErrors(Object.fromEntries(Object.entries(found).map(([key, code]) => [key, messages[code]])));
      const first = Object.keys(found)[0];
      requestAnimationFrame(() => document.querySelector(`[name="${first}"]`)?.focus());
      return;
    }
    const body = {
      name: form.name.trim(),
      isDefault: form.isDefault,
      isActive: form.isActive,
      config: credentialPayload(provider, form.values),
    };
    setBusy(true);
    try {
      const saved = await act(() =>
        editing
          ? api.put(`/accounts/${current.id}`, body)
          : api.post('/accounts', { ...body, channel: PROVIDER_CHANNEL[provider], provider })
      );
      await testAndFinish(saved);
    } catch (error) {
      const { code, details } = apiError(error);
      if (code === 'CONFIG_INVALID' && details.field) setErrors({ [details.field]: messages.invalid });
    } finally {
      setBusy(false);
    }
  };

  const connectMeta = async () => {
    setSignupError(null);
    let session;
    try {
      session = await signup.launch();
    } catch (error) {
      if (error?.message !== 'CANCELLED')
        setSignupError(
          error?.message === 'NO_NUMBER'
            ? t(
                'accounts.signup.noNumber',
                'The Meta flow finished without a phone number. Start again and add a number.'
              )
            : t(
                'accounts.signup.failed',
                'Meta did not finish the connection. Try again or enter the credentials by hand.'
              )
        );
      return;
    }
    setBusy(true);
    try {
      const done = await api.post('/accounts/embedded-signup', {
        ...session,
        name: form.name.trim() || providers.meta,
        isDefault: form.isDefault,
      });
      await testAndFinish(done.account, { steps: done.steps });
    } catch (error) {
      setSignupError(errorMessage(t, error));
    } finally {
      setBusy(false);
    }
  };

  const revealToken = async () => {
    try {
      const data = await act(() => api.post(`/accounts/${result.account.id}/verify-token`));
      setVerifyToken(data?.verifyToken || null);
    } catch {
      // notified
    }
  };

  const title =
    step === 'result'
      ? result?.test?.ok
        ? t('accounts.wizard.doneTitle', 'Connected')
        : t('accounts.wizard.checkTitle', 'Saved, but the test failed')
      : editing
        ? t('accounts.wizard.editTitle', 'Edit {name}', { name: current.name })
        : t('accounts.wizard.title', 'Connect a channel');

  const stepNames = {
    exchange: t('accounts.signup.step.exchange', 'Access token received'),
    subscribe: t('accounts.signup.step.subscribe', 'Webhooks subscribed'),
    register: t('accounts.signup.step.register', 'Number registered for the Cloud API'),
    contactsSync: t('accounts.signup.step.contactsSync', 'Business App contacts synced'),
    historySync: t('accounts.signup.step.historySync', 'Business App chat history requested'),
  };

  const back =
    mode === 'create' && !current && (step === 'credentials' || step === 'whatsapp') ? (
      <Button
        variant="tertiary"
        startIcon={<ArrowLeft />}
        onClick={() =>
          go(step === 'credentials' && provider === 'meta' && signupConfig?.enabled ? 'whatsapp' : 'channel')
        }
        disabled={busy}
      >
        {t('common.back', 'Back')}
      </Button>
    ) : (
      <Modal.Close>
        <Button variant="tertiary" disabled={busy}>
          {step === 'result' ? t('common.close', 'Close') : t('common.cancel', 'Cancel')}
        </Button>
      </Modal.Close>
    );

  return (
    <Modal.Root open onOpenChange={(open) => !open && !busy && onClose()}>
      <Modal.Content>
        <form onSubmit={save} noValidate>
          <Modal.Header>
            <Modal.Title ref={titleRef} tabIndex={-1}>
              {title}
            </Modal.Title>
          </Modal.Header>
          <Modal.Body>
            {step === 'channel' ? (
              <Flex direction="column" alignItems="stretch" gap={4}>
                <Typography textColor="neutral600">
                  {t('accounts.wizard.choose', 'Which channel do you want to connect?')}
                </Typography>
                <Grid.Root gap={3}>
                  <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                    <ChoiceTile
                      autoFocus
                      icon={<Message fill="primary600" />}
                      title={t('channel.whatsapp', 'WhatsApp')}
                      text={t(
                        'accounts.wizard.whatsapp',
                        'Official Cloud API by Meta. Templates, delivery and read receipts.'
                      )}
                      onClick={() => choose('meta')}
                    />
                  </Grid.Item>
                  <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                    <ChoiceTile
                      icon={<PaperPlane fill="primary600" />}
                      title={t('channel.telegram', 'Telegram')}
                      text={t('accounts.wizard.telegram', 'A bot from @BotFather. Free, contacts link once.')}
                      onClick={() => choose('telegram')}
                    />
                  </Grid.Item>
                  <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                    <ChoiceTile
                      icon={<Phone fill="primary600" />}
                      title={t('accounts.wizard.seven', 'SMS with seven.io')}
                      text={t('accounts.wizard.seven.text', 'German provider, servers in the EU.')}
                      onClick={() => choose('seven')}
                    />
                  </Grid.Item>
                  <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                    <ChoiceTile
                      icon={<Phone fill="primary600" />}
                      title={t('accounts.wizard.twilio', 'SMS with Twilio')}
                      text={t('accounts.wizard.twilio.text', 'Worldwide SMS, also used for number lookups.')}
                      onClick={() => choose('twilio')}
                    />
                  </Grid.Item>
                </Grid.Root>
              </Flex>
            ) : null}

            {step === 'whatsapp' ? (
              <Flex direction="column" alignItems="stretch" gap={5}>
                <Typography textColor="neutral700">
                  {t(
                    'accounts.signup.intro',
                    'Meta opens a window. Choose your business, then either add a new number (SMS code) or pick "WhatsApp Business App" and scan the QR code with the app. The app keeps working on your phone.'
                  )}
                </Typography>
                <Field.Root name="name" required error={errors.name}>
                  <Field.Label>{t('accounts.name', 'Name')}</Field.Label>
                  <TextInput
                    value={form.name}
                    onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                  />
                  <Field.Error />
                </Field.Root>
                {signup.status === 'blocked' ? (
                  <Notice variant="warning" title={t('accounts.signup.blockedTitle', 'The Meta window cannot load')}>
                    {t(
                      'accounts.signup.blocked',
                      'The browser or the admin content security policy blocks connect.facebook.net. Allow it (see README) or enter the credentials by hand.'
                    )}
                  </Notice>
                ) : null}
                {signupError ? (
                  <Notice variant="danger" role="alert">
                    {signupError}
                  </Notice>
                ) : null}
                <Flex gap={3} wrap="wrap">
                  <Button
                    size="L"
                    startIcon={<Message />}
                    onClick={connectMeta}
                    loading={busy || signup.status === 'loading'}
                    disabled={signup.status !== 'ready'}
                  >
                    {t('accounts.signup.button', 'Connect with Meta')}
                  </Button>
                  <Button size="L" variant="tertiary" startIcon={<Paperclip />} onClick={() => go('credentials')}>
                    {t('accounts.signup.manual', 'Enter credentials by hand')}
                  </Button>
                </Flex>
                <Typography variant="pi" textColor="neutral600">
                  {t(
                    'accounts.signup.coexistenceHint',
                    'Business App numbers need app version 2.24.17 or later. Groups, broadcast lists and disappearing messages stop working for that number. Contacts and history sync within 24 hours.'
                  )}
                </Typography>
              </Flex>
            ) : null}

            {step === 'credentials' && provider ? (
              <Flex direction="column" alignItems="stretch" gap={5}>
                <Typography textColor="neutral600">{providers[provider]}</Typography>
                <Grid.Root gap={4}>
                  <Grid.Item col={12} direction="column" alignItems="stretch">
                    <Field.Root
                      name="name"
                      required
                      error={errors.name}
                      hint={t('accounts.name.hint', 'Shown in the admin only, e.g. "Support line DE".')}
                    >
                      <Field.Label>{t('accounts.name', 'Name')}</Field.Label>
                      <TextInput
                        value={form.name}
                        maxLength={120}
                        onChange={(e) => {
                          setForm((prev) => ({ ...prev, name: e.target.value }));
                          setErrors((prev) => ({ ...prev, name: undefined }));
                        }}
                      />
                      <Field.Hint />
                      <Field.Error />
                    </Field.Root>
                  </Grid.Item>
                  {PROVIDER_FIELDS[provider].map((field) => {
                    const stored = field.secret && current?.secretsSet?.[field.name];
                    return (
                      <Grid.Item key={field.name} col={6} xs={12} direction="column" alignItems="stretch">
                        <Field.Root
                          name={field.name}
                          required={field.required && !stored}
                          error={errors[field.name]}
                          hint={
                            stored
                              ? t('accounts.field.stored', 'Stored. Leave empty to keep it.')
                              : texts[field.name]?.hint
                          }
                        >
                          <Field.Label>{texts[field.name]?.label || field.name}</Field.Label>
                          <TextInput
                            name={field.name}
                            type={field.secret ? 'password' : 'text'}
                            autoComplete={field.secret ? 'new-password' : 'off'}
                            spellCheck={false}
                            value={form.values[field.name] ?? ''}
                            placeholder={stored ? '••••••••' : field.placeholder}
                            onChange={(e) => {
                              const value = e.target.value;
                              setForm((prev) => ({ ...prev, values: { ...prev.values, [field.name]: value } }));
                              setErrors((prev) => ({ ...prev, [field.name]: undefined }));
                            }}
                          />
                          <Field.Hint />
                          <Field.Error />
                        </Field.Root>
                      </Grid.Item>
                    );
                  })}
                </Grid.Root>
                <Grid.Root gap={4}>
                  <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                    <BooleanField
                      name="isDefault"
                      label={t('accounts.isDefault', 'Default for the channel')}
                      hint={t('accounts.isDefault.hint', 'Used when a message does not name an account.')}
                      checked={form.isDefault}
                      onCheckedChange={(value) => setForm((prev) => ({ ...prev, isDefault: value }))}
                    />
                  </Grid.Item>
                  {editing ? (
                    <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
                      <BooleanField
                        name="isActive"
                        label={t('accounts.isActive', 'Active')}
                        hint={t('accounts.isActive.hint', 'Inactive accounts send nothing.')}
                        checked={form.isActive}
                        onCheckedChange={(value) => setForm((prev) => ({ ...prev, isActive: value }))}
                      />
                    </Grid.Item>
                  ) : null}
                </Grid.Root>
              </Flex>
            ) : null}

            {step === 'result' && result ? (
              <Flex direction="column" alignItems="stretch" gap={5}>
                {result.test?.ok ? (
                  <Notice variant="success" role="status" title={t('accounts.result.ok', 'The connection works.')}>
                    {result.account.provider === 'telegram'
                      ? t(
                          'accounts.result.telegram',
                          'The webhook is registered{bot}. Contacts link Telegram with the link from their contact page.',
                          { bot: result.test.info?.username ? ` (@${result.test.info.username})` : '' }
                        )
                      : t('accounts.result.next', 'Next: create a template, then send a test message.')}
                  </Notice>
                ) : (
                  <Notice
                    variant="danger"
                    role="alert"
                    title={t('accounts.result.failed', 'The provider refused the connection.')}
                  >
                    {reasonText(t, result.test?.code) ||
                      t('accounts.result.code', 'Reason code: {code}. Check the credentials and test again.', {
                        code: result.test?.code || '-',
                      })}
                  </Notice>
                )}
                {result.steps ? (
                  <Flex tag="ul" direction="column" alignItems="stretch" gap={2}>
                    {Object.entries(result.steps)
                      .filter(([, value]) => value && value !== 'skipped')
                      .map(([key, value]) => (
                        <Flex tag="li" key={key} gap={2}>
                          {value === 'ok' || value === 'started' ? (
                            <Check fill="success600" aria-hidden />
                          ) : (
                            <Cross fill="danger600" aria-hidden />
                          )}
                          <Typography>{stepNames[key] || key}</Typography>
                          {value !== 'ok' && value !== 'started' ? (
                            <ToneBadge tone="danger">{String(value)}</ToneBadge>
                          ) : null}
                        </Flex>
                      ))}
                  </Flex>
                ) : null}
                {result.account.webhookUrl && result.account.provider !== 'telegram' ? (
                  <CopyField
                    name="webhookUrl"
                    label={t('accounts.webhookUrl', 'Webhook URL')}
                    value={result.account.webhookUrl}
                    hint={t(
                      'accounts.webhookUrl.hint',
                      'Enter it in the provider console for delivery and read receipts.'
                    )}
                  />
                ) : null}
                {result.account.provider === 'meta' && !result.steps ? (
                  verifyToken ? (
                    <CopyField
                      name="verifyToken"
                      label={t('accounts.verifyToken', 'Verify token')}
                      value={verifyToken}
                      hint={t(
                        'accounts.verifyToken.hint',
                        'Meta asks for it with the callback URL under WhatsApp > Configuration.'
                      )}
                    />
                  ) : (
                    <Box>
                      <Button variant="secondary" startIcon={<Eye />} onClick={revealToken}>
                        {t('accounts.verifyToken.show', 'Show the verify token')}
                      </Button>
                    </Box>
                  )
                ) : null}
              </Flex>
            ) : null}
          </Modal.Body>
          <Modal.Footer>
            {back}
            {step === 'credentials' ? (
              <Button type="submit" loading={busy}>
                {editing
                  ? t('accounts.wizard.saveTest', 'Save and test')
                  : t('accounts.wizard.connectTest', 'Connect and test')}
              </Button>
            ) : step === 'result' && !result?.test?.ok ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setProvider(result.account.provider);
                  go('credentials');
                }}
              >
                {t('accounts.wizard.fix', 'Correct the credentials')}
              </Button>
            ) : null}
          </Modal.Footer>
        </form>
      </Modal.Content>
    </Modal.Root>
  );
};
