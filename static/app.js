'use strict';

/* Приймання щоденних розрахунків — клієнтська логіка.
   Усе працює у браузері: XLSX читається локально, реєстр у localStorage. */

const state = {
  tab: 'day',
  day: todayIso(),
  template: null,
  files: [],
  current: null,
  register: { q: '', status: '', order: 'number', dir: 'desc' },
  personQuery: '',
  calMonth: '',
  certMonth: '',
  certDraft: null,
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
  toast._timer = setTimeout(() => { box.className = 'toast'; }, 5200);
}

function fmtDay(iso) {
  if (!iso) return '—';
  const [y, m, d] = String(iso).split('-');
  return `${d}.${m}.${y}`;
}

function fmtStamp(text) {
  if (!text) return '—';
  const [date, time] = String(text).split(' ');
  return `${fmtDay(date)}${time ? ' ' + time.slice(0, 5) : ''}`;
}

function shiftDay(iso, delta) {
  const date = new Date(iso + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function monthLabel(key) {
  if (!key) return '—';
  const [y, m] = key.split('-');
  const names = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня',
    'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
  return `${names[Number(m) - 1] || m} ${y}`;
}

/* ---------- перемикання вкладок ---------- */

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((node) => {
    node.classList.toggle('active', node.dataset.tab === tab);
  });
  document.querySelectorAll('.view').forEach((node) => {
    node.classList.toggle('active', node.id === `view-${tab}`);
  });
  renderTab();
}

function renderTab() {
  try {
    if (state.tab === 'day') renderDay();
    else if (state.tab === 'register') renderRegister();
    else if (state.tab === 'calendar') renderCalendar();
    else if (state.tab === 'persons') renderPersons();
    else if (state.tab === 'certs') renderCerts();
  } catch (err) {
    toast(err.message, 'error');
    console.error(err);
  }
}

function refresh() {
  renderTab();
}

/* ---------- вкладка «Доба» ---------- */

function renderDay() {
  const data = loadState();
  data._template = state.template;
  const dash = dashboardOf(data, state.day);

  $('day-picker').value = state.day;
  $('day-label').textContent = fmtDay(state.day);

  const setStat = (key, value) => {
    const node = document.querySelector(`#day-stats [data-k="${key}"]`);
    if (node) node.textContent = value ?? 0;
  };
  setStat('expected', dash.expected);
  setStat('received', dash.received);
  setStat('accepted', dash.unitsStatus.filter(
    (u) => u.status === 'accepted' || u.status === 'accepted_notes').length);
  setStat('rework', dash.unitsStatus.filter((u) => u.status === 'rework').length);
  setStat('persons', dash.personsToday);

  const grid = $('units-status');
  grid.innerHTML = '';
  if (!dash.unitsStatus.length) {
    grid.appendChild(el('p', 'empty',
      'Ще немає подань. Натисніть «Завантажити» і виберіть файли розрахунків.'));
  }
  for (const unit of dash.unitsStatus) {
    const card = el('div', 'unit-card unit-' + unit.status);
    const head = el('div', 'unit-head');
    head.appendChild(el('span', 'unit-name', unit.unit));
    head.appendChild(el('span', 'status status-' + unit.status, unit.label));
    card.appendChild(head);

    if (unit.number) {
      card.appendChild(el('div', 'unit-meta', `Подання № ${unit.number}`));
    }
    if (unit.findings) {
      const meta = el('div', 'unit-meta');
      const c = unit.findings;
      if (c.critical) meta.appendChild(el('span', 'chip chip-critical', `критичних ${c.critical}`));
      if (c.error) meta.appendChild(el('span', 'chip chip-error', `помилок ${c.error}`));
      if (c.warning) meta.appendChild(el('span', 'chip chip-warning', `попереджень ${c.warning}`));
      if (!c.critical && !c.error && !c.warning) {
        meta.appendChild(el('span', 'chip chip-ok', 'без зауважень'));
      }
      card.appendChild(meta);
    }

    if (unit.status === 'expected') {
      const actions = el('div', 'unit-actions');
      const skip = el('button', 'btn btn-ghost btn-xs', 'Не очікується');
      skip.addEventListener('click', () => {
        const db = loadState();
        skipDay(db, unit.unit, state.day, '');
        saveState(db);
        toast('Позначено: подання не очікується');
        refresh();
      });
      actions.appendChild(skip);
      card.appendChild(actions);
    }

    if (unit.submissionId) {
      card.addEventListener('click', () => openDrawer(unit.submissionId));
      card.classList.add('clickable');
    }
    grid.appendChild(card);
  }

  const list = $('day-timeline');
  list.innerHTML = '';
  if (!dash.recent.length) {
    list.appendChild(el('li', 'empty', 'Поки що немає операцій'));
  }
  for (const ev of dash.recent) {
    const item = el('li');
    item.appendChild(el('span', 'tl-time', fmtStamp(ev.at)));
    item.appendChild(el('span', '', ev.text));
    list.appendChild(item);
  }
}

/* ---------- вкладка «Реєстр» ---------- */

function versionCounts(sub) {
  const v = activeVersion(sub);
  return v ? v.counts : null;
}

function renderRegister() {
  const data = loadState();
  let rows = [];
  for (const sub of data.submissions) {
    const version = activeVersion(sub);
    rows.push({
      id: sub.id,
      number: sub.number,
      unit: sub.unit,
      dayIso: sub.dayIso,
      day: sub.day,
      status: sub.status,
      statusLabel: STATUS_SHORT[sub.status] || sub.status,
      versions: sub.versions.length,
      version,
      filename: version ? version.filename : '—',
      counts: version ? version.counts : null,
      verdict: version ? version.verdict : '',
      errors: version && version.counts ? version.counts.error + version.counts.critical : 0,
    });
  }

  if (state.register.status) {
    rows = rows.filter((r) => r.status === state.register.status);
  }
  const q = state.register.q.toLowerCase();
  if (q) {
    rows = rows.filter((r) => [r.unit, r.number, r.filename]
      .join(' ').toLowerCase().includes(q));
  }

  const dir = state.register.dir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const key = state.register.order;
    if (key === 'errors') return ((a.errors || 0) - (b.errors || 0)) * dir;
    const va = a[key] ?? '';
    const vb = b[key] ?? '';
    return String(va).localeCompare(String(vb), 'uk') * dir;
  });

  const body = $('reg-body');
  body.innerHTML = '';
  if (!rows.length) {
    const tr = el('tr');
    const td = el('td', 'empty', 'Немає подань за цим фільтром');
    td.colSpan = 8;
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }

  for (const row of rows) {
    const tr = el('tr', 'row');
    tr.appendChild(el('td', 'mono', row.number));
    tr.appendChild(el('td', '', row.unit));
    tr.appendChild(el('td', 'nowrap', fmtDay(row.dayIso)));
    tr.appendChild(el('td', 'mono', `v${row.versions}`));
    tr.appendChild(el('td', 'filename', row.filename));

    const sum = el('td', 'summary');
    if (row.verdict) sum.appendChild(el('span', 'dot dot-' + row.verdict));
    const c = row.counts;
    sum.appendChild(document.createTextNode(
      !c ? 'не перевірено'
        : c.critical ? `критичних: ${c.critical}`
          : c.error ? `помилок: ${c.error}`
            : c.warning ? `попереджень: ${c.warning}` : 'без зауважень'));
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

/* ---------- вкладка «Календар» ---------- */

function renderCalendar() {
  const data = loadState();
  if (!state.calMonth) state.calMonth = state.day.slice(0, 7);
  $('cal-month').value = state.calMonth;
  const [year, month] = state.calMonth.split('-').map(Number);
  const table = $('cal-table');
  table.innerHTML = '';

  const cal = calendar(data, year, month);
  if (!cal.units.length) {
    table.appendChild(el('caption', 'empty', 'Ще немає подань за цей місяць'));
    return;
  }

  const thead = el('thead');
  const headRow = el('tr');
  headRow.appendChild(el('th', 'cal-unit', 'ПУ'));
  for (const day of cal.days) headRow.appendChild(el('th', 'cal-day', String(day.day)));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  cal.units.forEach((unit, ui) => {
    const tr = el('tr');
    tr.appendChild(el('td', 'cal-unit', unit));
    cal.days.forEach((day, di) => {
      const cell = cal.cells[ui][di];
      const td = el('td', 'cal-cell cal-' + cell.status);
      td.title = `${unit}, ${fmtDay(day.iso)}: `
        + (cell.status === 'missing' ? 'немає подання'
          : cell.status === 'skipped' ? 'подання не очікується'
            : STATUS_SHORT[cell.status] || cell.status);
      if (cell.submissionId) {
        td.classList.add('clickable');
        td.textContent = cell.status === 'accepted' || cell.status === 'accepted_notes'
          ? '✓' : '•';
        td.addEventListener('click', () => openDrawer(cell.submissionId));
      } else if (cell.status === 'skipped') {
        td.textContent = '—';
        td.addEventListener('click', () => {
          const db = loadState();
          unskipDay(db, unit, day.iso);
          saveState(db);
          toast('Позначку «не очікується» знято');
          refresh();
        });
      } else {
        td.textContent = '';
        td.addEventListener('click', () => {
          const comment = window.prompt(
            `Позначити ${fmtDay(day.iso)} для «${unit}» як «подання не очікується»? `
            + 'Коментар:', '') ;
          if (comment === null) return;
          const db = loadState();
          skipDay(db, unit, day.iso, comment);
          saveState(db);
          toast('Позначено');
          refresh();
        });
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
}

/* ---------- вкладка «Особи» ---------- */

function renderPersons() {
  const data = loadState();
  data._template = state.template;
  const suspicious = suspiciousNames(data, state.template);

  const box = $('suspicious-list');
  box.innerHTML = '';
  if (!suspicious.length) {
    box.appendChild(el('p', 'ok-line', 'Нерозвʼязаних збігів немає'));
  } else {
    const table = el('table', 'register');
    const thead = el('thead');
    const hr = el('tr');
    for (const h of ['У поданні', 'У реєстрі', 'Різниця', 'Діб', 'Дії']) {
      hr.appendChild(el('th', '', h));
    }
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = el('tbody');
    for (const item of suspicious) {
      const tr = el('tr');
      tr.appendChild(el('td', '', item.name));
      tr.appendChild(el('td', '', item.similarTo));
      tr.appendChild(el('td', 'mono', String(item.distance)));
      tr.appendChild(el('td', 'mono', String(item.count)));
      const actions = el('td', 'actions');
      const same = el('button', 'btn btn-ghost btn-xs', 'Це та сама особа');
      same.addEventListener('click', () => {
        const db = loadState();
        resolveAlias(db, item.key, item.personId, 'Підтверджено перевіряючим');
        saveState(db);
        toast('Написання ПІБ обʼєднано з особою');
        refresh();
      });
      const other = el('button', 'btn btn-ghost btn-xs', 'Різні особи');
      other.addEventListener('click', () => {
        const db = loadState();
        const person = db.persons.find((p) => p.id === item.personId);
        // створюємо окрему особу, щоб більше не пропонувало
        db.persons.push({
          id: (db.persons.reduce((max, p) => Math.max(max, p.id), 0) || 0) + 1,
          key: item.key,
          name: item.name,
          rank: '',
          position: '',
          vch: '',
          unit: '',
          firstSeen: nowText(),
          lastSeen: nowText(),
          active: true,
          distinctFrom: person ? person.id : null,
        });
        saveState(db);
        toast('Додано як окрему особу');
        refresh();
      });
      actions.appendChild(same);
      actions.appendChild(other);
      tr.appendChild(actions);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    box.appendChild(table);
  }

  const q = state.personQuery.toLowerCase();
  const persons = data.persons
    .filter((p) => !q || p.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, 'uk'));

  const body = $('persons-body');
  body.innerHTML = '';
  if (!persons.length) {
    const tr = el('tr');
    const td = el('td', 'empty', data.persons.length
      ? 'Нічого не знайдено' : 'Реєстр порожній — особи додаються після приймання подань');
    td.colSpan = 7;
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }

  for (const person of persons) {
    const days = new Set();
    for (const sub of data.submissions) {
      const version = activeVersion(sub);
      if (!version) continue;
      if (version.status !== 'accepted' && version.status !== 'accepted_notes') continue;
      if ((version.records || []).some((r) => r.personKey === person.key)) {
        days.add(sub.dayIso);
      }
    }
    const tr = el('tr');
    tr.appendChild(el('td', '', person.name));
    tr.appendChild(el('td', '', person.rank || '—'));
    tr.appendChild(el('td', '', person.position || '—'));
    tr.appendChild(el('td', 'mono', person.vch || '—'));
    tr.appendChild(el('td', '', person.unit || '—'));
    tr.appendChild(el('td', 'mono', String(days.size)));
    body.appendChild(tr);
  }
}

/* ---------- вкладка «Довідки» ---------- */

function renderCerts() {
  const data = loadState();
  data._template = state.template;
  if (!state.certMonth) state.certMonth = state.day.slice(0, 7);
  $('cert-month').value = state.certMonth;

  const [year, month] = state.certMonth.split('-').map(Number);
  const issues = certificateIssues(data, year, month);
  state.certIssues = issues;

  const box = $('cert-issues');
  box.innerHTML = '';

  const block = (title, items, render, severity) => {
    if (!items.length) return;
    const panel = el('div', 'issue-block issue-' + severity);
    const head = el('div', 'issue-head');
    head.appendChild(el('strong', '', title));
    head.appendChild(el('span', 'issue-count', String(items.length)));
    panel.appendChild(head);
    const list = el('ul', 'issue-list');
    for (const item of items.slice(0, 40)) {
      list.appendChild(el('li', '', render(item)));
    }
    if (items.length > 40) {
      list.appendChild(el('li', 'hint', `…та ще ${items.length - 40}`));
    }
    panel.appendChild(list);
    box.appendChild(panel);
  };

  block('Доби без прийнятого подання', issues.missing,
    (i) => `${i.unit} · ${fmtDay(i.day)}`, 'warning');
  block('Подання не завершені', issues.pending,
    (i) => `${i.unit} · ${fmtDay(i.day)} · ${i.label}`, 'warning');
  block('Нерозвʼязані збіги ПІБ', issues.suspicious,
    (i) => `${i.name} ≈ ${i.similarTo} (${i.distance})`, 'warning');
  block('Особа в двох ПУ за одну добу', issues.conflicts,
    (i) => `${i.name} · ${fmtDay(i.day)}: ${i.units.join(', ')}`, 'critical');
  block('Особи без звання або в/ч', issues.incomplete,
    (i) => `${i.unit} · ${fmtDay(i.day)} · ${i.name} (рядок ${i.row})`, 'critical');

  const results = $('cert-results');
  results.innerHTML = '';
  if (!state.certDraft) return;

  for (const cert of state.certDraft) {
    const panel = el('div', 'cert-card');
    const head = el('div', 'cert-head');
    head.appendChild(el('h3', '', `Довідка · ${cert.unit}`));
    head.appendChild(el('span', 'cert-meta',
      `${monthLabel(cert.month)} · осіб ${cert.totalPersons} · діб ${cert.totalDays}`));
    panel.appendChild(head);

    const table = el('table', 'register');
    const thead = el('thead');
    const hr = el('tr');
    for (const h of ['№', 'Звання', 'ПІБ', 'Посада', 'в/ч', 'Діб', 'Дати']) {
      hr.appendChild(el('th', '', h));
    }
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = el('tbody');
    cert.rows.forEach((row, i) => {
      const tr = el('tr');
      tr.appendChild(el('td', 'mono', String(i + 1)));
      tr.appendChild(el('td', '', row.rank || '—'));
      tr.appendChild(el('td', '', row.name));
      tr.appendChild(el('td', '', row.position || '—'));
      tr.appendChild(el('td', 'mono', row.vch || '—'));
      tr.appendChild(el('td', 'mono', String(row.days.length)));
      tr.appendChild(el('td', 'hint', row.days.join(', ')));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    panel.appendChild(table);

    if (cert.skipped.length) {
      panel.appendChild(el('p', 'hint',
        `Позначено «не очікується»: ${cert.skipped.join(', ')}`));
    }

    const actions = el('div', 'cert-actions');
    const exp = el('button', 'btn btn-ghost btn-sm', 'Експорт XLSX');
    exp.addEventListener('click', () => exportCertificate(cert));
    actions.appendChild(exp);
    panel.appendChild(actions);

    results.appendChild(panel);
  }
}

function buildCertificates() {
  const data = loadState();
  data._template = state.template;
  const [year, month] = state.certMonth.split('-').map(Number);
  const issues = certificateIssues(data, year, month);

  const blocking = issues.conflicts.length + issues.incomplete.length;
  if (blocking) {
    toast('Є конфлікти або незаповнені дані — виправте їх перед формуванням',
      'error');
    return;
  }

  const open = issues.missing.length + issues.pending.length + issues.suspicious.length;
  let comment = '';
  if (open) {
    const answer = window.prompt(
      `Відкритих пунктів: ${open}.\n`
      + 'Вони не блокують довідку, але її потрібно підтвердити.\n'
      + 'Впишіть коментар, щоб сформувати довідку:', '');
    if (answer === null || !answer.trim()) {
      toast('Формування скасовано — потрібен коментар', 'error');
      return;
    }
    comment = answer.trim();
  }

  const version = (data.months[state.certMonth] || 0) + 1;
  state.certDraft = buildCertificates(data, year, month, {
    version, confirmed: Boolean(open), comment,
  });
  data.months[state.certMonth] = version;
  logEvent(data, 'month:cert', {}, `Сформовано довідки за ${state.certMonth}, версія ${version}`);
  saveState(data);
  toast(`Довідки сформовано (версія ${version})`);
  renderCerts();
}

function exportCertificate(cert) {
  const rows = [
    [`Довідка про чергування. ${cert.unit}`],
    [`Період: ${monthLabel(cert.month)}`],
    [`Сформовано: ${fmtStamp(cert.generatedAt)}`],
    [],
    ['№', 'Звання', 'ПІБ', 'Посада', 'в/ч', 'Кількість діб', 'Дати'],
  ];
  cert.rows.forEach((row, i) => {
    rows.push([i + 1, row.rank, row.name, row.position, row.vch,
      row.days.length, row.days.join(', ')]);
  });
  rows.push([]);
  rows.push(['Усього осіб', cert.totalPersons]);
  rows.push(['Усього діб', cert.totalDays]);
  if (cert.skipped.length) rows.push(['Не очікувалось', cert.skipped.join(', ')]);

  const safeUnit = cert.unit.replace(/[^\wа-яіїєґ ]/gi, '').trim().replace(/\s+/g, '_');
  downloadBlob(buildXlsx([{ name: 'Довідка', rows }]),
    `Довідка_${safeUnit}_${cert.month.replace('-', '')}.xlsx`);
  toast('Довідку експортовано', 'ok');
}

/* ---------- зведення за добу ---------- */

function exportDaySummary() {
  const data = loadState();
  const summary = daySummary(data, state.day);

  const order = [
    ['для наказу', [
      ['ПУ', 'Група', 'Тип', 'Звання', 'ПІБ', 'Посада', 'в/ч'],
      ...summary.rows.filter((r) => r.accepted)
        .sort((a, b) => a.unit.localeCompare(b.unit, 'uk')
          || a.group.localeCompare(b.group, 'uk'))
        .map((r) => [r.unit, r.group, r.type, r.rank, r.name, r.position, r.vch]),
    ]],
    ['для виплат', [
      ['№', 'ПІБ', 'Звання', 'Посада', 'в/ч', 'ПУ', 'Група'],
      ...summary.rows.filter((r) => r.accepted)
        .map((r, i) => [i + 1, r.name, r.rank, r.position, r.vch, r.unit, r.group]),
    ]],
    ['підсумки', [
      ['Тип групи', 'Кількість'],
      ...Object.entries(summary.byType).map(([k, v]) => [k, v]),
      [],
      ['Усього', summary.total],
    ]],
  ];

  const sheets = order.map(([name, rows]) => ({ name, rows }));
  if (summary.conflicts.length) {
    sheets.push({
      name: 'конфлікти',
      rows: [['ПІБ', 'ПУ'], ...summary.conflicts.map((c) => [c.name, c.units.join(', ')])],
    });
  }

  downloadBlob(buildXlsx(sheets), `Зведення_${state.day.replace(/-/g, '')}.xlsx`);
  toast('Зведення експортовано', 'ok');
}

/* ---------- деталі подання ---------- */

function openDrawer(id) {
  const data = loadState();
  data._template = state.template;
  const sub = findSubmissionById(data, id);
  if (!sub) { toast('Подання не знайдено', 'error'); return; }
  state.current = sub;

  $('drawer-title').textContent = `Подання № ${sub.number}`;
  $('drawer-sub').textContent = `${sub.unit} · доба ${fmtDay(sub.dayIso)} · `
    + `версій: ${sub.versions.length}`;

  const body = $('drawer-body');
  body.innerHTML = '';

  const version = activeVersion(sub);
  const st = el('div', 'drawer-status');
  st.appendChild(el('span', 'status status-' + sub.status,
    STATUS_SHORT[sub.status] || sub.status));
  if (version) {
    st.appendChild(el('span', 'verdict verdict-' + version.verdict,
      VERDICT_LABEL[version.verdict] || version.verdict));
  }
  if (version && version.duplicateOf) {
    st.appendChild(el('span', 'note-warn',
      `Той самий файл уже є в поданні №${version.duplicateOf.submissionId}`));
  }
  body.appendChild(st);

  if (!version) {
    body.appendChild(el('p', 'empty', 'Ще не перевірено'));
  } else {
    const meta = el('dl', 'meta');
    const pairs = [
      ['Файл', version.filename],
      ['Розмір', (version.sizeBytes / 1024).toFixed(1) + ' КБ'],
      ['Отримано', fmtStamp(version.receivedAt)],
      ['Завантажено', fmtStamp(version.uploadedAt)],
      ['Контрольна сума', version.sha256.slice(0, 20) + '…'],
      ['Відповідальна особа', `${version.header.respRank} ${version.header.respName}`],
      ['Осіб у файлі', String((version.records || []).length)],
    ];
    for (const [label, value] of pairs) {
      meta.appendChild(el('dt', '', label));
      meta.appendChild(el('dd', '', String(value)));
    }
    body.appendChild(meta);

    const counts = el('div', 'counts');
    for (const sev of ['critical', 'error', 'warning', 'info']) {
      const box = el('div', 'count count-' + sev);
      box.appendChild(el('span', 'count-num', String(version.counts[sev] || 0)));
      box.appendChild(el('span', 'count-label', SEVERITY_LABEL[sev]));
      counts.appendChild(box);
    }
    body.appendChild(counts);

    if (version.findings.length) {
      const table = el('table', 'findings');
      const thead = el('thead');
      const hr = el('tr');
      for (const h of ['Рівень', 'Код', 'Клітинка', 'Проблема', 'Рекомендація']) {
        hr.appendChild(el('th', '', h));
      }
      thead.appendChild(hr);
      table.appendChild(thead);
      const tbody = el('tbody');
      for (const f of version.findings) {
        const tr = el('tr');
        tr.appendChild(el('td', 'sev sev-' + f.severity,
          SEVERITY_LABEL[f.severity] || f.severity));
        tr.appendChild(el('td', 'mono', f.code));
        tr.appendChild(el('td', 'mono cell', f.cell || '—'));
        tr.appendChild(el('td', '', f.problem));
        tr.appendChild(el('td', 'hint', f.recommendation || ''));
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      body.appendChild(table);
    } else {
      body.appendChild(el('p', 'ok-line', 'Зауважень не виявлено'));
    }
  }

  /* версії */
  if (sub.versions.length > 1) {
    body.appendChild(el('h4', '', 'Версії'));
    const list = el('ul', 'history');
    sub.versions.forEach((v) => {
      const li = el('li');
      li.appendChild(el('span', 'mono', `v${v.number}`));
      li.appendChild(el('span', '', v.filename));
      li.appendChild(el('span', 'tl-note', STATUS_SHORT[v.status] || v.status));
      list.appendChild(li);
    });
    body.appendChild(list);
  }

  /* дії */
  const actions = el('div', 'drawer-actions');
  const canAccept = version && version.counts.critical === 0;

  if (version) {
    const accept = el('button', 'btn btn-primary', 'Прийняти');
    accept.disabled = !canAccept;
    accept.title = canAccept ? '' : 'Критичні помилки блокують приймання';
    accept.addEventListener('click', () => decide(sub.id, 'accepted'));
    actions.appendChild(accept);

    if (version.counts.error > 0) {
      const notes = el('button', 'btn btn-warn', 'Прийняти із зауваженнями');
      notes.addEventListener('click', () => decide(sub.id, 'accepted_notes'));
      actions.appendChild(notes);
    }

    const rework = el('button', 'btn btn-warn', 'На доопрацювання');
    rework.addEventListener('click', () => decide(sub.id, 'rework'));
    actions.appendChild(rework);

    const reject = el('button', 'btn btn-danger', 'Відхилити');
    reject.addEventListener('click', () => decide(sub.id, 'rejected'));
    actions.appendChild(reject);

    const copy = el('button', 'btn btn-ghost', 'Копія з помітками');
    copy.addEventListener('click', () => markedCopy(sub, version));
    actions.appendChild(copy);

    const message = el('button', 'btn btn-ghost', 'Текст повідомлення');
    message.addEventListener('click', () => feedbackText(sub, version));
    actions.appendChild(message);
  }
  body.appendChild(actions);

  if (sub.comment) {
    body.appendChild(el('h4', '', 'Коментар перевіряючого'));
    body.appendChild(el('p', 'comment', sub.comment));
  }

  $('drawer').classList.add('open');
  $('backdrop').classList.add('show');
  $('drawer').setAttribute('aria-hidden', 'false');
}

function decide(subId, status) {
  const data = loadState();
  const sub = findSubmissionById(data, subId);
  const version = activeVersion(sub);
  if (!version) return;

  if (status === 'accepted' && version.counts.critical) {
    toast('Приймання заблоковане: є критичні помилки', 'error');
    return;
  }

  let note = '';
  if (status === 'accepted_notes' || status === 'rework' || status === 'rejected') {
    const prompt = status === 'accepted_notes'
      ? 'Коментар до приймання із зауваженнями (обовʼязково):'
      : 'Коментар для ПУ (необовʼязково):';
    const answer = window.prompt(prompt, '');
    if (answer === null) return;
    if (status === 'accepted_notes' && !answer.trim()) {
      toast('Для приймання із зауваженнями потрібен коментар', 'error');
      return;
    }
    note = answer.trim();
  }

  setStatus(data, subId, status, note);
  saveState(data);
  toast(`Статус: ${STATUS_SHORT[status]}`);
  refresh();
  openDrawer(subId);
}

function closeDrawer() {
  $('drawer').classList.remove('open');
  $('backdrop').classList.remove('show');
  $('drawer').setAttribute('aria-hidden', 'false');
  $('drawer').setAttribute('aria-hidden', 'true');
}

/* ---------- зворотний звʼязок ---------- */

function feedbackText(sub, version) {
  const problems = version.findings.filter(
    (f) => f.severity === 'critical' || f.severity === 'error');
  const lines = [
    `${sub.unit}, доба ${fmtDay(sub.dayIso)}.`,
    `У розрахунку виявлено ${problems.length} зауважень. Виправте та надішліть файл `
    + `повторно з новим номером версії.`,
    '',
  ];
  problems.forEach((f, i) => {
    lines.push(`${i + 1}. ${f.cell} — ${f.problem}`);
    if (f.recommendation) lines.push(`   Рекомендація: ${f.recommendation}`);
  });

  const text = lines.join('\n');
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(
      () => toast('Текст скопійовано в буфер обміну', 'ok'),
      () => showTextModal('Текст повідомлення', text));
  } else {
    showTextModal('Текст повідомлення', text);
  }
}

function showTextModal(title, text) {
  window.prompt(title + ' (скопіюйте):', text);
}

/* Позначена копія: той самий шаблон, проблемні клітинки в примітці. */
function markedCopy(sub, version) {
  const rows = [
    [`Копія з помітками. ${sub.unit}, доба ${fmtDay(sub.dayIso)}`],
    ['Оригінал не змінено. Нижче — перелік зауважень із привʼязкою до клітинок.'],
    [],
    ['Рівень', 'Код', 'Клітинка', 'Проблема', 'Рекомендація'],
  ];
  for (const f of version.findings) {
    rows.push([SEVERITY_LABEL[f.severity] || f.severity, f.code, f.cell || '',
      f.problem, f.recommendation || '']);
  }
  rows.push([]);
  rows.push(['Рядок', 'в/ч', 'Група', 'Посада', 'Звання', 'ПІБ', 'Проблеми']);
  for (const rec of version.records || []) {
    const own = version.findings.filter((f) => f.row === rec.row);
    rows.push([rec.row, rec.vch, rec.group, rec.position, rec.rank, rec.name,
      own.map((f) => f.code).join(', ')]);
  }
  const safeUnit = sub.unit.replace(/[^\wа-яіїєґ ]/gi, '').trim().replace(/\s+/g, '_');
  downloadBlob(buildXlsx([{ name: 'Помітки', rows }]),
    `Помітки_${safeUnit}_${sub.dayIso.replace(/-/g, '')}.xlsx`);
  toast('Копію з помітками сформовано', 'ok');
}

/* ---------- завантаження ---------- */

function openUpload() {
  state.files = [];
  $('upload-result').innerHTML = '';
  renderFiles();
  $('upload-modal').classList.add('open');
  $('upload-modal').setAttribute('aria-hidden', 'false');
}

function closeUpload() {
  $('upload-modal').classList.remove('open');
  $('upload-modal').setAttribute('aria-hidden', 'true');
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
  const maxSize = Number((state.template && state.template.params
    && state.template.params.max_size_mb) || 10) * 1024 * 1024;
  for (const file of fileList) {
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.xlsm')) {
      toast(`«${file.name}» містить макроси — не приймається`, 'error');
      continue;
    }
    if (!lower.endsWith('.xlsx')) {
      toast(`«${file.name}» не XLSX — пропущено`, 'error');
      continue;
    }
    if (file.size > maxSize) {
      toast(`«${file.name}» більший за ${maxSize / 1024 / 1024} МБ`, 'error');
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

  const data = loadState();
  data._template = state.template;
  const tpl = state.template;
  const results = [];

  for (const file of state.files) {
    try {
      const buffer = await file.arrayBuffer();
      const sha = await sha256Hex(buffer);
      const workbook = await readWorkbook(buffer);

      const registry = data.persons.map((p) => ({ key: p.key, name: p.name }));
      const result = evaluate(workbook, tpl, {
        filename: file.name,
        registry,
        today: new Date(),
      });

      if (!result.header.dayIso) {
        results.push({ name: file.name, ok: false,
          message: 'Не вдалося визначити добу зі шапки файлу' });
        continue;
      }

      const prev = findSubmission(data, result.header.sender || 'Без ПУ',
        result.header.dayIso);
      if (prev) {
        const prevVersion = activeVersion(prev);
        if (prevVersion && prevVersion.sha256 === sha) {
          results.push({ name: file.name, ok: false, duplicate: true,
            message: `Той самий файл уже прийнято (подання №${prev.number})` });
          continue;
        }
      }

      const dup = data.submissions.flatMap((s) => s.versions || [])
        .find((v) => v.sha256 === sha);
      if (dup) {
        results.push({ name: file.name, ok: false, duplicate: true,
          message: 'Ідентичний файл уже є в системі — не додано' });
        continue;
      }

      const { submission, version } = registerSubmission(data, {
        filename: file.name, size: file.size, sha256: sha,
      }, result, { templateVersion: tpl.version });

      results.push({
        name: file.name, ok: true,
        number: submission.number,
        unit: submission.unit,
        day: submission.day,
        version: version.number,
        verdict: result.verdict,
        counts: result.counts,
      });
    } catch (err) {
      results.push({ name: file.name, ok: false, message: err.message });
    }
  }

  try {
    saveState(data);
  } catch (err) {
    toast(err.message, 'error');
  }

  const box = $('upload-result');
  box.innerHTML = '';
  const table = el('table', 'register compact');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['Файл', 'ПУ', 'Доба', 'Результат']) hr.appendChild(el('th', '', h));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const item of results) {
    const tr = el('tr');
    tr.appendChild(el('td', 'filename', item.name));
    tr.appendChild(el('td', '', item.ok ? item.unit : '—'));
    tr.appendChild(el('td', 'nowrap', item.ok ? fmtDay(item.day) : '—'));
    const status = el('td');
    if (item.ok) {
      status.appendChild(el('span', 'verdict verdict-' + item.verdict,
        VERDICT_LABEL[item.verdict] || item.verdict));
      status.appendChild(el('span', 'hint',
        ` №${item.number} · v${item.version}`));
    } else {
      status.appendChild(el('span', 'hint', item.message));
    }
    tr.appendChild(status);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  box.appendChild(table);

  const good = results.filter((r) => r.ok).length;
  toast(`Опрацьовано ${results.length}: успішно ${good}`, good ? 'ok' : 'error');

  button.disabled = false;
  button.textContent = 'Перевірити й прийняти';
  state.files = [];
  renderFiles();
  refresh();
}

/* ---------- експорт реєстру ---------- */

function exportRegister() {
  const data = loadState();
  const rows = [['Номер', 'ПУ', 'Доба', 'Версія', 'Файл', 'Статус', 'Вердикт',
    'Критичних', 'Помилок', 'Попереджень', 'Інформація', 'Осіб', 'Завантажено']];
  for (const sub of data.submissions) {
    const version = activeVersion(sub);
    const c = version ? version.counts : {};
    rows.push([sub.number, sub.unit, fmtDay(sub.dayIso),
      version ? version.number : '',
      version ? version.filename : '',
      STATUS_SHORT[sub.status] || sub.status,
      version ? VERDICT_LABEL[version.verdict] : '',
      c.critical || 0, c.error || 0, c.warning || 0, c.info || 0,
      version ? (version.records || []).length : 0,
      version ? version.uploadedAt : '']);
  }
  downloadBlob(buildXlsx([{ name: 'Реєстр', rows }]),
    `Реєстр_${todayIso().replace(/-/g, '')}.xlsx`);
  toast('Реєстр експортовано', 'ok');
}

function exportPersons() {
  const data = loadState();
  const rows = [['ПІБ', 'Звання', 'Посада', 'в/ч', 'ПУ', 'Активна']];
  for (const p of data.persons) {
    rows.push([p.name, p.rank, p.position, p.vch, p.unit, p.active ? 'так' : 'ні']);
  }
  downloadBlob(buildXlsx([{ name: 'Особи', rows }]), 'Реєстр_осіб.xlsx');
  toast('Реєстр осіб експортовано', 'ok');
}

/* ---------- резервні копії ---------- */

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
      toast('Дані відновлено', 'ok');
      refresh();
    } catch (err) {
      toast('Не вдалося відновити: ' + err.message, 'error');
    }
  };
  reader.readAsText(file);
  input.value = '';
}

/* ---------- ініціалізація ---------- */

async function loadTemplate() {
  const res = await fetch('rules/template.json');
  if (!res.ok) throw new Error('Не вдалося завантажити опис шаблону');
  state.template = await res.json();
  $('template-line').textContent =
    `Шаблон v${state.template.version} · ТЗ v${state.template.rules_version}`;
  return state.template;
}

function bind() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => setTab(tab.dataset.tab));
  });

  $('day-prev').addEventListener('click', () => {
    state.day = shiftDay(state.day, -1);
    renderDay();
  });
  $('day-next').addEventListener('click', () => {
    state.day = shiftDay(state.day, 1);
    renderDay();
  });
  $('day-today').addEventListener('click', () => {
    state.day = todayIso();
    renderDay();
  });
  $('day-picker').addEventListener('change', (e) => {
    state.day = e.target.value || todayIso();
    renderDay();
  });

  $('btn-upload').addEventListener('click', openUpload);
  $('upload-close').addEventListener('click', closeUpload);
  $('upload-cancel').addEventListener('click', closeUpload);
  $('upload-send').addEventListener('click', sendFiles);

  $('drawer-close').addEventListener('click', closeDrawer);
  $('backdrop').addEventListener('click', closeDrawer);

  $('btn-backup').addEventListener('click', backup);
  $('btn-restore').addEventListener('click', () => $('restore-input').click());
  $('restore-input').addEventListener('change', (e) => restore(e.target));

  $('reg-search').addEventListener('input', (e) => {
    state.register.q = e.target.value.trim();
    renderRegister();
  });
  const statusFilter = $('reg-status');
  for (const [key, label] of Object.entries(STATUS_SHORT)) {
    const opt = el('option', '', label);
    opt.value = key;
    statusFilter.appendChild(opt);
  }
  statusFilter.addEventListener('change', (e) => {
    state.register.status = e.target.value;
    renderRegister();
  });
  document.querySelectorAll('#view-register th[data-order]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.order;
      if (state.register.order === key) {
        state.register.dir = state.register.dir === 'asc' ? 'desc' : 'asc';
      } else {
        state.register.order = key;
        state.register.dir = 'desc';
      }
      renderRegister();
    });
  });
  $('reg-export').addEventListener('click', exportRegister);

  $('cal-month').addEventListener('change', (e) => {
    state.calMonth = e.target.value;
    renderCalendar();
  });

  $('person-search').addEventListener('input', (e) => {
    state.personQuery = e.target.value.trim();
    renderPersons();
  });
  $('persons-export').addEventListener('click', exportPersons);

  $('cert-month').addEventListener('change', (e) => {
    state.certMonth = e.target.value;
    state.certDraft = null;
    renderCerts();
  });
  $('cert-build').addEventListener('click', buildCertificates);
  $('btn-day-summary').addEventListener('click', exportDaySummary);

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
  setTab('day');
});