'use strict';

/* Робоче місце перевіряючого — клієнтська логіка.
   Працює повністю в браузері: файли читаються локально, нікуди не надсилаються.
   Реєстр зберігається в localStorage цього браузера. */

const state = {
  rows: [],
  statuses: STATUS_LABELS,
  filter: { status: '', q: '', order: 'id', dir: 'desc' },
  current: null,
  files: [],
  template: null,
};

const VERDICT_LABEL = {
  ok: 'Без зауважень',
  warning: 'Попередження',
  error: 'Є помилки',
  critical: 'Непридатний',
};

const SEVERITY_LABEL = {
  critical: 'Критична помилка',
  error: 'Помилка',
  warning: 'Попередження',
};

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toast(message, kind) {
  const box = $('toast');
  box.textContent = message;
  box.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { box.className = 'toast'; }, 4800);
}

function fmtDate(text) {
  if (!text) return '—';
  const parts = String(text).split(' ');
  if (!parts[0]) return '—';
  const [y, m, d] = parts[0].split('-');
  if (!y || !m || !d) return String(text);
  return `${d}.${m}.${y}` + (parts[1] ? ' ' + parts[1].slice(0, 5) : '');
}

/* ---------- головна панель ---------- */

function loadDashboard() {
  const data = dashboardOf(loadState());

  document.querySelectorAll('.stat').forEach((card) => {
    const key = card.dataset.key;
    card.querySelector('.stat-value').textContent = data[key] ?? 0;
  });

  const tpl = state.template || {};
  $('template-line').textContent =
    `Шаблон v${tpl.version || '—'} · ${data.units} підрозділів`;

  const filter = $('filter-status');
  if (filter.options.length <= 1) {
    for (const [key, label] of Object.entries(STATE_LABELS_SAFE())) {
      const opt = el('option', '', label);
      opt.value = key;
      filter.appendChild(opt);
    }
  }

  const list = $('timeline');
  list.innerHTML = '';
  if (!data.recent.length) {
    list.appendChild(el('li', 'empty', 'Поки що немає операцій'));
  }
  for (const ev of data.recent) {
    const item = el('li');
    item.appendChild(el('span', 'tl-time', fmtDate(ev.at)));
    const body = el('span', 'tl-body');
    body.appendChild(el('strong', '', `№ ${ev.number}`));
    body.appendChild(document.createTextNode(` · ${ev.unit} → `));
    body.appendChild(el('span', 'tl-status', ev.statusLabel));
    if (ev.note) body.appendChild(el('span', 'tl-note', ' — ' + ev.note));
    item.appendChild(body);
    list.appendChild(item);
  }
}

function STATE_LABELS_SAFE() {
  return typeof STATUS_LABELS !== 'undefined' ? STATUS_LABELS : state.statuses;
}

/* ---------- реєстр ---------- */

function loadRegister() {
  const store = loadState();
  let rows = store.submissions.map((s) => ({
    ...s,
    statusLabel: STATUS_LABELS[s.status] || s.status,
    summary: summaryOf(s),
  }));

  if (state.filter.status) {
    rows = rows.filter((r) => r.status === state.filter.status);
  }
  const q = state.filter.q.toLowerCase();
  if (q) {
    rows = rows.filter((r) => [r.unit, r.filename, r.number]
      .join(' ').toLowerCase().includes(q));
  }

  const order = state.filter.order;
  const dir = state.filter.dir === 'asc' ? 1 : -1;
  const val = (row) => {
    if (order === 'errors') return (row.counts && row.counts.error) || 0;
    if (order === 'warnings') return (row.counts && row.counts.warning) || 0;
    return row[order] ?? '';
  };
  rows.sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va).localeCompare(String(vb), 'uk') * dir;
  });

  state.rows = rows;
  const body = $('register-body');
  body.innerHTML = '';

  if (!rows.length) {
    const tr = el('tr');
    const td = el('td', 'empty', store.submissions.length
      ? 'Немає подань за цим фільтром'
      : 'Ще немає подань — натисніть «Завантажити файли»');
    td.colSpan = 8;
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }

  for (const row of rows) {
    const tr = el('tr');
    tr.className = 'row';

    const num = el('td', 'mono', row.number);
    if (row.duplicateOf) {
      const badge = el('span', 'badge badge-dup', 'дубль');
      badge.title = `Повторне завантаження файлу подання №${row.duplicateOf}`;
      num.appendChild(badge);
    }
    tr.appendChild(num);
    tr.appendChild(el('td', '', row.unit));
    tr.appendChild(el('td', 'filename', row.filename));
    tr.appendChild(el('td', 'nowrap', fmtDate(row.receivedAt)));
    tr.appendChild(el('td', 'nowrap', fmtDate(row.uploadedAt)));

    const sum = el('td', 'summary');
    if (row.verdict) sum.appendChild(el('span', 'dot dot-' + row.verdict));
    sum.appendChild(document.createTextNode(row.summary || 'не перевірено'));
    tr.appendChild(sum);

    const st = el('td');
    st.appendChild(el('span', 'status status-' + row.status, row.statusLabel));
    tr.appendChild(st);

    const act = el('td', 'actions');
    const open = el('button', 'btn btn-ghost btn-xs', 'Відкрити');
    open.addEventListener('click', (e) => { e.stopPropagation(); openDrawer(row.id); });
    act.appendChild(open);
    tr.appendChild(act);

    tr.addEventListener('click', () => openDrawer(row.id));
    body.appendChild(tr);
  }
}

