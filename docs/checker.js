/* checker.js — рушій перевірки, дзеркало checker.py.
   Уся логіка правил тут; шаблон читається з rules/template.json. */

const SEVERITY_ORDER = { critical: 0, error: 1, warning: 2 };
const DATE_RE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;
const TRAILING_SPACE_RE = /^\s|\s$|  +/;

function finding(severity, sheet, row, column, problem, recommendation, ruleId) {
  return { severity, sheet, row, column, problem, recommendation, rule: ruleId };
}

function isBlank(value) {
  return value === null || value === undefined
    || (typeof value === 'string' && value.trim() === '');
}

function parseDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'string') {
    const m = DATE_RE.exec(value.trim());
    if (!m) return null;
    const [, d, mo, y] = m.map(Number);
    const date = new Date(Date.UTC(y, mo - 1, d));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1
      || date.getUTCDate() !== d) return null;
    return date;
  }
  return null;
}

function toNumber(value) {
  if (typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return null;
  if (typeof value === 'string') {
    const text = value.trim().replace(',', '.');
    if (text === '') return null;
    const num = Number(text);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

function fmtNum(n) {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4)));
}

function headerMap(sheetCfg, rows) {
  const headerRow = Number(sheetCfg.header_row || 1) - 1;
  const header = rows[headerRow] || [];
  const normalized = new Map();
  header.forEach((cell, idx) => {
    if (typeof cell !== 'string') return;
    const key = cell.trim().toLowerCase();
    if (!normalized.has(key)) normalized.set(key, idx);
  });
  const positions = new Map();
  (sheetCfg.columns || []).forEach((col, pos) => {
    const title = String(col.name || '').trim().toLowerCase();
    if (normalized.has(title)) positions.set(pos, normalized.get(title));
  });
  return positions;
}

function checkStructure(workbook, template) {
  const found = [];
  const byName = new Map();
  for (const sheet of workbook) byName.set(sheet.name.trim().toLowerCase(), sheet);
  const data = new Map();

  for (const sheetCfg of template.sheets || []) {
    const name = sheetCfg.name;
    const key = name.trim().toLowerCase();
    if (sheetCfg.required !== false && !byName.has(key)) {
      found.push(finding('critical', name, null, null,
        `Відсутній обов'язковий аркуш «${name}»`,
        'Надайте файл за затвердженим шаблоном; аркуш не має бути '
        + 'перейменований або видалений', 'sheet_missing'));
      continue;
    }
    const sheet = byName.get(key);
    if (!sheet) continue;

    const rows = sheet.rows;
    const headerRow = Number(sheetCfg.header_row || 1);
    if (rows.length < headerRow) {
      found.push(finding('critical', name, headerRow, null,
        'Немає рядка заголовків',
        'Відновіть шапку таблиці згідно з шаблоном', 'header_row_missing'));
      continue;
    }

    const header = rows[headerRow - 1] || [];
    const present = new Set(header.filter((c) => typeof c === 'string')
      .map((c) => c.trim().toLowerCase()));
    for (const col of sheetCfg.columns || []) {
      if (!col.required) continue;
      const title = String(col.name).trim();
      if (!present.has(title.toLowerCase())) {
        found.push(finding('critical', name, headerRow, null,
          `Відсутній обов'язковий стовпець «${title}»`,
          'Відновіть назву стовпця точно як у шаблоні', 'column_missing'));
      }
    }

    if (!found.some((f) => f.sheet === name)) {
      data.set(name, {
        rows,
        positions: headerMap(sheetCfg, rows),
        start: Number(sheetCfg.data_start_row || headerRow + 1) - 1,
      });
    }
  }
  return { found, data };
}

