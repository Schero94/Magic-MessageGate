import {
  Box,
  Button,
  Field,
  Flex,
  Grid,
  IconButton,
  SingleSelect,
  SingleSelectOption,
  TextInput,
  Typography,
} from '@strapi/design-system';
import { Plus, Trash } from '@strapi/icons';

import { useT } from '../../hooks/useT';
import { BUTTON_TYPES, LIMITS, RCS_BUTTON_TYPES } from '../../utils/templates.mjs';

/**
 * Text input inside a Field with label, optional hint and inline error. The
 * input carries `name` so the editor can focus the first invalid field.
 *
 * @param {object} props - Props.
 * @param {string} props.name - Field path, e.g. `content.buttons.0.title`.
 * @param {string} props.label - Label.
 * @param {string} [props.hint] - Hint.
 * @param {string} [props.error] - Error message.
 * @param {boolean} [props.required] - Required marker.
 * @param {string} props.value - Value.
 * @param {number} [props.maxLength] - Input limit.
 * @param {string} [props.type] - Input type.
 * @param {string} [props.placeholder] - Example value.
 * @param {boolean} [props.disabled] - Read-only.
 * @param {(value: string) => void} props.onChange - Change handler.
 * @returns {JSX.Element} Field.
 */
const TextField = ({ name, label, hint, error, required, value, maxLength, type, placeholder, disabled, onChange }) => (
  <Field.Root name={name} required={required} error={error} hint={hint}>
    <Field.Label>{label}</Field.Label>
    <TextInput
      name={name}
      type={type}
      value={value || ''}
      maxLength={maxLength}
      placeholder={placeholder}
      spellCheck={false}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
    {hint ? <Field.Hint /> : null}
    <Field.Error />
  </Field.Root>
);

/**
 * One button row: a neutral box with the fields and a remove action on the right.
 *
 * @param {{ index: number, readOnly: boolean, onRemove: () => void, children: JSX.Element }} props - Props.
 * @returns {JSX.Element} Row.
 */
const Row = ({ index, readOnly, onRemove, children }) => {
  const t = useT();
  return (
    <Flex tag="li" background="neutral100" hasRadius padding={4} gap={3} alignItems="flex-start">
      <Box flex="1" minWidth={0}>
        <Grid.Root gap={3}>{children}</Grid.Root>
      </Box>
      {!readOnly ? (
        <Box paddingTop={6} shrink={0}>
          <IconButton
            label={t('editor.button.remove', 'Remove button {n}', { n: index + 1 })}
            variant="ghost"
            onClick={onRemove}
          >
            <Trash />
          </IconButton>
        </Box>
      ) : null}
    </Flex>
  );
};

/**
 * Button list with heading, hint, rows and an "Add button" action that
 * disappears at the channel's limit.
 *
 * @param {object} props - Props.
 * @param {string} [props.hint] - Limits and behaviour of the channel's buttons.
 * @param {boolean} props.canAdd - Below the limit and editable.
 * @param {() => void} props.onAdd - Adds a button.
 * @param {JSX.Element[]} props.children - Rows.
 * @returns {JSX.Element} List.
 */
const ButtonList = ({ hint, canAdd, onAdd, children }) => {
  const t = useT();
  return (
    <Flex direction="column" alignItems="stretch" gap={3}>
      <Flex direction="column" alignItems="stretch" gap={1}>
        <Typography variant="sigma" textColor="neutral600" tag="h3">
          {t('editor.buttons', 'Buttons')}
        </Typography>
        {hint ? (
          <Typography variant="pi" textColor="neutral600">
            {hint}
          </Typography>
        ) : null}
      </Flex>
      {children?.length ? (
        <Flex tag="ul" direction="column" alignItems="stretch" gap={3}>
          {children}
        </Flex>
      ) : null}
      {canAdd ? (
        <Box>
          <Button variant="secondary" startIcon={<Plus />} onClick={onAdd}>
            {t('editor.button.add', 'Add button')}
          </Button>
        </Box>
      ) : null}
    </Flex>
  );
};

/**
 * Type select of a button row.
 *
 * @param {{ name: string, value: string, types: string[], labels: Record<string, string>, disabled: boolean, onChange: (value: string) => void }} props - Props.
 * @returns {JSX.Element} Field.
 */
const TypeField = ({ name, value, types, labels, disabled, onChange }) => {
  const t = useT();
  return (
    <Field.Root name={name}>
      <Field.Label>{t('editor.button.type', 'Type')}</Field.Label>
      <SingleSelect value={value} disabled={disabled} onChange={onChange}>
        {types.map((type) => (
          <SingleSelectOption key={type} value={type}>
            {labels[type]}
          </SingleSelectOption>
        ))}
      </SingleSelect>
    </Field.Root>
  );
};