function summaryOf(sub) {
  const c = sub.counts || {};
  const hints = [];
  if (c.critical) hints.push(`критичних: ${c.critical}`);
  if (c.error) hints.push(`помилок: ${c.error}`);
  if (c.warning) hints.push(`попереджень: ${c.warning}`);
  if (hints.length) return hints.join('; ');
  return sub.verdict === 'ok' ? 'без зауважень' : '';
}

/* ---------- деталі подання ---------- */

function openDrawer(id) {
  const store = loadState();
  const item = store.submissions.find((s) => s.id === id);
  if (!item) { toast('Подання не знайдено', 'error'); return; }
  state.current = item;

  $('drawer-title').textContent = `Подання № ${item.number}`;
  $('drawer-sub').textContent = `${item.unit} · ${item.filename} · ${fmtDate(item.uploadedAt)}`;

  const body = $('drawer-body');
  body.innerHTML = '';

  const st = el('div', 'drawer-status');
  st.appendChild(el('span', 'status status-' + item.status,
    STATUS_LABELS[item.status] || item.status));
  if (item.duplicateOf) {
    const dup = store.submissions.find((s) => s.id === item.duplicateOf);
    st.appendChild(el('span', 'note-warn',
      `Повторне завантаження подання №${dup ? dup.number : item.duplicateOf}`));
  }
  body.appendChild(st);

  const meta = el('dl', 'meta');
  const pairs = [
    ['Номер', item.number],
    ['Підрозділ', item.unit],
    ['Файл', item.filename],
    ['Розмір', (item.sizeBytes / 1024).toFixed(1) + ' КБ'],
    ['Отримано від підрозділу', fmtDate(item.receivedAt)],
    ['Завантажено до системи', fmtDate(item.uploadedAt)],
    ['Контрольна сума', item.sha256.slice(0, 16) + '…'],
  ];
  for (const [label, value] of pairs) {
    meta.appendChild(el('dt', '', label));
    meta.appendChild(el('dd', '', String(value)));
  }
  body.appendChild(meta);

  if (item.verdict) {
    const head = el('div', 'check-head');
    head.appendChild(el('span', 'verdict verdict-' + item.verdict,
      VERDICT_LABEL[item.verdict] || item.verdict));
    head.appendChild(el('span', 'check-meta',
      `перевірка ${fmtDate(item.checkedAt)} · шаблон v${item.templateVersion || '—'}`));
    body.appendChild(head);

    const counts = el('div', 'counts');
    for (const sev of ['critical', 'error', 'warning']) {
      const box = el('div', 'count count-' + sev);
      box.appendChild(el('span', 'count-num', String((item.counts || {})[sev] || 0)));
      box.appendChild(el('span', 'count-label', SEVERITY_LABEL[sev]));
      counts.appendChild(box);
    }
    body.appendChild(counts);

    if (item.findings && item.findings.length) {
      const table = el('table', 'findings');
      const thead = el('thead');
      const hr = el('tr');
      for (const h of ['Рівень', 'Аркуш', 'Рядок', 'Стовпець', 'Проблема', 'Рекомендація']) {
        hr.appendChild(el('th', '', h));
      }
      thead.appendChild(hr);
      table.appendChild(thead);
      const tbody = el('tbody');
      for (const f of item.findings) {
        const tr = el('tr');
        tr.appendChild(el('td', 'sev sev-' + f.severity,
          SEVERITY_LABEL[f.severity] || f.severity));
        tr.appendChild(el('td', '', f.sheet || '—'));
        tr.appendChild(el('td', 'mono', f.row ? String(f.row) : '—'));
        tr.appendChild(el('td', '', f.column || '—'));
        tr.appendChild(el('td', '', f.problem));
        tr.appendChild(el('td', 'hint', f.recommendation || ''));
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      body.appendChild(table);

      const exportBtn = el('button', 'btn btn-ghost btn-sm', 'Експорт зауважень у XLSX');
      exportBtn.addEventListener('click', () => exportFindings(item));
      body.appendChild(exportBtn);
    } else {
      body.appendChild(el('p', 'ok-line', 'Зауважень не виявлено'));
    }
  } else {
    body.appendChild(el('p', 'empty', 'Ще не перевірено'));
  }

  const actions = el('div', 'drawer-actions');

  const recheck = el('button', 'btn btn-ghost', 'Перевірити ще раз');
  recheck.addEventListener('click', () => {
    try {
      const tpl = state.template;
      const workbook = restoreWorkbook(item);
      const result = evaluate(workbook, tpl);
      item.verdict = result.verdict;
      item.counts = result.counts;
      item.findings = result.findings;
      item.checkedAt = nowText();
      item.templateVersion = tpl.version;
      saveState(store);
      toast('Перевірку виконано за збереженим зліпком файлу');
      refreshAll();
      openDrawer(id);
    } catch (err) {
      toast('Не вдалося перевірити: ' + err.message, 'error');
    }
  });
  actions.appendChild(recheck);

  const accept = el('button', 'btn btn-primary', 'Прийняти');
  accept.addEventListener('click', () => decide(item.id, 'accepted'));
  actions.appendChild(accept);

  const rework = el('button', 'btn btn-warn', 'На доопрацювання');
  rework.addEventListener('click', () => decide(item.id, 'rework'));
  actions.appendChild(rework);

  const reject = el('button', 'btn btn-danger', 'Відхилити');
  reject.addEventListener('click', () => decide(item.id, 'rejected'));
  actions.appendChild(reject);

  body.appendChild(actions);

  if (item.comment) {
    body.appendChild(el('h4', '', 'Коментар перевіряючого'));
    body.appendChild(el('p', 'comment', item.comment));
  }

  body.appendChild(el('h4', '', 'Історія'));
  const hist = el('ul', 'history');
  for (const ev of historyOf(store, item.id)) {
    const li = el('li');
    li.appendChild(el('span', 'tl-time', fmtDate(ev.at)));
    li.appendChild(el('span', '',
      STATUS_LABELS[ev.toStatus] || ev.toStatus));
    if (ev.note) li.appendChild(el('span', 'tl-note', ' — ' + ev.note));
    hist.appendChild(li);
  }
  body.appendChild(hist);

  $('drawer').classList.add('open');
  $('backdrop').classList.add('show');
  $('drawer').setAttribute('aria-hidden', 'false');
}

function decide(id, status) {
  const store = loadState();
  const item = store.submissions.find((s) => s.id === id);
  if (!item) return;
  let note = '';
  if (status === 'rework' || status === 'rejected') {
    note = window.prompt('Коментар для підрозділу (необов\'язково):', '') || '';
    item.comment = note;
  }
  setStatus(store, id, status, note || 'Рішення перевіряючого');
  saveState(store);
  toast('Рішення збережено');
  refreshAll();
  openDrawer(id);
}

function closeDrawer() {
  $('drawer').classList.remove('open');
  $('backdrop').classList.remove('show');
  $('drawer').setAttribute('aria-hidden', 'true');
}

/* ---------- експорт ---------- */

function exportFindings(item) {
  const rows = [['Рівень', 'Аркуш', 'Рядок', 'Стовпець', 'Проблема', 'Рекомендація']];
  for (const f of item.findings) {
    rows.push([SEVERITY_LABEL[f.severity] || f.severity, f.sheet || '',
      f.row || '', f.column || '', f.problem, f.recommendation || '']);
  }
  const bytes = buildXlsx([{ name: 'Зауваження', rows }]);
  downloadBlob(bytes, `Зауваження_${item.number}.xlsx`);
  toast('Файл зауважень сформовано', 'ok');
}

function exportRegister() {
  const store = loadState();
  const rows = [['Номер', 'Підрозділ', 'Файл', 'Отримано', 'Завантажено',
    'Статус', 'Вердикт', 'Критичних', 'Помилок', 'Попереджень']];
  for (const s of store.submissions) {
    const c = s.counts || {};
    rows.push([s.number, s.unit, s.filename, s.receivedAt, s.uploadedAt,
      STATUS_LABELS[s.status] || s.status, VERDICT_LABEL[s.verdict] || s.verdict || '',
      c.critical || 0, c.error || 0, c.warning || 0]);
  }
  const bytes = buildXlsx([{ name: 'Реєстр', rows }]);
  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob(bytes, `Реєстр_подань_${stamp}.xlsx`);
  toast('Реєстр експортовано', 'ok');
}

function backup() {
  const bytes = new TextEncoder().encode(dumpState());
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  downloadBlob(bytes, `backup_${stamp}.json`, 'application/json');
  toast('Резервну копію збережено', 'ok');
}

function restore(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      importState(String(reader.result));
      state.files = [];
      toast('Дані відновлено з резервної копії', 'ok');
      refreshAll();
    } catch (err) {
      toast('Не вдалося відновити: ' + err.message, 'error');
    }
  };
  reader.readAsText(file);
  input.value = '';
}

