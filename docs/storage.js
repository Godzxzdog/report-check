/* storage.js — реєстр у localStorage для щоденних розрахунків.
   Оригінали XLSX у браузері не зберігаються: зберігаються подання, версії,
   результати перевірки, записи присутності, реєстр осіб і журнал. */

const STORE_KEY = 'reportcheck.v41';
const STATUS_LABELS = {
  new: 'Новий',
  checking: 'На перевірці',
  checked: 'Перевірено',
  accepted: 'Прийнято',
  accepted_notes: 'Прийнято із зауваженнями',
  rework: 'На доопрацювання',
  rejected: 'Відхилено',
  replaced: 'Замінено',
};
const STATUS_SHORT = {
  new: 'Новий',
  checking: 'На перевірці',
  checked: 'Перевірено',
  accepted: 'Прийнято',
  accepted_notes: 'З зауваженнями',
  rework: 'На доопрацювання',
  rejected: 'Відхилено',
  replaced: 'Замінено',
};

const VERDICT_LABEL = {
  ok: 'Без зауважень',
  info: 'Лише інформація',
  warning: 'Попередження',
  error: 'Є помилки',
  critical: 'Непридатний',
};

const EMPTY_STATE = {
  submissions: [],
  persons: [],
  aliases: [],
  months: {},
  skips: [],
  events: [],
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return JSON.parse(JSON.stringify(EMPTY_STATE));
    const data = JSON.parse(raw);
    return {
      submissions: data.submissions || [],
      persons: data.persons || [],
      aliases: data.aliases || [],
      months: data.months || {},
      skips: data.skips || [],
      events: data.events || [],
    };
  } catch (err) {
    return JSON.parse(JSON.stringify(EMPTY_STATE));
  }
}

function saveState(state) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    return true;
  } catch (err) {
    throw new Error('Не вдалося зберегти дані у браузері: '
      + 'сховище переповнене. Зробіть резервну копію і видаліть старі подання.');
  }
}

function nowText() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function todayIso() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* ---------- номери ---------- */

function nextNumber(state) {
  const year = new Date().getFullYear();
  const seq = state.submissions
    .filter((s) => s.number.startsWith(`${year}-`))
    .reduce((max, s) => Math.max(max, Number(s.number.split('-')[1]) || 0), 0);
  return `${year}-${String(seq + 1).padStart(4, '0')}`;
}

function nextDocNumber(state, kind) {
  const prefix = kind === 'cert' ? 'ДВ' : 'ЗВ';
  const year = new Date().getFullYear();
  const count = (state.events || []).filter(
    (e) => e.type === `doc:${kind}` && e.year === year).length;
  return `${prefix}-${year}-${String(count + 1).padStart(3, '0')}`;
}

/* ---------- журнал ---------- */

function logEvent(state, type, payload, details) {
  state.events.push({
    at: nowText(),
    type,
    payload: payload || {},
    details: details || '',
    year: new Date().getFullYear(),
  });
  if (state.events.length > 800) state.events = state.events.slice(-600);
}

/* ---------- подання ---------- */

function findSubmission(state, unit, dayIso) {
  return state.submissions.find((s) => s.unit === unit && s.dayIso === dayIso);
}

function findSubmissionById(state, id) {
  return state.submissions.find((s) => s.id === id);
}

function activeVersion(submission) {
  if (!submission || !submission.versions || !submission.versions.length) return null;
  return submission.versions[submission.versions.length - 1];
}

/**
 * Реєструє файл: створює подання ПУ+доба або нову версію.
 * Результат evaluate() вже обчислено.
 */
