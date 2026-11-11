'use strict';

/**
 * In-memory stand-in for the media library (`ctx.files`): library files for
 * attachments/template samples and a store for inbound media.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PDF = Buffer.from('%PDF-1.4\n%synthetic\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

/**
 * @returns {object} files implementation plus `stored` map and `add(file, bytes)`
 */
function memoryFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-files-'));
  const rows = new Map();
  const bytesOf = new Map();
  let next = 1;
  const api = {
    rows,
    /** @param {object} file @param {Buffer} [bytes] - local file content */
    add(file, bytes) {
      const id = file.id || next++;
      next = Math.max(next, id + 1);
      rows.set(id, { id, provider: 'local', ...file });
      if (bytes) bytesOf.set(id, bytes);
      return id;
    },
    async get(id) {
      return rows.get(Number(id)) || null;
    },
    localPath(file) {
      const bytes = bytesOf.get(file.id);
      if (!bytes) return null;
      const target = path.join(dir, `f${file.id}`);
      if (!fs.existsSync(target)) fs.writeFileSync(target, bytes);
      return target;
    },
    async fetchRemote() {
      return null;
    },
    async read(id) {
      return bytesOf.get(Number(id)) || null;
    },
    async store({ bytes, mime, filename }) {
      const id = next++;
      rows.set(id, {
        id,
        name: filename,
        mime,
        size: bytes.length / 1024,
        url: `/uploads/${filename}`,
        provider: 'local',
      });
      bytesOf.set(id, bytes);
      return id;
    },
    async remove(id) {
      rows.delete(Number(id));
      bytesOf.delete(Number(id));
    },
  };
  return api;
}

module.exports = { memoryFiles, PDF, PNG };
