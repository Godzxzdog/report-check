const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = '/Users/vitaliy/clawd/projects/report-check';

/* --- мінімальна браузерна обгортка --- */
const storage = new Map();
const ctx = {
  console, TextDecoder, TextEncoder, DataView, Uint8Array, Uint32Array,
  Date, Map, Set, Buffer, zlib, JSON, Number, String, Object, Array, Math,
  RegExp, Error, Boolean, parseInt, parseFloat, isNaN,
  navigator: {},
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  },
};
vm.createContext(ctx);

let xlsxSrc = fs.readFileSync(path.join(ROOT, 'static/xlsx.js'), 'utf8');
xlsxSrc = xlsxSrc.replace(/async function inflateRaw\(bytes\) \{[\s\S]*?\n\}/,
  'async function inflateRaw(bytes){return new Uint8Array(zlib.inflateRawSync(Buffer.from(bytes)))}');
vm.runInContext(xlsxSrc, ctx, { filename: 'xlsx.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'static/checker.js'), 'utf8'),
  ctx, { filename: 'checker.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'static/storage.js'), 'utf8'),
  ctx, { filename: 'storage.js' });

const tpl = JSON.parse(fs.readFileSync(path.join(ROOT, 'rules/template.json'), 'utf8'));

const load = (name) => fs.readFileSync(path.join(ROOT, 'tests/cases', name));
const expected = fs.readFileSync(path.join(ROOT, 'tests/cases/expected.txt'), 'utf8')
  .trim().split('\n').map((l) => l.split('\t'));

let pass = 0;
let fail = 0;

function check(label, condition, detail) {
  if (condition) {
    pass++;
    console.log(`OK   ${label}${detail ? ' — ' + detail : ''}`);
  } else {
    fail++;
    console.log(`FAIL ${label}${detail ? ' — ' + detail : ''}`);
  }
}

(async () => {
  console.log('=== 1. Розпізнавання шаблону v1.3 ===');
  for (const [name, want] of expected) {
    const buf = load(name);
    try {
      const wb = await ctx.readWorkbook(new Uint8Array(buf).buffer.slice(0));
      const res = ctx.evaluate(wb, tpl, {
        filename: name,
        registry: [],
        today: new Date(Date.UTC(2026, 10, 7)),
      });
      check(`${name} → ${want}`, res.verdict === want,
        `отримано ${res.verdict} (к/п/по/і ${res.counts.critical}/${res.counts.error}/${res.counts.warning}/${res.counts.info})`);
    } catch (err) {
      check(`${name} → ${want}`, false, 'виняток: ' + err.message);
    }
  }

  console.log('\n=== 2. Справжній шаблон (порожній) ===');
  const realPath = '/Users/vitaliy/clawd/media/inbound/openclaw-staged-d65a6997-af6c-4853-954d-7c72aa705add/input-shablon_shchodennyi_rozrakhunok_v1.3---93ac208a-6bf5-4d8e-9dd2-101a160fb61b.xlsx';
  const realWb = await ctx.readWorkbook(new Uint8Array(fs.readFileSync(realPath)).buffer.slice(0));
  const realRes = ctx.evaluate(realWb, tpl, { today: new Date(Date.UTC(2026, 10, 7)) });
  check('шаблон читається', realWb.sheets.length === 3,
    `аркушів ${realWb.sheets.length}`);
  check('іменовані клітинки знайдено', realWb.names.has('f_sender'),
    `${realWb.names.size} імен`);
  check('довідники прочитано', realRes.dictionaries.groups === 7,
    `груп ${realRes.dictionaries.groups}, посад ${realRes.dictionaries.positions}, звань ${realRes.dictionaries.ranks}`);
  check('порожній шаблон → critical', realRes.verdict === 'critical',
    realRes.findings.map((f) => f.code).join(', '));

  console.log('\n=== 3. Повний цикл: приймання і рішення ===');
  let db = ctx.loadState();
  db._template = tpl;

  const wb1 = await ctx.readWorkbook(new Uint8Array(load('T01_good.xlsx')).buffer.slice(0));
  const res1 = ctx.evaluate(wb1, tpl, { filename: 'T01_good.xlsx', today: new Date(Date.UTC(2026, 10, 7)) });
  const reg1 = ctx.registerSubmission(db, {
    filename: 'РОЗРАХУНОК_ПУ1_20261105_v1.xlsx', size: 4096, sha256: 'aaa111',
  }, res1, { templateVersion: tpl.version });

  check('подання створено', reg1.submission.number === '2026-0001',
    `${reg1.submission.number}, ПУ ${reg1.submission.unit}, доба ${reg1.submission.dayIso}`);
  check('версія перша', reg1.version.number === 1);
  check('особи ще не в реєстрі', db.persons.length === 0);

  ctx.setStatus(db, reg1.submission.id, 'accepted', 'Перевірено без зауважень');
  check('прийнято, особи додано', db.persons.length === 5,
    `${db.persons.length} осіб`);

  console.log('\n=== 4. Нова версія за ту саму добу ===');
  const reg2 = ctx.registerSubmission(db, {
    filename: 'РОЗРАХУНОК_ПУ1_20261105_v2.xlsx', size: 4096, sha256: 'bbb222',
  }, res1, { templateVersion: tpl.version });
  check('подання те саме', reg2.submission.id === reg1.submission.id,
    `номер ${reg2.submission.number}`);
  check('версія друга', reg2.version.number === 2, `v${reg2.version.number}`);
  check('попередня версія замінена', reg2.submission.versions[0].status === 'replaced',
    reg2.submission.versions[0].status);

  console.log('\n=== 5. Дашборд доби ===');
  const dash = ctx.dashboardOf(db, '2026-11-05');
  check('отримано 1 ПУ', dash.received === 1, `очікується ${dash.expected}, отримано ${dash.received}`);
  check('осіб у прийнятих 0 (версія v2 не прийнята)', dash.personsToday === 0,
    String(dash.personsToday));

  console.log('\n=== 6. Календар ===');
  const cal = ctx.calendar(db, 2026, 11);
  const cell = cal.cells[0][4];
  check('комірка 5 листопада має подання', cell.status === 'checked',
    `статус ${cell.status}, подання №${cell.number}`);
  const missingCount = cal.cells[0].filter((c) => c.status === 'missing').length;
  check('пропуски пораховано', missingCount === 29, `${missingCount} пропусків`);

  console.log('\n=== 7. Позначка «не очікується» ===');
  ctx.skipDay(db, 'ПУ 1', '2026-11-06', 'ПУ не чергував');
  const cal2 = ctx.calendar(db, 2026, 11);
  check('пропуск зменшився', cal2.cells[0].filter((c) => c.status === 'missing').length === 28);
  check('позначка збережена', cal2.cells[0][5].status === 'skipped');

  console.log('\n=== 8. Проблеми перед довідкою ===');
  const issues = ctx.certificateIssues(db, 2026, 11);
  check('знайдено неприйняті доби', issues.pending.length >= 1,
    `${issues.pending.length} у черзі`);
  check('знайдено пропуски', issues.missing.length === 28, `${issues.missing.length}`);

  console.log('\n=== 9. Довідка про чергування ===');
  ctx.setStatus(db, reg1.submission.id, 'accepted', '');
  const certs = ctx.buildCertificates(db, 2026, 11, { version: 1 });
  const cert = certs[0];
  check('довідку сформовано', Boolean(cert), `${certs.length} довідок`);
  check('осіб у довідці 5', cert.totalPersons === 5, String(cert.totalPersons));
  check('у кожного 1 доба', cert.rows.every((r) => r.days.length === 1),
    cert.rows.map((r) => `${r.name}:${r.days.length}`).join(', '));
  check('усі діби = 5', cert.rows.every((r) => r.days[0] === 5));
  check('пропуски позначено', cert.skipped.length === 1, `позначено ${cert.skipped.join(',')}`);
  check('дати пропусків відомі', cert.missingDays.length === 28);

  console.log('\n=== 10. Зведення за добу ===');
  const summary = ctx.daySummary(db, '2026-11-05');
  check('осіб у зведенні 5', summary.total === 5, String(summary.total));
  check('типи груп пораховано', Object.keys(summary.byType).length >= 3,
    JSON.stringify(summary.byType));
  check('конфліктів немає', summary.conflicts.length === 0);

  console.log('\n=== 11. Підозрілий ПІБ (описка) ===');
  const person = db.persons[0];
  check('реєстр осіб заповнено', Boolean(person), person ? person.name : 'порожній');
  const fakeWb = await ctx.readWorkbook(new Uint8Array(load('T01_good.xlsx')).buffer.slice(0));
  const fakeRes = ctx.evaluate(fakeWb, tpl, {
    filename: 'x.xlsx',
    registry: db.persons.map((p) => ({ key: p.key, name: p.name })),
    today: new Date(Date.UTC(2026, 10, 7)),
  });
  check('без схожих ПІБ немає L06',
    fakeRes.findings.filter((f) => f.code === 'L06').length === 0);

  const typoName = String(person.name).replace('о', 'а');
  const typoKey = ctx.personKey(typoName);
  const distance = ctx.levenshtein(typoKey, person.key);
  check('Levenshtein ловить 1 символ', distance === 1, `відстань ${distance}`);
  const closeKeys = ctx.levenshtein('петренко іван олегович', 'петренко іван олегович');
  check('однаковий ключ = 0', closeKeys === 0);

  console.log('\n=== 12. Особа в двох ПУ за добу (L02) ===');
  const db2 = ctx.loadState();
  const conflictRes = ctx.evaluate(fakeWb, tpl, {
    filename: 'x.xlsx',
    today: new Date(Date.UTC(2026, 10, 7)),
    submissionsForDay: [{
      unit: 'ПУ 2',
      records: [{ name: 'ПЕТРЕНКО Іван Олегович' }],
    }],
  });
  const l02 = conflictRes.findings.filter((f) => f.code === 'L02');
  check('L02 спрацювало', l02.length >= 1, `${l02.length} знахідок`);
  check('показує другий ПУ', l02.length > 0 && l02[0].otherUnit === 'ПУ 2',
    l02.length ? l02[0].otherUnit : '—');

  console.log('\n=== 13. Порівняння чисельності (L09) ===');
  const dropRes = ctx.evaluate(fakeWb, tpl, {
    filename: 'x.xlsx',
    previousCount: 20,
    today: new Date(Date.UTC(2026, 10, 7)),
  });
  const l09 = dropRes.findings.filter((f) => f.code === 'L09');
  check('L09 ловить падіння 20→5', l09.length === 1,
    l09.length ? l09[0].problem : 'не спрацювало');

  console.log('\n=== 14. Експорт XLSX ===');
  const resultRows = [['Рівень', 'Код', 'Клітинка', 'Проблема']];
  res1.findings.forEach((f) => resultRows.push([f.severity, f.code, f.cell, f.problem]));
  const bytes = ctx.buildXlsx([{ name: 'Зауваження', rows: resultRows }]);
  fs.writeFileSync('/tmp/v41_findings.xlsx', Buffer.from(bytes));
  check('XLSX зібрано', bytes.length > 500, `${bytes.length} байт`);

  // назад у читач — перевірка зворотного читання
  const roundTrip = await ctx.readWorkbook(new Uint8Array(bytes).buffer.slice(0));
  check('експорт читається назад', roundTrip.sheets.length === 1,
    `аркушів ${roundTrip.sheets.length}, рядків ${roundTrip.sheets[0].rows.length}`);

  const certRows = [['Довідка'], ['ПІБ', 'Діб']];
  cert.rows.forEach((r) => certRows.push([r.name, r.days.length]));
  const certBytes = ctx.buildXlsx([{ name: 'Довідка', rows: certRows }]);
  fs.writeFileSync('/tmp/v41_cert.xlsx', Buffer.from(certBytes));
  check('довідка експортована', certBytes.length > 400, `${certBytes.length} байт`);

  console.log('\n=== 15. Збереження стану ===');
  ctx.saveState(db);
  const reloaded = ctx.loadState();
  check('подання збереглись', reloaded.submissions.length === db.submissions.length,
    `${reloaded.submissions.length}`);
  check('особи збереглись', reloaded.persons.length === db.persons.length);
  check('позначки збереглись', reloaded.skips.length === 1);

  const dump = ctx.dumpState();
  check('дамп створюється', dump.length > 100, `${dump.length} байт`);
  ctx.importState(dump);
  const after = ctx.loadState();
  check('відновлення правильне', after.submissions.length === db.submissions.length);

  console.log(`\n${pass} пройдено, ${fail} провалено`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('ПОМИЛКА:', err.message);
  console.error(err.stack);
  process.exit(1);
});