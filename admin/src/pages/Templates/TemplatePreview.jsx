import { Box, Divider, Flex, Typography } from '@strapi/design-system';
import { Duplicate, ExternalLink, File, Image, Play } from '@strapi/icons';

import { useT } from '../../hooks/useT';
import { previewParts, renderText, smsSegments } from '../../utils/templatePreview.mjs';

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

const MEDIA_ICON = { IMAGE: Image, DOCUMENT: File, VIDEO: Play };

/**
 * Live preview of a template draft as the recipient sees it: a WhatsApp
 * message with header, body, footer and buttons, a Telegram message, or an
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
  const header = c.header && c.header.format !== 'NONE' ? c.header : null;
  const MediaIcon = header ? MEDIA_ICON[header.format] : null;
  const sms = draft.channel === 'sms' ? smsSegments(renderText(c.text, values, examples, format)) : null;

  return (
    <Flex direction="column" alignItems="stretch" gap={3}>
      <Box background="neutral150" hasRadius padding={4} aria-label={t('editor.preview', 'Preview')} role="figure">
        <Box
          background="neutral0"
          hasRadius
          shadow="tableShadow"
          padding={3}
          maxWidth="34rem"
          marginLeft={draft.channel === 'sms' ? 0 : undefined}
        >
          <Flex direction="column" alignItems="stretch" gap={2}>
            {draft.channel === 'whatsapp' ? (
              <>
                {header?.format === 'TEXT' ? (
                  <Highlighted text={header.text} values={values} examples={examples} format={format} variant="delta" />
                ) : null}
                {MediaIcon ? (
                  <Flex
                    background="neutral100"
                    hasRadius
                    height="12rem"
                    justifyContent="center"
                    alignItems="center"
                    direction="column"
                    gap={2}
                  >
                    <MediaIcon width="3.2rem" height="3.2rem" fill="neutral500" aria-hidden />
                    <Typography variant="pi" textColor="neutral600">
                      {t('editor.preview.media', 'Media is attached when sending')}
                    </Typography>
                  </Flex>
                ) : null}
                <Highlighted
                  text={c.body || t('editor.preview.empty', 'Your message appears here.')}
                  values={values}
                  examples={examples}
                  format={format}
                />
                {c.footer ? (
                  <Typography variant="pi" textColor="neutral600">
                    {c.footer}
                  </Typography>
                ) : null}
                {c.buttons?.length ? (
                  <Flex direction="column" alignItems="stretch">
                    {c.buttons.map((button, index) => (
                      <Box key={index}>
                        <Divider />
                        <Flex justifyContent="center" gap={2} paddingTop={2} paddingBottom={1}>
                          {button.type === 'URL' ? <ExternalLink fill="primary600" aria-hidden /> : null}
                          {button.type === 'COPY_CODE' ? <Duplicate fill="primary600" aria-hidden /> : null}
                          <Typography textColor="primary600" fontWeight="semiBold">
                            {button.text || t('editor.button.untitled', 'Button')}
                          </Typography>
                        </Flex>
                      </Box>
                    ))}
                  </Flex>
                ) : null}
              </>
            ) : (
              <Highlighted
                text={c.text || t('editor.preview.empty', 'Your message appears here.')}
                values={values}
                examples={examples}
                format={format}
              />
            )}
          </Flex>
        </Box>
      </Box>
      {sms ? (
        <Typography variant="pi" textColor={sms.segments > 1 ? 'warning700' : 'neutral600'}>
          {t(
            'editor.sms.segments',
            '{characters} characters, {encoding}, {segments, plural, one {# SMS} other {# SMS parts}}',
            {
              characters: sms.characters,
              encoding: sms.encoding,
              segments: sms.segments,
            }
          )}
          {sms.encoding === 'UCS-2'
            ? ` · ${t('editor.sms.ucs2', 'Emoji or special characters shorten each part to 70 characters.')}`
            : ''}
        </Typography>
      ) : null}
      <Typography variant="pi" textColor="neutral600">
        {t('editor.preview.hint', 'Placeholders show their example value; missing ones are highlighted.')}
      </Typography>
    </Flex>
  );
};
