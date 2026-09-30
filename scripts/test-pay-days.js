'use strict';
// Tick off days a driver has already been paid for, through the real wages
// dialog against an in-memory DB. Run: npm run test:paydays
process.env.H2S_DB_DRIVER = 'sqlite';
process.env.H2S_DB = ':memory:';
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');
const db = require('../server/db');
const routes = require('../server/routes');
const wages = require('../server/services/wages');

const WEEK = { from: '2026-09-14', to: '2026-09-18' }; // Mon to Fri

async function main() {
  await db.migrate();
  const org = await db.driver.insertReturningId('INSERT INTO organisations (name) VALUES (?)', ['Pay days test']);
  const driver = await db.insert('staff', { type: 'driver', first_name: 'Mohammed', last_name: 'Anees', status: 'active' },
    ['type', 'first_name', 'last_name', 'status'], null, org);
  const data = { code: 'PAY TEST', driver_id: driver, status: 'active', start_date: '2026-09-01',
    days_of_week: '1,2,3,4,5', income_per_day: 100, income_basis: 'per_journey', driver_pay_per_day: 60, pay_basis: 'per_journey' };
  await db.insert('contracts', data, Object.keys(data), null, org);

  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<body><div id="test-host"></div><div id="modal-root"></div><div id="toasts"></div></body>');
    for (const file of ['core.js', 'icons.js', 'ui.js', 'views-finance.js']) await page.addScriptTag({ path: require('node:path').join(__dirname, '../public/js', file) });
    await page.exposeFunction('testApi', async (method, url, body = {}) => {
      const parsed = new URL(url, 'http://test');
      const res = { writeHead(status) { this.status = status; }, end(value) { this.body = JSON.parse(value); } };
      await routes.handle({ req: { method }, res, path: parsed.pathname, query: Object.fromEntries(parsed.searchParams),
        body, files: [], user: { organisation_id: org, name: 'Browser tester' } });
      if (res.status >= 400) throw new Error(res.body.error);
      return res.body;
    });
    await page.evaluate(({ driver, week }) => {
      api.get = (url, params) => window.testApi('GET', params ? url + '?' + new URLSearchParams(params) : url);
      api.post = (url, body) => window.testApi('POST', url, body);
      window.toast = (message, type) => { window.lastToast = message; if (type === 'err') throw new Error(message); };
      Router.handle = () => {};
      window.dialog = () => [...document.querySelectorAll('.modal')].at(-1);
      window.dueCells = () => [...window.dialog().querySelectorAll('tbody td:last-child')].map(td => td.textContent);
      window.footTotal = () => window.dialog().querySelector('tfoot td.num').textContent;
      window.setDate = (name, value) => { const c = window.dialog().querySelector(`[name=${name}]`); c.value = value; c.dispatchEvent(new Event('change')); };
      Fin.payDays({ id: driver, name: 'Mohammed Anees', type: 'driver' }, week.from, week.to);
    }, { driver, week: WEEK });

    // The whole week is offered, day by day, at what it earned.
    await page.waitForFunction(() => document.querySelector('.modal tfoot'));
    assert.deepEqual(await page.evaluate(() => window.dueCells()), ['£60.00', '£60.00', '£60.00', '£60.00', '£60.00']);
    assert.equal(await page.evaluate(() => window.footTotal()), '£300.00');
    assert.equal(await page.evaluate(() => window.dialog().querySelector('[name=amount]').value), '300.00');

    // Narrow it to Monday to Wednesday: the preview and suggested amount follow.
    await page.evaluate(() => window.setDate('to', '2026-09-16'));
    await page.waitForFunction(() => document.querySelector('.modal tfoot td.num').textContent === '£180.00');
    assert.equal(await page.evaluate(() => window.dialog().querySelector('[name=amount]').value), '180.00');
    await page.evaluate(() => { window.dialog().querySelector('[name=method]').value = 'Cash'; });
    await page.evaluate(() => [...window.dialog().querySelectorAll('button')].find(b => b.textContent === 'Record as already paid').click());
    await page.waitForFunction(() => document.querySelectorAll('.modal').length === 0);
    assert.equal(await page.evaluate(() => window.lastToast), '£180.00 recorded as already paid for 3 days');

    // Three payments of 60, and the week now owes 120.
    const paid = await db.all('SELECT work_date, amount, method, note FROM payments WHERE organisation_id = ? ORDER BY work_date', [org]);
    assert.deepEqual(paid.map(p => [p.work_date, Number(p.amount), p.method]), [['2026-09-14', 60, 'Cash'], ['2026-09-15', 60, 'Cash'], ['2026-09-16', 60, 'Cash']]);
    assert.equal(paid[0].note, 'Paid for 14/09/2026 to 16/09/2026');
    const w = await wages.calculateWages(org, { ...WEEK });
    assert.equal(w.results[0].totals.already_paid, 180);
    assert.equal(w.results[0].totals.amount_due, 120);

    // Opening it again shows those days as paid and only offers the rest.
    await page.evaluate(({ driver, week }) => Fin.payDays({ id: driver, name: 'Mohammed Anees', type: 'driver' }, week.from, week.to), { driver, week: WEEK });
    await page.waitForFunction(() => document.querySelector('.modal tfoot'));
    assert.deepEqual(await page.evaluate(() => window.dueCells()), ['paid', 'paid', 'paid', '£60.00', '£60.00']);
    assert.equal(await page.evaluate(() => window.footTotal()), '£120.00');
    // A day already paid cannot be recorded again.
    await page.evaluate(() => window.setDate('to', '2026-09-14'));
    await page.waitForFunction(() => document.querySelector('.modal tfoot td.num').textContent === '£0.00');
    assert.equal(await page.evaluate(() => [...window.dialog().querySelectorAll('button')].find(b => b.textContent === 'Record as already paid').disabled), true);

    await page.evaluate(() => UI.closeAll());

    // Undo: the breakdown offers the three days paid together as one button.
    await page.evaluate(({ driver }) => { api.del = url => window.testApi('DELETE', url); window.driverId = driver; }, { driver });
    const wagesRow = await page.evaluate(week => api.get('/api/wages', { from: week.from, to: week.to }).then(w => w.results[0]), WEEK);
    assert.equal(wagesRow.lines.filter(l => l.kind === 'already_paid').length, 3, 'three paid lines in the breakdown');
    await page.evaluate(({ row, week }) => Fin.breakdown(row, week.from, week.to), { row: wagesRow, week: WEEK });
    await page.waitForFunction(() => document.querySelector('.modal .breakdown'));
    assert.equal(await page.evaluate(() => document.querySelectorAll('.modal .breakdown input.pay-pick').length), 3, 'each paid line can be ticked');
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.modal .breakdown button')].some(b => /Undo the 3 days paid together/.test(b.textContent))), true, 'and the batch has a one-click undo');
    // Tick two of the three and undo them together.
    await page.evaluate(() => { const boxes = [...document.querySelectorAll('.modal .breakdown input.pay-pick')]; for (const b of boxes.slice(0, 2)) { b.checked = true; b.dispatchEvent(new Event('change')); } });
    assert.match(await page.evaluate(() => [...document.querySelectorAll('.modal .breakdown button')].find(b => /^Undo selected/.test(b.textContent)).textContent), /Undo selected \(2, £120\.00\)/);
    await page.evaluate(() => [...document.querySelectorAll('.modal .breakdown button')].find(b => /^Undo selected/.test(b.textContent)).click());
    await page.waitForFunction(() => [...document.querySelectorAll('.modal button')].some(b => b.textContent === 'Yes, undo it'));
    await page.evaluate(() => [...document.querySelectorAll('.modal button')].find(b => b.textContent === 'Yes, undo it').click());
    await page.waitForFunction(() => document.querySelectorAll('.modal').length === 0 && /2 payments undone/.test(window.lastToast || ''));
    assert.equal((await db.all('SELECT id FROM payments WHERE organisation_id = ?', [org])).length, 1, 'one payment is left');
    assert.equal((await wages.calculateWages(org, { ...WEEK })).results[0].totals.amount_due, 240, 'and two days are owed again');
    // Select all (the one left) and undo it too.
    const rowAgain = await page.evaluate(week => api.get('/api/wages', { from: week.from, to: week.to }).then(w => w.results[0]), WEEK);
    await page.evaluate(({ row, week }) => Fin.breakdown(row, week.from, week.to), { row: rowAgain, week: WEEK });
    await page.waitForFunction(() => document.querySelector('.modal .breakdown'));
    await page.evaluate(() => [...document.querySelectorAll('.modal .breakdown button')].find(b => /^Select/.test(b.textContent)).click());
    await page.evaluate(() => [...document.querySelectorAll('.modal .breakdown button')].find(b => /^Undo selected/.test(b.textContent)).click());
    await page.waitForFunction(() => [...document.querySelectorAll('.modal button')].some(b => b.textContent === 'Yes, undo it'));
    await page.evaluate(() => [...document.querySelectorAll('.modal button')].find(b => b.textContent === 'Yes, undo it').click());
    await page.waitForFunction(() => document.querySelectorAll('.modal').length === 0 && /1 payment undone/.test(window.lastToast || ''));
    assert.equal((await db.all('SELECT id FROM payments WHERE organisation_id = ?', [org])).length, 0, 'the three payments are gone');
    const w3 = await wages.calculateWages(org, { ...WEEK });
    assert.equal(w3.results[0].totals.amount_due, 300, 'and the week is owed in full again');

    // Undoing one cover payment that was paid immediately puts the cover back on payroll.
    const cover = await db.insert('staff', { type: 'driver', first_name: 'Cover', last_name: 'Driver', status: 'pool' }, ['type', 'first_name', 'last_name', 'status'], null, org);
    const contractId = (await db.all('SELECT id FROM contracts WHERE organisation_id = ?', [org]))[0].id;
    const ex = await page.evaluate(({ contractId, cover }) => api.post('/api/exceptions', { contract_id: contractId, date: '2026-09-17', type: 'staff_absence', role: 'driver', leg: 'DAY', cover_staff_id: cover, cover_pay: 55, paid_immediately: 1 }), { contractId, cover });
    let pays = await db.all('SELECT id, exception_id FROM payments WHERE organisation_id = ?', [org]);
    assert.equal(pays.length, 1, 'cover paid immediately writes a payment');
    const undone = await page.evaluate(id => api.del('/api/payments/' + id), pays[0].id);
    assert.equal(undone.exception_reset, true);
    assert.equal((await db.all('SELECT paid_immediately FROM exceptions WHERE id = ?', [ex[0].id]))[0].paid_immediately, 0, 'the absence no longer says paid immediately');
    const w4 = await wages.calculateWages(org, { ...WEEK, include_zero: true });
    assert.equal(w4.results.find(r => r.staff.name === 'Cover Driver').totals.amount_due, 55, 'so payroll owes the cover');

    // A payroll run can be undone as a whole.
    const runRes = await page.evaluate(week => api.post('/api/payroll-runs', { from: week.from, to: week.to }), WEEK);
    assert.equal(runRes.paid, 2, 'payroll pays the driver and the cover');
    assert.equal((await wages.calculateWages(org, { ...WEEK })).totals.total_due, 0, 'nothing is due after payroll');
    const runUndo = await page.evaluate(id => api.del('/api/payroll-runs/' + id), runRes.id);
    assert.equal(runUndo.removed, 2);
    assert.equal((await db.all('SELECT id FROM payroll_runs WHERE organisation_id = ?', [org])).length, 0, 'the run is gone');
    assert.equal((await wages.calculateWages(org, { ...WEEK })).totals.total_due, 240 + 55, 'and everyone is owed again');

    assert.deepEqual(errors, []);
    console.log('Pay days browser checks passed: per-day preview, narrowed period, one payment per day, paid days ticked off, no double payment, undo of ticked payments, a cover payment and a payroll run.');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.close());
