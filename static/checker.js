/* checker.js — рушій правил щоденних розрахунків (ТЗ v4.1, шаблон v1.3).

   Рівні: critical · error · warning · info
   Коди: S — структура, H — шапка, R — заповнення записів,
         L — логіка, N — нормалізація.
   Кожна знахідка має клітинку у форматі «Розрахунок!G17». */

const SEVERITY_ORDER = { critical: 0, error: 1, warning: 2, info: 3 };
const SEVERITY_LABEL = {
  critical: 'Критична',
  error: 'Помилка',
  warning: 'Попередження',
  info: 'Інформація',
};

const RANK_TYPES = ['ПУ', 'МВГ', 'ВГ', 'Екіпаж'];

/* ---------- нормалізація тексту ---------- */

const CYR = 'абвгдеєжзиіїйклмнопрстуфхцчшщьюя';
const LAT = 'abvgdeêžziïjklmnoprstufhcčšŝûâ';
const LAT_MAP = {
  a: 'а', b: 'б', v: 'в', g: 'г', d: 'д', e: 'е', ê: 'є', ž: 'ж', z: 'з',
  i: 'и', ï: 'і', j: 'й', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о', p: 'п',
  r: 'р', s: 'с', t: 'т', u: 'у', f: 'ф', h: 'х', c: 'ц', č: 'ч', š: 'ш',
  ŝ: 'щ', û: 'ю', â: 'я', y: 'и', q: 'к', w: 'в', x: 'х',
};

/* Прибирає пробіли, табуляції, нерозривні пробіли, лапки й апострофи. */
function normalizeText(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  text = text.replace(/\u00a0/g, ' ').replace(/[\t\r\n]+/g, ' ');
  text = text.replace(/[’‘`´]/g, "'");
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

/* Латиниця → кирилиця для кодів в/ч. */
function cyrillize(text) {
  return String(text).replace(/[a-zêžïčšŝûâ]/gi, (ch) => {
    const lower = ch.toLowerCase();
    const map = LAT_MAP[lower];
    if (!map) return ch;
    return ch === lower ? map : map.toUpperCase();
  });
}

/* Ключ особи: прізвище+ім'я+по батькові у нижньому регістрі, літери без
   діакритики, апострофи прибрані. Використовується для реєстру осіб. */
function personKey(name) {
  let text = normalizeText(name).toLowerCase();
  text = text.replace(/[’'`´ʼ]/g, '');
  text = text.replace(/ё/g, 'е').replace(/ъ/g, 'ь');
  text = text.replace(/[^а-яіїєґa-z ]/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

/* Відстань Левенштейна — для пошуку схожих ПІБ (правило L06). */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const cur = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

/* ---------- знахідки ---------- */

function finding(code, severity, cell, problem, recommendation, extra) {
  return {
    code,
    severity,
    cell: cell || '',
    problem,
    recommendation: recommendation || '',
    ...(extra || {}),
  };
}

function cellRef(sheet, letter, row) {
  return `${sheet}!${letter}${row}`;
}

function isBlank(value) {
  return value === null || value === undefined
    || (typeof value === 'string' && value.trim() === '');
}

function asText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return formatDate(value);
  return normalizeText(value);
}

/* ---------- дати ---------- */

function parseDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'number' && value > 1 && value < 60000) {
    return serialToDate(value);
  }
  if (typeof value === 'string') {
    const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value.trim());
    if (!m) return null;
    const [, d, mo, y] = m.map(Number);
    const date = new Date(Date.UTC(y, mo - 1, d));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1
      || date.getUTCDate() !== d) return null;
    return date;
  }
  return null;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function dayDiff(a, b) {
  return Math.round((a.getTime() - b.getTime()) / 86400000);
}

/* ---------- довідники ---------- */

/**
 * Читає діапазони довідників з аркуша «Довідники».
 * Повертає {groups, units, vch, positions, ranks, groupTypes}.
 */
