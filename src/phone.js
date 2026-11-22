'use strict';

/**
 * Казахстанские мобильные номера: +7 7XX XXX XX XX.
 * Принимаем любые варианты ввода: "+7 (701) 123-45-67", "87011234567", "7011234567".
 * Возвращаем нормализованный вид "+77011234567" или null, если номер некорректный.
 */
function normalizePhone(input) {
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  let d = String(input).replace(/\D/g, '');
  if (d.length === 11 && (d[0] === '7' || d[0] === '8')) d = d.slice(1);
  if (d.length !== 10) return null;
  if (d[0] !== '7') return null; // мобильные коды КЗ: 7XX
  return '+7' + d;
}

/** "+77011234567" -> "+7 (701) 123-45-67" */
function formatPhone(normalized) {
  const m = /^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(normalized || '');
  if (!m) return normalized || '';
  return `+7 (${m[1]}) ${m[2]}-${m[3]}-${m[4]}`;
}

module.exports = { normalizePhone, formatPhone };
