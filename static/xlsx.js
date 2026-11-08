/* xlsx_read.js — мінімальний читач XLSX у браузері, без бібліотек.
   XLSX = ZIP з XML. Беремо тільки те, що потрібно перевіряючому:
   назви аркушів, рядки, значення клітинок (рядки, числа, дати, формули). */

/* ---------- ZIP ---------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new XlsxError('Цей браузер не вміє розпаковувати XLSX. '
      + 'Скористайтеся Chrome, Edge, Safari 16.4+ або Firefox 113+.');
  }
  try {
    const stream = new Blob([bytes]).stream()
      .pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (err) {
    throw new XlsxError('Файл пошкоджений або має формат, відмінний від XLSX');
  }
}

class XlsxError extends Error {}

/* Центральний каталог ZIP: шукаємо з кінця, читаємо записи. */
async function unzip(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 22) {
    throw new XlsxError('Файл пошкоджений або має формат, відмінний від XLSX');
  }

  let eocd = -1;
  const floor = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= floor; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) {
    throw new XlsxError('Файл пошкоджений або має формат, відмінний від XLSX');
  }

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries = new Map();

  for (let n = 0; n < count; n++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder('utf-8').decode(
      bytes.subarray(offset + 46, offset + 46 + nameLen));
    entries.set(name, { method, compSize, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, bytes, view };
}

async function readEntry(zip, name) {
  const entry = zip.entries.get(name);
  if (!entry) return null;
  const { bytes, view } = zip;
  const at = entry.localOffset;
  if (view.getUint32(at, true) !== 0x04034b50) {
    throw new XlsxError('Файл пошкоджений: некоректна структура архіву');
  }
  const nameLen = view.getUint16(at + 26, true);
  const extraLen = view.getUint16(at + 28, true);
  const start = at + 30 + nameLen + extraLen;
  const raw = bytes.subarray(start, start + entry.compSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateRaw(raw);
  throw new XlsxError('Файл пошкоджений: невідомий спосіб стискання');
}

function textOf(zip, name) {
  return readEntry(zip, name).then((data) =>
    data === null ? null : new TextDecoder('utf-8').decode(data));
}

/* ---------- XML ---------- */

/* DOMParser, якщо він є (браузер) — швидший і надійніший. */
const HAS_DOMPARSER = typeof DOMParser !== 'undefined';

function parseXml(text) {
  if (HAS_DOMPARSER) {
    let doc = null;
    try {
      doc = new DOMParser().parseFromString(text, 'application/xml');
    } catch (err) {
      doc = null;
    }
    if (doc) {
      const broken = typeof doc.querySelector === 'function'
        && doc.querySelector('parsererror');
      if (!broken) return { mode: 'dom', doc };
    }
    /* Браузер не дав документ — розбираємо власним парсером. */
  }
  return { mode: 'tree', doc: parseTree(text) };
}

/* Локальні назви без простору імен: робота з будь-яким префіксом. */
function tags(node, name) {
  if (!node || !node.doc) return [];
  if (node.mode === 'dom') {
    const all = node.doc.getElementsByTagName('*');
    if (!all) return [];
    return Array.from(all).filter((n) => n && nodeNameOf(n) === name);
  }
  const out = [];
  const walk = (n) => {
    const kids = (n && n.children) || [];
    for (const child of kids) {
      if (!child) continue;
      if (child.local === name) out.push({ mode: 'tree', doc: child });
      walk(child);
    }
  };
  walk(node.doc);
  return out;
}

/* Локальна назва вузла DOM: localName, інакше nodeName без префікса. */
function nodeNameOf(n) {
  if (n.localName) return n.localName;
  const raw = n.nodeName || '';
  return raw.includes(':') ? raw.split(':').pop() : raw;
}

function attr(node, name) {
  if (!node) return null;
  if (node.mode === 'dom') {
    const doc = node.doc;
    if (!doc) return null;
    const list = doc.attributes;
    if (!list) return null;
    for (const a of Array.from(list)) {
      if (a && nodeNameOf(a) === name) return a.value;
    }
    return null;
  }
  const source = node.attrs || (node.doc && node.doc.attrs) || {};
  const value = source[name];
  return value === undefined ? null : value;
}

function nodeText(node) {
  if (!node) return '';
  if (node.mode === 'dom') {
    const doc = node.doc;
    if (!doc) return '';
    return doc.textContent === undefined ? '' : String(doc.textContent);
  }
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if (n.text) out.push(n.text);
    const kids = n.children || [];
    for (const child of kids) walk(child);
  };
  walk(node.doc);
  return out.join('');
}

/* Резервний мінімальний XML-парсер: дерево без простору імен. */
function parseTree(text) {
  const root = { local: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  const decode = (s) => s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      stack[stack.length - 1].text += decode(text.slice(i));
      break;
    }
    if (lt > i) stack[stack.length - 1].text += decode(text.slice(i, lt));

    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt);
      const body = text.slice(lt + 9, end < 0 ? text.length : end);
      stack[stack.length - 1].text += body;
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<?', lt) || text.startsWith('<!', lt)) {
      const end = text.indexOf('>', lt);
      i = end < 0 ? text.length : end + 1;
      continue;
    }

    const gt = text.indexOf('>', lt);
    if (gt < 0) break;
    let body = text.slice(lt + 1, gt);
    const selfClosing = body.endsWith('/');
    if (selfClosing) body = body.slice(0, -1);

    if (body.startsWith('/')) {
      if (stack.length > 1) stack.pop();
      i = gt + 1;
      continue;
    }

    const space = body.search(/\s/);
    const rawName = space < 0 ? body : body.slice(0, space);
    const local = rawName.includes(':') ? rawName.split(':').pop() : rawName;
    const node = { local, attrs: {}, children: [], text: '' };

    const attrText = space < 0 ? '' : body.slice(space + 1);
    const attrRe = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = attrRe.exec(attrText)) !== null) {
      const attrName = m[1].includes(':') ? m[1].split(':').pop() : m[1];
      node.attrs[attrName] = decode(m[3] !== undefined ? m[3] : m[4]);
    }

    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    i = gt + 1;
  }
  return root;
}

