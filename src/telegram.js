'use strict';

const { Bot, InlineKeyboard } = require('grammy');
const { formatPhone } = require('./phone');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (n) => `${Number(n).toLocaleString('ru-RU').replace(/ /g, ' ')} ₸`;

function createTelegram({ config, db, botOptions, log = console }) {
  const tz = config.timeZone;
  const fmtTime = (iso) =>
    new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      .format(iso ? new Date(iso) : new Date())
      .replace(',', '');
  const dayKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const statusLabel = { pending: '⏳ күтуде', paid: '✅ расталды', rejected: '❌ бас тартылды' };

  // ---------- тексты сообщений ----------
  function orderText(o) {
    const lines = [
      `<b>💳 Жаңа төлем · өтінім #${o.id}</b>`,
      '',
      `👤 Аты-жөні: <b>${esc(o.name)}</b>`,
      `📱 Kaspi телефоны: <code>${esc(formatPhone(o.phone))}</code>`,
      `💰 Сома: <b>${money(o.amount)}</b>`,
      `🕒 Уақыты: ${fmtTime(o.created_at)}`,
    ];
    const prev = db.findPaidByPhone(o.phone);
    if (prev && prev.id !== o.id) lines.push('', `ℹ️ Бұл нөмір бұрын төлеген: #${prev.id} (${fmtTime(prev.confirmed_at)})`);
    if (o.status === 'paid') lines.push('', `<b>Расталды ✅ (${fmtTime(o.confirmed_at)})</b>`);
    if (o.status === 'rejected') lines.push('', `<b>Бас тартылды ❌ (${fmtTime(o.rejected_at)})</b>`);
    return lines.join('\n');
  }
  const orderKeyboard = (o) => new InlineKeyboard().text('✅ Растау', `ok:${o.id}`).text('❌ Бас тарту', `no:${o.id}`);

  function restoreText(r) {
    const paid = db.findPaidByPhone(r.phone);
    const lines = [
      `<b>🔁 Қолжетімділікті қайтару · сұрау #${r.id}</b>`,
      '',
      `📱 Телефон: <code>${esc(formatPhone(r.phone))}</code>`,
      `🕒 Уақыты: ${fmtTime(r.created_at)}`,
      '',
      paid
        ? `✅ Бұл нөмірмен расталған төлем бар: #${paid.id}, ${esc(paid.name)}, ${fmtTime(paid.confirmed_at)}`
        : '⚠️ Бұл нөмір бойынша расталған төлем табылмады. Kaspi-ден тексеріңіз.',
    ];
    if (r.status === 'approved') lines.push('', `<b>Қолжетімділік қайтарылды ✅ (${fmtTime(r.resolved_at)})</b>`);
    if (r.status === 'rejected') lines.push('', `<b>Бас тартылды ❌ (${fmtTime(r.resolved_at)})</b>`);
    return lines.join('\n');
  }
  const restoreKeyboard = (r) =>
    new InlineKeyboard().text('🔓 Қолжетімділікті қайтару', `rok:${r.id}`).row().text('❌ Бас тарту', `rno:${r.id}`);

  // ---------- без бота: просто логируем ----------
  if (!config.botToken) {
    return {
      bot: null,
      notifyOrder: async (o) => log.info?.(`[telegram:off] заявка #${o.id}: ${o.name}, ${o.phone}, ${o.amount} ₸`),
      notifyRestore: async (r) => log.info?.(`[telegram:off] восстановление #${r.id}: ${r.phone}`),
      flushUnnotified: async () => 0,
      start: () => {},
      stop: async () => {},
      orderText,
      restoreText,
    };
  }

  const bot = new Bot(config.botToken, botOptions);
  const isAdmin = (ctx) => !!config.adminChatId && String(ctx.from?.id) === config.adminChatId;
  const html = { parse_mode: 'HTML' };

  async function sendToAdmin(text, extra = {}) {
    if (!config.adminChatId) {
      log.warn('[telegram] ADMIN_CHAT_ID не задан, сообщение не отправлено (будет дослано после настройки)');
      return false;
    }
    try {
      await bot.api.sendMessage(config.adminChatId, text, { ...html, ...extra });
      return true;
    } catch (e) {
      log.error('[telegram] не удалось отправить сообщение:', e.description || e.message);
      return false;
    }
  }

  // ---------- команды ----------
  bot.command('start', (ctx) => {
    log.info(`[telegram] /start от chat id ${ctx.chat.id}${isAdmin(ctx) ? ' (админ)' : ''}`);
    return ctx.reply(
      [
        `Сіздің chat id: <code>${ctx.chat.id}</code>`,
        '',
        isAdmin(ctx)
          ? '✅ Сіз әкімшісіз. Командалар: /pending, /orders, /stats, /reset'
          : 'Осы санды Railway-де ADMIN_CHAT_ID айнымалысына жазыңыз.',
      ].join('\n'),
      html
    );
  });

  const adminOnly = (handler) => async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('Рұқсат жоқ');
    return handler(ctx);
  };

  bot.command(
    'orders',
    adminOnly(async (ctx) => {
      const rows = db.recentOrders(10);
      if (!rows.length) return ctx.reply('Әзірге өтінім жоқ.');
      const text = rows
        .map((o) => `#${o.id} · ${statusLabel[o.status]}\n${esc(o.name)} · <code>${esc(formatPhone(o.phone))}</code> · ${money(o.amount)}\n${fmtTime(o.created_at)}`)
        .join('\n\n');
      return ctx.reply(`<b>Соңғы 10 өтінім</b>\n\n${text}`, html);
    })
  );

  bot.command(
    'pending',
    adminOnly(async (ctx) => {
      const rows = db.pendingOrders(10);
      const total = db.pendingCount();
      if (!rows.length) return ctx.reply('Расталмаған өтінім жоқ ✨');
      await ctx.reply(`Расталмаған өтінімдер: ${total}${total > rows.length ? ` (алғашқы ${rows.length} көрсетілді)` : ''}`);
      for (const o of rows) await ctx.reply(orderText(o), { ...html, reply_markup: orderKeyboard(o) });
    })
  );

  bot.command(
    'stats',
    adminOnly(async (ctx) => {
      const paid = db.paidOrders();
      const today = dayKey(new Date());
      const t = paid.filter((o) => o.confirmed_at && dayKey(new Date(o.confirmed_at)) === today);
      const sum = (arr) => arr.reduce((s, o) => s + o.amount, 0);
      return ctx.reply(
        [
          '<b>📊 Статистика</b>',
          '',
          `Бүгін: ${t.length} төлем · ${money(sum(t))}`,
          `Барлығы: ${paid.length} төлем · ${money(sum(paid))}`,
          `Күтуде: ${db.pendingCount()}`,
        ].join('\n'),
        html
      );
    })
  );

  bot.command(
    'reset',
    adminOnly((ctx) =>
      ctx.reply(
        '⚠️ <b>Барлық өтінімдерді өшіру?</b>\n\nБарлық төлемдер мен статистика жойылады, төлеген адамдардың қолжетімділігі жабылады. Бұл әрекетті қайтару мүмкін емес.',
        { ...html, reply_markup: new InlineKeyboard().text('🗑 Иә, бәрін өшіру', 'reset:yes').text('Жоқ', 'reset:no') }
      )
    )
  );

  // ---------- inline-кнопки ----------
  bot.on('callback_query:data', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCallbackQuery({ text: 'Рұқсат жоқ', show_alert: true });

    if (ctx.callbackQuery.data.startsWith('reset:')) {
      const yes = ctx.callbackQuery.data === 'reset:yes';
      const n = yes ? db.resetAll() : 0;
      if (yes) log.info(`[telegram] /reset: удалено записей: ${n}`);
      await ctx.answerCallbackQuery({ text: yes ? 'Өшірілді' : 'Болдырылмады' });
      await ctx.editMessageText(yes ? `🗑 Барлығы өшірілді (${n} жазба). Сайт таза күйде.` : 'Болдырылмады.').catch(() => {});
      return;
    }

    const m = /^(ok|no|rok|rno):(\d+)$/.exec(ctx.callbackQuery.data);
    if (!m) return ctx.answerCallbackQuery();
    const [, action, idStr] = m;
    const id = Number(idStr);

    let res, text, done;
    if (action === 'ok' || action === 'no') {
      res = action === 'ok' ? db.confirmOrder(id) : db.rejectOrder(id);
      if (!res.order) return ctx.answerCallbackQuery({ text: 'Өтінім табылмады' });
      text = orderText(res.order);
      done = res.changed ? (action === 'ok' ? 'Расталды ✅' : 'Бас тартылды ❌') : 'Бұл өтінім бұрын өңделген';
    } else {
      res = action === 'rok' ? db.approveRestore(id) : db.rejectRestore(id);
      if (!res.restore) return ctx.answerCallbackQuery({ text: 'Сұрау табылмады' });
      text = restoreText(res.restore);
      done = res.changed ? (action === 'rok' ? 'Қолжетімділік қайтарылды ✅' : 'Бас тартылды ❌') : 'Бұл сұрау бұрын өңделген';
    }

    await ctx.answerCallbackQuery({ text: done });
    // Редактируем сообщение и убираем кнопки (reply_markup не передаём)
    try {
      await ctx.editMessageText(text, html);
    } catch (e) {
      if (!String(e.description || '').includes('message is not modified')) {
        log.error('[telegram] не удалось изменить сообщение:', e.description || e.message);
      }
    }
  });

  bot.catch((err) => log.error('[telegram] ошибка обработчика:', err.error?.message || err.message));

  async function notifyOrder(o) {
    if (await sendToAdmin(orderText(o), { reply_markup: orderKeyboard(o) })) db.markOrderNotified(o.id);
  }
  async function notifyRestore(r) {
    if (await sendToAdmin(restoreText(r), { reply_markup: restoreKeyboard(r) })) db.markRestoreNotified(r.id);
  }
  /** Дослать заявки, которые не дошли до админа (не был задан ADMIN_CHAT_ID, сбой сети и т.п.) */
  async function flushUnnotified() {
    if (!config.adminChatId) return 0;
    const orders = db.unnotifiedOrders();
    const restores = db.unnotifiedRestores();
    for (const o of orders) await notifyOrder(o);
    for (const r of restores) await notifyRestore(r);
    const n = orders.length + restores.length;
    if (n) log.info(`[telegram] дослано неотправленных заявок: ${n}`);
    return n;
  }

  // ---------- запуск long polling с переподключением ----------
  let stopped = false;
  async function start() {
    while (!stopped) {
      try {
        await bot.api
          .setMyCommands([
            { command: 'pending', description: 'Расталмаған өтінімдер' },
            { command: 'orders', description: 'Соңғы 10 өтінім' },
            { command: 'stats', description: 'Статистика' },
            { command: 'reset', description: 'Барлық өтінімдерді өшіру (тесттен кейін)' },
            { command: 'start', description: 'Chat id көрсету' },
          ])
          .catch(() => {});
        await bot.start({
          allowed_updates: ['message', 'callback_query'],
          onStart: (me) => {
            log.info(`[telegram] бот @${me.username} запущен (long polling)`);
            flushUnnotified().catch((e) => log.error('[telegram] досылка не удалась:', e.message));
          },
        });
        return; // bot.stop() вызван
      } catch (e) {
        if (stopped) return;
        log.error('[telegram] polling упал, перезапуск через 5 с:', e.description || e.message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  return {
    bot,
    notifyOrder,
    notifyRestore,
    flushUnnotified,
    start: () => {
      start();
    },
    stop: async () => {
      stopped = true;
      if (bot.isRunning()) await bot.stop();
    },
    orderText,
    restoreText,
  };
}

module.exports = { createTelegram };
