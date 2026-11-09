/* db.js — файл як база даних.
   Ніякого localStorage. Уся історія живе в аркуші «Зведення» того XLSX,
   який користувач завантажує і скачує. Сайт лише читає, дописує й віддає файл.

   Ключ запису: ПУ + доба. Повторна заливка того самого ключа —
   підтвердження користувача і перезапис рядка (номер версії +1). */

var SUMMARY_SHEET = 'Зведення';
var RESULT_SHEET = 'Результат';

var SUMMARY_HEADER = [
  'ПУ', 'Доба', '№ подання', 'Версія', 'Осіб', 'Вердикт',
  'В/ч', 'Групи', 'Звань', 'Посад', 'Файл', 'Файл (SHA-256)',
  'Розмір, байт', 'Завантажено', 'Замінено', 'Стан', 'Примітка',
];

var RESULT_HEADER = [
  'Серйозність', 'Код', 'Клітинка', 'Що не так', 'Що робити',
];

/* ---------- дрібні хелпери ---------- */

function dbText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return dbStamp(value);
  return String(value).trim();
}

function dbStamp(date) {
  const d = date || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} `
    + `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ISO-доба з будь-якого подання: '2026-11-08' або '08.11.2026' або Date. */
function dbIsoDay(value) {
  if (!value) return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    return value.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return text;
  const dotted = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (dotted) {
    return `${dotted[3]}-${dotted[2].padStart(2, '0')}-${dotted[1].padStart(2, '0')}`;
  }
  return '';
}

function dbKey(unit, dayIso) {
  return `${unit}||${dayIso}`;
}

/* ---------- читання наявного «Зведення» ---------- */

/* Повертає { present, rows[], headerOk } — з аркуша «Зведення», якщо він є. */
function readSummary(workbook) {
  const empty = { present: false, rows: [], headerOk: false, problems: [] };
  if (!workbook || !Array.isArray(workbook.sheets)) return empty;

  const sheet = workbook.sheets.find(
    (s) => String(s.name).toLowerCase() === SUMMARY_SHEET.toLowerCase());
  if (!sheet) return empty;

  const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
  if (!rows.length) {
    return { present: true, rows: [], headerOk: false,
      problems: ['Аркуш «Зведення» порожній'] };
  }

  const head = (rows[0] || []).map(dbText);
  const map = {};
  head.forEach((title, index) => {
    const known = SUMMARY_HEADER.find(
      (h) => h.toLowerCase() === title.toLowerCase());
    if (known) map[known] = index;
  });

  const need = ['ПУ', 'Доба'];
  const missing = need.filter((h) => map[h] === undefined);
  if (missing.length) {
    return { present: true, rows: [], headerOk: false,
      problems: [`На аркуші «Зведення» немає колонок: ${missing.join(', ')}`] };
  }

  const take = (row, title) => {
    const index = map[title];
    return index === undefined ? '' : dbText(row[index]);
  };

  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const unit = take(row, 'ПУ');
    const dayIso = dbIsoDay(take(row, 'Доба'));
    if (!unit && !dayIso) continue;
    out.push({
      rowNumber: r + 1,
      unit,
      dayIso,
      day: take(row, 'Доба'),
      number: take(row, '№ подання'),
      version: Number(take(row, 'Версія')) || 1,
      persons: Number(take(row, 'Осіб')) || 0,
      verdict: take(row, 'Вердикт'),
      vch: take(row, 'В/ч'),
      groups: take(row, 'Групи'),
      positions: take(row, 'Посад'),
      filename: take(row, 'Файл'),
      sha256: take(row, 'Файл (SHA-256)'),
      size: Number(take(row, 'Розмір, байт')) || 0,
      uploadedAt: take(row, 'Завантажено'),
      replacedAt: take(row, 'Замінено'),
      status: take(row, 'Стан'),
      note: take(row, 'Примітка'),
    });
  }

  return { present: true, rows: out, headerOk: true, problems: [] };
}

/* Записи, які стосуються конкретного ПУ за добу (0 або 1 за нашою моделлю). */
function findSummaryRow(summary, unit, dayIso) {
  if (!summary || !summary.rows) return null;
  return summary.rows.find((r) => r.unit === unit && r.dayIso === dayIso) || null;
}

function summaryOfUnitMonth(summary, monthKey) {
  if (!summary || !summary.rows) return [];
  return summary.rows.filter((r) => r.dayIso && r.dayIso.slice(0, 7) === monthKey);
}

/* ---------- запис ---------- */

/* Перетворює один результат перевірки у рядок «Зведення». */
function summaryRowOf(unit, result, meta) {
  const info = meta || {};
  const counts = result.counts || {};
  const dict = result.dictionaries || {};
  return {
    ПУ: unit,
    Доба: result.header.dayIso || '',
    '№ подання': info.number || '',
    Версія: info.version || 1,
    Осіб: (result.records || []).length,
    Вердикт: VERDICT_LABEL[result.verdict] || result.verdict || '',
    'В/ч': dict.vch === undefined ? '' : String(dict.vch),
    Групи: dict.groups === undefined ? '' : String(dict.groups),
    Звань: dict.ranks === undefined ? '' : String(dict.ranks),
    Посад: dict.positions === undefined ? '' : String(dict.positions),
    Файл: info.filename || '',
    'Файл (SHA-256)': info.sha256 || '',
    'Розмір, байт': info.size || 0,
    Завантажено: info.uploadedAt || dbStamp(),
    Замінено: info.replacedAt || '',
    Стан: info.status || 'Прийнято',
    Примітка: info.note || '',
    _counts: counts,
  };
}

/* Аркуш «Результат»: усі знахідки останньої перевірки. */
function resultSheetRows(result) {
  const rows = [RESULT_HEADER.slice()];
  for (const f of result.findings || []) {
    rows.push([
      SEVERITY_LABEL[f.severity] || f.severity,
      f.code || '',
      f.cell || '',
      f.problem || '',
      f.recommendation || '',
    ]);
  }
  if (rows.length === 1) {
    rows.push(['', '', '', 'Зауважень немає', '']);
  }
  return rows;
}

/* ---------- назви ---------- */
/* SEVERITY_LABEL оголошено в checker.js — не дублюємо. */

var VERDICT_LABEL = {
  ok: 'Без зауважень',
  info: 'Лише інформація',
  warning: 'Попередження',
  error: 'Є помилки',
  critical: 'Непридатний',
};

var VERDICT_BY_LABEL = {
  'Без зауважень': 'ok',
  'Лише інформація': 'info',
  'Попередження': 'warning',
  'Є помилки': 'error',
  'Непридатний': 'critical',
};

/* Санітарна назва файлу для скачування. */
function dbFileName(unit, dayIso, suffix) {
  const safe = String(unit || 'Без ПУ')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '_');
  const day = String(dayIso || '').replace(/-/g, '') || dbStamp().slice(0, 10).replace(/\./g, '');
  return `${safe}_${day}${suffix || ''}.xlsx`;
}