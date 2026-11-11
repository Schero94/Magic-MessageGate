import { Box, Field, Flex, IconButton, SingleSelect, SingleSelectOption, Typography } from '@strapi/design-system';
import { ArrowDown, ArrowUp, Cross } from '@strapi/icons';

import { useT } from '../../hooks/useT';
import { CHAIN_CHANNELS, channelLabels } from '../../utils/channels';
import { moveInChain } from '../../utils/settings.mjs';

/**
 * Ordered fallback chain: the first channel is tried first, the next one
 * when the contact cannot be reached (no consent, not on WhatsApp, failed).
 *
 * @param {object} props - Props.
 * @param {string} props.name - Field name.
 * @param {string} props.label - Label.
 * @param {string} [props.hint] - Hint.
 * @param {string} [props.error] - Error.
 * @param {string[]} props.value - Chain.
 * @param {(chain: string[]) => void} props.onChange - Change handler.
 * @param {boolean} [props.emailAvailable] - Magic Mail installed.
 * @param {boolean} [props.disabled] - Read-only.
 * @returns {JSX.Element} Editor.
 */
export const ChainEditor = ({ name, label, hint, error, value, onChange, emailAvailable, disabled }) => {
  const t = useT();
  const channels = channelLabels(t);
  const remaining = CHAIN_CHANNELS.filter((c) => !value.includes(c) && (c !== 'email' || emailAvailable));
  return (
    <Field.Root name={name} hint={hint} error={error}>
      <Field.Label>{label}</Field.Label>
      <Flex tag="ol" direction="column" alignItems="stretch" gap={2} aria-label={label}>
        {value.map((channel, index) => (
          <Flex
            tag="li"
            key={channel}
            gap={2}
            padding={2}
            paddingLeft={4}
            hasRadius
            background="neutral100"
            borderColor="neutral200"
            justifyContent="space-between"
          >
            <Flex gap={3} minWidth={0}>
              <Typography variant="sigma" textColor="neutral600" aria-hidden>
                {index + 1}
              </Typography>
              <Typography textColor="neutral800" fontWeight="semiBold">
                {channels[channel]}
              </Typography>
            </Flex>
            {!disabled ? (
              <Flex gap={1}>
                <IconButton
                  variant="ghost"
                  label={t('chain.up', 'Move {channel} up', { channel: channels[channel] })}
                  disabled={index === 0}
                  onClick={() => onChange(moveInChain(value, index, -1))}
                >
                  <ArrowUp />
                </IconButton>
                <IconButton
                  variant="ghost"
                  label={t('chain.down', 'Move {channel} down', { channel: channels[channel] })}
                  disabled={index === value.length - 1}
                  onClick={() => onChange(moveInChain(value, index, 1))}
                >
                  <ArrowDown />
                </IconButton>
                <IconButton
                  variant="ghost"
                  label={t('chain.remove', 'Remove {channel}', { channel: channels[channel] })}
                  onClick={() => onChange(value.filter((c) => c !== channel))}
                >
                  <Cross />
                </IconButton>
              </Flex>
            ) : null}
          </Flex>
        ))}
      </Flex>
      {!disabled && remaining.length ? (
        <Box paddingTop={2} maxWidth="32rem">
          <SingleSelect
            aria-label={t('chain.add', 'Add a channel')}
            placeholder={t('chain.add', 'Add a channel')}
            value={null}
            onChange={(next) => onChange([...value, next])}
          >
            {remaining.map((c) => (
              <SingleSelectOption key={c} value={c}>
                {channels[c]}
              </SingleSelectOption>
            ))}
          </SingleSelect>
        </Box>
      ) : null}
      <Field.Hint />
      <Field.Error />
    </Field.Root>
  );
};