/* ---------- завантаження ---------- */

function openUpload() {
  state.files = [];
  renderFiles();
  $('upload-modal').classList.add('open');
  $('upload-modal').setAttribute('aria-hidden', 'false');
}

function closeUpload() {
  $('upload-modal').classList.remove('open');
  $('upload-modal').setAttribute('aria-hidden', 'true');
  $('upload-unit').value = '';
}

function renderFiles() {
  const list = $('file-list');
  list.innerHTML = '';
  for (const file of state.files) {
    const li = el('li');
    li.appendChild(el('span', 'file-name', file.name));
    li.appendChild(el('span', 'file-size', (file.size / 1024).toFixed(1) + ' КБ'));
    list.appendChild(li);
  }
  $('upload-send').disabled = state.files.length === 0;
}

function addFiles(fileList) {
  for (const file of fileList) {
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      toast(`«${file.name}» не XLSX — пропущено`, 'error');
      continue;
    }
    if (state.files.some((f) => f.name === file.name && f.size === file.size)) continue;
    state.files.push(file);
  }
  renderFiles();
}

async function sendFiles() {
  if (!state.files.length) return;
  const button = $('upload-send');
  button.disabled = true;
  button.textContent = 'Перевірка…';

  const unit = $('upload-unit').value.trim() || 'Без підрозділу';
  const store = loadState();
  const tpl = state.template;
  let good = 0;
  let bad = 0;
  const problems = [];

  for (const file of state.files) {
    try {
      const buffer = await file.arrayBuffer();
      const sha = await sha256Hex(buffer);
      const workbook = await readWorkbook(buffer);
      const result = evaluate(workbook, tpl);
      const snapshot = snapshotOf(workbook, tpl.version);
      registerSubmission(store, {
        filename: file.name, size: file.size, sha256: sha,
      }, unit, snapshot, result);
      good += 1;
    } catch (err) {
      bad += 1;
      problems.push(`${file.name}: ${err.message}`);
    }
  }

  saveState(store);
  let message = `Прийнято ${good} файл(ів)`;
  if (bad) message += `; не вдалося прочитати ${bad}`;
  toast(message, bad ? 'error' : 'ok');
  if (problems.length) console.warn(problems.join('\n'));

  button.disabled = false;
  button.textContent = 'Завантажити';
  closeUpload();
  refreshAll();
}

