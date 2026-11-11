import { Box, Divider, Flex, Typography } from '@strapi/design-system';
import { Duplicate, ExternalLink, File, Image, Phone, Play } from '@strapi/icons';

import { useT } from '../../hooks/useT';
import { previewParts, rcsFallbackText, renderText, smsSegments } from '../../utils/templatePreview.mjs';

/**
 * Text with placeholders highlighted: filled values in bold, missing ones
 * as `{{name}}` in the primary colour.
 *
 * @param {{ text: string, values: object, examples: object, format: string, variant?: string }} props - Props.
 * @returns {JSX.Element} Text.
 */
const Highlighted = ({ text, values, examples, format, variant = 'omega' }) => (
  <Typography variant={variant} textColor="neutral800" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
    {previewParts(text, values, examples, format).map((part, index) =>
      part.variable ? (
        <Typography
          key={index}
          variant={variant}
          fontWeight="bold"
          textColor={part.filled ? 'neutral800' : 'primary600'}
        >
          {part.text}
        </Typography>
      ) : (
        <span key={index}>{part.text}</span>
      )
    )}
  </Typography>
);

/**
 * Grey media placeholder. The preview never loads the media itself, so no
 * request leaves the admin and the admin CSP is not involved.
 *
 * @param {{ icon: Function, label: string }} props - Icon component and caption.
 * @returns {JSX.Element} Placeholder.
 */
const MediaPlaceholder = ({ icon: Icon, label }) => (
  <Flex
    background="neutral100"
    hasRadius
    height="12rem"
    justifyContent="center"
    alignItems="center"
    direction="column"
    gap={2}
    padding={3}
  >
    <Icon width="3.2rem" height="3.2rem" fill="neutral500" aria-hidden />
    <Typography variant="pi" textColor="neutral600" textAlign="center" style={{ overflowWrap: 'anywhere' }}>
      {label}
    </Typography>
  </Flex>
);

/**
 * Host name of a URL for the image caption, or null when it does not parse.
 *
 * @param {string} url - URL.
 * @returns {string | null} Host.
 */
const hostOf = (url) => {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
};

const MEDIA_ICON = { IMAGE: Image, DOCUMENT: File, VIDEO: Play };
const BUTTON_ICON = { URL: ExternalLink, PHONE_NUMBER: Phone, COPY_CODE: Duplicate };

/**
 * Message buttons stacked under the text, separated by dividers (WhatsApp
 * buttons, Telegram inline keyboard rows).
 *
 * @param {{ buttons: Array<{type?: string, label: string}> }} props - Buttons.
 * @returns {JSX.Element} Rows.
 */
const ButtonRows = ({ buttons }) => (
  <Flex tag="ul" direction="column" alignItems="stretch">
    {buttons.map((button, index) => {
      const Icon = BUTTON_ICON[button.type];
      return (
        <Box tag="li" key={index}>
          <Divider />
          <Flex justifyContent="center" gap={2} paddingTop={2} paddingBottom={1}>
            {Icon ? <Icon fill="primary600" aria-hidden /> : null}
            <Typography textColor="primary600" fontWeight="semiBold" style={{ overflowWrap: 'anywhere' }}>
              {button.label}
            </Typography>
          </Flex>
        </Box>
      );
    })}
  </Flex>
);

/**
 * RCS suggestion chips under a rich card.
 *
 * @param {{ buttons: Array<{type: string, label: string}> }} props - Buttons.
 * @returns {JSX.Element} Chips.
 */
const Chips = ({ buttons }) => (
  <Flex tag="ul" gap={2} wrap="wrap">
    {buttons.map((button, index) => {
      const Icon = BUTTON_ICON[button.type];
      return (
        <Flex
          tag="li"
          key={index}
          gap={1}
          alignItems="center"
          hasRadius
          borderColor="primary200"
          background="primary100"
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={3}
          paddingRight={3}
          minWidth={0}
        >
          {Icon ? <Icon fill="primary600" aria-hidden /> : null}
          <Typography variant="pi" textColor="primary700" fontWeight="semiBold" style={{ overflowWrap: 'anywhere' }}>
            {button.label}
          </Typography>
        </Flex>
      );
    })}
  </Flex>
);

/**
 * Character, encoding and part count of an SMS text.
 *
 * @param {{ info: {characters: number, encoding: string, segments: number} }} props - Segment info.
 * @returns {JSX.Element} Hint.
 */
const SmsInfo = ({ info }) => {
  const t = useT();
  return (
    <Typography variant="pi" textColor={info.segments > 1 ? 'warning700' : 'neutral600'}>
      {t(
        'editor.sms.segments',
        '{characters} characters, {encoding}, {segments, plural, one {# SMS} other {# SMS parts}}',
        {
          characters: info.characters,
          encoding: info.encoding,
          segments: info.segments,
        }
      )}
      {info.encoding === 'UCS-2'
        ? ` · ${t('editor.sms.ucs2', 'Emoji or special characters shorten each part to 70 characters.')}`
        : ''}
    </Typography>
  );
};

