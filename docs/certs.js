/* certs.js — довідки про чергування за місяць, з аркуша «Зведення».
   Нічого не зберігається: файл завантажили, довідку скачали. */

/* Зведення по ПУ за місяць: хто скільки діб, які доби не подано. */
function buildMonthlyCerts(summary, records, monthKey, unitFilter) {
  const rows = (summary && summary.rows) || [];
  const inMonth = rows.filter((r) => r.dayIso && r.dayIso.slice(0, 7) === monthKey
    && (!unitFilter || r.unit === unitFilter));

  const unitsMap = new Map();
  for (const row of inMonth) {
    if (!unitsMap.has(row.unit)) unitsMap.set(row.unit, []);
    unitsMap.get(row.unit).push(row);
  }

  const overall = certificateIssuesFrom(inMonth, records, monthKey, unitFilter);
  const certs = [];

  for (const [unit, unitRows] of unitsMap) {
    const present = new Set(unitRows.map((r) => r.dayIso));
    const daysInMonth = monthDayCount(monthKey);
    const missingDays = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = `${monthKey}-${String(d).padStart(2, '0')}`;
      if (!present.has(iso)) missingDays.push(iso);
    }

    certs.push({
      unit,
      month: monthKey,
      rows: unitRows.slice().sort((a, b) => a.dayIso.localeCompare(b.dayIso)),
      missingDays,
      presentCount: unitRows.length,
      persons: unitRows.reduce((sum, r) => sum + (r.persons || 0), 0),
    });
  }

  certs.sort((a, b) => a.unit.localeCompare(b.unit, 'uk'));
  return { certs, issues: overall };
}

function monthDayCount(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

function monthTitleUk(monthKey) {
  if (!monthKey) return '—';
  const [y, m] = monthKey.split('-');
  const names = ['січень', 'лютий', 'березень', 'квітень', 'травень', 'червень',
    'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень'];
  return `${names[Number(m) - 1] || m} ${y}`;
}

/* Перевірка перед формуванням: чого бракує в «Зведенні». */
function certificateIssuesFrom(rows, records, monthKey, unitFilter) {
  const missing = [];
  const lowVerdict = [];
  const emptyRows = [];

  const daysInMonth = monthDayCount(monthKey);
  const byUnit = new Map();
  for (const row of rows) {
    if (!byUnit.has(row.unit)) byUnit.set(row.unit, new Set());
    byUnit.get(row.unit).add(row.dayIso);
  }

  for (const [unit, present] of byUnit) {
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = `${monthKey}-${String(d).padStart(2, '0')}`;
      if (!present.has(iso)) missing.push({ unit, day: iso });
    }
  }

  for (const row of rows) {
    if (!row.persons) emptyRows.push({ unit: row.unit, day: row.dayIso });
    if (row.verdict === 'Критичний' || row.verdict === 'Непридатний'
      || row.verdict === 'Є помилки' || row.verdict === 'Помилка') {
      lowVerdict.push({ unit: row.unit, day: row.dayIso, verdict: row.verdict });
    }
  }

  /* Одна особа за одну добу у двох ПУ — конфлікт чергування. */
  const conflicts = [];
  if (records) {
    const byPersonDay = new Map();
    for (const rec of records) {
      const key = `${rec.personKey || rec.name}||${rec.dayIso}`;
      const bucket = byPersonDay.get(key) || new Set();
      bucket.add(rec.unit);
      byPersonDay.set(key, bucket);
    }
    for (const [key, unitSet] of byPersonDay) {
      if (unitSet.size > 1) {
        const [name, day] = key.split('||');
        conflicts.push({ name, day, units: Array.from(unitSet) });
      }
    }
  }

  return { missing, lowVerdict, emptyRows, conflicts };
}

/* Довідка -> аркуші XLSX. */
function certSheets(certs, monthKey, issues) {
  const sheets = [];

  const head = [
    ['Довідка про чергування', ''],
    ['Місяць', monthTitleUk(monthKey)],
    ['Сформовано', dbStamp()],
    ['Джерело', 'аркуш «Зведення» завантаженого файлу'],
    [],
  ];

  const body = [['ПУ', 'Доба', '№ подання', 'Версія', 'Осіб', 'Вердикт', 'Файл']];
  for (const cert of certs) {
    head.push(['ПУ', cert.unit]);
    head.push(['Діб у зведенні', cert.presentCount]);
    head.push(['Діб без подання', cert.missingDays.length]);
    head.push([]);
    for (const row of cert.rows) {
      body.push([row.unit, row.day || row.dayIso, row.number, row.version,
        row.persons, row.verdict, row.filename]);
    }
  }

  sheets.push({
    name: 'Довідка',
    rows: head.concat(body),
    widths: [34, 18, 14, 10, 10, 22, 34],
    headerRow: null,
  });

  /* Пропущені доби окремим аркушем — щоб було видно, що добрати. */
  const gaps = [['ПУ', 'Доба без подання']];
  for (const item of (issues && issues.missing) || []) {
    gaps.push([item.unit, item.day]);
  }
  if (gaps.length === 1) gaps.push(['—', 'усі доби подано']);
  sheets.push({ name: 'Пропущені доби', rows: gaps, widths: [34, 18], headerRow: 1 });

  const notes = [['Що не так', 'Деталі']];
  for (const item of (issues && issues.lowVerdict) || []) {
    notes.push(['Подання з помилками', `${item.unit} · ${item.day} · ${item.verdict}`]);
  }
  for (const item of (issues && issues.emptyRows) || []) {
    notes.push(['Порожнє подання (0 осіб)', `${item.unit} · ${item.day}`]);
  }
  for (const item of (issues && issues.conflicts) || []) {
    notes.push(['Особа у двох ПУ за одну добу',
      `${item.name} · ${item.day} · ${item.units.join(', ')}`]);
  }
  if (notes.length === 1) notes.push(['Зауважень немає', '']);
  sheets.push({ name: 'Зауваження', rows: notes, widths: [36, 60], headerRow: 1 });

  return sheets;
}