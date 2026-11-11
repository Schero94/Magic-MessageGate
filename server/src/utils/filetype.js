'use strict';

/**
 * File type detection by magic bytes, file-name sanitising and metadata
 * stripping for inbound media. No third-party code: the signatures below are
 * the published format headers (JPEG SOI, PNG signature, RIFF/WEBP, %PDF,
 * ZIP local header for OOXML, OLE2 for legacy Office, OggS, ID3/MPEG frame,
 * ADTS AAC, #!AMR, ISO BMFF `ftyp` for MP4/M4A/3GP).
 */

/** Inbound MIME types accepted by default. */
const DEFAULT_INBOUND_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'text/plain',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/amr',
  'video/mp4',
  'video/3gpp',
]);

/** Which detected container a declared type must have. */
const FAMILY = Object.freeze({
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'zip',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'zip',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'zip',
  'application/msword': 'ole',
  'application/vnd.ms-excel': 'ole',
  'application/vnd.ms-powerpoint': 'ole',
  'text/plain': 'text',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'isobmff',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'video/mp4': 'isobmff',
  'video/3gpp': 'isobmff',
});

const EXT = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'text/plain': 'txt',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
});

/**
 * @param {Buffer} b
 * @returns {string|null} Detected container family.
 */
function detectFamily(b) {
  if (!Buffer.isBuffer(b) || b.length < 4) return null;
  const ascii = (start, end) => b.subarray(start, end).toString('latin1');
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(0, 5) === '%PDF-') return 'pdf';
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'zip';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    return 'ole';
  }
  if (ascii(0, 4) === 'OggS') return 'ogg';
  if (ascii(0, 5) === '#!AMR') return 'amr';
  if (b.length >= 8 && ascii(4, 8) === 'ftyp') return 'isobmff';
  if (ascii(0, 3) === 'ID3') return 'mp3';
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return 'aac';
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'mp3';
  const head = b.subarray(0, Math.min(b.length, 4096));
  if (!head.includes(0) && !/<(?:!doctype|html|script|svg|\?xml)/i.test(head.toString('utf8'))) return 'text';
  return null;
}

/**
 * Whether the bytes really are of the declared type.
 *
 * @param {Buffer} bytes
 * @param {string} mime
 * @returns {boolean}
 */
function matchesType(bytes, mime) {
  const family = FAMILY[mime];
  return Boolean(family) && detectFamily(bytes) === family;
}

/**
 * Normalises a provider MIME type (`audio/ogg; codecs=opus` → `audio/ogg`).
 *
 * @param {string} value
 * @returns {string}
 */
const baseMime = (value) =>
  String(value || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
    .replace(/^image\/jpg$/, 'image/jpeg')
    .replace(/^audio\/x-m4a$/, 'audio/mp4')
    .replace(/^audio\/mp3$/, 'audio/mpeg');

/**
 * Safe file name: letters, digits, dot, dash, underscore; the extension
 * always matches the type.
 *
 * @param {string|null|undefined} name
 * @param {string} mime
 * @returns {string}
 */
function safeFilename(name, mime) {
  const ext = EXT[mime] || 'bin';
  const stem =
    String(name || '')
      .replace(/\.[^.]*$/, '')
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'file';
  return `${stem}.${ext}`;
}

/**
 * Removes EXIF (APP1 "Exif") segments from a JPEG, which hold GPS position
 * and device data. Other segments and the image data stay untouched.
 *
 * @param {Buffer} bytes
 * @returns {Buffer}
 */
function stripJpegExif(bytes) {
  if (detectFamily(bytes) !== 'jpeg') return bytes;
  const parts = [bytes.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return bytes; // unexpected layout: keep the original
    const marker = bytes[i + 1];
    if (marker === 0xda || marker === 0xd9) {
      parts.push(bytes.subarray(i));
      return Buffer.concat(parts);
    }
    const length = bytes.readUInt16BE(i + 2);
    if (length < 2 || i + 2 + length > bytes.length) return bytes;
    const segment = bytes.subarray(i, i + 2 + length);
    const isExif = marker === 0xe1 && segment.subarray(4, 10).toString('latin1') === 'Exif\u0000\u0000';
    if (!isExif) parts.push(segment);
    i += 2 + length;
  }
  return bytes;
}

/**
 * Removes `eXIf` chunks from a PNG.
 *
 * @param {Buffer} bytes
 * @returns {Buffer}
 */
function stripPngExif(bytes) {
  if (detectFamily(bytes) !== 'png') return bytes;
  const parts = [bytes.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(i);
    const type = bytes.subarray(i + 4, i + 8).toString('latin1');
    const end = i + 12 + length;
    if (end > bytes.length) return bytes;
    if (type !== 'eXIf') parts.push(bytes.subarray(i, end));
    i = end;
    if (type === 'IEND') return Buffer.concat(parts);
  }
  return bytes;
}

/**
 * @param {Buffer} bytes
 * @param {string} mime
 * @returns {Buffer} Bytes without location metadata where the format allows it.
 */
function stripMetadata(bytes, mime) {
  if (mime === 'image/jpeg') return stripJpegExif(bytes);
  if (mime === 'image/png') return stripPngExif(bytes);
  return bytes;
}

/**
 * Synthetic file of a type and size (sandbox).
 *
 * @param {string} mime
 * @param {number} size
 * @returns {Buffer}
 */
function syntheticFile(mime, size) {
  const heads = {
    jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0x00, 0x00]),
    png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    webp: Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBP', 'latin1'),
    pdf: Buffer.from('%PDF-1.4\n', 'latin1'),
    zip: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    ole: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    text: Buffer.from('sandbox file\n'),
    ogg: Buffer.from('OggS', 'latin1'),
    mp3: Buffer.from('ID3', 'latin1'),
    isobmff: Buffer.from('\u0000\u0000\u0000\u0018ftypmp42', 'latin1'),
    aac: Buffer.from([0xff, 0xf1, 0x50, 0x80]),
    amr: Buffer.from('#!AMR\n', 'latin1'),
  };
  const head = heads[FAMILY[mime]] || Buffer.from('sandbox');
  const total = Math.max(head.length, Math.floor(size) || head.length);
  return Buffer.concat([head, Buffer.alloc(total - head.length, FAMILY[mime] === 'text' ? 0x61 : 0x20)]);
}

module.exports = {
  DEFAULT_INBOUND_TYPES,
  FAMILY,
  detectFamily,
  matchesType,
  baseMime,
  safeFilename,
  stripMetadata,
  stripJpegExif,
  stripPngExif,
  syntheticFile,
};