/**
 * Shared props of the per-channel button editors.
 *
 * @typedef {object} ButtonEditorProps
 * @property {object[]} buttons - Buttons of the draft.
 * @property {Record<string, string>} errors - Error messages by path.
 * @property {boolean} readOnly - Read-only.
 * @property {(index: number, patch: object) => void} onUpdate - Changes one button.
 * @property {(buttons: object[]) => void} onSet - Replaces the list.
 */

/**
 * WhatsApp buttons: quick reply (optional payload), link, copy code.
 *
 * @param {ButtonEditorProps} props - Props.
 * @returns {JSX.Element} Editor.
 */
export const WhatsAppButtons = ({ buttons, errors, readOnly, onUpdate, onSet }) => {
  const t = useT();
  const labels = {
    QUICK_REPLY: t('editor.button.QUICK_REPLY', 'Quick reply'),
    URL: t('editor.button.URL', 'Link'),
    COPY_CODE: t('editor.button.COPY_CODE', 'Copy code'),
  };
  return (
    <ButtonList
      canAdd={!readOnly && buttons.length < LIMITS.buttons}
      onAdd={() => onSet([...buttons, { type: 'QUICK_REPLY', text: '' }])}
    >
      {buttons.map((b, i) => (
        <Row key={i} index={i} readOnly={readOnly} onRemove={() => onSet(buttons.filter((_, j) => j !== i))}>
          <Grid.Item col={5} xs={12} direction="column" alignItems="stretch">
            <TypeField
              name={`content.buttons.${i}.type`}
              value={b.type}
              types={BUTTON_TYPES}
              labels={labels}
              disabled={readOnly}
              onChange={(type) => onUpdate(i, { type })}
            />
          </Grid.Item>
          <Grid.Item col={7} xs={12} direction="column" alignItems="stretch">
            <TextField
              name={`content.buttons.${i}.text`}
              label={t('editor.button.text', 'Label')}
              required
              error={errors[`content.buttons.${i}.text`]}
              value={b.text}
              maxLength={LIMITS.button}
              disabled={readOnly}
              onChange={(text) => onUpdate(i, { text })}
            />
          </Grid.Item>
          {b.type === 'URL' ? (
            <Grid.Item col={12} direction="column" alignItems="stretch">
              <TextField
                name={`content.buttons.${i}.url`}
                label={t('editor.button.url', 'Address')}
                required
                type="url"
                error={errors[`content.buttons.${i}.url`]}
                hint={t('editor.button.url.hint', 'May end with one variable, e.g. {example}.', {
                  example: 'https://shop.example/orders/{{order_id}}',
                })}
                value={b.url}
                disabled={readOnly}
                onChange={(url) => onUpdate(i, { url })}
              />
            </Grid.Item>
          ) : null}
          {b.type === 'COPY_CODE' ? (
            <Grid.Item col={12} direction="column" alignItems="stretch">
              <TextField
                name={`content.buttons.${i}.variable`}
                label={t('editor.button.variable', 'Code variable')}
                hint={t('editor.button.variable.hint', 'Variable that holds the code, e.g. coupon_code.')}
                value={b.variable}
                maxLength={60}
                disabled={readOnly}
                onChange={(variable) => onUpdate(i, { variable })}
              />
            </Grid.Item>
          ) : null}
          {b.type === 'QUICK_REPLY' ? (
            <Grid.Item col={12} direction="column" alignItems="stretch">
              <TextField
                name={`content.buttons.${i}.payload`}
                label={t('editor.button.payload', 'Payload (optional)')}
                hint={t(
                  'editor.button.payload.hint',
                  'Returned in the inbound message when the customer taps the button.'
                )}
                error={errors[`content.buttons.${i}.payload`]}
                value={b.payload}
                maxLength={64}
                placeholder="confirm_order"
                disabled={readOnly}
                onChange={(payload) => onUpdate(i, { payload })}
              />
            </Grid.Item>
          ) : null}
        </Row>
      ))}
    </ButtonList>
  );
};

/**
 * RCS rich card buttons (suggestions): open link, call, quick reply.
 *
 * @param {ButtonEditorProps} props - Props.
 * @returns {JSX.Element} Editor.
 */