function checkCells(sheetName, sheetCfg, rows, positions) {
  const found = [];
  const columns = sheetCfg.columns || [];
  const start = Number(sheetCfg.data_start_row || 2) - 1;

  for (let rowNo = start; rowNo < rows.length; rowNo++) {
    const row = rows[rowNo] || [];
    const excelRow = rowNo + 1;

    columns.forEach((col, pos) => {
      if (!positions.has(pos)) return;
      const idx = positions.get(pos);
      const value = idx < row.length ? row[idx] : null;
      const letter = indexToCol(idx);
      const title = col.name;
      const where = `${letter}${excelRow}`;

      if (isBlank(value)) {
        if (col.required) {
          found.push(finding('error', sheetName, excelRow, title,
            `Порожнє обов'язкове поле «${title}» (${where})`,
            'Заповніть поле', 'required_empty'));
        }
        return;
      }

      const ctype = col.type || 'text';

      if (ctype === 'number') {
        const num = toNumber(value);
        if (num === null) {
          found.push(finding('error', sheetName, excelRow, title,
            `«${title}» (${where}) має бути числом, а містить «${value}»`,
            'Введіть числове значення без літер і пробілів',
            'number_format'));
          return;
        }
        if (col.min !== undefined && num < col.min) {
          found.push(finding('error', sheetName, excelRow, title,
            `«${title}» (${where}) = ${fmtNum(num)}, менше за мінімум ${fmtNum(col.min)}`,
            `Значення не може бути меншим за ${fmtNum(col.min)}`, 'number_min'));
        }
        if (col.max !== undefined && num > col.max) {
          found.push(finding('error', sheetName, excelRow, title,
            `«${title}» (${where}) = ${fmtNum(num)}, більше за максимум ${fmtNum(col.max)}`,
            `Значення не може бути більшим за ${fmtNum(col.max)}`, 'number_max'));
        }
      } else if (ctype === 'date') {
        if (parseDate(value) === null) {
          found.push(finding('error', sheetName, excelRow, title,
            `«${title}» (${where}) не є датою у форматі ДД.ММ.РРРР: «${value}»`,
            'Введіть дату як 05.11.2026', 'date_format'));
        }
      } else if (ctype === 'text') {
        const text = String(value);
        if (col.max_length && text.length > col.max_length) {
          found.push(finding('error', sheetName, excelRow, title,
            `«${title}» (${where}) довше за ${col.max_length} символів`,
            'Скоротіть текст', 'text_too_long'));
        }
        if (TRAILING_SPACE_RE.test(text)) {
          found.push(finding('warning', sheetName, excelRow, title,
            `«${title}» (${where}) містить зайві пробіли`,
            'Приберіть пробіли на початку, в кінці та подвійні всередині',
            'text_spaces'));
        }
      }
    });
  }
  return found;
}

function checkRows(sheetName, sheetCfg, rows, positions) {
  const found = [];
  const start = Number(sheetCfg.data_start_row || 2) - 1;
  const columns = sheetCfg.columns || [];
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const keyPos = new Map(columns.map((c, pos) => [c.key, pos]));

  for (const check of sheetCfg.row_checks || []) {
    const when = check.when || {};
    const assert = check.assert || {};
    const whenKey = when.column;
    const targetKey = assert.column;
    if (!keyPos.has(whenKey) || !keyPos.has(targetKey)) continue;
    const wPos = keyPos.get(whenKey);
    const tPos = keyPos.get(targetKey);
    if (!positions.has(wPos) || !positions.has(tPos)) continue;
    const wIdx = positions.get(wPos);
    const tIdx = positions.get(tPos);
    const tTitle = byKey.get(targetKey).name;
    const tLetter = indexToCol(tIdx);

    for (let rowNo = start; rowNo < rows.length; rowNo++) {
      const row = rows[rowNo] || [];
      const wVal = wIdx < row.length ? row[wIdx] : null;
      if (when.is === 'filled' && isBlank(wVal)) continue;
      const tVal = tIdx < row.length ? row[tIdx] : null;
      if (isBlank(tVal)) continue;

      let left;
      let right;
      if (assert.column_ref !== undefined) {
        const refPos = keyPos.get(assert.column_ref);
        if (refPos === undefined || !positions.has(refPos)) continue;
        const rIdx = positions.get(refPos);
        const rVal = rIdx < row.length ? row[rIdx] : null;
        left = toNumber(tVal);
        right = toNumber(rVal);
      } else {
        left = toNumber(tVal);
        right = toNumber(assert.value);
      }
      if (left === null || right === null) continue;

      const tol = Number(assert.tolerance !== undefined ? assert.tolerance : 0.001);
      const ops = {
        '<=': left <= right, '<': left < right,
        '>=': left >= right, '>': left > right,
        '==': left === right, '!=': left !== right,
        '~=': Math.abs(left - right) <= tol,
      };
      if (ops[assert.op] === undefined || ops[assert.op]) continue;

      const excelRow = rowNo + 1;
      found.push(finding('error', sheetName, excelRow, tTitle,
        `${check.description || 'Порушення правила'} (${tLetter}${excelRow}: `
        + `${fmtNum(left)} ${assert.op} ${fmtNum(right)})`,
        'Виправте значення у рядку', check.id || 'row_check'));
    }
  }
  return found;
}

