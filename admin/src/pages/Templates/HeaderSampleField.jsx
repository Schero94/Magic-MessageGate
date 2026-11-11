import { useRef, useState } from 'react';
import { Box, Button, Field, Flex, NumberInput } from '@strapi/design-system';
import { Images } from '@strapi/icons';
import { useStrapiApp } from '@strapi/strapi/admin';

import { useT } from '../../hooks/useT';

/** Media-library filter per header format (`allowedTypes` of the upload plugin). */
const ALLOWED_TYPES = { IMAGE: ['images'], VIDEO: ['videos'], DOCUMENT: ['files'] };
/** MIME types Meta accepts for template header samples. */
const MIME_TYPES = { IMAGE: ['image/jpeg', 'image/png'], VIDEO: ['video/mp4'], DOCUMENT: ['application/pdf'] };
/** Meta's upload limit; media-library sizes are in KB. */
const MAX_KB = 16 * 1024;

/**
 * Sample file of a WhatsApp media header (IMAGE, DOCUMENT, VIDEO) as a
 * media-library file ID. The file is uploaded to Meta as the sample on
 * submit and is the default header media when a message has no attachment.
 *
 * When the upload plugin registers its `media-library` dialog (Strapi docs,
 * "Reuse admin panel components": `useStrapiApp(..., s => s.components)['media-library']`),
 * a button opens it; otherwise only the numeric field is shown.
 *
 * @param {object} props - Props.
 * @param {'IMAGE' | 'DOCUMENT' | 'VIDEO'} props.format - Header format.
 * @param {number | undefined} props.value - File ID.
 * @param {string} [props.error] - Inline error.
 * @param {boolean} [props.disabled] - Read-only.
 * @param {(value: number | undefined) => void} props.onChange - Change handler.
 * @returns {JSX.Element} Field.
 */
export const HeaderSampleField = ({ format, value, error, disabled, onChange }) => {
  const t = useT();
  const components = useStrapiApp('MessageGateHeaderSample', (state) => state.components, false);
  const MediaLibraryDialog = components?.['media-library'];
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState(null);
  const buttonRef = useRef(null);

  const close = () => {
    setPicking(false);
    requestAnimationFrame(() => buttonRef.current?.focus());
  };

  const select = (assets) => {
    const asset = assets?.[0];
    close();
    if (!asset) return;
    if (!MIME_TYPES[format].includes(asset.mime)) {
      setPickError(
        t(
          'editor.header.file.type',
          'This file type does not fit the header: use JPEG or PNG images, MP4 video or PDF.'
        )
      );
      return;
    }
    if (Number(asset.size) > MAX_KB) {
      setPickError(t('editor.header.file.size', 'This file is larger than 16 MB.'));
      return;
    }
    setPickError(null);
    onChange(asset.id);
  };

  return (
    <Flex direction="column" alignItems="stretch" gap={2}>
      <Field.Root
        name="content.header.fileId"
        error={pickError || error}
        hint={t(
          'editor.header.file.hint',
          'Used as the sample uploaded to Meta on submit and as the default header media when a message has no attachment. JPEG or PNG for images, MP4 video, PDF documents, up to 16 MB.'
        )}
      >
        <Field.Label>{t('editor.header.file', 'Sample file (media library file ID)')}</Field.Label>
        <NumberInput
          name="content.header.fileId"
          value={value ?? undefined}
          disabled={disabled}
          step={1}
          onValueChange={(next) => {
            setPickError(null);
            onChange(next);
          }}
        />
        <Field.Hint />
        <Field.Error />
      </Field.Root>
      {MediaLibraryDialog && !disabled ? (
        <Box>
          <Button ref={buttonRef} variant="tertiary" size="S" startIcon={<Images />} onClick={() => setPicking(true)}>
            {t('editor.header.file.choose', 'Choose from the media library')}
          </Button>
        </Box>
      ) : null}
      {picking && MediaLibraryDialog ? (
        <MediaLibraryDialog
          allowedTypes={ALLOWED_TYPES[format]}
          multiple={false}
          onClose={close}
          onSelectAssets={select}
        />
      ) : null}
    </Flex>
  );
};