export const RcsButtons = ({ buttons, errors, readOnly, onUpdate, onSet }) => {
  const t = useT();
  const labels = {
    URL: t('editor.button.URL', 'Link'),
    PHONE_NUMBER: t('editor.button.PHONE_NUMBER', 'Call'),
    QUICK_REPLY: t('editor.button.QUICK_REPLY', 'Quick reply'),
  };
  return (
    <ButtonList
      hint={t(
        'editor.buttons.rcsHint',
        'Up to 4, shown as chips under the card. Labels up to 25 characters, quick replies up to 20.'
      )}
      canAdd={!readOnly && buttons.length < LIMITS.rcsButtons}
      onAdd={() => onSet([...buttons, { type: 'URL', title: '' }])}
    >
      {buttons.map((b, i) => (
        <Row key={i} index={i} readOnly={readOnly} onRemove={() => onSet(buttons.filter((_, j) => j !== i))}>
          <Grid.Item col={5} xs={12} direction="column" alignItems="stretch">
            <TypeField
              name={`content.buttons.${i}.type`}
              value={b.type}
              types={RCS_BUTTON_TYPES}
              labels={labels}
              disabled={readOnly}
              onChange={(type) => onUpdate(i, { type })}
            />
          </Grid.Item>
          <Grid.Item col={7} xs={12} direction="column" alignItems="stretch">
            <TextField
              name={`content.buttons.${i}.title`}
              label={t('editor.button.text', 'Label')}
              required
              error={errors[`content.buttons.${i}.title`]}
              value={b.title}
              maxLength={b.type === 'QUICK_REPLY' ? LIMITS.rcsQuickReply : LIMITS.rcsButton}
              disabled={readOnly}
              onChange={(title) => onUpdate(i, { title })}
            />
          </Grid.Item>
          <Grid.Item col={12} direction="column" alignItems="stretch">
            {b.type === 'URL' ? (
              <TextField
                name={`content.buttons.${i}.url`}
                label={t('editor.button.url', 'Address')}
                required
                type="url"
                error={errors[`content.buttons.${i}.url`]}
                value={b.url}
                placeholder="https://shop.example/orders"
                disabled={readOnly}
                onChange={(url) => onUpdate(i, { url })}
              />
            ) : b.type === 'PHONE_NUMBER' ? (
              <TextField
                name={`content.buttons.${i}.phone`}
                label={t('editor.button.phone', 'Phone number')}
                required
                type="tel"
                hint={t('editor.button.phone.hint', 'International format with country code.')}
                error={errors[`content.buttons.${i}.phone`]}
                value={b.phone}
                maxLength={17}
                placeholder="+4930123456789"
                disabled={readOnly}
                onChange={(phone) => onUpdate(i, { phone })}
              />
            ) : (
              <TextField
                name={`content.buttons.${i}.payload`}
                label={t('editor.button.payload', 'Payload (optional)')}
                hint={t(
                  'editor.button.payload.hint',
                  'Returned in the inbound message when the customer taps the button.'
                )}
                error={errors[`content.buttons.${i}.payload`]}
                value={b.payload}
                maxLength={64}
                placeholder="confirm_order"
                disabled={readOnly}
                onChange={(payload) => onUpdate(i, { payload })}
              />
            )}
          </Grid.Item>
        </Row>
      ))}
    </ButtonList>
  );
};

/**
 * Telegram inline keyboard: one button per row with label and payload.
 *
 * @param {ButtonEditorProps} props - Props.
 * @returns {JSX.Element} Editor.
 */
export const TelegramButtons = ({ buttons, errors, readOnly, onUpdate, onSet }) => {
  const t = useT();
  return (
    <ButtonList
      hint={t('editor.buttons.telegramHint', 'Up to 8, shown under the text, one per row. Labels up to 40 characters.')}
      canAdd={!readOnly && buttons.length < LIMITS.telegramButtons}
      onAdd={() => onSet([...buttons, { title: '', payload: '' }])}
    >
      {buttons.map((b, i) => (
        <Row key={i} index={i} readOnly={readOnly} onRemove={() => onSet(buttons.filter((_, j) => j !== i))}>
          <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
            <TextField
              name={`content.buttons.${i}.title`}
              label={t('editor.button.text', 'Label')}
              required
              error={errors[`content.buttons.${i}.title`]}
              value={b.title}
              maxLength={LIMITS.telegramButton}
              disabled={readOnly}
              onChange={(title) => onUpdate(i, { title })}
            />
          </Grid.Item>
          <Grid.Item col={6} xs={12} direction="column" alignItems="stretch">
            <TextField
              name={`content.buttons.${i}.payload`}
              label={t('editor.button.payloadRequired', 'Payload')}
              required
              hint={t(
                'editor.button.payload.hint',
                'Returned in the inbound message when the customer taps the button.'
              )}
              error={errors[`content.buttons.${i}.payload`]}
              value={b.payload}
              maxLength={64}
              placeholder="confirm_order"
              disabled={readOnly}
              onChange={(payload) => onUpdate(i, { payload })}
            />
          </Grid.Item>
        </Row>
      ))}
    </ButtonList>
  );
};