function registerSubmission(state, file, result, options) {
  const opts = options || {};
  const dayIso = result.header.dayIso;
  const unit = result.header.sender || opts.unit || 'Без ПУ';

  let submission = findSubmission(state, unit, dayIso);
  if (!submission) {
    const id = (state.submissions.reduce((max, s) => Math.max(max, s.id), 0) || 0) + 1;
    submission = {
      id,
      number: nextNumber(state),
      unit,
      dayIso,
      day: result.header.day,
      status: 'new',
      comment: '',
      versions: [],
      createdAt: nowText(),
    };
    state.submissions.push(submission);
    logEvent(state, 'submission', { id, number: submission.number },
      `Подання ${unit} за ${result.header.day}`);
  }

  const prevVersion = activeVersion(submission);
  if (prevVersion && prevVersion.status === 'accepted') {
    prevVersion.status = 'replaced';
    logEvent(state, 'version:replaced', { id: submission.id }, 'Попередня версія замінена');
  }

  const duplicate = state.submissions
    .flatMap((s) => s.versions.map((v) => ({ ...v, submissionId: s.id })))
    .find((v) => v.sha256 === file.sha256 && !(prevVersion && v.id === prevVersion.id));

  const version = {
    id: (submission.versions.reduce((max, v) => Math.max(max, v.number), 0) || 0) + 1,
    number: (submission.versions.reduce((max, v) => Math.max(max, v.number), 0) || 0) + 1,
    filename: file.filename,
    sizeBytes: file.size,
    sha256: file.sha256,
    receivedAt: opts.receivedAt || nowText(),
    uploadedAt: nowText(),
    status: 'checked',
    verdict: result.verdict,
    counts: result.counts,
    findings: result.findings,
    header: result.header,
    records: result.records,
    dictionaries: result.dictionaries,
    templateVersion: opts.templateVersion || '',
    duplicateOf: duplicate ? { submissionId: duplicate.submissionId, version: duplicate.number } : null,
    checkedAt: nowText(),
  };

  submission.versions.push(version);
  submission.status = 'checked';
  logEvent(state, 'version', { id: submission.id, version: version.number },
    `Версія ${version.number}: ${VERDICT_LABEL[result.verdict] || result.verdict}`);
  return { submission, version };
}

function setStatus(state, submissionId, status, note) {
  const submission = findSubmissionById(state, submissionId);
  if (!submission) throw new Error('Подання не знайдено');
  const version = activeVersion(submission);
  const previous = submission.status;

  if (version) {
    version.status = status;
    version.decidedAt = nowText();
    if (note) version.comment = note;
  }
  submission.status = status;
  if (note) submission.comment = note;

  if (status === 'accepted' || status === 'accepted_notes') {
    addPersonsFromVersion(state, submission, version);
  }
  logEvent(state, 'decision', { id: submissionId, status },
    `Статус: ${STATUS_LABELS[status] || status}` + (note ? ` — ${note}` : ''));
  return previous;
}

/* ---------- реєстр осіб ---------- */

function addPersonsFromVersion(state, submission, version) {
  if (!version) return;
  for (const rec of version.records || []) {
    const key = rec.personKey;
    if (!key) continue;
    let person = state.persons.find((p) => p.key === key);
    if (!person) {
      person = {
        id: (state.persons.reduce((max, p) => Math.max(max, p.id), 0) || 0) + 1,
        key,
        name: rec.name,
        rank: rec.rank,
        position: rec.position,
        vch: rec.vch,
        unit: submission.unit,
        firstSeen: version.uploadedAt,
        lastSeen: version.uploadedAt,
        active: true,
      };
      state.persons.push(person);
      logEvent(state, 'person:new', { id: person.id }, 'Нова особа в реєстрі');
    } else {
      person.rank = rec.rank || person.rank;
      person.position = rec.position || person.position;
      person.vch = rec.vch || person.vch;
      person.lastSeen = version.uploadedAt;
      person.active = true;
    }
  }
}

function personKeyOf(name) {
  return personKey(name);
}

function resolveAlias(state, fromKey, toPersonId, comment) {
  const toPerson = state.persons.find((p) => p.id === toPersonId);
  if (!toPerson) throw new Error('Особу не знайдено');
  state.aliases.push({
    key: fromKey,
    personId: toPersonId,
    comment: comment || '',
    at: nowText(),
  });
  logEvent(state, 'person:alias', { id: toPersonId }, 'Підтверджено написання ПІБ');
}

function aliasTarget(state, key) {
  const alias = state.aliases.find((a) => a.key === key);
  if (!alias) return null;
  return state.persons.find((p) => p.id === alias.personId) || null;
}

/* Підозрілі збіги: у прийнятих поданнях є ключ, якого немає в реєстрі,
   але який близький до наявної особи. */
