'use strict';
process.env.H2S_DB_DRIVER = 'sqlite';
process.env.H2S_DB = ':memory:';
process.env.H2S_STRICT_TENANCY = '1';
const assert = require('node:assert/strict');
const db = require('../server/db');
const routes = require('../server/routes');
const cal = require('../server/services/calendar');
const wages = require('../server/services/wages');
const invoices = require('../server/services/invoicing');
const finance = require('../server/services/finance');
const puppeteer = require('puppeteer-core');
const holidays = require('../server/services/school-holidays');

(async () => {
  await db.migrate(); await db.migrate();
  const org = await db.insert('organisations', { name: 'School holiday test' }, ['name']);
  const other = await db.insert('organisations', { name: 'Other firm' }, ['name']);
  const add = (table, data, organisation = org) => db.insert(table, data, Object.keys(data), null, organisation);
  const school = await add('schools', { name: 'School A' });
  const schoolB = await add('schools', { name: 'School B' });
  const foreignSchool = await add('schools', { name: 'Foreign school' }, other);
  const driver = await add('staff', { type: 'driver', first_name: 'Normal', last_name: 'Driver' });
  const pa = await add('staff', { type: 'pa', first_name: 'Normal', last_name: 'PA' });
  const cover = await add('staff', { type: 'driver', first_name: 'Cover', last_name: 'Driver' });
  const contract = async (code, school_id, basis) => add('contracts', { code, school_id, driver_id: driver, pa_id: pa, requires_pa: 1,
    status: 'active', start_date: '2026-01-01', days_of_week: '1,2,3,4,5', income_per_day: 100,
    driver_pay_per_day: 60, pa_pay_per_day: 40, pay_basis: basis, income_basis: basis, po_number: 'PO1' });
  const c = await contract('A', school, 'per_day');
  const b = await contract('B', schoolB, 'per_journey');
  const call = async (method, path, body = {}, organisation = org) => {
    const url = new URL(path, 'http://test');
    const res = { writeHead(status) { this.status = status; }, end(value) { this.body = JSON.parse(value); } };
    await routes.handle({ req: { method }, res, path: url.pathname, query: Object.fromEntries(url.searchParams), body, user: { organisation_id: organisation, name: 'Tester' } });
    return { status: res.status, data: res.body };
  };
  const url = '/api/school-holidays';
  const data = { name: 'Half-term', start_date: '2026-10-26', end_date: '2026-10-30', all_schools: 0, school_ids: [school] };
  const day = async (id, date = data.start_date) => (await call('GET', `/api/contracts/${id}/day/${date}`)).data;
  assert.equal((await day(c)).income, 100);
  const saved = await call('POST', url, data);
  assert.equal(saved.status, 201);
  const id = saved.data.id;
  for (const date of ['2026-10-26', '2026-10-30']) {
    const d = await day(c, date);
    assert.equal(d.income, 0); assert.equal(d.chargeable_days, 0);
    assert(d.trips.every(t => t.closed && t.driver.pay === 0 && t.pa.pay === 0));
    assert(d.summary.some(text => text.includes('Half-term')));
  }
  assert.equal((await day(c, '2026-10-23')).income, 100);
  assert.equal((await day(c, '2026-11-02')).income, 100);
  assert.equal((await day(b)).income, 100);
  const opts = { from: data.start_date, to: data.end_date, contract_id: c, include_zero: true };
  await add('exceptions', { contract_id: c, date: data.start_date, type: 'staff_absence', role: 'driver', staff_id: driver, cover_staff_id: cover, cover_pay: 500, leg: 'DAY' });
  await add('exceptions', { contract_id: c, date: data.start_date, type: 'pay_override', role: 'pa', amount: 500, leg: 'DAY' });
  const payroll = await wages.calculateWages(org, opts);
  assert.equal(payroll.totals.total_due, 0);
  const preview = await invoices.preview(org, { from: opts.from, to: opts.to, contract_ids: [c] });
  assert.equal(preview.rows[0].subtotal, 0);
  const profit = await finance.profitability(org, opts);
  assert.equal(profit.totals.income, 0);
  assert.equal((await call('POST', url, { ...data, school_ids: [foreignSchool] })).status, 400);
  assert.equal((await call('POST', url, { ...data, school_ids: [] })).status, 400);
  assert.equal((await call('POST', url, { ...data, start_date: '2026-02-30' })).status, 400);
  assert.equal((await call('POST', url, { ...data, end_date: '2026-10-25' })).status, 400);
  assert.deepEqual((await call('GET', url, {}, other)).data, []);
  assert.equal((await call('PUT', url + '/' + id, data, other)).status, 404);
  assert.equal((await call('DELETE', url + '/' + id, {}, other)).status, 404);
  assert.deepEqual(await holidays.exceptions(other, opts.from, opts.to), []);
  await call('PUT', url + '/' + id, { ...data, school_ids: [school, schoolB] });
  assert.equal((await day(b)).income, 0);
  await call('PUT', url + '/' + id, { ...data, all_schools: 1, school_ids: [] });
  const schoolC = await add('schools', { name: 'New school' });
  const c3 = await contract('C', schoolC, 'per_journey');
  assert.equal((await day(c3)).income, 0, 'all schools includes subsequently added schools and routes');
  await call('PUT', url + '/' + id, { ...data, start_date: '2026-10-27', end_date: '2026-10-27', school_ids: [schoolB] });
  assert.equal((await day(b)).income, 100);
  assert.equal((await day(b, '2026-10-27')).income, 0, 'single-day inset');
  assert.equal((await day(c, '2026-10-27')).income, 100);
  const overlapping = await call('POST', url, { ...data, school_ids: [schoolB] });
  await call('DELETE', url + '/' + overlapping.data.id);
  assert.equal((await day(b, '2026-10-27')).income, 0, 'removing an overlapping holiday retains the other closure');
  const invoiceData = { number: 1, invoice_no: 'INV1', contract_id: b, period_from: opts.from, period_to: opts.to, invoice_date: opts.to, days: 5, daily_rate: 100, subtotal: 500, vat: 100, total: 600, snapshot: '{}' };
  await add('invoices', invoiceData);
  await add('payments', { staff_id: driver, work_date: '2026-10-27', amount: 60 });
  const updated = await call('PUT', url + '/' + id, { ...data, school_ids: [schoolB] });
  assert.equal(updated.data.warnings.length, 2);
  assert.equal((await db.get('SELECT subtotal FROM invoices WHERE organisation_id = ?', [org])).subtotal, 500);
  assert.equal((await db.get('SELECT amount FROM payments WHERE organisation_id = ?', [org])).amount, 60);

  // Academic year is filed from the first closed date (August to July).
  assert.equal((await call('GET', url)).data.find(h => h.id === id).academic_year, '2026/2027');
  // An all-schools holiday can keep named schools open: their term dates differ.
  const xmas = await call('POST', url, { name: 'Christmas', start_date: '2026-12-21', end_date: '2027-01-01', all_schools: 1, school_ids: [], open_school_ids: [schoolB] });
  assert.equal(xmas.status, 201);
  const listed = (await call('GET', url)).data.find(h => h.id === xmas.data.id);
  assert.equal(listed.academic_year, '2026/2027');
  assert.deepEqual(listed.open_schools.map(s => s.id), [schoolB]);
  assert.equal((await day(c, '2026-12-21')).closed, true, 'the whole day reads as closed');
  assert.equal((await day(c, '2027-01-01')).closure_reason, 'Christmas');
  assert.equal((await day(c, '2027-01-04')).closed, false, 'the normal pattern resumes after the last closed date');
  assert.equal((await day(c, '2027-01-04')).income, 100);
  assert.equal((await day(b, '2026-12-21')).closed, false, 'the school kept open runs as normal');
  assert.equal((await day(b, '2026-12-21')).income, 100);
  assert.equal((await call('POST', url, { name: 'Bad', start_date: '2026-12-21', end_date: '2026-12-22', all_schools: 1, open_school_ids: [foreignSchool] })).status, 400);
  // A route carrying children from two schools follows each child's school.
  const mixed = await contract('M', school, 'per_journey');
  const kidA = await add('children', { first_name: 'Ann', last_name: 'A', contract_id: mixed, school_id: school, status: 'active' });
  const kidB = await add('children', { first_name: 'Ben', last_name: 'B', contract_id: mixed, school_id: schoolB, status: 'active' });
  const inset = await call('POST', url, { name: 'Inset A', start_date: '2027-01-04', end_date: '2027-01-04', all_schools: 0, school_ids: [school] });
  let md = await day(mixed, '2027-01-04');
  assert.equal(md.closed, false, 'the trip still runs for the child at the open school');
  assert.equal(md.income, 100);
  assert(md.trips.every(t => t.status === 'operated' && t.children_travelling === 1 && t.children_closed === 1 && t.driver.pay > 0), JSON.stringify(md.trips.map(t => [t.status, t.children_travelling, t.children_closed])));
  assert.equal(md.children.find(k => k.id === kidA).trips[1], 'school_closed');
  assert.equal(md.children.find(k => k.id === kidB).trips[1], 'travelling');
  assert(md.summary.some(text => /at a closed school/.test(text)));
  await call('PUT', url + '/' + inset.data.id, { name: 'Inset A and B', start_date: '2027-01-04', end_date: '2027-01-04', all_schools: 0, school_ids: [school, schoolB] });
  md = await day(mixed, '2027-01-04');
  assert.equal(md.closed, true, 'closed once every child aboard is at a closed school');
  assert.equal(md.income, 0);
  assert(md.trips.every(t => t.closed && t.driver.pay === 0 && t.pa.pay === 0));
  // "School open" recorded on one contract overrides the closure for that contract only.
  const opened = await call('POST', '/api/exceptions', { contract_id: mixed, date: '2027-01-04', type: 'school_open', leg: 'DAY', note: 'Authorised' });
  assert(opened.status < 300, JSON.stringify(opened));
  md = await day(mixed, '2027-01-04');
  assert.equal(md.closed, false); assert.equal(md.school_open, true); assert.equal(md.income, 100);
  assert(md.trips.every(t => t.status === 'operated' && t.children_travelling === 2 && t.driver.pay > 0));
  assert.equal((await day(c, '2027-01-04')).closed, true, 'other contracts at the school stay closed');
  assert.equal((await call('POST', '/api/exceptions', { date: '2027-01-04', type: 'school_open', leg: 'DAY' })).status, 400, 'school open needs a contract');
  assert.equal((await wages.calculateWages(org, { from: '2027-01-04', to: '2027-01-04', contract_id: mixed, include_zero: true })).totals.total_due, 100);
  assert.equal((await wages.calculateWages(org, { from: '2027-01-04', to: '2027-01-04', contract_id: c, include_zero: true })).totals.total_due, 0);
  await call('DELETE', url + '/' + inset.data.id);
  await call('DELETE', url + '/' + xmas.data.id);

  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage(); const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setContent('<body><div id="view"></div><div id="modal-root"></div><div id="toasts"></div></body>');
    for (const file of ['core.js', 'icons.js', 'ui.js', 'views-records.js', 'views-main.js']) await page.addScriptTag({ path: require('node:path').join(__dirname, '../public/js', file) });
    await page.exposeFunction('testApi', async (method, path, body) => {
      const r = await call(method, path, body); if (r.status >= 400) throw new Error(r.data.error); return r.data;
    });
    await page.evaluate(async school => {
      App.can = () => true; Router.handle = () => {};
      api.get = url => window.testApi('GET', url); api.post = (url, body) => window.testApi('POST', url, body);
      api.put = (url, body) => window.testApi('PUT', url, body); api.del = url => window.testApi('DELETE', url);
      await Rec.schoolHolidays(school);
      [...document.querySelectorAll('.modal button')].find(b => b.textContent === '+ Add school holiday').click();
      const modal = [...document.querySelectorAll('.modal')].at(-1);
      modal.querySelector('[name="name"]').value = 'Christmas';
      modal.querySelector('[name="start_date"]').value = '2026-12-21';
      modal.querySelector('[name="end_date"]').value = '2027-01-01';
      if (modal.querySelector('[name="all_schools"]').checked) throw new Error('School-specific entry should select this school');
      if (modal.querySelectorAll('[name="school_ids"]:checked').length !== 1) throw new Error('Expected one school selected');
      [...modal.querySelectorAll('button')].find(b => b.textContent === 'Save').click();
    }, school);
    await page.waitForFunction(() => [...document.querySelectorAll('.modal')].some(m => m.textContent.includes('Christmas') && m.querySelector('table')));
    assert((await holidays.list(org)).some(h => h.name === 'Christmas' && h.schools[0].id === school));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
  const removed = await call('DELETE', url + '/' + id);
  assert.equal(removed.data.warnings.length, 2);
  assert.equal((await day(b)).income, 100);
  assert.equal((await call('DELETE', url + '/' + id)).status, 404);
  console.log('School holidays: calendar, wages, cover, fixed-day income, invoice previews, editing, cancellation, historical warnings, academic years, schools kept open, mixed-school routes, school open overrides, tenancy and browser entry passed.');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => db.close());
