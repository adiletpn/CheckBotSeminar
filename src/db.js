'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const newToken = () => crypto.randomBytes(32).toString('hex');
const newPublicId = () => crypto.randomBytes(16).toString('hex');
const now = () => new Date().toISOString();

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'seminar.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id           INTEGER PRIMARY KEY AUTOINCREMENT, -- номер заявки (видит админ)
      public_id    TEXT NOT NULL UNIQUE,              -- неугадываемый id для опроса статуса
      name         TEXT NOT NULL,
      phone        TEXT NOT NULL,
      amount       INTEGER NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','rejected')),
      created_at   TEXT NOT NULL,
      confirmed_at TEXT,
      rejected_at  TEXT,
      token        TEXT UNIQUE,
      ip           TEXT
    );
    CREATE INDEX IF NOT EXISTS orders_phone_status ON orders(phone, status);

    CREATE TABLE IF NOT EXISTS restores (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      public_id   TEXT NOT NULL UNIQUE,
      phone       TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      created_at  TEXT NOT NULL,
      resolved_at TEXT,
      order_id    INTEGER REFERENCES orders(id),
      token       TEXT
    );
    CREATE INDEX IF NOT EXISTS restores_phone_status ON restores(phone, status);
    CREATE INDEX IF NOT EXISTS restores_token ON restores(token);
  `);
  // миграция: отметка, что админ получил уведомление (для досылки после сбоя)
  for (const t of ['orders', 'restores']) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    if (!cols.includes('notified_at')) db.exec(`ALTER TABLE ${t} ADD COLUMN notified_at TEXT`);
  }

  const q = {
    orderById: db.prepare('SELECT * FROM orders WHERE id = ?'),
    orderByPublic: db.prepare('SELECT * FROM orders WHERE public_id = ?'),
    pendingByPhone: db.prepare("SELECT * FROM orders WHERE phone = ? AND status = 'pending' ORDER BY id DESC LIMIT 1"),
    paidByPhone: db.prepare("SELECT * FROM orders WHERE phone = ? AND status = 'paid' ORDER BY id DESC LIMIT 1"),
    insertOrder: db.prepare(`INSERT INTO orders (public_id, name, phone, amount, created_at, ip)
                             VALUES (@public_id, @name, @phone, @amount, @created_at, @ip)`),
    confirm: db.prepare("UPDATE orders SET status = 'paid', token = ?, confirmed_at = ? WHERE id = ? AND status = 'pending'"),
    reject: db.prepare("UPDATE orders SET status = 'rejected', rejected_at = ? WHERE id = ? AND status = 'pending'"),
    recent: db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT ?'),
    pending: db.prepare("SELECT * FROM orders WHERE status = 'pending' ORDER BY id ASC LIMIT ?"),
    pendingCount: db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'"),
    paidAll: db.prepare("SELECT amount, confirmed_at FROM orders WHERE status = 'paid'"),

    restoreById: db.prepare('SELECT * FROM restores WHERE id = ?'),
    restoreByPublic: db.prepare('SELECT * FROM restores WHERE public_id = ?'),
    pendingRestoreByPhone: db.prepare("SELECT * FROM restores WHERE phone = ? AND status = 'pending' ORDER BY id DESC LIMIT 1"),
    insertRestore: db.prepare('INSERT INTO restores (public_id, phone, created_at) VALUES (?, ?, ?)'),
    approveRestore: db.prepare("UPDATE restores SET status = 'approved', token = ?, order_id = ?, resolved_at = ? WHERE id = ? AND status = 'pending'"),
    rejectRestore: db.prepare("UPDATE restores SET status = 'rejected', resolved_at = ? WHERE id = ? AND status = 'pending'"),

    markOrderNotified: db.prepare('UPDATE orders SET notified_at = ? WHERE id = ?'),
    markRestoreNotified: db.prepare('UPDATE restores SET notified_at = ? WHERE id = ?'),
    unnotifiedOrders: db.prepare("SELECT * FROM orders WHERE status = 'pending' AND notified_at IS NULL ORDER BY id"),
    unnotifiedRestores: db.prepare("SELECT * FROM restores WHERE status = 'pending' AND notified_at IS NULL ORDER BY id"),

    tokenValid: db.prepare(`SELECT 1 FROM orders WHERE token = @t AND status = 'paid'
                            UNION ALL SELECT 1 FROM restores WHERE token = @t AND status = 'approved' LIMIT 1`),
  };

  return {
    raw: db,
    close: () => db.close(),

    getOrder: (id) => q.orderById.get(id),
    getOrderByPublicId: (pid) => q.orderByPublic.get(pid),
    findPaidByPhone: (phone) => q.paidByPhone.get(phone),

    /** Создаёт заявку или возвращает уже существующую pending по этому телефону. */
    createOrder: db.transaction(({ name, phone, amount, ip }) => {
      const existing = q.pendingByPhone.get(phone);
      if (existing) return { order: existing, created: false };
      const info = q.insertOrder.run({ public_id: newPublicId(), name, phone, amount, created_at: now(), ip: ip || null });
      return { order: q.orderById.get(info.lastInsertRowid), created: true };
    }),

    /** Подтверждение. changed=false, если заявка уже была обработана (защита от двойного нажатия). */
    confirmOrder: (id) => {
      const changed = q.confirm.run(newToken(), now(), id).changes === 1;
      return { changed, order: q.orderById.get(id) };
    },
    rejectOrder: (id) => {
      const changed = q.reject.run(now(), id).changes === 1;
      return { changed, order: q.orderById.get(id) };
    },

    recentOrders: (n = 10) => q.recent.all(n),
    pendingOrders: (n = 20) => q.pending.all(n),
    pendingCount: () => q.pendingCount.get().n,
    paidOrders: () => q.paidAll.all(),

    getRestore: (id) => q.restoreById.get(id),
    getRestoreByPublicId: (pid) => q.restoreByPublic.get(pid),
    createRestore: db.transaction((phone) => {
      const existing = q.pendingRestoreByPhone.get(phone);
      if (existing) return { restore: existing, created: false };
      const info = q.insertRestore.run(newPublicId(), phone, now());
      return { restore: q.restoreById.get(info.lastInsertRowid), created: true };
    }),
    /** Восстановление: если есть оплаченная заявка с этим телефоном — выдаём её токен, иначе новый. */
    approveRestore: db.transaction((id) => {
      const r = q.restoreById.get(id);
      if (!r) return { changed: false, restore: undefined };
      const paid = q.paidByPhone.get(r.phone);
      const token = paid ? paid.token : newToken();
      const changed = q.approveRestore.run(token, paid ? paid.id : null, now(), id).changes === 1;
      return { changed, restore: q.restoreById.get(id) };
    }),
    rejectRestore: (id) => {
      const changed = q.rejectRestore.run(now(), id).changes === 1;
      return { changed, restore: q.restoreById.get(id) };
    },

    markOrderNotified: (id) => q.markOrderNotified.run(now(), id),
    markRestoreNotified: (id) => q.markRestoreNotified.run(now(), id),
    unnotifiedOrders: () => q.unnotifiedOrders.all(),
    unnotifiedRestores: () => q.unnotifiedRestores.all(),

    isTokenValid: (t) => typeof t === 'string' && /^[a-f0-9]{64}$/.test(t) && !!q.tokenValid.get({ t }),
  };
}

module.exports = { openDb };
