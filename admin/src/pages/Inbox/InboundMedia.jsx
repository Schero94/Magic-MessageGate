import { useEffect, useRef, useState } from 'react';
import { Box, Button, Flex, Loader, TextButton, Typography } from '@strapi/design-system';
import { ArrowClockwise, Download, Microphone, Paperclip, Play } from '@strapi/icons';
import { useFetchClient, useNotification } from '@strapi/strapi/admin';
import { useIntl } from 'react-intl';
import styled from 'styled-components';

import { ToneBadge } from '../../components/ui/StatusBadge';
import { useT } from '../../hooks/useT';
import { PLUGIN_ID } from '../../pluginId';
import { errorMessage } from '../../utils/apiError';
import { formatDuration, mediaPresentation } from '../../utils/inbox.mjs';
import { mediaStates, mediaTypeLabels } from './labels';

/*
 * Native media elements have no DS primitive. They fill the bubble but never
 * widen it (max-width 100%); heights are capped in 10 px rem units
 * (32rem = 320 px, 36rem = 360 px) so one file does not fill the screen.
 */
const Thumbnail = styled.img`
  display: block;
  max-width: 100%;
  max-height: 32rem;
  height: auto;
  border-radius: ${({ theme }) => theme.borderRadius};
  background: ${({ theme }) => theme.colors.neutral100};
`;

const AudioPlayer = styled.audio`
  display: block;
  width: 100%;
  min-width: 0;
`;

const VideoPlayer = styled.video`
  display: block;
  max-width: 100%;
  max-height: 36rem;
  border-radius: ${({ theme }) => theme.borderRadius};
  background: ${({ theme }) => theme.colors.neutral150};
`;

const FileName = styled(Typography)`
  overflow-wrap: anywhere;
`;

/**
 * Saves a blob under a file name through a temporary object URL.
 *
 * @param {Blob} blob - File content.
 * @param {string} filename - Suggested name.
 * @returns {void}
 */
function saveBlob(blob, filename) {
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

/**
 * File size in the admin locale (kB or MB).
 *
 * @param {(value: number, options: object) => string} formatNumber - react-intl formatter.
 * @param {number | null} size - Bytes.
 * @returns {string | null} Size text.
 */
function sizeText(formatNumber, size) {
  if (!Number.isFinite(size) || size <= 0) return null;
  if (size < 1_000_000)
    return formatNumber(Math.max(size / 1000, 0.1), {
      style: 'unit',
      unit: 'kilobyte',
      unitDisplay: 'short',
      maximumFractionDigits: 1,
    });
  return formatNumber(size / 1_000_000, {
    style: 'unit',
    unit: 'megabyte',
    unitDisplay: 'short',
    maximumFractionDigits: 1,
  });
}

/**
 * Loads the stored file of an inbound message as an object URL. The media
 * route needs the admin JWT, so `<img src>` cannot call it directly; the
 * file comes through Strapi's fetch client (`responseType: 'blob'`) and the
 * URL is revoked when the file changes or the component unmounts.
 *
 * @param {string} url - Admin media route.
 * @param {boolean} wanted - Fetch only while true.
 * @param {number} attempt - Increment to retry after an error.
 * @returns {{ src: string | null, error: any }} Object URL or error.
 */
function useMediaBlob(url, wanted, attempt) {
  const { get } = useFetchClient();
  const [state, setState] = useState({ src: null, error: null, url: null });

  useEffect(() => {
    if (!wanted) return undefined;
    let alive = true;
    let created = null;
    get(url, { responseType: 'blob' }).then(
      (response) => {
        if (!alive) return;
        created = URL.createObjectURL(response.data);
        setState({ src: created, error: null, url });
      },
      (error) => {
        if (!alive || error?.name === 'AbortError') return;
        setState({ src: null, error, url });
      }
    );
    return () => {
      alive = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [get, url, wanted, attempt]);

  // A result of an earlier URL never shows for a different file.
  return state.url === url ? state : { src: null, error: null };
}

/**
 * True once the element was scrolled near the viewport (thumbnails and
 * players only download when they are about to be seen).
 *
 * @param {import('react').RefObject<HTMLElement>} ref - Observed element.
 * @param {boolean} active - Observe only while the element is rendered.
 * @returns {boolean} Seen.
 */
function useSeen(ref, active) {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (seen || !active || !ref.current) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
      },
      { rootMargin: '200px' }
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref, seen, active]);
  return seen;
}

/**
 * Badge for a media state that is not `ready`, with the server's reason code.
 *
 * @param {{ status: string, code?: string | null }} props - Media state.
 * @returns {JSX.Element} State.
 */
export const MediaStateBadge = ({ status, code }) => {
  const t = useT();
  const state = mediaStates(t)[status] || { tone: 'neutral', label: status };
  return (
    <Flex gap={2} wrap="wrap" alignItems="center">
      <ToneBadge tone={state.tone}>{state.label}</ToneBadge>
      {code ? (
        <Typography variant="pi" textColor="neutral600">
          {code}
        </Typography>
      ) : null}
    </Flex>
  );
};

/**
 * Stored file of an inbound message: image thumbnail, audio player (voice
 * notes with their duration), MP4 player, or a file chip with a download
 * button. Files that are pending, failed, quarantined or not stored show a
 * state badge with the reason code instead.
 *
 * @param {object} props - Props.
 * @param {string} props.id - Inbound message id.
 * @param {{status: string, code: string|null, mime: string|null, size: number|null, filename: string|null, caption?: string|null, duration: number|null}} props.media - Media DTO.
 * @returns {JSX.Element} Media block.
 */