function readDictionaries(workbook, template) {
  const cfg = template.dictionaries || {};
  const sheetCfg = cfg.columns || {};
  const start = Number(cfg.start_row || 2) - 1;
  const end = Number(cfg.end_row || 200);

  const sheet = workbook.sheets.find(
    (s) => s.name.trim().toLowerCase()
      === String(template.reference_sheet || 'Довідники').trim().toLowerCase());
  const empty = {
    groups: [], units: [], vch: [], positions: [], ranks: [],
    groupTypes: new Map(), present: Boolean(sheet),
  };
  if (!sheet) return empty;

  const colIndex = (letter) => colToIndex(letter);
  const idx = {
    group: colIndex(sheetCfg.group || 'A'),
    groupType: colIndex(sheetCfg.group_type || 'B'),
    vch: colIndex(sheetCfg.vch || 'C'),
    position: colIndex(sheetCfg.position || 'D'),
    rank: colIndex(sheetCfg.rank || 'E'),
    unit: colIndex(sheetCfg.unit || 'F'),
  };

  const groups = [];
  const units = [];
  const vch = [];
  const positions = [];
  const ranks = [];
  const groupTypes = new Map();

  for (let r = start; r < end && r < sheet.rows.length; r++) {
    const row = sheet.rows[r] || [];
    const pick = (i) => (i < row.length ? asText(row[i]) : '');

    const group = pick(idx.group);
    const groupType = pick(idx.groupType);
    const vchCode = pick(idx.vch).toUpperCase();
    const position = pick(idx.position);
    const rank = pick(idx.rank);
    const unit = pick(idx.unit);

    if (group) {
      groups.push(group);
      if (groupType) groupTypes.set(group.toLowerCase(), groupType);
    }
    if (vchCode) vch.push(vchCode);
    if (position) positions.push(position);
    if (rank) ranks.push(rank);
    if (unit) units.push(unit);
  }

  const uniq = (list) => Array.from(new Set(list));
  return {
    groups: uniq(groups),
    groupTypes,
    units: uniq(units),
    vch: uniq(vch),
    positions: uniq(positions),
    ranks: uniq(ranks),
    present: true,
  };
}

/* ---------- шапка ---------- */

function readHeader(workbook, template) {
  const cells = (template.header && template.header.cells) || {};
  const values = {};
  for (const [key, address] of Object.entries(cells)) {
    const m = /^([A-Z]+)(\d+)$/.exec(address);
    if (!m) continue;
    values[key] = cellValue(workbook, template.sheet, Number(m[2]) - 1,
      colToIndex(m[1]));
  }
  return values;
}

function checkHeader(header, template, dict, options) {
  const found = [];
  const sheet = template.sheet;
  const params = template.params || {};
  const required = (template.header && template.header.required) || [];
  const labels = {
    f_sender: 'ПУ (відправник)',
    f_day: 'Доба (дата початку)',
    f_resp_rank: 'Відповідальна особа: звання',
    f_resp_name: 'Відповідальна особа: ПІБ',
  };

  // H01 — обов'язкові поля шапки
  for (const key of required) {
    const address = template.header.cells[key];
    if (isBlank(header[key])) {
      found.push(finding('H01', 'error', cellRef(sheet, address.replace(/\d+/, ''),
        Number(address.replace(/\D/g, ''))),
        `Не заповнене поле шапки «${labels[key] || key}»`,
        'Заповніть жовту клітинку шапки', { field: key }));
    }
  }

  // S03 — версія форми
  const version = asText(header.f_version);
  const supported = (template.header && template.header.supported_versions) || [];
  if (version && supported.length && !supported.includes(version)) {
    found.push(finding('S03', 'error',
      cellRef(sheet, 'D', 3),
      `Версія форми ${version} не підтримується`,
      `Отримайте шаблон версії ${supported.join(' або ')}`,
      { value: version }));
  }

  // H02 — ПУ з довідника
  const sender = asText(header.f_sender);
  if (sender && dict.present) {
    const known = dict.units.some(
      (u) => u.toLowerCase() === sender.toLowerCase());
    if (!known) {
      found.push(finding('H02', 'error', cellRef(sheet, 'D', 4),
        `ПУ «${sender}» немає в довіднику відправників`,
        'Виберіть ПУ зі списку або додайте його до довідників',
        { value: sender }));
    }
  }

  // H03 — доба в допустимому діапазоні
  const day = parseDate(header.f_day);
  if (!isBlank(header.f_day) && !day) {
    found.push(finding('H03', 'error', cellRef(sheet, 'D', 5),
      `Доба не є датою у форматі ДД.ММ.РРРР: «${asText(header.f_day)}»`,
      'Введіть дату як 05.11.2026', { value: asText(header.f_day) }));
  } else if (day) {
    const today = options.today || new Date();
    const todayUtc = new Date(Date.UTC(today.getUTCFullYear(),
      today.getUTCMonth(), today.getUTCDate()));
    const past = Number(params.horizon_past_days ?? 7);
    const future = Number(params.horizon_future_days ?? 1);
    const diff = dayDiff(day, todayUtc);
    if (diff < -past) {
      found.push(finding('H03', 'warning', cellRef(sheet, 'D', 5),
        `Доба ${formatDate(day)} старіша за ${past} діб`,
        'Перевірте дату початку доби', { value: formatDate(day) }));
    } else if (diff > future) {
      found.push(finding('H03', 'error', cellRef(sheet, 'D', 5),
        `Доба ${formatDate(day)} у майбутньому`,
        'Вкажіть фактичну дату початку доби', { value: formatDate(day) }));
    }
  }

  // H04 — дата в імені файлу
  if (day && options.filename) {
    const m = /(\d{4})(\d{2})(\d{2})/.exec(options.filename);
    if (m) {
      const fileDay = `${m[3]}.${m[2]}.${m[1]}`;
      if (fileDay !== formatDate(day)) {
        found.push(finding('H04', 'warning', cellRef(sheet, 'D', 5),
          `Доба у файлі ${formatDate(day)} не збігається з датою в імені `
          + `файлу (${fileDay})`,
          'Узгодьте дату в шапці та в імені файлу', { value: formatDate(day) }));
      }
    }
  }

  return found;
}

