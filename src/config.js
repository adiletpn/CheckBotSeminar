'use strict';

const fs = require('fs');
const path = require('path');
const { normalizePhone, formatPhone } = require('./phone');

const ROOT = path.resolve(__dirname, '..');

function int(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function loadConfig(overrides = {}) {
  const env = { ...process.env, ...overrides };
  const kaspiRaw = (env.KASPI_PHONE || '').trim();
  const kaspiNorm = normalizePhone(kaspiRaw);
  const materialsDir = path.resolve(env.MATERIALS_DIR || path.join(ROOT, 'private', 'materials'));
  const publicDir = path.join(ROOT, 'public');

  const cfg = {
    root: ROOT,
    port: int(env.PORT, 3000),
    botToken: (env.BOT_TOKEN || '').trim(),
    adminChatId: (env.ADMIN_CHAT_ID || '').trim(),
    kaspiPhone: kaspiNorm || kaspiRaw,
    kaspiPhoneDisplay: kaspiNorm ? formatPhone(kaspiNorm) : kaspiRaw,
    price: int(env.PRICE, 666),
    oldPrice: int(env.OLD_PRICE, 0), // зачёркнутая «старая» цена (0 — не показывать)
    siteUrl: (env.SITE_URL || '').trim().replace(/\/+$/, ''),
    dataDir: path.resolve(env.DATA_DIR || path.join(ROOT, 'data')),
    supportContact: (env.SUPPORT_CONTACT || '').trim(),
    timeZone: (env.TIME_ZONE || 'Asia/Almaty').trim(),
    orderRateLimit: int(env.ORDER_RATE_LIMIT, 5),
    trustProxy: int(env.TRUST_PROXY, 1),
    materialsDir,
    folderTitle: (env.FOLDER_TITLE || 'Семинар материалдары').trim(),
    publicDir,
    kaspiQrPath: path.join(publicDir, 'kaspi-qr.png'),
  };

  if (!fs.existsSync(materialsDir)) console.warn(`[config] ВНИМАНИЕ: папка с материалами не найдена: ${materialsDir}`);
  if (!cfg.kaspiPhone) console.warn('[config] ВНИМАНИЕ: KASPI_PHONE не задан');
  if (!cfg.botToken) console.warn('[config] ВНИМАНИЕ: BOT_TOKEN не задан — уведомления в Telegram отключены');
  else if (!cfg.adminChatId) console.warn('[config] ВНИМАНИЕ: ADMIN_CHAT_ID не задан — напишите боту /start, чтобы узнать его');
  return cfg;
}

module.exports = { loadConfig };