function suspiciousNames(state, template) {
  const threshold = Number((template && template.params
    && template.params.name_similarity_distance) || 2);
  const known = new Set(state.persons.map((p) => p.key));
  const seen = new Map();

  for (const sub of state.submissions) {
    const version = activeVersion(sub);
    if (!version || (version.status !== 'accepted'
      && version.status !== 'accepted_notes')) continue;
    for (const rec of version.records || []) {
      if (!rec.personKey || known.has(rec.personKey)) continue;
      if (state.aliases.some((a) => a.key === rec.personKey)) continue;
      if (!seen.has(rec.personKey)) {
        seen.set(rec.personKey, { key: rec.personKey, name: rec.name, unit: sub.unit,
          submissionId: sub.id, day: sub.dayIso, count: 0 });
      }
      seen.get(rec.personKey).count += 1;
    }
  }

  const out = [];
  for (const item of seen.values()) {
    let best = null;
    let bestDistance = Infinity;
    for (const person of state.persons) {
      const distance = levenshtein(item.key, person.key);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = person;
      }
    }
    if (best && bestDistance > 0 && bestDistance <= threshold) {
      out.push({ ...item, similarTo: best.name, personId: best.id, distance: bestDistance });
    }
  }
  return out;
}

/* ---------- календар і довідки ---------- */

function monthKey(iso) {
  return iso ? iso.slice(0, 7) : '';
}

function monthDays(year, month) {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Array.from({ length: last }, (_, i) => {
    const d = String(i + 1).padStart(2, '0');
    return { iso: `${year}-${String(month).padStart(2, '0')}-${d}`, day: i + 1 };
  });
}

function units(state) {
  return Array.from(new Set(state.submissions.map((s) => s.unit))).sort();
}

function isSkipped(state, unit, dayIso) {
  return state.skips.some((s) => s.unit === unit && s.day === dayIso);
}

function skipDay(state, unit, dayIso, comment) {
  if (isSkipped(state, unit, dayIso)) return;
  state.skips.push({ unit, day: dayIso, comment: comment || '', at: nowText() });
  logEvent(state, 'skip', {}, `Позначено «не очікується»: ${unit}, ${dayIso}`);
}

function unskipDay(state, unit, dayIso) {
  state.skips = state.skips.filter((s) => !(s.unit === unit && s.day === dayIso));
}

function calendar(state, year, month) {
  const days = monthDays(year, month);
  const list = units(state);
  return {
    days,
    units: list,
    cells: list.map((unit) => days.map(({ iso }) => {
      const sub = findSubmission(state, unit, iso);
      if (sub) {
        return { status: sub.status, submissionId: sub.id, number: sub.number };
      }
      if (isSkipped(state, unit, iso)) return { status: 'skipped' };
      return { status: 'missing' };
    })),
  };
}

function acceptedVersionFor(state, unit, dayIso) {
  const sub = findSubmission(state, unit, dayIso);
  if (!sub) return null;
  const version = activeVersion(sub);
  if (!version) return null;
  if (version.status !== 'accepted' && version.status !== 'accepted_notes') return null;
  return { submission: sub, version };
}

/* Проблеми перед формуванням довідки. */
function certificateIssues(state, year, month) {
  const days = monthDays(year, month);
  const list = units(state);
  const missing = [];
  const pending = [];
  const conflicts = [];
  const incomplete = [];

  for (const unit of list) {
    for (const { iso } of days) {
      const sub = findSubmission(state, unit, iso);
      if (!sub) {
        if (!isSkipped(state, unit, iso)) missing.push({ unit, day: iso });
        continue;
      }
      const version = activeVersion(sub);
      if (!version) continue;
      if (version.status === 'new' || version.status === 'checking'
        || version.status === 'checked' || version.status === 'rework') {
        pending.push({ unit, day: iso, status: version.status,
          label: STATUS_SHORT[version.status] || version.status });
      }
      if (version.status === 'accepted' || version.status === 'accepted_notes') {
        for (const rec of version.records || []) {
          if (!rec.rank || !rec.vch) {
            incomplete.push({ unit, day: iso, name: rec.name, row: rec.row });
          }
        }
      }
    }
  }

  const byPerson = new Map();
  for (const unit of list) {
    for (const { iso } of days) {
      const hit = acceptedVersionFor(state, unit, iso);
      if (!hit) continue;
      for (const rec of hit.version.records || []) {
        const bucket = byPerson.get(rec.personKey) || [];
        bucket.push({ unit, day: iso, name: rec.name });
        byPerson.set(rec.personKey, bucket);
      }
    }
  }
  for (const [key, entries] of byPerson) {
    const dayMap = new Map();
    for (const entry of entries) {
      const list2 = dayMap.get(entry.day) || [];
      list2.push(entry);
      dayMap.set(entry.day, list2);
    }
    for (const [day, group] of dayMap) {
      const distinctUnits = new Set(group.map((g) => g.unit));
      if (distinctUnits.size > 1) {
        conflicts.push({ personKey: key, name: group[0].name, day,
          units: Array.from(distinctUnits) });
      }
    }
  }

  const suspicious = suspiciousNames(state, state._template);
  return { missing, pending, conflicts, incomplete, suspicious };
}