export const InboundMedia = ({ id, media }) => {
  const t = useT();
  const { formatNumber } = useIntl();
  const { get } = useFetchClient();
  const { toggleNotification } = useNotification();
  const ready = media.status === 'ready';
  const frame = useRef(null);
  const seen = useSeen(frame, ready);
  const [attempt, setAttempt] = useState(0);
  const [videoRequested, setVideoRequested] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const kind = mediaPresentation(media.mime);
  const types = mediaTypeLabels(t);
  const url = `/${PLUGIN_ID}/inbound/${encodeURIComponent(id)}/media`;
  const wanted = ready && seen && (kind === 'image' || kind === 'audio' || (kind === 'video' && videoRequested));
  const { src, error } = useMediaBlob(url, wanted, attempt);
  const filename = media.filename || types[kind];
  const size = sizeText(formatNumber, media.size);
  const duration = formatDuration(media.duration);

  const download = async () => {
    setDownloading(true);
    try {
      const response = await get(url, { responseType: 'blob', params: { download: 'true' } });
      saveBlob(response.data, filename);
    } catch (err) {
      if (err?.name !== 'AbortError') toggleNotification({ type: 'danger', message: errorMessage(t, err) });
    } finally {
      setDownloading(false);
    }
  };

  const downloadButton = (
    <Button
      variant="tertiary"
      size="S"
      startIcon={<Download />}
      onClick={download}
      loading={downloading}
      aria-label={t('inbox.media.downloadNamed', 'Download {name}', { name: filename })}
    >
      {t('inbox.media.download', 'Download')}
    </Button>
  );

  if (!ready) {
    return (
      <Flex direction="column" alignItems="flex-start" gap={1}>
        <Flex gap={2} alignItems="center">
          <Paperclip aria-hidden />
          <Typography textColor="neutral800">{types[kind]}</Typography>
        </Flex>
        <MediaStateBadge status={media.status} code={media.code} />
      </Flex>
    );
  }

  const meta = [media.filename, size].filter(Boolean).join(' · ');
  const loading = wanted && !src && !error;

  return (
    <Flex ref={frame} direction="column" alignItems="stretch" gap={2} minWidth={0}>
      {kind === 'image' ? (
        src ? (
          <Thumbnail src={src} alt={t('inbox.media.imageAlt', 'Image sent by the contact')} />
        ) : null
      ) : null}

      {kind === 'audio' ? (
        <>
          <Flex gap={2} alignItems="center">
            <Microphone aria-hidden />
            <Typography textColor="neutral800">
              {duration
                ? t('inbox.media.audioDuration', 'Audio message, {duration}', { duration })
                : t('inbox.media.audioMessage', 'Audio message')}
            </Typography>
          </Flex>
          {src ? (
            <AudioPlayer
              controls
              preload="metadata"
              src={src}
              aria-label={
                duration
                  ? t('inbox.media.audioDuration', 'Audio message, {duration}', { duration })
                  : t('inbox.media.audioMessage', 'Audio message')
              }
            />
          ) : null}
        </>
      ) : null}

      {kind === 'video' ? (
        src ? (
          <VideoPlayer controls preload="metadata" src={src} aria-label={t('inbox.media.video', 'Video')} />
        ) : !videoRequested ? (
          <Box>
            <Button variant="secondary" size="S" startIcon={<Play />} onClick={() => setVideoRequested(true)}>
              {size
                ? t('inbox.media.loadVideoSize', 'Load video ({size})', { size })
                : t('inbox.media.loadVideo', 'Load video')}
            </Button>
          </Box>
        ) : null
      ) : null}

      {kind === 'file' ? (
        <Flex
          gap={3}
          alignItems="center"
          padding={3}
          hasRadius
          borderColor="neutral200"
          background="neutral100"
          minWidth={0}
          wrap="wrap"
        >
          <Paperclip aria-hidden />
          <Flex direction="column" alignItems="flex-start" gap={1} minWidth={0} flex="1 1 0">
            <FileName textColor="neutral800" fontWeight="semiBold">
              {filename}
            </FileName>
            <Typography variant="pi" textColor="neutral600">
              {[size, media.mime].filter(Boolean).join(' · ')}
            </Typography>
          </Flex>
          {downloadButton}
        </Flex>
      ) : null}

      {loading ? (
        <Box>
          <Loader small>{t('inbox.media.loading', 'Loading the file…')}</Loader>
        </Box>
      ) : null}

      {error ? (
        <Flex gap={2} wrap="wrap" alignItems="center">
          <Typography variant="pi" textColor="danger600">
            {t('inbox.media.loadFailed', 'The file could not be loaded.')}
          </Typography>
          <TextButton startIcon={<ArrowClockwise />} onClick={() => setAttempt((n) => n + 1)}>
            {t('common.retry', 'Try again')}
          </TextButton>
        </Flex>
      ) : null}

      {kind !== 'file' ? (
        <Flex gap={2} wrap="wrap" alignItems="center" justifyContent="space-between">
          {meta ? (
            <FileName variant="pi" textColor="neutral600">
              {meta}
            </FileName>
          ) : (
            <span />
          )}
          {downloadButton}
        </Flex>
      ) : null}
    </Flex>
  );
};
