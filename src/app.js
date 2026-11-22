'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { rateLimit } = require('express-rate-limit');
const contentDisposition = require('content-disposition');
const { normalizePhone } = require('./phone');
const { createMaterials } = require('./materials');

const COOKIE = 'sa_access';
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function humanSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

function createApp({ config, db, telegram, materials, log = console }) {
  materials = materials || createMaterials({ dir: config.materialsDir, cacheDir: path.join(config.dataDir, 'cache'), title: config.folderTitle, log });
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy); // Railway стоит за прокси: нужен реальный IP и req.secure

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });
  app.use(express.json({ limit: '10kb' }));
  app.use(cookieParser());

  // ---------- helpers ----------
  const tokenFrom = (req) => req.cookies?.[COOKIE];
  const hasAccess = (req) => db.isTokenValid(tokenFrom(req));
  const baseUrl = (req) => config.siteUrl || `${req.protocol}://${req.get('host')}`;
  const accessLink = (req, token) => `${baseUrl(req)}/access/${token}`;
  const setAccessCookie = (req, res, token) =>
    res.cookie(COOKIE, token, { httpOnly: true, secure: req.secure, sameSite: 'lax', maxAge: YEAR_MS, path: '/' });
  const noStore = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  };
  const bad = (res, code, error, status = 400) => res.status(status).json({ ok: false, code, error });

  const limiter = () =>
    rateLimit({
      windowMs: 10 * 60 * 1000,
      limit: config.orderRateLimit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: (req, res) => bad(res, 'rate_limited', 'Тым көп сұрау. 10 минуттан кейін қайталап көріңіз.', 429),
    });

  // ---------- публичные данные ----------
  app.get('/api/config', noStore, (req, res) => {
    res.json({
      price: config.price,
      oldPrice: config.oldPrice > config.price ? config.oldPrice : 0,
      kaspiPhone: config.kaspiPhone,
      kaspiPhoneDisplay: config.kaspiPhoneDisplay,
      hasQr: fs.existsSync(config.kaspiQrPath),
      supportContact: config.supportContact,
    });
  });

  app.get('/api/materials', noStore, (req, res) => {
    const files = materials.list();
    const total = files.reduce((n, f) => n + f.size, 0);
    res.json({
      title: materials.title,
      count: files.length,
      size: files.length ? humanSize(total) : '',
      // названия файлов внутри папки показываем только после оплаты
      files: hasAccess(req) ? files.map((f) => ({ id: f.id, name: f.name, ext: f.ext, size: humanSize(f.size) })) : [],
    });
  });

  app.get('/api/me', noStore, (req, res) => {
    const token = tokenFrom(req);
    if (db.isTokenValid(token)) return res.json({ access: true, link: accessLink(req, token) });
    res.json({ access: false });
  });

  // ---------- заявки ----------
  app.post('/api/orders', noStore, limiter(), async (req, res) => {
    const name = String(req.body?.name ?? '').trim().replace(/\s+/g, ' ');
    const phone = normalizePhone(req.body?.phone);
    if (name.length < 2 || name.length > 80) return bad(res, 'bad_name', 'Аты-жөніңізді жазыңыз');
    if (!phone) return bad(res, 'bad_phone', 'Телефон нөмірі қате. Үлгі: +7 (7XX) XXX-XX-XX');

    const { order, created } = db.createOrder({ name, phone, amount: config.price, ip: req.ip });
    if (created) await telegram.notifyOrder(order);
    res.status(created ? 201 : 200).json({ ok: true, orderId: order.public_id, orderNo: order.id, status: order.status, existing: !created });
  });

  app.get('/api/orders/:id/status', noStore, (req, res) => {
    const order = db.getOrderByPublicId(String(req.params.id));
    if (!order) return bad(res, 'not_found', 'Өтінім табылмады', 404);
    const out = { ok: true, status: order.status, orderNo: order.id };
    if (order.status === 'paid') {
      setAccessCookie(req, res, order.token);
      out.link = accessLink(req, order.token);
    }
    res.json(out);
  });

  // ---------- восстановление доступа ----------
  app.post('/api/restore', noStore, limiter(), async (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return bad(res, 'bad_phone', 'Телефон нөмірі қате. Үлгі: +7 (7XX) XXX-XX-XX');
    const { restore, created } = db.createRestore(phone);
    if (created) await telegram.notifyRestore(restore);
    res.status(created ? 201 : 200).json({ ok: true, restoreId: restore.public_id, requestNo: restore.id, status: restore.status });
  });

  app.get('/api/restore/:id/status', noStore, (req, res) => {
    const r = db.getRestoreByPublicId(String(req.params.id));
    if (!r) return bad(res, 'not_found', 'Сұрау табылмады', 404);
    // для фронта статусы одинаковые с заявками: pending / paid / rejected
    const status = r.status === 'approved' ? 'paid' : r.status;
    const out = { ok: true, status, requestNo: r.id };
    if (status === 'paid') {
      setAccessCookie(req, res, r.token);
      out.link = accessLink(req, r.token);
    }
    res.json(out);
  });

  // ---------- личная ссылка ----------
  app.get('/access/:token', noStore, (req, res) => {
    const token = String(req.params.token);
    if (!db.isTokenValid(token)) return res.redirect(302, '/?access=bad');
    setAccessCookie(req, res, token);
    res.redirect(302, '/?access=ok');
  });

  // ---------- файлы (только через проверку токена) ----------
  function denied(req, res, intent) {
    res.status(401);
    if (req.accepts(['html', 'json']) === 'html') {
      const to = `/?pay=${intent}`;
      return res.type('html').send(
        `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${to}">` +
          `<p>Қолжетімділік жоқ. <a href="${to}">Төлем бетіне өту</a></p>`
      );
    }
    return res.json({ ok: false, code: 'unauthorized', error: 'Қолжетімділік жоқ' });
  }
  const notFound = (res) => res.status(404).json({ ok: false, code: 'not_found', error: 'Файл табылмады' });
  function send(res, file, name, disposition) {
    res.set('Cache-Control', 'private, no-store');
    res.set('Content-Disposition', contentDisposition(name, { type: disposition }));
    res.sendFile(file, (err) => { // Content-Type — по расширению файла
      if (err && !res.headersSent) notFound(res);
    });
  }

  // вся папка одним ZIP
  app.get('/api/download/all', async (req, res, next) => {
    if (!hasAccess(req)) return denied(req, res, 'download');
    try {
      const { path: zipPath, files } = await materials.zip();
      if (!files.length) return notFound(res);
      send(res, zipPath, `${materials.title}.zip`, 'attachment');
    } catch (e) {
      next(e);
    }
  });

  // отдельные файлы: id только из списка файлов папки (белый список), никаких путей от пользователя
  function sendOne(disposition) {
    return (req, res) => {
      const f = /^[a-f0-9]{12}$/.test(req.params.fileId) ? materials.get(req.params.fileId) : null;
      if (!f) return notFound(res);
      if (!hasAccess(req)) return denied(req, res, 'view');
      send(res, f.path, f.name, disposition);
    };
  }
  app.get('/api/download/:fileId', sendOne('attachment'));
  app.get('/api/view/:fileId', sendOne('inline'));

  // ---------- статика (только public/) ----------
  app.use(express.static(config.publicDir, { index: 'index.html', extensions: false }));

  app.use('/api', (req, res) => bad(res, 'not_found', 'Not found', 404));
  app.use((req, res) => res.status(404).type('text').send('Not found'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return bad(res, 'bad_json', 'Bad JSON');
    log.error('[http]', err);
    res.status(500).json({ ok: false, code: 'server_error', error: 'Сервер қатесі' });
  });

  return app;
}

module.exports = { createApp, COOKIE };