/* Будує довідки про чергування за місяць по кожному ПУ. */
function buildCertificates(state, year, month, options) {
  const opts = options || {};
  const days = monthDays(year, month);
  const list = units(state);
  const aliasMap = new Map();
  for (const alias of state.aliases) {
    const person = state.persons.find((p) => p.id === alias.personId);
    if (person) aliasMap.set(alias.key, person);
  }

  const certificates = [];
  for (const unit of list) {
    const persons = new Map();
    for (const { iso, day } of days) {
      const hit = acceptedVersionFor(state, unit, iso);
      if (!hit) continue;
      for (const rec of hit.version.records || []) {
        const person = aliasMap.get(rec.personKey)
          || state.persons.find((p) => p.key === rec.personKey)
          || { name: rec.name, rank: rec.rank, position: rec.position, vch: rec.vch };
        const key = person.key || rec.personKey;
        if (!persons.has(key)) {
          persons.set(key, {
            key,
            name: person.name || rec.name,
            rank: rec.rank,
            position: rec.position,
            vch: rec.vch,
            days: [],
            lastDay: iso,
          });
        }
        const entry = persons.get(key);
        entry.days.push(day);
        entry.rank = rec.rank || entry.rank;
        entry.position = rec.position || entry.position;
        entry.vch = rec.vch || entry.vch;
        entry.lastDay = iso;
      }
    }

    if (!persons.size) continue;
    const rows = Array.from(persons.values())
      .sort((a, b) => a.name.localeCompare(b.name, 'uk'));
    const skipped = days.filter(({ iso }) => !acceptedVersionFor(state, unit, iso)
      && isSkipped(state, unit, iso)).map(({ day }) => day);
    const missingDays = days.filter(({ iso }) => !acceptedVersionFor(state, unit, iso)
      && !isSkipped(state, unit, iso)).map(({ day }) => day);

    certificates.push({
      unit,
      month: `${year}-${String(month).padStart(2, '0')}`,
      rows,
      skipped,
      missingDays,
      totalPersons: rows.length,
      totalDays: rows.reduce((sum, r) => sum + r.days.length, 0),
      generatedAt: nowText(),
      version: (opts.version || 1),
      number: opts.number || '',
      confirmed: Boolean(opts.confirmed),
      comment: opts.comment || '',
    });
  }
  return certificates;
}

/* ---------- зведення за добу ---------- */

function daySummary(state, dayIso) {
  const rows = [];
  const conflicts = [];
  for (const sub of state.submissions) {
    if (sub.dayIso !== dayIso) continue;
    const version = activeVersion(sub);
    if (!version) continue;
    const accepted = version.status === 'accepted' || version.status === 'accepted_notes';
    for (const rec of version.records || []) {
      rows.push({
        unit: sub.unit,
        group: rec.group,
        type: rec.groupType || '—',
        rank: rec.rank,
        name: rec.name,
        position: rec.position,
        vch: rec.vch,
        accepted,
        status: version.status,
      });
    }
  }

  const byName = new Map();
  for (const row of rows) {
    const key = personKey(row.name);
    const bucket = byName.get(key) || [];
    bucket.push(row);
    byName.set(key, bucket);
  }
  for (const [key, bucket] of byName) {
    const distinct = new Set(bucket.map((b) => b.unit));
    if (distinct.size > 1) {
      conflicts.push({ name: bucket[0].name, units: Array.from(distinct) });
    }
  }

  const byType = {};
  for (const row of rows) {
    byType[row.type] = (byType[row.type] || 0) + 1;
  }

  return { rows, conflicts, byType, total: rows.length };
}

/* ---------- головна панель ---------- */