function checkUniques(sheetName, sheetCfg, rows, positions) {
  const found = [];
  const keys = sheetCfg.unique_by || [];
  if (!keys.length) return found;
  const columns = sheetCfg.columns || [];
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const keyPos = new Map(columns.map((c, pos) => [c.key, pos]));
  if (!keys.every((k) => keyPos.has(k) && positions.has(keyPos.get(k)))) {
    return found;
  }
  const indices = keys.map((k) => positions.get(keyPos.get(k)));
  const start = Number(sheetCfg.data_start_row || 2) - 1;
  const seen = new Map();

  for (let rowNo = start; rowNo < rows.length; rowNo++) {
    const row = rows[rowNo] || [];
    const values = indices.map((i) => (i < row.length ? row[i] : null));
    if (values.every(isBlank)) continue;
    const signature = values
      .map((v) => (typeof v === 'string' ? v.trim().toLowerCase() : String(v)))
      .join('|');
    const excelRow = rowNo + 1;
    if (seen.has(signature)) {
      const titles = keys.map((k) => byKey.get(k).name).join(', ');
      found.push(finding('error', sheetName, excelRow, titles,
        `Дублікат запису (${titles}) — уже є в рядку ${seen.get(signature)}`,
        "Видаліть повтор або об'єднайте записи", 'duplicate_row'));
    } else {
      seen.set(signature, excelRow);
    }
  }
  return found;
}

function checkTotals(sheetName, sheetCfg, rows, positions) {
  const found = [];
  const columns = sheetCfg.columns || [];
  const keyPos = new Map(columns.map((c, pos) => [c.key, pos]));
  const start = Number(sheetCfg.data_start_row || 2) - 1;

  const collect = (spec) => {
    if (!spec) return null;
    if (spec.ratio) {
      const [a, b] = spec.ratio;
      if (!keyPos.has(a) || !keyPos.has(b)) return null;
      if (!positions.has(keyPos.get(a)) || !positions.has(keyPos.get(b))) return null;
      const ia = positions.get(keyPos.get(a));
      const ib = positions.get(keyPos.get(b));
      let totalA = 0;
      let totalB = 0;
      for (const row of rows.slice(start)) {
        const va = toNumber(row && ia < row.length ? row[ia] : null);
        const vb = toNumber(row && ib < row.length ? row[ib] : null);
        if (va === null || !vb) continue;
        totalA += va;
        totalB += vb;
      }
      if (!totalB) return null;
      return (totalA / totalB) * Number(spec.scale || 1);
    }
    const key = spec.column;
    if (!keyPos.has(key) || !positions.has(keyPos.get(key))) return null;
    const idx = positions.get(keyPos.get(key));
    const values = rows.slice(start)
      .map((row) => toNumber(row && idx < row.length ? row[idx] : null))
      .filter((v) => v !== null);
    if (!values.length) return null;
    const agg = spec.agg || 'sum';
    if (agg === 'sum') return values.reduce((a, b) => a + b, 0);
    if (agg === 'avg') return values.reduce((a, b) => a + b, 0) / values.length;
    if (agg === 'min') return Math.min(...values);
    if (agg === 'max') return Math.max(...values);
    if (agg === 'count') return values.length;
    return null;
  };

  for (const rule of sheetCfg.totals || []) {
    const left = collect(rule.left || {});
    const right = collect(rule.right || {});
    if (left === null || right === null) continue;
    const op = rule.op || '==';
    const tol = Number(rule.tolerance !== undefined ? rule.tolerance : 0.001);
    const ops = {
      '<=': left <= right + tol, '<': left < right - tol,
      '>=': left >= right - tol, '>': left > right + tol,
      '==': Math.abs(left - right) <= tol,
      '~=': Math.abs(left - right) <= tol,
    };
    if (ops[op] === undefined || ops[op]) continue;
    found.push(finding('error', sheetName, null, null,
      `${rule.description || 'Порушення контрольного співвідношення'}: `
      + `отримано ${fmtNum(left)}, очікується ${op} ${fmtNum(right)}`,
      'Перевірте підсумкові показники проти деталізованих даних',
      rule.id || 'totals'));
  }
  return found;
}

function evaluate(workbook, template) {
  const structure = checkStructure(workbook, template);
  const found = structure.found.slice();

  for (const sheetCfg of template.sheets || []) {
    const info = structure.data.get(sheetCfg.name);
    if (!info) continue;
    const { rows, positions } = info;
    const name = sheetCfg.name;
    found.push(...checkCells(name, sheetCfg, rows, positions));
    found.push(...checkRows(name, sheetCfg, rows, positions));
    found.push(...checkUniques(name, sheetCfg, rows, positions));
    found.push(...checkTotals(name, sheetCfg, rows, positions));
  }

  const counts = { critical: 0, error: 0, warning: 0 };
  for (const f of found) counts[f.severity] += 1;

  let verdict = 'ok';
  if (counts.critical) verdict = 'critical';
  else if (counts.error) verdict = 'error';
  else if (counts.warning) verdict = 'warning';

  found.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    || String(a.sheet || '').localeCompare(String(b.sheet || ''))
    || (a.row || 0) - (b.row || 0));

  return { verdict, counts, findings: found };
}