function colToIndex(ref) {
  const letters = String(ref).replace(/\d+$/, '');
  let index = 0;
  for (const ch of letters) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

function indexToCol(index) {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/* ---------- книга ---------- */

const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57,
]);

function isDateFormat(code) {
  if (!code) return false;
  const cleaned = String(code)
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '');
  return /[dmyhs]/i.test(cleaned) && !/^[#0.,%\s]+$/.test(cleaned);
}

/* Серійне число Excel -> дата (система 1900, з відомим зсувом 1900-02-29). */
/**
 * Номер дати Excel -> Date.
 * У 1900-системі Excel помилково має 29.02.1900, тому все, що більше
 * за 60, зсунуте на день уперед. 1904-система (Mac) починається з 01.01.1904.
 */
function serialToDate(serial) {
  const days = Math.floor(serial);
  const ms = Math.round((serial - days) * 86400) * 1000;
  if (days <= 0) return new Date(NaN);
  const base = days < 61 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  return new Date(base + days * 86400000 + ms);
}

function formatDate(date) {
  const d = String(date.getUTCDate()).padStart(2, '0');
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${d}.${m}.${date.getUTCFullYear()}`;
}

function readSharedStrings(doc) {
  if (!doc) return [];
  return tags(doc, 'si').map((si) => {
    const texts = tags(si, 't').map((t) => nodeText(t));
    return texts.join('');
  });
}

function readStyleDates(doc) {
  const dateStyles = new Set();
  if (!doc) return { dateStyles, isDateStyle: () => false };
  const customFormats = new Map();
  for (const fmt of tags(doc, 'numFmt')) {
    customFormats.set(Number(attr(fmt, 'numFmtId')), attr(fmt, 'formatCode'));
  }
  const isDateStyle = (styleIndex) => {
    const xfs = tags(doc, 'xf');
    const xf = xfs[styleIndex];
    if (!xf) return false;
    const id = Number(attr(xf, 'numFmtId') || 0);
    if (BUILTIN_DATE_FORMATS.has(id)) return true;
    return isDateFormat(customFormats.get(id));
  };
  return { dateStyles, isDateStyle };
}

function readWorkbookSheets(doc) {
  return tags(doc, 'sheet').map((sheet, i) => ({
    name: attr(sheet, 'name') || `Аркуш${i + 1}`,
    rid: attr(sheet, 'id') || attr(sheet, 'r:id') || '',
  }));
}

/* Іменовані клітинки книги: f_sender -> {sheet, row, col} */
function readDefinedNames(doc) {
  const names = new Map();
  for (const node of tags(doc, 'definedName')) {
    const name = attr(node, 'name');
    if (!name || name.startsWith('_xlnm')) continue;
    const target = (nodeText(node) || '').trim();
    const m = /^(?:'([^']+)'|([^!]+))!\$?([A-Z]+)\$?(\d+)$/.exec(target);
    if (!m) continue;
    names.set(name, {
      sheet: m[1] || m[2],
      col: colToIndex(m[3]),
      row: Number(m[4]) - 1,
    });
  }
  return names;
}

function readRels(doc) {
  const map = new Map();
  if (!doc) return map;
  for (const rel of tags(doc, 'Relationship')) {
    const id = attr(rel, 'Id') || attr(rel, 'id');
    const target = attr(rel, 'Target') || attr(rel, 'target');
    if (id && target) map.set(id, target);
  }
  return map;
}

/**
 * Читає XLSX з ArrayBuffer.
 * Повертає [{name, rows: [[value, ...], ...]}], де value — рядок, число або Date.
 */
async function readWorkbook(arrayBuffer) {
  const zip = await unzip(arrayBuffer);

  const wbXml = await textOf(zip, 'xl/workbook.xml');
  if (wbXml === null) {
    throw new XlsxError('У файлі немає книги Excel (xl/workbook.xml)');
  }
  const wbDoc = parseXml(wbXml);

  const relsXml = await textOf(zip, 'xl/_rels/workbook.xml.rels');
  const rels = readRels(relsXml ? parseXml(relsXml) : null);

  const sstXml = await textOf(zip, 'xl/sharedStrings.xml');
  const shared = readSharedStrings(sstXml ? parseXml(sstXml) : null);

  const stylesXml = await textOf(zip, 'xl/styles.xml');
  const styles = readStyleDates(stylesXml ? parseXml(stylesXml) : null);

  const names = readWorkbookSheets(wbDoc);
  const sheets = [];
  for (let i = 0; i < names.length; i++) {
    const sheet = names[i];
    const candidates = [];
    let target = rels.get(sheet.rid) || '';
    if (target) {
      target = target.replace(/^\.?\//, '');
      if (!target.startsWith('xl/')) target = 'xl/' + target;
      candidates.push(target);
    }
    /* Резерв: типові місця аркушів, якщо звʼязки не прочитались. */
    candidates.push(`xl/worksheets/sheet${i + 1}.xml`);
    candidates.push(`xl/worksheets/sheet${sheet.name.replace(/[^\w]/g, '')}.xml`);

    let xml = null;
    for (const path of candidates) {
      xml = await textOf(zip, path);
      if (xml !== null) break;
    }
    if (xml === null) continue;
    sheets.push({ name: sheet.name, rows: readSheet(parseXml(xml), shared, styles) });
  }

  if (!sheets.length) {
    throw new XlsxError('У файлі немає жодного аркуша з даними');
  }
  const entryNames = Array.from(zip.entries.keys());
  return {
    sheets,
    names: readDefinedNames(wbDoc),
    meta: {
      macros: entryNames.some((n) => /vbaProject\.bin$/i.test(n)),
      hasComments: entryNames.some((n) => n.startsWith('xl/comments')),
      sheetNames: sheets.map((s) => s.name),
    },
  };
}

/* Значення клітинки за адресою з іменованої клітинки. */
function cellValue(workbook, sheetName, row, col) {
  const wanted = String(sheetName).trim().toLowerCase();
  const sheet = workbook.sheets.find(
    (s) => s.name.trim().toLowerCase() === wanted);
  if (!sheet) return null;
  const data = sheet.rows[row];
  if (!data) return null;
  const value = data[col];
  return value === undefined ? null : value;
}

function namedValue(workbook, name) {
  const ref = workbook.names.get(name);
  if (!ref) return null;
  return cellValue(workbook, ref.sheet, ref.row, ref.col);
}

function readSheet(doc, shared, styles) {
  const rows = [];
  for (const row of tags(doc, 'row')) {
    const r = Number(attr(row, 'r') || rows.length + 1) - 1;
    while (rows.length < r) rows.push([]);
    const cells = [];
    for (const c of tags(row, 'c')) {
      const ref = attr(c, 'r');
      const idx = ref ? colToIndex(ref) : cells.length;
      while (cells.length < idx) cells.push(null);
      cells[idx] = readCell(c, shared, styles);
    }
    rows[r] = cells;
  }
  return rows;
}

function readCell(node, shared, styles) {
  const type = attr(node, 't');
  const styleIndex = Number(attr(node, 's') || 0);
  const vNode = tags(node, 'v')[0];
  const raw = vNode ? nodeText(vNode) : null;

  if (type === 'inlineStr') {
    return tags(node, 't').map((t) => nodeText(t)).join('');
  }
  if (type === 's') {
    if (raw === null) return null;
    return shared[Number(raw)] ?? null;
  }
  if (type === 'str') return raw;
  if (type === 'b') return raw === '1';
  if (type === 'e') return null;
  if (raw === null || raw === '') return null;

  const num = Number(raw);
  if (!Number.isFinite(num)) return raw;
  if (styles.isDateStyle(styleIndex) && num > 0) {
    const date = serialToDate(num);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return num;
}