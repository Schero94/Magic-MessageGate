import { Field, TextInput } from '@strapi/design-system';
import { Duplicate } from '@strapi/icons';
import { useClipboard, useNotification } from '@strapi/strapi/admin';
import { useT } from '../../hooks/useT';

/**
 * Read-only value (webhook URL, verify token) with a copy button.
 *
 * @param {{ name: string, label: string, value: string, hint?: string }} props - Props.
 * @returns {JSX.Element} Field.
 */
export const CopyField = ({ name, label, value, hint }) => {
  const t = useT();
  const { copy } = useClipboard();
  const { toggleNotification } = useNotification();
  const onCopy = async () => {
    const ok = await copy(value);
    toggleNotification({
      type: ok ? 'success' : 'warning',
      message: ok
        ? t('common.copied', 'Copied to the clipboard.')
        : t('common.copyFailed', 'Copying failed. Select the text and copy it by hand.'),
    });
  };
  return (
    <Field.Root name={name} hint={hint}>
      <Field.Label>{label}</Field.Label>
      <TextInput
        value={value}
        readOnly
        onFocus={(event) => event.target.select()}
        endAction={
          <Field.Action label={t('common.copyLabel', 'Copy {label}', { label })} onClick={onCopy}>
            <Duplicate />
          </Field.Action>
        }
      />
      <Field.Hint />
    </Field.Root>
  );
};