/* ---------- записи ---------- */

function readRows(workbook, template) {
  const table = template.table || {};
  const cols = table.columns || [];
  const sheet = workbook.sheets.find(
    (s) => s.name.trim().toLowerCase() === String(template.sheet).trim().toLowerCase());
  if (!sheet) return [];

  const start = Number(table.data_start_row || 12) - 1;
  const end = Math.min(Number(table.data_end_row || 311), sheet.rows.length);
  const byKey = new Map(cols.map((c) => [c.key, colToIndex(c.letter)]));
  const records = [];

  for (let r = start; r < end; r++) {
    const row = sheet.rows[r] || [];
    const get = (key) => {
      const idx = byKey.get(key);
      if (idx === undefined) return null;
      const value = idx < row.length ? row[idx] : null;
      return value === undefined ? null : value;
    };
    const record = {
      row: r + 1,
      n: get('n'),
      vch: asText(get('vch')),
      group: asText(get('group')),
      groupType: asText(get('group_type')),
      position: asText(get('position')),
      rank: asText(get('rank')),
      name: asText(get('name')),
      note: asText(get('note')),
      control: asText(get('control')),
      raw: { vch: get('vch'), name: get('name') },
    };
    const filled = ['vch', 'group', 'position', 'rank', 'name']
      .filter((k) => !isBlank(record[k]));
    record.filledCount = filled.length;
    record.empty = filled.length === 0;
    records.push(record);
  }

  // обрізаємо хвіст: порожні рядки в кінці — норма
  while (records.length && records[records.length - 1].empty) records.pop();
  return records;
}

