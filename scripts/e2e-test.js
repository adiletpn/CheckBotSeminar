'use strict';
/**
 * Локальная проверка всего сценария без настоящего Telegram:
 * API Telegram подменяется, нажатия кнопок имитируются через bot.handleUpdate().
 * Запуск: npm test
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { loadConfig } = require('../src/config');
const { openDb } = require('../src/db');
const { createTelegram } = require('../src/telegram');
const { createApp, COOKIE } = require('../src/app');

const ADMIN = '111111';
const STRANGER = '222222';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seminar-e2e-'));

const config = loadConfig({
  BOT_TOKEN: '123:TEST',
  ADMIN_CHAT_ID: ADMIN,
  KASPI_PHONE: '87001234567',
  PRICE: '666',
  DATA_DIR: dataDir,
  SITE_URL: '',
  ORDER_RATE_LIMIT: '1000', // лимит проверяется отдельно в конце
  MATERIALS_FILE: path.join(__dirname, 'materials.demo.json'), // 5 демо-PDF
});
const db = openDb(config.dataDir);

// --- фейковый Telegram API ---
const calls = [];
let msgId = 100;
const telegram = createTelegram({
  config,
  db,
  botOptions: { botInfo: { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false } },
  log: { info() {}, warn() {}, error: console.error },
});
telegram.bot.api.config.use(async (prev, method, payload) => {
  calls.push({ method, payload });
  const chat = { id: Number(payload.chat_id || ADMIN), type: 'private' };
  const result = method === 'sendMessage' ? { message_id: ++msgId, date: 0, chat, text: payload.text } : true;
  return { ok: true, result };
});
const lastCall = (m) => [...calls].reverse().find((c) => c.method === m);

let upd = 1;
const press = (from, data, message_id = msgId) =>
  telegram.bot.handleUpdate({
    update_id: upd++,
    callback_query: {
      id: String(upd), from: { id: Number(from), is_bot: false, first_name: 'X' }, chat_instance: 'c', data,
      message: { message_id, date: 0, chat: { id: Number(from), type: 'private' }, text: '...' },
    },
  });
const command = (from, cmd) =>
  telegram.bot.handleUpdate({
    update_id: upd++,
    message: { message_id: upd, date: 0, chat: { id: Number(from), type: 'private' }, from: { id: Number(from), is_bot: false, first_name: 'X' }, text: cmd, entities: [{ type: 'bot_command', offset: 0, length: cmd.length }] },
  });

// --- HTTP-клиент с куками ---
let base;
function client() {
  const jar = {};
  return {
    jar,
    async req(p, opt = {}) {
      const headers = { ...(opt.headers || {}) };
      const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookie) headers.cookie = cookie;
      if (opt.json) { headers['content-type'] = 'application/json'; opt.body = JSON.stringify(opt.json); }
      const r = await fetch(base + p, { method: opt.method || 'GET', headers, body: opt.body, redirect: 'manual' });
      for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
      return r;
    },
  };
}

let passed = 0;
async function step(name, fn) {
  await fn();
  passed++;
  console.log('  ✓', name);
}

(async () => {
  const app = createApp({ config, db, telegram, log: { error: console.error } });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  console.log(`E2E: ${base}  (DATA_DIR=${dataDir})\n`);

  const user = client();
  const anon = client();
  let order;

  try {
    await step('главная и список материалов отдаются', async () => {
      const r = await user.req('/');
      assert.equal(r.status, 200);
      assert.match(await r.text(), /Кәмелетке толмағандардың психологиялық қауіпсіздігі/);
      const m = await (await user.req('/api/materials')).json();
      assert.equal(m.length, 5);
      assert.ok(m.every((x) => x.id && x.title && x.size && !('filename' in x) && !('path' in x)));
      const c = await (await user.req('/api/config')).json();
      assert.equal(c.price, 666);
      assert.equal(c.kaspiPhoneDisplay, '+7 (700) 123-45-67');
      assert.equal(c.hasQr, fs.existsSync(config.kaspiQrPath));
    });

    await step('без токена файлы недоступны (download/view → 401, прямые пути → 404)', async () => {
      assert.equal((await anon.req('/api/download/bayandama')).status, 401);
      assert.equal((await anon.req('/api/view/bayandama')).status, 401);
      const html = await anon.req('/api/download/bayandama', { headers: { accept: 'text/html' } });
      assert.equal(html.status, 401);
      assert.match(await html.text(), /\/\?pay=bayandama/);
      for (const p of ['/files/bayandama.pdf', '/private/bayandama.pdf', '/bayandama.pdf', '/materials.json', '/package.json', '/.env', '/data/seminar.db'])
        assert.equal((await anon.req(p)).status, 404, p);
      // поддельный токен
      const fake = client();
      fake.jar[COOKIE] = 'a'.repeat(64);
      assert.equal((await fake.req('/api/download/bayandama')).status, 401);
      assert.equal((await (await fake.req('/api/me')).json()).access, false);
    });

    await step('path traversal не проходит', async () => {
      for (const p of ['/api/download/..%2F..%2Fpackage.json', '/api/download/..%2Fprivate%2Fbayandama.pdf', '/api/download/bayandama.pdf', '/api/view/%2E%2E%2F.env'])
        assert.ok([401, 404].includes((await anon.req(p)).status), p);
    });

    await step('валидация заявки', async () => {
      let r = await user.req('/api/orders', { method: 'POST', json: { name: 'А', phone: '+77011234567' } });
      assert.equal(r.status, 400);
      r = await user.req('/api/orders', { method: 'POST', json: { name: 'Айгүл', phone: '+7 (601) 123-45-67' } });
      assert.equal((await r.json()).code, 'bad_phone');
      r = await user.req('/api/orders', { method: 'POST', json: { name: 'Айгүл', phone: '12345' } });
      assert.equal(r.status, 400);
    });

    await step('создание заявки → уведомление админу с кнопками', async () => {
      const r = await user.req('/api/orders', { method: 'POST', json: { name: 'Айгүл <b>Серікова</b>', phone: '8 701 123 45 67' } });
      assert.equal(r.status, 201);
      order = await r.json();
      assert.match(order.orderId, /^[a-f0-9]{32}$/);
      const msg = lastCall('sendMessage');
      assert.equal(String(msg.payload.chat_id), ADMIN);
      assert.match(msg.payload.text, new RegExp(`#${order.orderNo}`));
      assert.match(msg.payload.text, /Айгүл &lt;b&gt;Серікова&lt;\/b&gt;/); // HTML экранирован
      assert.match(msg.payload.text, /\+7 \(701\) 123-45-67/);
      assert.match(msg.payload.text, /666 ₸/);
      const btns = msg.payload.reply_markup.inline_keyboard.flat();
      assert.deepEqual(btns.map((b) => b.text), ['✅ Растау', '❌ Бас тарту']);
      assert.deepEqual(btns.map((b) => b.callback_data), [`ok:${order.orderNo}`, `no:${order.orderNo}`]);
    });

    await step('дубль по тому же телефону возвращает ту же заявку, без нового сообщения', async () => {
      const n = calls.filter((c) => c.method === 'sendMessage').length;
      const r = await user.req('/api/orders', { method: 'POST', json: { name: 'Айгүл', phone: '+77011234567' } });
      const d = await r.json();
      assert.equal(d.orderId, order.orderId);
      assert.equal(d.existing, true);
      assert.equal(calls.filter((c) => c.method === 'sendMessage').length, n);
    });

    await step('статус pending, cookie не выдаётся', async () => {
      const d = await (await user.req(`/api/orders/${order.orderId}/status`)).json();
      assert.equal(d.status, 'pending');
      assert.equal(user.jar[COOKIE], undefined);
      assert.equal((await user.req('/api/orders/nonexistent/status')).status, 404);
    });

    await step('чужой человек нажимает кнопку → «Рұқсат жоқ», статус не меняется', async () => {
      await press(STRANGER, `ok:${order.orderNo}`);
      const a = lastCall('answerCallbackQuery');
      assert.equal(a.payload.text, 'Рұқсат жоқ');
      assert.equal(db.getOrder(order.orderNo).status, 'pending');
      await command(STRANGER, '/stats');
      assert.equal(lastCall('sendMessage').payload.text, 'Рұқсат жоқ');
    });

    await step('админ нажимает «✅ Растау» → сообщение отредактировано, кнопки убраны', async () => {
      await press(ADMIN, `ok:${order.orderNo}`);
      assert.equal(lastCall('answerCallbackQuery').payload.text, 'Расталды ✅');
      const e = lastCall('editMessageText');
      assert.match(e.payload.text, /Расталды ✅ \(\d\d\.\d\d\.\d{4} \d\d:\d\d\)/);
      assert.equal(e.payload.reply_markup, undefined);
      assert.equal(db.getOrder(order.orderNo).status, 'paid');
    });

    await step('повторное нажатие не меняет решение', async () => {
      await press(ADMIN, `no:${order.orderNo}`);
      assert.equal(lastCall('answerCallbackQuery').payload.text, 'Бұл өтінім бұрын өңделген');
      assert.equal(db.getOrder(order.orderNo).status, 'paid');
    });

    let link;
    await step('опрос статуса → paid, httpOnly cookie на год + личная ссылка', async () => {
      const r = await user.req(`/api/orders/${order.orderId}/status`);
      const d = await r.json();
      assert.equal(d.status, 'paid');
      const sc = r.headers.getSetCookie().find((c) => c.startsWith(COOKIE + '='));
      assert.ok(sc, 'cookie set');
      assert.match(sc, /HttpOnly/i);
      assert.match(sc, /SameSite=Lax/i);
      assert.match(sc, /Max-Age=31536000/);
      assert.match(user.jar[COOKIE], /^[a-f0-9]{64}$/);
      assert.equal(d.link, `${base}/access/${user.jar[COOKIE]}`);
      link = d.link;
      const me = await (await user.req('/api/me')).json();
      assert.equal(me.access, true);
    });

    await step('скачивание (attachment) и просмотр (inline) с токеном', async () => {
      const r = await user.req('/api/download/bayandama');
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-disposition'), /^attachment; filename="bayandama\.pdf"/);
      assert.match(r.headers.get('content-type'), /application\/pdf/);
      const buf = Buffer.from(await r.arrayBuffer());
      assert.deepEqual(buf, fs.readFileSync(path.join(config.privateDir, 'bayandama.pdf')));
      const v = await user.req('/api/view/baghdarlama');
      assert.equal(v.status, 200);
      assert.match(v.headers.get('content-disposition'), /^inline;/);
      assert.equal(Number(v.headers.get('content-length')), fs.statSync(path.join(config.privateDir, 'baghdarlama.pdf')).size);
      assert.equal((await user.req('/api/download/../package.json')).status, 404);
      assert.equal((await user.req('/api/download/nope')).status, 404);
    });

    await step('личная ссылка /access/<токен> открывает доступ на другом устройстве', async () => {
      const other = client();
      const r = await other.req(new URL(link).pathname);
      assert.equal(r.status, 302);
      assert.equal(r.headers.get('location'), '/?access=ok');
      assert.equal((await other.req('/api/download/zhadnama')).status, 200);
      const bad = await client().req('/access/' + 'b'.repeat(64));
      assert.equal(bad.headers.get('location'), '/?access=bad');
    });

    await step('отклонение заявки: «❌ Бас тарту» → rejected, без доступа', async () => {
      const c2 = client();
      const o = await (await c2.req('/api/orders', { method: 'POST', json: { name: 'Ерлан', phone: '+7 (777) 000-11-22' } })).json();
      await press(ADMIN, `no:${o.orderNo}`);
      assert.match(lastCall('editMessageText').payload.text, /Бас тартылды ❌/);
      const d = await (await c2.req(`/api/orders/${o.orderId}/status`)).json();
      assert.equal(d.status, 'rejected');
      assert.equal(c2.jar[COOKIE], undefined);
      assert.equal((await c2.req('/api/download/bayandama')).status, 401);
    });

    await step('восстановление «Бұрын төледім» → кнопка «Қолжетімділікті қайтару» → доступ с тем же токеном', async () => {
      const fresh = client();
      const r = await fresh.req('/api/restore', { method: 'POST', json: { phone: '+77011234567' } });
      assert.equal(r.status, 201);
      const rs = await r.json();
      const msg = lastCall('sendMessage');
      assert.match(msg.payload.text, /расталған төлем бар: #/);
      assert.deepEqual(msg.payload.reply_markup.inline_keyboard.flat().map((b) => b.text), ['🔓 Қолжетімділікті қайтару', '❌ Бас тарту']);
      assert.equal((await (await fresh.req(`/api/restore/${rs.restoreId}/status`)).json()).status, 'pending');
      await press(ADMIN, `rok:${rs.requestNo}`);
      assert.match(lastCall('editMessageText').payload.text, /Қолжетімділік қайтарылды ✅/);
      const d = await (await fresh.req(`/api/restore/${rs.restoreId}/status`)).json();
      assert.equal(d.status, 'paid');
      assert.equal(fresh.jar[COOKIE], user.jar[COOKIE]);
      assert.equal((await fresh.req('/api/download/trening')).status, 200);
    });

    await step('восстановление по номеру без оплаты: админ видит предупреждение, может отклонить', async () => {
      const c3 = client();
      const rs = await (await c3.req('/api/restore', { method: 'POST', json: { phone: '+77050000000' } })).json();
      assert.match(lastCall('sendMessage').payload.text, /расталған төлем табылмады/);
      await press(ADMIN, `rno:${rs.requestNo}`);
      assert.equal((await (await c3.req(`/api/restore/${rs.restoreId}/status`)).json()).status, 'rejected');
    });

    await step('команды админа: /start, /orders, /pending, /stats', async () => {
      await command(STRANGER, '/start');
      assert.match(lastCall('sendMessage').payload.text, new RegExp(STRANGER));
      await command(ADMIN, '/orders');
      assert.match(lastCall('sendMessage').payload.text, /Соңғы 10 өтінім/);
      await command(ADMIN, '/stats');
      const st = lastCall('sendMessage').payload.text;
      assert.match(st, /Бүгін: 1 төлем · 666 ₸/);
      assert.match(st, /Барлығы: 1 төлем · 666 ₸/);
      await (client()).req('/api/orders', { method: 'POST', json: { name: 'Болат', phone: '+77470001122' } });
      const before = calls.length;
      await command(ADMIN, '/pending');
      const sent = calls.slice(before).filter((c) => c.method === 'sendMessage');
      assert.match(sent[0].payload.text, /Расталмаған өтінімдер: 1/);
      assert.ok(sent[1].payload.reply_markup.inline_keyboard);
    });

    await step('rate limit: не больше 5 заявок за 10 минут с одного IP', async () => {
      const app2 = createApp({ config: { ...config, orderRateLimit: 5 }, db, telegram, log: { error: console.error } });
      const s2 = app2.listen(0);
      await new Promise((r) => s2.once('listening', r));
      const u = `http://127.0.0.1:${s2.address().port}/api/orders`;
      const codes = [];
      for (let i = 0; i < 6; i++) {
        const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Спам', phone: '+7700999887' + i }) });
        codes.push(r.status);
      }
      s2.close();
      assert.deepEqual(codes, [201, 201, 201, 201, 201, 429]);
    });

    await step('боевой materials.json: архив со всеми материалами скачивается после оплаты', async () => {
      const real = loadConfig({ DATA_DIR: dataDir, BOT_TOKEN: '' });
      const app3 = createApp({ config: real, db, telegram, log: { error: console.error } });
      const s3 = app3.listen(0);
      await new Promise((r) => s3.once('listening', r));
      const b = `http://127.0.0.1:${s3.address().port}`;
      try {
        const list = await (await fetch(b + '/api/materials')).json();
        for (const m of list) {
          assert.equal((await fetch(`${b}/api/download/${m.id}`)).status, 401, m.id);
          const r = await fetch(`${b}/api/download/${m.id}`, { headers: { cookie: `${COOKIE}=${user.jar[COOKIE]}` } });
          assert.equal(r.status, 200, m.id);
          const src = real.materials.find((x) => x.id === m.id);
          assert.equal(Buffer.from(await r.arrayBuffer()).length, fs.statSync(src.path).size);
          console.log(`      ${m.id}: ${r.headers.get('content-type')} · ${r.headers.get('content-disposition')}`);
        }
      } finally {
        s3.close();
      }
    });

    console.log(`\nВсе проверки пройдены: ${passed}`);
  } catch (e) {
    console.error('\n✗ ОШИБКА:', e.message);
    process.exitCode = 1;
  } finally {
    server.close();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})();
