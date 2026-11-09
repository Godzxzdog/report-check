'use strict';

/* app.js — екран перевірки. Дані не зберігаються:
   завантажив файл → перевірив → скачав оновлений файл. */

const state = {
  template: null,
  busy: false,
  /** файл-база, який користувач завантажив (у пам'яті лише на час сесії) */
  base: null,       // { workbook, summary, fileName, sheets }
  pending: [],      // файли, що чекають підтвердження перезапису
  certMonth: '',
};

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function toast(message, kind) {
  const box = $('toast');
  box.textContent = message;
  box.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { box.className = 'toast'; }, 6000);
}

function fmtDay(iso) {
  if (!iso) return '—';
  const [y, m, d] = String(iso).split('-');
  return `${d}.${m}.${y}`;
}

function sha256Hex(buffer) {
  return crypto.subtle.digest('SHA-256', buffer).then((digest) =>
    Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join(''));
}

/* ---------- шаблон ---------- */

async function loadTemplate() {
  const res = await fetch('rules/template.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('Не вдалося завантажити опис шаблону');
  state.template = await res.json();
  $('template-line').textContent =
    `Шаблон v${state.template.version} · ТЗ v${state.template.rules_version}`;
}

/* ---------- обробка файлу ---------- */

/* Читає файл, перевіряє, повертає об'єкт для подальшого запису. */
async function checkFile(file, base) {
  const buffer = await file.arrayBuffer();
  const sha = await sha256Hex(buffer);
  const workbook = await readWorkbook(buffer);
  const result = await evaluate(workbook, state.template, {
    filename: file.name,
    registry: [],
    today: new Date(),
  });

  if (!result.header.dayIso) {
    return { file, ok: false, message: 'Не вдалося визначити добу зі шапки файлу' };
  }

  const unit = result.header.sender || 'Без ПУ';
  const prev = findSummaryRow(base && base.summary, unit, result.header.dayIso);

  return {
    file, ok: true, sha, workbook, result, unit,
    dayIso: result.header.dayIso,
    prev,
    sameFile: Boolean(prev && prev.sha256 && prev.sha256 === sha),
  };
}

/* ---------- запис у базу ---------- */

/* Додає/замінює рядок «Зведення» і повертає аркуші для нового файлу. */
function mergeIntoBase(base, entry) {
  const prev = entry.prev;
  const version = prev ? (prev.version || 1) + 1 : 1;
  const number = prev && prev.number ? prev.number : makeNumber(base, entry);

  const row = summaryRowOf(entry.unit, entry.result, {
    number,
    version,
    filename: entry.file.name,
    sha256: entry.sha,
    size: entry.file.size,
    uploadedAt: dbStamp(),
    replacedAt: prev ? dbStamp() : '',
    status: 'Прийнято',
    note: prev ? `замінено файл (v${prev.version})` : '',
  });

  const asArray = SUMMARY_HEADER.map((h) => row[h] === undefined ? '' : row[h]);

  const rows = base.summary && base.summary.rows ? base.summary.rows.slice() : [];
  const index = rows.findIndex((r) => r.unit === entry.unit && r.dayIso === entry.dayIso);
  if (index >= 0) {
    rows[index] = Object.assign({}, prev, {
      unit: entry.unit,
      dayIso: entry.dayIso,
      day: entry.result.header.day || entry.dayIso,
      number,
      version,
      persons: (entry.result.records || []).length,
      verdict: row['Вердикт'],
      filename: entry.file.name,
      sha256: entry.sha,
      size: entry.file.size,
      uploadedAt: row['Завантажено'],
      replacedAt: row['Замінено'],
      status: 'Прийнято',
      note: row['Примітка'],
    });
  } else {
    rows.push({
      unit: entry.unit, dayIso: entry.dayIso,
      day: entry.result.header.day || entry.dayIso,
      number, version,
      persons: (entry.result.records || []).length,
      verdict: row['Вердикт'],
      vch: row['В/ч'], groups: row['Групи'], positions: row['Посад'],
      filename: entry.file.name, sha256: entry.sha, size: entry.file.size,
      uploadedAt: row['Завантажено'], replacedAt: '', status: 'Прийнято', note: '',
    });
  }

  return { rows, version, number, asArray };
}

function makeNumber(base, entry) {
  const year = (entry.dayIso || '').slice(0, 4);
  let max = 0;
  for (const row of (base.summary && base.summary.rows) || []) {
    const m = String(row.number || '').match(/^(\d{4})-(\d+)$/);
    if (m && m[1] === year) max = Math.max(max, Number(m[2]));
  }
  return `${year}-${String(max + 1).padStart(4, '0')}`;
}

/* Аркуші для скачування: дані + Результат + Зведення. */
function sheetsFor(base, merged) {
  const sheets = [];

  /* 1. Усі аркуші вихідної книги, крім наших службових. */
  const source = (base && base.workbook && base.workbook.sheets) || [];
  for (const sheet of source) {
    if (sheet.name === SUMMARY_SHEET || sheet.name === RESULT_SHEET) continue;
    sheets.push({
      name: sheet.name,
      rows: sheet.rows || [],
      widths: [],
      headerRow: null,
    });
  }

  /* Якщо бази не було — беремо аркуші поточного файлу. */
  if (!sheets.length) {
    for (const sheet of merged.workbook.sheets || []) {
      if (sheet.name === SUMMARY_SHEET || sheet.name === RESULT_SHEET) continue;
      sheets.push({ name: sheet.name, rows: sheet.rows || [], widths: [], headerRow: null });
    }
  }

  /* 2. Аркуш «Результат». */
  sheets.push({
    name: RESULT_SHEET,
    rows: resultSheetRows(merged.result),
    widths: [18, 10, 22, 60, 60],
    headerRow: 1,
  });

  /* 3. Аркуш «Зведення» — база. */
  const summaryRows = [SUMMARY_HEADER.slice()];
  const sorted = merged.rows.slice().sort((a, b) =>
    (a.unit || '').localeCompare(b.unit || '', 'uk')
    || String(a.dayIso).localeCompare(String(b.dayIso)));
  for (const row of sorted) {
    summaryRows.push([
      row.unit, row.day || fmtDay(row.dayIso), row.number, row.version,
      row.persons, row.verdict, row.vch, row.groups, row.positions, row.vch,
      row.filename, row.sha256, row.size, row.uploadedAt, row.replacedAt,
      row.status, row.note,
    ]);
  }
  sheets.push({
    name: SUMMARY_SHEET,
    rows: summaryRows,
    widths: [26, 12, 12, 8, 8, 22, 8, 8, 8, 8, 34, 66, 10, 18, 18, 12, 26],
    headerRow: 1,
  });

  return sheets;
}

/* ---------- результат на екрані ---------- */

function renderResults(items) {
  const box = $('results');
  box.innerHTML = '';

  for (const item of items) {
    const card = el('div', 'result-card');

    const head = el('div', 'result-head');
    const name = el('div', 'result-name', item.file ? item.file.name : '');
    head.appendChild(name);

    if (item.ok) {
      const badge = el('span', 'verdict verdict-' + item.result.verdict,
        VERDICT_LABEL[item.result.verdict] || item.result.verdict);
      head.appendChild(badge);
    }
    card.appendChild(head);

    if (!item.ok) {
      card.appendChild(el('div', 'result-error', item.message || 'Не вдалося прочитати файл'));
      box.appendChild(card);
      continue;
    }

    const counts = item.result.counts || {};
    const meta = el('div', 'result-meta');
    meta.appendChild(el('span', '', `ПУ: ${item.unit}`));
    meta.appendChild(el('span', '', `Доба: ${item.result.header.day || fmtDay(item.dayIso)}`));
    meta.appendChild(el('span', '', `Осіб: ${(item.result.records || []).length}`));
    meta.appendChild(el('span', '',
      `Знайдено: ${counts.critical || 0} критичних · ${counts.error || 0} помилок · ${counts.warning || 0} попереджень`));
    card.appendChild(meta);

    if (item.prev) {
      const warn = el('div', 'result-warn');
      warn.appendChild(el('strong', '', 'Запис за цю добу вже є. '));
      warn.appendChild(el('span', '',
        `Версія v${item.prev.version}, прийнято ${item.prev.uploadedAt || '—'}. `
        + 'При підтвердженні рядок буде замінено, версія стане v'
        + (item.prev.version + 1) + '.'));
      card.appendChild(warn);
    }

    const findings = item.result.findings || [];
    if (findings.length) {
      const table = el('table', 'findings');
      const thead = el('thead');
      const hr = el('tr');
      for (const title of ['', 'Код', 'Клітинка', 'Що не так', 'Що робити']) {
        hr.appendChild(el('th', '', title));
      }
      thead.appendChild(hr);
      table.appendChild(thead);
      const tbody = el('tbody');
      for (const f of findings.slice(0, 40)) {
        const tr = el('tr', 'sev-' + f.severity);
        tr.appendChild(el('td', 'sev', SEVERITY_LABEL[f.severity] || f.severity));
        tr.appendChild(el('td', 'code', f.code || ''));
        tr.appendChild(el('td', 'cell', f.cell || ''));
        tr.appendChild(el('td', '', f.problem || ''));
        tr.appendChild(el('td', 'hint', f.recommendation || ''));
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      card.appendChild(table);
      if (findings.length > 40) {
        card.appendChild(el('div', 'hint', `…і ще ${findings.length - 40} зауважень — усі в аркуші «Результат»`));
      }
    } else {
      card.appendChild(el('div', 'result-ok', 'Зауважень немає'));
    }

    box.appendChild(card);
  }
}

/* ---------- головний потік ---------- */

async function handleFiles(fileList) {
  if (state.busy) return;
  const files = Array.from(fileList).filter((f) => f.name.toLowerCase().endsWith('.xlsx'));
  if (!files.length) {
    toast('Потрібен файл XLSX', 'error');
    return;
  }
  const skipped = Array.from(fileList).filter((f) => !f.name.toLowerCase().endsWith('.xlsx'));
  if (skipped.length) {
    toast(`Пропущено не-XLSX: ${skipped.map((f) => f.name).join(', ')}`, 'error');
  }

  state.busy = true;
  $('dropzone').classList.add('busy');
  try {
    const items = [];
    for (const file of files) {
      try {
        items.push(await checkFile(file, state.base));
      } catch (err) {
        items.push({ file, ok: false, message: err.message });
      }
    }
    renderResults(items);
    state.pending = items.filter((i) => i.ok);

    if (!state.pending.length) {
      toast('Жоден файл не пройшов — нічого не змінено', 'error');
      return;
    }

    const needConfirm = state.pending.filter((i) => i.prev);
    const action = el('div', 'action-row');
    const btn = el('button', 'btn btn-primary',
      needConfirm.length
        ? `Підтвердити й скачати файл (${state.pending.length})`
        : `Скачати оновлений файл (${state.pending.length})`);
    btn.id = 'btn-save';
    btn.addEventListener('click', () => saveBase(needConfirm.length > 0));
    action.appendChild(btn);
    $('results').appendChild(action);
  } finally {
    state.busy = false;
    $('dropzone').classList.remove('busy');
  }
}

/* Записує всі перевірені файли в базу і віддає один XLSX. */
async function saveBase(confirmed) {
  if (!state.pending.length) return;

  const problems = state.pending.filter((i) => i.prev);
  if (problems.length && !confirmed) {
    toast('Потрібне підтвердження перезапису', 'error');
    return;
  }

  const btn = $('btn-save');
  if (btn) { btn.disabled = true; btn.textContent = 'Формую файл…'; }

  try {
    let base = state.base || {
      workbook: state.pending[0].workbook,
      summary: { present: false, rows: [], headerOk: true, problems: [] },
      fileName: 'база.xlsx',
    };

    const rows = base.summary.rows.slice();
    let lastResult = null;

    for (const entry of state.pending) {
      const merged = mergeIntoBase(
        { summary: { rows } },
        entry,
      );
      /* замінюємо рядки накопичувально */
      rows.length = 0;
      Array.from(merged.rows).forEach((r) => rows.push(r));
      lastResult = { entry, merged };

      const sheets = sheetsFor(base, {
        workbook: entry.workbook,
        result: entry.result,
        rows,
      });
      const blob = buildWorkbook(sheets);
      const fileName = dbFileName(entry.unit, entry.dayIso, '_перевірено');
      saveBlob(blob, fileName);

      /* База для наступного файлу цієї ж сесії — уже з оновленим зведенням. */
      base = {
        workbook: base.workbook,
        summary: { present: true, rows: rows.slice(), headerOk: true, problems: [] },
        fileName,
      };
      await new Promise((r) => setTimeout(r, 400));
    }

    state.base = base;
    toast(`Файл збережено: ${state.pending.length} подання`, 'ok');
    state.pending = [];
    if (btn) btn.remove();
    updateCertUnits();
  } catch (err) {
    toast('Не вдалося сформувати файл: ' + err.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Підтвердити й скачати файл'; }
  }
}

/* ---------- довідки ---------- */

function updateCertUnits() {
  const select = $('cert-unit');
  if (!select) return;
  if (!state.base) return;
  const units = Array.from(new Set(
    (state.base.summary.rows || []).map((r) => r.unit))).sort((a, b) => a.localeCompare(b, 'uk'));
  const current = select.value;
  select.innerHTML = '';
  const all = el('option', '', 'усі');
  all.value = '';
  select.appendChild(all);
  for (const unit of units) {
    const opt = el('option', '', unit);
    opt.value = unit;
    select.appendChild(opt);
  }
  if (current && units.includes(current)) select.value = current;
}

async function loadCertBase(file) {
  try {
    const buffer = await file.arrayBuffer();
    const workbook = await readWorkbook(buffer);
    const summary = readSummary(workbook);
    state.base = { workbook, summary, fileName: file.name };

    if (!summary.present) {
      $('cert-status').textContent = 'У файлі немає аркуша «Зведення» — '
        + 'спершу перевірте розрахунок і скачайте оновлений файл.';
      $('cert-results').innerHTML = '';
      updateCertUnits();
      return;
    }
    if (!summary.headerOk) {
      $('cert-status').textContent = (summary.problems || []).join('. ');
      $('cert-results').innerHTML = '';
      updateCertUnits();
      return;
    }

    $('cert-status').textContent = `У «Зведенні» ${summary.rows.length} записів.`;
    updateCertUnits();
    if (!state.certMonth) {
      const last = summary.rows.reduce((acc, r) => (r.dayIso > acc ? r.dayIso : acc), '');
      state.certMonth = last ? last.slice(0, 7) : '';
      if (state.certMonth) $('cert-month').value = state.certMonth;
    }
  } catch (err) {
    $('cert-status').textContent = 'Не вдалося прочитати файл: ' + err.message;
  }
}

function buildCerts() {
  if (!state.base || !state.base.summary || !state.base.summary.headerOk) {
    toast('Спершу завантажте файл із аркушем «Зведення»', 'error');
    return;
  }
  const month = $('cert-month').value;
  if (!month) {
    toast('Оберіть місяць', 'error');
    return;
  }
  state.certMonth = month;
  const unit = $('cert-unit').value;

  const { certs, issues } = buildMonthlyCerts(state.base.summary, null, month, unit);
  if (!certs.length) {
    $('cert-issues').innerHTML = '';
    $('cert-results').innerHTML = '';
    $('cert-status').textContent = `За ${monthTitleUk(month)} у «Зведенні» немає записів`
      + (unit ? ` для ПУ «${unit}»` : '') + '.';
    return;
  }

  renderCertIssues(issues, month, certs);

  const sheets = certSheets(certs, month, issues);
  const blob = buildWorkbook(sheets);
  const suffix = unit ? `_${unit.replace(/[\\/:*?"<>|]/g, '-')}` : '';
  saveBlob(blob, `Довідки_${month}${suffix}.xlsx`);
  toast('Довідку сформовано й скачано', 'ok');
}

function renderCertIssues(issues, month, certs) {
  const box = $('cert-issues');
  box.innerHTML = '';

  const parts = [];
  if (issues.missing.length) {
    parts.push(`<strong>${issues.missing.length}</strong> діб без подання`);
  }
  if (issues.lowVerdict.length) {
    parts.push(`<strong>${issues.lowVerdict.length}</strong> подань із помилками`);
  }
  if (issues.emptyRows.length) {
    parts.push(`<strong>${issues.emptyRows.length}</strong> порожніх подань`);
  }
  if (issues.conflicts.length) {
    parts.push(`<strong>${issues.conflicts.length}</strong> конфліктів чергування`);
  }

  const summary = el('div', '');
  summary.innerHTML = parts.length
    ? `За ${monthTitleUk(month)}: ${parts.join(', ')}.`
    : `За ${monthTitleUk(month)} зауважень немає.`;
  box.appendChild(summary);

  if (issues.missing.length) {
    const first = issues.missing.slice(0, 12).map((m) => `${m.unit} · ${fmtDay(m.day)}`);
    box.appendChild(el('div', 'hint',
      'Доби без подання: ' + first.join('; ')
      + (issues.missing.length > 12 ? ` …і ще ${issues.missing.length - 12}` : '')
      + '. Повний перелік — аркуш «Пропущені доби» у довідці.'));
  }

  const list = el('div', 'result-meta');
  for (const cert of certs) {
    list.appendChild(el('span', '',
      `${cert.unit}: діб ${cert.presentCount}, осіб ${cert.persons}`));
  }
  $('cert-results').innerHTML = '';
  $('cert-results').appendChild(list);
}

/* ---------- прив'язка подій ---------- */

function bind() {
  const drop = $('dropzone');
  const input = $('file-input');
  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files && input.files.length) handleFiles(input.files);
    input.value = '';
  });
  ['dragenter', 'dragover'].forEach((evt) => {
    drop.addEventListener(evt, (e) => { e.preventDefault(); drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    drop.addEventListener(evt, (e) => { e.preventDefault(); drop.classList.remove('over'); });
  });
  drop.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
  });

  $('cert-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) await loadCertBase(file);
    e.target.value = '';
  });
  $('cert-build').addEventListener('click', buildCerts);
}

document.addEventListener('DOMContentLoaded', async () => {
  bind();
  try {
    await loadTemplate();
  } catch (err) {
    toast(err.message, 'error');
  }
});