function checkRows(records, dict, template, options) {
  const found = [];
  const sheet = template.sheet;
  const letter = (key) => {
    const col = (template.table.columns || []).find((c) => c.key === key);
    return col ? col.letter : '?';
  };
  const params = template.params || {};

  // S07 — порожні рядки всередині списку
  let lastFilled = -1;
  records.forEach((rec, i) => { if (!rec.empty) lastFilled = i; });
  records.forEach((rec, i) => {
    if (rec.empty && i < lastFilled) {
      found.push(finding('S07', 'warning', `${sheet}!A${rec.row}`,
        `Порожній рядок ${rec.row} всередині списку`,
        'Видаліть порожні рядки, щоб список ішов без розривів'));
    }
  });

  const filled = records.filter((r) => !r.empty);

  // S08 — список не порожній
  if (!filled.length) {
    found.push(finding('S08', 'critical', `${sheet}!A12`,
      'Список особового складу порожній',
      'Внесіть наявний особовий склад на добу'));
    return found;
  }

  const nameSeen = new Map();

  for (const rec of filled) {
    // R01 — обов'язкові поля
    const missing = [
      ['vch', 'в/ч'], ['group', 'Група'], ['position', 'Посада'],
      ['rank', 'Військове звання'], ['name', 'ПІБ'],
    ].filter(([key]) => isBlank(rec[key]));
    for (const [key, label] of missing) {
      found.push(finding('R01', 'error', cellRef(sheet, letter(key), rec.row),
        `Порожнє обов'язкове поле «${label}»`,
        'Заповніть поле', { row: rec.row, field: key }));
    }

    // R02 — група з довідника
    if (rec.group && dict.present && !dict.groups.some(
      (g) => g.toLowerCase() === rec.group.toLowerCase())) {
      found.push(finding('R02', 'error', cellRef(sheet, letter('group'), rec.row),
        `Групи «${rec.group}» немає в довіднику`,
        'Виберіть групу зі списку', { row: rec.row, value: rec.group }));
    }

    // R03 — в/ч з довідника
    if (rec.vch && dict.present) {
      const normalized = cyrillize(rec.vch).toUpperCase();
      const known = dict.vch.some((v) => v.toUpperCase() === normalized);
      if (!known) {
        const suggestion = closest(rec.vch, dict.vch);
        found.push(finding('R03', 'warning', cellRef(sheet, letter('vch'), rec.row),
          `в/ч «${rec.vch}» немає в довіднику`,
          suggestion ? `Можливо: «${suggestion}»` : 'Додайте в/ч до довідника',
          { row: rec.row, value: rec.vch, suggestion }));
      }
      if (normalized !== rec.vch.toUpperCase()) {
        found.push(finding('N03', 'info', cellRef(sheet, letter('vch'), rec.row),
          `в/ч містить латиницю: «${rec.vch}»`,
          `Система читає як «${normalized}»`, { row: rec.row }));
      }
    }

    // R04 — посада з довідника
    if (rec.position && dict.present && !dict.positions.some(
      (p) => p.toLowerCase() === rec.position.toLowerCase())) {
      const suggestion = closest(rec.position, dict.positions);
      found.push(finding('R04', 'warning', cellRef(sheet, letter('position'), rec.row),
        `Посади «${rec.position}» немає в довіднику`,
        suggestion ? `Найближча: «${suggestion}»` : 'Додайте посаду до довідника',
        { row: rec.row, value: rec.position, suggestion }));
    }

    // R05 — звання з довідника
    if (rec.rank && dict.present && !dict.ranks.some(
      (r) => r.toLowerCase() === rec.rank.toLowerCase())) {
      found.push(finding('R05', 'error', cellRef(sheet, letter('rank'), rec.row),
        `Звання «${rec.rank}» немає в довіднику`,
        'Виберіть звання зі списку', { row: rec.row, value: rec.rank }));
    }

    // R06 — формат ПІБ
    if (rec.name) {
      checkNameFormat(rec, found, sheet, letter('name'));
    }

    // R07 — тип групи (система визначає сама за довідником)
    if (rec.group && dict.groupTypes.size) {
      const expected = dict.groupTypes.get(rec.group.toLowerCase());
      if (expected) {
        if (!rec.groupType) {
          found.push(finding('N07', 'info', cellRef(sheet, letter('group_type'), rec.row),
            `Тип групи для «${rec.group}» у файлі порожній`,
            `Система визначає тип «${expected}» за довідником`,
            { row: rec.row, cosmetic: true }));
        } else if (rec.groupType.toLowerCase() !== expected.toLowerCase()) {
          found.push(finding('R07', 'info', cellRef(sheet, letter('group_type'), rec.row),
            `Тип групи у файлі «${rec.groupType}», за довідником «${expected}»`,
            `Система використовує «${expected}»`, { row: rec.row }));
        }
      } else if (rec.groupType && !RANK_TYPES.includes(rec.groupType)) {
        found.push(finding('R07', 'info', cellRef(sheet, letter('group_type'), rec.row),
          `Тип групи «${rec.groupType}» не з переліку ПУ / МВГ / ВГ / Екіпаж`,
          'Перевірте довідник груп', { row: rec.row }));
      }
    }

    // N01/N02 — ненормальні пробіли
    for (const [key, label] of [['name', 'ПІБ'], ['position', 'Посада'],
      ['group', 'Група'], ['rank', 'Звання']]) {
      const raw = rec.raw && rec.raw[key] !== undefined ? rec.raw[key] : rec[key];
      if (typeof raw !== 'string') continue;
      if (raw !== normalizeText(raw)) {
        found.push(finding('N01', 'info', cellRef(sheet, letter(key), rec.row),
          `«${label}» містить зайві пробіли або символи табуляції`,
          'Система читає значення без зайвих пробілів', { row: rec.row }));
      }
    }

    // L01 — дубль ПІБ у файлі
    if (rec.name) {
      const key = personKey(rec.name);
      if (nameSeen.has(key)) {
        found.push(finding('L01', 'error', cellRef(sheet, letter('name'), rec.row),
          `Дубль ПІБ: така сама особа вже є в рядку ${nameSeen.get(key)}`,
          'Залиште один запис', { row: rec.row, value: rec.name }));
      } else {
        nameSeen.set(key, rec.row);
      }
    }

    // L05 — у МВГ є командир
    if (params.require_group_commander) {
      // перевіряється окремо після збору груп
    }
  }

  // L05 — МВГ без командира
  if (params.require_group_commander) {
    const byGroup = new Map();
    for (const rec of filled) {
      if (!rec.group) continue;
      if (!byGroup.has(rec.group)) byGroup.set(rec.group, []);
      byGroup.get(rec.group).push(rec);
    }
    for (const [group, recs] of byGroup) {
      const type = dict.groupTypes.get(group.toLowerCase());
      if (type !== 'МВГ') continue;
      const hasCommander = recs.some((r) => /командир/i.test(r.position));
      if (!hasCommander) {
        found.push(finding('L05', 'warning', `${sheet}!C${recs[0].row}`,
          `У групі «${group}» немає командира`,
          'Додайте командира МВГ або перевірте склад групи',
          { group }));
      }
    }
  }

  // L09 — різка зміна чисельності
  if (options.previousCount !== undefined && options.previousCount !== null) {
    const prev = Number(options.previousCount);
    const now = filled.length;
    if (prev > 0) {
      const change = Math.abs(now - prev) / prev * 100;
      const threshold = Number(params.headcount_change_percent ?? 40);
      if (change > threshold) {
        found.push(finding('L09', 'warning', `${sheet}!A12`,
          `Різка зміна чисельності: було ${prev}, стало ${now} `
          + `(${change.toFixed(0)} %)`,
          'Перевірте, чи не пропущено частину списку', { previous: prev, current: now }));
      }
    }
  }

  return found;
}

