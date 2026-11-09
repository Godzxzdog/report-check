/* writer.js — запис XLSX у браузері, без бібліотек.
   Формує новий файл: усі аркуші вихідної книги (дані) + «Результат» + «Зведення».
   Стиль ZIP — без компресії (store): простіше й надійніше, файли невеликі. */

function wXmlEscape(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    /* керівні символи Excel не приймає */
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function wCol(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/* styles.xml: 0 — звичайний, 1 — жирний, 2 — обведений заголовок. */
var W_STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<fonts count="2">'
  + '<font><sz val="11"/><name val="Calibri"/></font>'
  + '<font><b/><sz val="11"/><name val="Calibri"/></font>'
  + '</fonts>'
  + '<fills count="3">'
  + '<fill><patternFill patternType="none"/></fill>'
  + '<fill><patternFill patternType="gray125"/></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill>'
  + '</fills>'
  + '<borders count="1"><border/></borders>'
  + '<cellStyleXfs count="1"><xf fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="3">'
  + '<xf fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
  + '<xf fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1">'
  + '<alignment vertical="center" wrapText="1"/></xf>'
  + '</cellXfs>'
  + '</styleSheet>';

function wCell(value, ref, style, dateStyle) {
  if (value === null || value === undefined || value === '') {
    return style ? `<c r="${ref}" s="${style}"/>` : '';
  }
  const s = style ? ` s="${style}"` : '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    const serial = dateToSerial(value);
    return `<c r="${ref}"${s}><v>${serial}</v></c>`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"${s}><v>${value}</v></c>`;
  }
  if (typeof value === 'boolean') {
    return `<c r="${ref}"${s} t="b"><v>${value ? 1 : 0}</v></c>`;
  }
  const text = wXmlEscape(value);
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
}

/* Date -> серійне число Excel (1900-система). */
function dateToSerial(date) {
  const utc = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const base = Date.UTC(1899, 11, 31);
  let serial = Math.round((utc - base) / 86400000);
  if (serial > 59) serial += 1; /* вигадане 29.02.1900 */
  return serial;
}

function wSheetXml(rows, widths, headerRow) {
  const cols = (widths && widths.length)
    ? '<cols>' + widths.map((w, i) =>
      `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>'
    : '';
  const body = [];
  (rows || []).forEach((row, r) => {
    const cells = (row || []).map((value, c) => {
      const ref = `${wCol(c)}${r + 1}`;
      let style = 0;
      if (headerRow && r === headerRow - 1) style = 2;
      return wCell(value, ref, style);
    }).join('');
    body.push(`<row r="${r + 1}">${cells}</row>`);
  });
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + cols + `<sheetData>${body.join('')}</sheetData></worksheet>`;
}

function wZip(files) {
  const encoder = new TextEncoder();
  const parts = [];
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
    const crc = crc32(Array.from(data));

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
    parts.push(local, data);

    const head = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(head.buffer);
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
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    head.set(nameBytes, 46);
    central.push(head);

    offset += local.length + data.length;
  }

  const centralSize = central.reduce((sum, c) => sum + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  return parts.concat(central, [end]);
}

/* sheets: [{ name, rows, widths, headerRow }] -> Blob (xlsx). */
function buildWorkbook(sheets) {
  const encoder = new TextEncoder();
  const n = sheets.length;

  let ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>';
  for (let i = 1; i <= n; i++) {
    ct += `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
  }
  ct += '</Types>';

  const refs = sheets.map((s, i) =>
    `<sheet name="${wXmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<sheets>${refs}</sheets></workbook>`;

  let rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
  for (let i = 1; i <= n; i++) {
    rels += `<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`;
  }
  rels += `<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;
  rels += '</Relationships>';

  const root = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '</Relationships>';

  const files = [
    { name: '[Content_Types].xml', data: ct },
    { name: '_rels/.rels', data: root },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    { name: 'xl/styles.xml', data: W_STYLES },
  ];
  sheets.forEach((s, i) => {
    files.push({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: wSheetXml(s.rows, s.widths, s.headerRow),
    });
  });

  return new Blob(wZip(files), {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}