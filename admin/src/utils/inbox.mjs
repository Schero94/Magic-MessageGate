/**
 * Inbox helpers (pure, testable without a bundler).
 */

export const INBOUND_KINDS = ['text', 'button', 'media', 'location', 'other'];

/** Reply limit of the send API (`text` max 4096 characters). */
export const REPLY_MAX_LENGTH = 4096;

/** Inline media types the server serves with `Content-Disposition: inline`. */
const INLINE_IMAGES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const INLINE_AUDIO = new Set(['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac']);
const INLINE_VIDEO = new Set(['video/mp4']);

/**
 * How a stored inbound file is shown: an image thumbnail, an audio or video
 * player, or a file chip with a download button.
 *
 * @param {string | null | undefined} mime - Media type reported by the server.
 * @returns {'image' | 'audio' | 'video' | 'file'} Presentation.
 */
export function mediaPresentation(mime) {
  const type = String(mime || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (INLINE_IMAGES.has(type)) return 'image';
  if (INLINE_AUDIO.has(type)) return 'audio';
  if (INLINE_VIDEO.has(type)) return 'video';
  return 'file';
}

/**
 * Shortens a text for a list cell on a word boundary where possible.
 *
 * @param {string | null | undefined} text - Full text.
 * @param {number} [max] - Maximum characters before the ellipsis.
 * @returns {string} Excerpt (empty for missing text).
 */
export function excerpt(text, max = 100) {
  const clean = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Duration in seconds as `m:ss` (voice notes) or `h:mm:ss`.
 *
 * @param {number | null | undefined} seconds - Duration.
 * @returns {string | null} Formatted duration, null when unknown.
 */
export function formatDuration(seconds) {
  const total = Math.round(Number(seconds));
  if (!Number.isFinite(total) || total < 0) return null;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * Valid coordinates of a shared location, or null.
 *
 * @param {{latitude?: unknown, longitude?: unknown} | null | undefined} location - Location.
 * @returns {{lat: number, lon: number} | null} Coordinates.
 */
export function coordinates(location) {
  const lat = Number(location?.latitude);
  const lon = Number(location?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/**
 * OpenStreetMap link with a marker on the shared location.
 *
 * @param {{latitude?: unknown, longitude?: unknown} | null | undefined} location - Location.
 * @returns {string | null} URL, null for invalid coordinates.
 */
export function osmUrl(location) {
  const c = coordinates(location);
  if (!c) return null;
  const lat = c.lat.toFixed(6);
  const lon = c.lon.toFixed(6);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}`;
}

/**
 * The inbound message a reply answers: the newest inbound item of the
 * conversation (the server sends the reply on its channel and account).
 *
 * @param {Array<{direction: string, at: number}>} items - Conversation, oldest first.
 * @returns {object | null} Newest inbound item.
 */
export function replyTarget(items) {
  for (let i = (items || []).length - 1; i >= 0; i -= 1) if (items[i].direction === 'inbound') return items[i];
  return null;
}

/**
 * Whether free text can be sent as a reply: WhatsApp only inside the
 * 24-hour customer service window, the other channels always.
 *
 * @param {{channel: string} | null} target - Reply target.
 * @param {boolean} whatsappWindowOpen - Window state from the server.
 * @returns {boolean} Free text allowed.
 */
export function canReplyFreeText(target, whatsappWindowOpen) {
  if (!target) return false;
  return target.channel !== 'whatsapp' || whatsappWindowOpen === true;
}

/**
 * Query parameters for `GET /inbound` from the URL filters.
 *
 * @param {{page?: unknown, pageSize?: unknown, channel?: string, kind?: string, state?: string, read?: string}} query - URL query.
 * @returns {Record<string, string | number>} API params.
 */
export function inboundParams(query = {}) {
  const params = { page: Number(query.page) || 1, pageSize: Number(query.pageSize) || 25 };
  if (query.channel && query.channel !== 'all') params.channel = query.channel;
  if (query.kind && INBOUND_KINDS.includes(query.kind)) params.kind = query.kind;
  if (query.state === 'processed') params.processed = 'true';
  if (query.state === 'open') params.processed = 'false';
  if (query.read === 'unread') params.unread = 'true';
  return params;
}