/* R06 — формат ПІБ: три слова, прізвище великими, без цифр. */
function checkNameFormat(rec, found, sheet, letter) {
  const ref = cellRef(sheet, letter, rec.row);
  const name = rec.name;
  const words = name.split(' ').filter(Boolean);

  if (/\d/.test(name)) {
    found.push(finding('R06', 'error', ref,
      `ПІБ містить цифри: «${name}»`,
      'Приберіть цифри з поля ПІБ', { row: rec.row, value: name }));
    return;
  }
  if (/[a-z]/i.test(name) && !/[а-яіїєґ]/i.test(name)) {
    found.push(finding('R06', 'error', ref,
      `ПІБ записано латиницею: «${name}»`,
      'Ведіть ПІБ кирилицею', { row: rec.row, value: name }));
    return;
  }
  if (words.length < 3) {
    found.push(finding('R06', 'error', ref,
      `ПІБ має три слова (прізвище, ім'я, по батькові), а містить ${words.length}: `
      + `«${name}»`,
      "Вкажіть ПРІЗВИЩЕ Ім'я По батькові через один пробіл",
      { row: rec.row, value: name }));
    return;
  }
  const surname = words[0];
  if (surname !== surname.toUpperCase()) {
    found.push(finding('R06', 'error', ref,
      `Прізвище має бути великими літерами: «${surname}»`,
      `Запишіть як «${surname.toUpperCase()} ${words.slice(1).join(' ')}»`,
      { row: rec.row, value: name }));
  }
  if (words.length > 3) {
    found.push(finding('R06', 'warning', ref,
      `ПІБ містить зайві слова: «${name}»`,
      "Вкажіть ПРІЗВИЩЕ Ім'я По батькові", { row: rec.row, value: name }));
  }
}