/**
 * Live preview of a template draft as the recipient sees it: a WhatsApp
 * message with header, body, footer and buttons, an RCS rich card with
 * image, title, text and suggestion chips (plus the SMS fallback Twilio sends
 * to phones without RCS), a Telegram message with its inline keyboard, or an
 * SMS with its segment count. Uses DS colour tokens only, so it follows the
 * admin theme.
 *
 * @param {{ draft: object, values?: Record<string, string> }} props - Draft and test values.
 * @returns {JSX.Element} Preview.
 */
export const TemplatePreview = ({ draft, values = {} }) => {
  const t = useT();
  const examples = Object.fromEntries((draft.variables || []).map((v) => [v.name, v.example || '']));
  const format = draft.parameterFormat === 'positional' ? 'positional' : 'named';
  const c = draft.content || {};
  const channel = draft.channel;
  const header = channel === 'whatsapp' && c.header && c.header.format !== 'NONE' ? c.header : null;
  const MediaIcon = header ? MEDIA_ICON[header.format] : null;
  const empty = t('editor.preview.empty', 'Your message appears here.');
  const untitled = t('editor.button.untitled', 'Button');
  const sms = channel === 'sms' ? smsSegments(renderText(c.text, values, examples, format)) : null;
  const rcsFallback =
    channel === 'rcs' && String(c.text || '').trim()
      ? renderText(rcsFallbackText(c), values, examples, format).slice(0, 1600)
      : null;
  const mediaHost = channel === 'rcs' && c.mediaUrl ? hostOf(c.mediaUrl) : null;

  return (
    <Flex direction="column" alignItems="stretch" gap={3}>
      <Box background="neutral150" hasRadius padding={4} aria-label={t('editor.preview', 'Preview')} role="figure">
        <Box
          background="neutral0"
          hasRadius
          shadow="tableShadow"
          padding={3}
          maxWidth="34rem"
          marginLeft={channel === 'sms' ? 0 : undefined}
        >
          <Flex direction="column" alignItems="stretch" gap={2}>
            {channel === 'whatsapp' ? (
              <>
                {header?.format === 'TEXT' ? (
                  <Highlighted text={header.text} values={values} examples={examples} format={format} variant="delta" />
                ) : null}
                {MediaIcon ? (
                  <MediaPlaceholder
                    icon={MediaIcon}
                    label={
                      header.fileId
                        ? t('editor.preview.mediaSample', 'Sample file {id}, unless the message has an attachment', {
                            id: header.fileId,
                          })
                        : t('editor.preview.media', 'Media is attached when sending')
                    }
                  />
                ) : null}
                <Highlighted text={c.body || empty} values={values} examples={examples} format={format} />
                {c.footer ? (
                  <Typography variant="pi" textColor="neutral600">
                    {c.footer}
                  </Typography>
                ) : null}
                {c.buttons?.length ? (
                  <ButtonRows buttons={c.buttons.map((b) => ({ type: b.type, label: b.text || untitled }))} />
                ) : null}
              </>
            ) : channel === 'rcs' ? (
              <>
                {c.mediaUrl ? (
                  <MediaPlaceholder
                    icon={Image}
                    label={
                      mediaHost
                        ? t('editor.preview.rcsImage', 'Image from {host}', { host: mediaHost })
                        : t('editor.preview.rcsImageInvalid', 'Image (address not valid yet)')
                    }
                  />
                ) : null}
                {String(c.title || '').trim() ? (
                  <Highlighted text={c.title} values={values} examples={examples} format={format} variant="delta" />
                ) : null}
                <Highlighted text={c.text || empty} values={values} examples={examples} format={format} />
                {c.buttons?.length ? (
                  <Box paddingTop={1}>
                    <Chips buttons={c.buttons.map((b) => ({ type: b.type, label: b.title || untitled }))} />
                  </Box>
                ) : null}
              </>
            ) : (
              <>
                <Highlighted text={c.text || empty} values={values} examples={examples} format={format} />
                {channel === 'telegram' && c.buttons?.length ? (
                  <ButtonRows buttons={c.buttons.map((b) => ({ label: b.title || untitled }))} />
                ) : null}
              </>
            )}
          </Flex>
        </Box>
      </Box>
      {sms ? <SmsInfo info={sms} /> : null}
      {rcsFallback ? (
        <Flex direction="column" alignItems="stretch" gap={2}>
          <Typography variant="sigma" textColor="neutral600" tag="h3">
            {t('editor.preview.rcsFallback', 'SMS fallback on phones without RCS')}
          </Typography>
          <Box background="neutral100" hasRadius padding={3}>
            <Typography
              variant="pi"
              textColor="neutral800"
              style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
            >
              {rcsFallback}
            </Typography>
          </Box>
          <SmsInfo info={smsSegments(rcsFallback)} />
        </Flex>
      ) : null}
      <Typography variant="pi" textColor="neutral600">
        {t('editor.preview.hint', 'Placeholders show their example value; missing ones are highlighted.')}
      </Typography>
    </Flex>
  );
};
