'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const SKIP = (n) => n.startsWith('.') || n.startsWith('~$') || n === 'Thumbs.db' || n === 'desktop.ini';

/**
 * Папка с материалами: все файлы из MATERIALS_DIR (private/materials).
 * Белый список строится сканированием папки — путей от пользователя нет.
 * «Скачать всё» — ZIP, который собирается автоматически и кешируется, пока файлы не поменяются.
 */
function createMaterials({ dir, cacheDir, title, log = console }) {
  fs.mkdirSync(cacheDir, { recursive: true });

  function list() {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((d) => d.isFile() && !SKIP(d.name))
      .map((d) => {
        const abs = path.join(dir, d.name);
        const st = fs.statSync(abs);
        const name = d.name.normalize('NFC'); // macOS хранит имена в NFD
        return { id: sha1(name).slice(0, 12), name, path: abs, size: st.size, mtime: st.mtimeMs, ext: path.extname(name).slice(1).toLowerCase() };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }));
  }

  const get = (id) => list().find((f) => f.id === id);

  const building = new Map();
  async function zip() {
    const files = list();
    const sig = sha1(files.map((f) => `${f.name}:${f.size}:${f.mtime}`).join('|')).slice(0, 16);
    const out = path.join(cacheDir, `folder-${sig}.zip`);
    if (fs.existsSync(out)) return { path: out, files };
    if (!building.has(out)) {
      building.set(
        out,
        (async () => {
          const tmp = `${out}.${process.pid}.tmp`;
          await new Promise((resolve, reject) => {
            const ws = fs.createWriteStream(tmp);
            const a = archiver('zip', { zlib: { level: 6 } });
            ws.on('close', resolve);
            a.on('error', reject);
            ws.on('error', reject);
            a.pipe(ws);
            for (const f of files) a.file(f.path, { name: `${title}/${f.name}` });
            a.finalize();
          });
          fs.renameSync(tmp, out);
          // удалить старые архивы
          for (const n of fs.readdirSync(cacheDir)) if (n.startsWith('folder-') && path.join(cacheDir, n) !== out) fs.rmSync(path.join(cacheDir, n), { force: true });
          log.info?.(`[materials] собран архив: ${files.length} файл(ов)`);
        })().finally(() => building.delete(out))
      );
    }
    await building.get(out);
    return { path: out, files };
  }

  return { title, dir, list, get, zip };
}

module.exports = { createMaterials };