/* ---------- порівняння з реєстром осіб ---------- */

function checkPersons(records, registry, template) {
  const found = [];
  const sheet = template.sheet;
  const letterCol = (template.table.columns || [])
    .find((c) => c.key === 'name');
  const letter = letterCol ? letterCol.letter : 'G';
  const threshold = Number((template.params || {}).name_similarity_distance ?? 2);
  const known = registry || [];

  for (const rec of records) {
    if (rec.empty || !rec.name) continue;
    if (known.some((p) => p.key === personKey(rec.name))) continue;

    let best = null;
    let bestDistance = Infinity;
    const key = personKey(rec.name);
    for (const person of known) {
      const distance = levenshtein(key, person.key);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = person;
      }
    }

    if (best && bestDistance > 0 && bestDistance <= threshold) {
      found.push(finding('L06', 'warning', cellRef(sheet, letter, rec.row),
        `ПІБ схожий на «${best.name}» (різниця ${bestDistance} символів)`,
        'Підтвердіть, це та сама особа (псевдонім) чи різні особи',
        { row: rec.row, value: rec.name, similarTo: best.name, distance: bestDistance }));
    } else if (known.length) {
      found.push(finding('L07', 'info', cellRef(sheet, letter, rec.row),
        `Нова особа: «${rec.name}» відсутня в реєстрі`,
        'Після приймання особа буде додана до реєстру',
        { row: rec.row, value: rec.name }));
    }
  }
  return found;
}

function checkCrossUnits(records, submissionsForDay, template) {
  const found = [];
  const sheet = template.sheet;
  if (!submissionsForDay || !submissionsForDay.length) return found;
  const letter = ((template.table.columns || []).find((c) => c.key === 'name')
    || { letter: 'G' }).letter;
  const ownUnit = template._unit;

  for (const rec of records) {
    if (rec.empty || !rec.name) continue;
    const key = personKey(rec.name);
    for (const other of submissionsForDay) {
      if (ownUnit && other.unit === ownUnit) continue;
      const hit = (other.records || []).find((r) => personKey(r.name) === key);
      if (hit) {
        found.push(finding('L02', 'error', cellRef(sheet, letter, rec.row),
          `Особа «${rec.name}» є в поданні ПУ «${other.unit}» за ту саму добу`,
          'Одна особа не може бути в двох ПУ — з’ясуйте, хто подав правильно',
          { row: rec.row, value: rec.name, otherUnit: other.unit }));
        break;
      }
    }
  }
  return found;
}