function dashboardOf(state, dayIso) {
  const day = dayIso || todayIso();
  const list = units(state);
  const unitsStatus = list.map((unit) => {
    const sub = findSubmission(state, unit, day);
    if (!sub) {
      return { unit, status: isSkipped(state, unit, day) ? 'skipped' : 'expected',
        label: isSkipped(state, unit, day) ? 'Не очікується' : 'Очікується' };
    }
    const version = activeVersion(sub);
    return {
      unit,
      status: version ? version.status : 'new',
      label: STATUS_SHORT[version ? version.status : 'new'],
      number: sub.number,
      submissionId: sub.id,
      findings: version ? version.counts : null,
    };
  });

  const statusCounts = {};
  for (const sub of state.submissions) {
    const version = activeVersion(sub);
    if (!version) continue;
    statusCounts[version.status] = (statusCounts[version.status] || 0) + 1;
  }

  const personsToday = state.submissions
    .filter((s) => s.dayIso === day)
    .reduce((sum, s) => {
      const v = activeVersion(s);
      if (!v || (v.status !== 'accepted' && v.status !== 'accepted_notes')) return sum;
      return sum + (v.records || []).length;
    }, 0);

  const recent = state.events.slice(-12).reverse().map((ev) => ({
    at: ev.at,
    text: ev.details || ev.type,
    type: ev.type,
  }));

  return {
    day,
    unitsStatus,
    expected: unitsStatus.filter((u) => u.status === 'expected').length,
    received: unitsStatus.filter((u) => u.status !== 'expected').length,
    statusCounts,
    personsToday,
    recent,
    total: state.submissions.length,
    persons: state.persons.length,
  };
}

/* ---------- резервні копії ---------- */

function dumpState() {
  return JSON.stringify(loadState(), null, 2);
}

function importState(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data.submissions)) {
    throw new Error('Файл резервної копії має неправильний формат');
  }
  saveState({
    submissions: data.submissions,
    persons: data.persons || [],
    aliases: data.aliases || [],
    months: data.months || {},
    skips: data.skips || [],
    events: data.events || [],
  });
}

/* ---------- експорт XLSX ---------- */

function xmlEscape(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[ch]));
}

function sheetXml(rows) {
  const parts = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<sheetData>'];
  rows.forEach((row, r) => {
    const cells = row.map((value, c) => {
      const ref = `${indexToCol(c)}${r + 1}`;
      if (value === null || value === undefined || value === '') return '';
      if (typeof value === 'number' && Number.isFinite(value)) {
        return `<c r="${ref}"><v>${value}</v></c>`;
      }
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">`
        + `${xmlEscape(value)}</t></is></c>`;
    }).join('');
    parts.push(`<row r="${r + 1}">${cells}</row>`);
  });
  parts.push('</sheetData></worksheet>');
  return parts.join('');
}

function buildZip(files) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const time = ((now.getHours() << 11) | (now.getMinutes() << 5)
    | Math.floor(now.getSeconds() / 2)) & 0xffff;
  const date = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5)
    | now.getDate()) & 0xffff;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    chunks.push(local, data);

    const header = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(header.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    header.set(nameBytes, 46);
    central.push(header);
    offset += local.length + data.length;
  }

  let centralSize = 0;
  for (const c of central) centralSize += c.length;

  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const all = [...chunks, ...central, end];
  const total = all.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of all) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

function buildXlsx(sheets) {
  const overrides = sheets.map((s, i) =>
    `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join('');
  const files = [{
    name: '[Content_Types].xml',
    data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + overrides + '</Types>',
  }, {
    name: '_rels/.rels',
    data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '</Relationships>',
  }, {
    name: 'xl/workbook.xml',
    data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
      + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
      + sheets.map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
      + '</sheets></workbook>',
  }, {
    name: 'xl/_rels/workbook.xml.rels',
    data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + '</Relationships>',
  }];

  sheets.forEach((sheet, i) => {
    files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(sheet.rows) });
  });

  return buildZip(files);
}

function downloadBlob(bytes, filename, type) {
  const blob = new Blob([bytes], {
    type: type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function sha256Hex(buffer) {
  if (window.crypto && window.crypto.subtle) {
    const digest = await window.crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) {
    h1 = ((h1 ^ bytes[i]) * 0x01000193) >>> 0;
    h2 = ((h2 + bytes[i]) * 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16) + h2.toString(16)).padStart(16, '0').repeat(4);
}