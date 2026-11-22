'use strict';

require('dotenv').config({ quiet: true });
const { loadConfig } = require('./src/config');
const { openDb } = require('./src/db');
const { createTelegram } = require('./src/telegram');
const { createApp } = require('./src/app');

const config = loadConfig();
const db = openDb(config.dataDir);
const telegram = createTelegram({ config, db });
const app = createApp({ config, db, telegram });

const server = app.listen(config.port, () => {
  console.log(`[http] сайт запущен: http://localhost:${config.port}  (данные: ${config.dataDir})`);
});
telegram.start();

let closing = false;
async function shutdown(sig) {
  if (closing) return;
  closing = true;
  console.log(`[app] ${sig}: остановка…`);
  await telegram.stop().catch(() => {});
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