function checkStructure(workbook, template) {
  const found = [];
  const sheetCfg = template.sheet;

  // S02 — форма розпізнана
  const sheet = workbook.sheets.find(
    (s) => s.name.trim().toLowerCase() === String(sheetCfg).trim().toLowerCase());
  if (!sheet) {
    found.push(finding('S02', 'critical', sheetCfg,
      `Немає аркуша «${sheetCfg}»`,
      'Надайте файл за затвердженим шаблоном v1.3'));
    return { found, ok: false };
  }

  const headerRow = Number((template.table || {}).header_row || 11) - 1;
  const header = sheet.rows[headerRow] || [];
  const expected = (template.table.columns || []).filter((c) => c.name);
  const missing = [];
  for (const col of expected) {
    const idx = colToIndex(col.letter);
    const value = idx < header.length ? asText(header[idx]) : '';
    if (!value) {
      missing.push(col.letter);
      continue;
    }
    // заголовок має починатися з очікуваного тексту (у шаблоні є уточнення)
    if (!value.toLowerCase().startsWith(String(col.name).toLowerCase().slice(0, 8))) {
      missing.push(`${col.letter} («${value}» замість «${col.name}»)`);
    }
  }

  if (missing.length) {
    found.push(finding('S02', 'critical', `${sheetCfg}!A11`,
      `Заголовки таблиці не відповідають шаблону: ${missing.join('; ')}`,
      'Відновіть рядок 11 згідно з шаблоном v1.3'));
    return { found, ok: false };
  }

  // S04 — макроси
  if (workbook.meta && workbook.meta.macros) {
    found.push(finding('S04', 'critical', sheetCfg,
      'Файл містить макроси',
      'Надішліть звичайний .xlsx без макросів'));
    return { found, ok: false };
  }

  // робимо зріз даних поза таблицею (S06)
  const start = Number((template.table || {}).data_start_row || 12) - 1;
  const end = Number((template.table || {}).data_end_row || 311) - 1;
  const cols = (template.table.columns || []).map((c) => colToIndex(c.letter));
  const maxCol = Math.max(...cols);
  const stray = [];
  sheet.rows.forEach((row, r) => {
    if (r <= headerRow) return;
    if (r > end) {
      const hasData = (row || []).some((v) => !isBlank(v));
      if (hasData) stray.push(r + 1);
      return;
    }
    for (let c = 0; c < (row || []).length; c++) {
      if (c > maxCol && !isBlank(row[c])) {
        stray.push(r + 1);
        break;
      }
    }
  });
  if (stray.length) {
    found.push(finding('S06', 'warning', `${sheetCfg}!A${stray[0]}`,
      `Дані поза зоною таблиці у рядках: ${stray.slice(0, 8).join(', ')}`
      + (stray.length > 8 ? ` та інших (${stray.length})` : ''),
      'Внесіть записи в таблицю, а не поза нею'));
  }

  return { found, ok: true };
}

/* ---------- допоміжне ---------- */

function closest(value, options) {
  let best = null;
  let bestDistance = Infinity;
  const target = String(value).toLowerCase();
  for (const option of options || []) {
    const distance = levenshtein(target, String(option).toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = option;
    }
  }
  return bestDistance <= Math.max(2, Math.floor(target.length / 4)) ? best : null;
}

/**
 * Головна функція.
 * options: {filename, registry, previousCount, today, submissionsForDay}
 */
function evaluate(workbook, template, options) {
  const opts = options || {};
  const dict = readDictionaries(workbook, template);
  const header = readHeader(workbook, template);

  const structure = checkStructure(workbook, template);
  const found = structure.found.slice();

  let records = [];
  if (structure.ok) {
    records = readRows(workbook, template);
    found.push(...checkHeader(header, template, dict, opts));
    found.push(...checkRows(records, dict, template, opts));
    found.push(...checkPersons(records.filter((r) => !r.empty),
      opts.registry, template));
    found.push(...checkCrossUnits(records.filter((r) => !r.empty),
      opts.submissionsForDay, template));
  }

  const counts = { critical: 0, error: 0, warning: 0, info: 0 };
  for (const f of found) counts[f.severity] += 1;
  /* косметичні інформаційні знахідки не змінюють вердикт */
  const materialInfo = found.filter((f) => f.severity === 'info' && !f.cosmetic).length;

  let verdict = 'ok';
  if (counts.critical) verdict = 'critical';
  else if (counts.error) verdict = 'error';
  else if (counts.warning) verdict = 'warning';
  else if (materialInfo) verdict = 'info';

  found.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    || String(a.cell).localeCompare(String(b.cell), 'uk'));

  const day = parseDate(header.f_day);
  const filled = records.filter((r) => !r.empty);

  return {
    verdict,
    counts,
    findings: found,
    header: {
      version: asText(header.f_version),
      sender: asText(header.f_sender),
      day: day ? formatDate(day) : asText(header.f_day),
      dayIso: day ? isoDate(day) : null,
      respRank: asText(header.f_resp_rank),
      respName: asText(header.f_resp_name),
    },
    records: filled.map((r) => ({
      row: r.row,
      vch: r.vch,
      group: r.group,
      groupType: dict.groupTypes.get(r.group.toLowerCase()) || r.groupType,
      position: r.position,
      rank: r.rank,
      name: r.name,
      note: r.note,
      personKey: personKey(r.name),
    })),
    dictionaries: {
      present: dict.present,
      groups: dict.groups.length,
      units: dict.units.length,
      positions: dict.positions.length,
      ranks: dict.ranks.length,
      vch: dict.vch.length,
    },
  };
}