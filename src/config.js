'use strict';

const fs = require('fs');
const path = require('path');
const { normalizePhone, formatPhone } = require('./phone');

const ROOT = path.resolve(__dirname, '..');

function int(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

/** Загрузка materials.json: белый список файлов. Пути от пользователя никогда не используются. */
function loadMaterials(file, privateDir) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(raw)) throw new Error('materials.json: ожидается массив');
  const seen = new Set();
  return raw.map((m, i) => {
    const where = `materials.json[${i}]`;
    if (!m || typeof m.id !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(m.id)) {
      throw new Error(`${where}: id должен состоять из латиницы, цифр, "-" или "_"`);
    }
    if (seen.has(m.id)) throw new Error(`${where}: id "${m.id}" повторяется`);
    seen.add(m.id);
    if (typeof m.filename !== 'string' || path.basename(m.filename) !== m.filename || m.filename.startsWith('.')) {
      throw new Error(`${where}: filename должен быть просто именем файла внутри private/`);
    }
    const abs = path.join(privateDir, m.filename);
    if (!fs.existsSync(abs)) console.warn(`[config] ВНИМАНИЕ: файл не найден: private/${m.filename}`);
    return {
      id: m.id,
      title: String(m.title || m.filename),
      description: String(m.description || ''),
      filename: m.filename,
      tag: String(m.tag || ''),
      size: m.size ? String(m.size) : null, // если не указан — считается автоматически
      path: abs,
    };
  });
}

function loadConfig(overrides = {}) {
  const env = { ...process.env, ...overrides };
  const kaspiRaw = (env.KASPI_PHONE || '').trim();
  const kaspiNorm = normalizePhone(kaspiRaw);
  const privateDir = path.resolve(env.PRIVATE_DIR || path.join(ROOT, 'private'));
  const publicDir = path.join(ROOT, 'public');

  const cfg = {
    root: ROOT,
    port: int(env.PORT, 3000),
    botToken: (env.BOT_TOKEN || '').trim(),
    adminChatId: (env.ADMIN_CHAT_ID || '').trim(),
    kaspiPhone: kaspiNorm || kaspiRaw,
    kaspiPhoneDisplay: kaspiNorm ? formatPhone(kaspiNorm) : kaspiRaw,
    price: int(env.PRICE, 666),
    siteUrl: (env.SITE_URL || '').trim().replace(/\/+$/, ''),
    dataDir: path.resolve(env.DATA_DIR || path.join(ROOT, 'data')),
    supportContact: (env.SUPPORT_CONTACT || '').trim(),
    timeZone: (env.TIME_ZONE || 'Asia/Almaty').trim(),
    orderRateLimit: int(env.ORDER_RATE_LIMIT, 5),
    trustProxy: int(env.TRUST_PROXY, 1),
    privateDir,
    publicDir,
    kaspiQrPath: path.join(publicDir, 'kaspi-qr.png'),
    materials: loadMaterials(path.join(ROOT, 'materials.json'), privateDir),
  };

  if (!cfg.kaspiPhone) console.warn('[config] ВНИМАНИЕ: KASPI_PHONE не задан');
  if (!cfg.botToken) console.warn('[config] ВНИМАНИЕ: BOT_TOKEN не задан — уведомления в Telegram отключены');
  else if (!cfg.adminChatId) console.warn('[config] ВНИМАНИЕ: ADMIN_CHAT_ID не задан — напишите боту /start, чтобы узнать его');
  return cfg;
}

module.exports = { loadConfig };
