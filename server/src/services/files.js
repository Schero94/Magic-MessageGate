'use strict';

/**
 * Media library access for the core (attachments, template samples, inbound
 * media). Uses the upload plugin's own service so every upload provider
 * (local, S3, Cloudinary, …) works without extra code.
 *
 * Strapi 5 upload service (read in @strapi/upload 5.61 source, the server
 * API is not on docs.strapi.io): `upload({ data: { fileInfo }, files })`
 * with `files = { filepath, originalFilename, mimetype, size }`,
 * `remove(file)`, and `service('folder').create({ name, parent })`.
 * Files: Query Engine `plugin::upload.file` (https://docs.strapi.io/cms/api/query-engine).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { localUploadPath } = require('../core/attachments');
const { fetchLimited } = require('../utils/download');
const { checkUrl, resolvesPublic } = require('../utils/url-guard');

const FOLDER_NAME = 'MessageGate inbound';
const FIELDS = ['id', 'name', 'mime', 'size', 'url', 'provider', 'formats', 'hash', 'ext'];

/**
 * @param {object} strapi
 * @returns {object} `ctx.files` implementation
 */
function createFiles(strapi) {
  const query = () => strapi.db.query('plugin::upload.file');
  let folderId = null;

  /** @returns {Promise<number|null>} id of the MessageGate inbound folder */
  async function folder() {
    if (folderId) return folderId;
    const folders = strapi.db.query('plugin::upload.folder');
    let row = await folders.findOne({ where: { name: FOLDER_NAME, parent: null }, orderBy: { id: 'asc' } });
    if (!row) {
      try {
        await strapi.plugin('upload').service('folder').create({ name: FOLDER_NAME, parent: null });
      } catch {
        // a parallel process created it
      }
      row = await folders.findOne({ where: { name: FOLDER_NAME, parent: null }, orderBy: { id: 'asc' } });
    }
    folderId = row?.id ?? null;
    return folderId;
  }

  const api = {
    /** @param {number} id */
    get: (id) => query().findOne({ where: { id }, select: FIELDS }),

    /** @param {object} file */
    localPath: (file) => {
      const full = localUploadPath(strapi.dirs?.static?.public, file);
      return full && fs.existsSync(full) ? full : null;
    },

    /**
     * Downloads a remote media-library file (public https host only).
     *
     * @param {string} url
     * @param {number} maxBytes
     * @returns {Promise<Buffer|null>}
     */
    async fetchRemote(url, maxBytes) {
      if (!checkUrl(url).ok || !(await resolvesPublic(url))) return null;
      const res = await fetchLimited({ url, maxBytes });
      return res.ok ? res.bytes : null;
    },

    /**
     * @param {number} id
     * @param {number} maxBytes
     * @returns {Promise<Buffer|null>}
     */
    async read(id, maxBytes) {
      const file = await api.get(id);
      if (!file) return null;
      const local = api.localPath(file);
      if (local) return fs.promises.readFile(local);
      return api.fetchRemote(String(file.url), maxBytes);
    },

    /**
     * Stores bytes in the media library (MessageGate inbound folder).
     *
     * @param {{bytes: Buffer, mime: string, filename: string}} input
     * @returns {Promise<number>} file id
     */
    async store({ bytes, mime, filename }) {
      const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mg-inbound-'));
      try {
        const filepath = path.join(dir, filename);
        await fs.promises.writeFile(filepath, bytes, { mode: 0o600 });
        const [file] = await strapi
          .plugin('upload')
          .service('upload')
          .upload({
            data: { fileInfo: { name: filename, folder: await folder() } },
            files: { filepath, originalFilename: filename, mimetype: mime, size: bytes.length },
          });
        return file.id;
      } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
      }
    },

    /** @param {number} id */
    async remove(id) {
      const file = await query().findOne({ where: { id } });
      if (file) await strapi.plugin('upload').service('upload').remove(file);
    },
  };
  return api;
}

module.exports = { createFiles, FOLDER_NAME };