/* ---------- ініціалізація ---------- */

function refreshAll() {
  try {
    loadDashboard();
    loadRegister();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function loadTemplate() {
  const res = await fetch('rules/template.json');
  if (!res.ok) throw new Error('Не вдалося завантажити опис шаблону');
  state.template = await res.json();
  return state.template;
}

function bind() {
  $('btn-upload').addEventListener('click', openUpload);
  $('upload-close').addEventListener('click', closeUpload);
  $('upload-cancel').addEventListener('click', closeUpload);
  $('upload-send').addEventListener('click', sendFiles);
  $('btn-reload').addEventListener('click', refreshAll);
  $('drawer-close').addEventListener('click', closeDrawer);
  $('backdrop').addEventListener('click', closeDrawer);

  $('btn-backup').addEventListener('click', backup);
  $('btn-restore').addEventListener('click', () => $('restore-input').click());
  $('restore-input').addEventListener('change', (e) => restore(e.target));
  $('btn-export-register').addEventListener('click', exportRegister);

  const drop = $('dropzone');
  const input = $('upload-files');
  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
  ['dragenter', 'dragover'].forEach((evt) => {
    drop.addEventListener(evt, (e) => { e.preventDefault(); drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    drop.addEventListener(evt, (e) => { e.preventDefault(); drop.classList.remove('over'); });
  });
  drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

  let timer;
  $('search').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.filter.q = e.target.value.trim();
      loadRegister();
    }, 200);
  });

  $('filter-status').addEventListener('change', (e) => {
    state.filter.status = e.target.value;
    loadRegister();
  });

  document.querySelectorAll('th[data-order]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.order;
      if (state.filter.order === key) {
        state.filter.dir = state.filter.dir === 'asc' ? 'desc' : 'asc';
      } else {
        state.filter.order = key;
        state.filter.dir = 'desc';
      }
      loadRegister();
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('upload-modal').classList.contains('open')) closeUpload();
    else closeDrawer();
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  bind();
  try {
    await loadTemplate();
  } catch (err) {
    toast(err.message, 'error');
  }
  refreshAll();
});