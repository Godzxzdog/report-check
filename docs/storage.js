/* storage.js — реєстр у localStorage.
   Оригінали файлів не зберігаються в браузері (обмеження Pages):
   зберігаються подання, результати перевірки, історія рішень,
   а також текстовий зліпок вмісту для повторної перевірки. */

const STORE_KEY = 'reportCheck.v1';
const STATUS_LABELS = {
  new: 'Новий',
  checking: 'На перевірці',
  checked: 'Перевірено',
  accepted: 'Прийнято',
  rework: 'На доопрацювання',
  rejected: 'Відхилено',
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { submissions: [], events: [], counter: 0 };
    const data = JSON.parse(raw);
    if (!Array.isArray(data.submissions)) return { submissions: [], events: [], counter: 0 };
    return {
      submissions: data.submissions,
      events: data.events || [],
      counter: data.counter || data.submissions.length,
    };
  } catch (err) {
    return { submissions: [], events: [], counter: 0 };
  }
}

function saveState(state) {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
}

function nowText() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function nextNumber(state) {
  const year = new Date().getFullYear();
  const seq = state.submissions
    .filter((s) => s.number.startsWith(`${year}-`))
    .reduce((max, s) => Math.max(max, Number(s.number.split('-')[1]) || 0), 0);
  return `${year}-${String(seq + 1).padStart(4, '0')}`;
}

async function sha256Hex(buffer) {
  if (window.crypto && window.crypto.subtle) {
    const digest = await window.crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Без WebCrypto (не захищений контекст): грубий, але стабільний відбиток.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) {
    h1 = ((h1 ^ bytes[i]) * 0x01000193) >>> 0;
    h2 = ((h2 + bytes[i]) * 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16) + h2.toString(16)).padStart(16, '0').repeat(4);
}

function addEvent(state, submissionId, from, to, note) {
  state.events.push({
    submissionId,
    at: nowText(),
    fromStatus: from,
    toStatus: to,
    note: note || '',
  });
}

function setStatus(state, submissionId, status, note) {
  const sub = state.submissions.find((s) => s.id === submissionId);
  if (!sub || sub.status === status) return;
  const from = sub.status;
  sub.status = status;
  addEvent(state, submissionId, from, status, note);
}

function registerSubmission(state, file, unit, snapshot, result) {
  const id = (state.submissions.reduce((max, s) => Math.max(max, s.id), 0) || 0) + 1;
  const duplicate = state.submissions.find((s) => s.sha256 === file.sha256);
  const sub = {
    id,
    number: nextNumber(state),
    unit,
    filename: file.filename,
    sizeBytes: file.size,
    sha256: file.sha256,
    receivedAt: file.receivedAt || nowText(),
    uploadedAt: nowText(),
    status: 'checked',
    comment: '',
    duplicateOf: duplicate ? duplicate.id : null,
    verdict: result.verdict,
    counts: result.counts,
    findings: result.findings,
    checkedAt: nowText(),
    templateVersion: snapshot.templateVersion,
    sheets: snapshot.sheets,
  };
  state.submissions.push(sub);
  addEvent(state, id, null, 'new', 'Подання зареєстровано');
  addEvent(state, id, 'new', 'checking', 'Розпочато автоматичну перевірку');
  addEvent(state, id, 'checking', 'checked', 'Автоматична перевірка завершена');
  return sub;
}

function historyOf(state, submissionId) {
  return state.events.filter((e) => e.submissionId === submissionId);
}

function dashboardOf(state) {
  const byStatus = {};
  for (const s of state.submissions) {
    byStatus[s.status] = (byStatus[s.status] || 0) + 1;
  }
  const recent = state.events.slice(-12).reverse().map((ev) => {
    const sub = state.submissions.find((s) => s.id === ev.submissionId);
    return {
      ...ev,
      number: sub ? sub.number : '—',
      unit: sub ? sub.unit : '—',
      statusLabel: STATUS_LABELS[ev.toStatus] || ev.toStatus,
    };
  });
  return {
    total: state.submissions.length,
    units: new Set(state.submissions.map((s) => s.unit)).size,
    new: byStatus.new || 0,
    checking: byStatus.checking || 0,
    checked: byStatus.checked || 0,
    accepted: byStatus.accepted || 0,
    rework: byStatus.rework || 0,
    rejected: byStatus.rejected || 0,
    recent,
  };
}

/* Текстовий зліпок вмісту: дозволяє перевірити файл повторно,
   коли оригіналу вже немає (браузер не може зберегти сам XLSX). */
function snapshotOf(workbook, templateVersion) {
  return {
    templateVersion,
    sheets: workbook.map((sheet) => ({
      name: sheet.name,
      rows: sheet.rows.map((row) => row.map((cell) => {
        if (cell instanceof Date) return cell.toISOString();
        if (cell === null || cell === undefined) return null;
        if (typeof cell === 'number' || typeof cell === 'boolean') return cell;
        return String(cell);
      })),
    })),
  };
}

function restoreWorkbook(snapshot) {
  return snapshot.sheets.map((sheet) => ({
    name: sheet.name,
    rows: sheet.rows.map((row) => row.map((cell) => {
      if (typeof cell === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(cell)) {
        const d = new Date(cell);
        if (!Number.isNaN(d.getTime())) return d;
      }
      return cell;
    })),
  }));
}

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
    events: data.events || [],
    counter: data.counter || data.submissions.length,
  });
}

function clearState() {
  localStorage.removeItem(STORE_KEY);
}

/* ---------- експорт XLSX (без бібліотек) ---------- */

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

/* Мінімальний ZIP без стискання (method 0) — читається Excel і LibreOffice. */
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