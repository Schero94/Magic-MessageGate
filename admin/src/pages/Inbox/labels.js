/**
 * Inbox vocabulary: one label per inbound kind, media state and media type.
 */

/**
 * @param {(id: string, def: string) => string} t - Translator.
 * @returns {Record<string, string>} Inbound kind labels.
 */
export const kindLabels = (t) => ({
  text: t('inbox.kind.text', 'Text'),
  button: t('inbox.kind.button', 'Button reply'),
  media: t('inbox.kind.media', 'File'),
  location: t('inbox.kind.location', 'Location'),
  other: t('inbox.kind.other', 'Other'),
});

/**
 * Badge tone and label per media state that is not `ready`. The danger tone
 * is kept for states where the file is unusable for a reason (quarantine,
 * failed download); `skipped` (not stored by setting) is neutral.
 *
 * @param {(id: string, def: string) => string} t - Translator.
 * @returns {Record<string, {tone: string, label: string}>} Media states.
 */
export const mediaStates = (t) => ({
  pending: { tone: 'warning', label: t('inbox.media.pending', 'Download pending') },
  failed: { tone: 'danger', label: t('inbox.media.failed', 'Download failed') },
  quarantined: { tone: 'danger', label: t('inbox.media.quarantined', 'Quarantined') },
  skipped: { tone: 'neutral', label: t('inbox.media.skipped', 'Not stored') },
});

/**
 * @param {(id: string, def: string) => string} t - Translator.
 * @returns {Record<'image' | 'audio' | 'video' | 'file', string>} Media type labels.
 */
export const mediaTypeLabels = (t) => ({
  image: t('inbox.media.image', 'Image'),
  audio: t('inbox.media.audio', 'Audio'),
  video: t('inbox.media.video', 'Video'),
  file: t('inbox.media.file', 'File'),
});
