'use strict';
// One driver absent all day, a different cover on each journey, recorded
// through the real day dialog against an in-memory DB. Run: npm run test:cover
process.env.H2S_DB_DRIVER = 'sqlite';
process.env.H2S_DB = ':memory:';
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');
const db = require('../server/db');
const routes = require('../server/routes');
const wages = require('../server/services/wages');

const DATE = '2026-09-16'; // a Wednesday

async function main() {
  await db.migrate();
  const org = await db.driver.insertReturningId('INSERT INTO organisations (name) VALUES (?)', ['Split cover test']);
  const staff = async (first, last, status) => db.insert('staff', { type: 'driver', first_name: first, last_name: last, status },
    ['type', 'first_name', 'last_name', 'status'], null, org);
  const driver = await staff('Mohammed', 'Anees', 'active');
  const coverAm = await staff('Ahmed', 'Morning', 'pool');
  const coverPm = await staff('Sam', 'Afternoon', 'pool');
  const data = { code: 'SPLIT TEST', driver_id: driver, status: 'active', start_date: '2026-09-01',
    days_of_week: '1,2,3,4,5', income_per_day: 100, income_basis: 'per_journey', driver_pay_per_day: 60, pay_basis: 'per_journey' };
  const contract = await db.insert('contracts', data, Object.keys(data), null, org);

  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<body><div id="test-host"></div><div id="modal-root"></div><div id="toasts"></div></body>');
    for (const file of ['core.js', 'ui.js', 'views-main.js']) await page.addScriptTag({ path: require('node:path').join(__dirname, '../public/js', file) });
    await page.exposeFunction('testApi', async (method, url, body = {}) => {
      const parsed = new URL(url, 'http://test');
      const res = { writeHead(status) { this.status = status; }, end(value) { this.body = JSON.parse(value); } };
      await routes.handle({ req: { method }, res, path: parsed.pathname, query: Object.fromEntries(parsed.searchParams),
        body, files: [], user: { organisation_id: org, name: 'Browser tester' } });
      if (res.status >= 400) throw new Error(res.body.error);
      return res.body;
    });
    await page.evaluate(async ({ contract, driver, coverAm, coverPm, date }) => {
      api.get = url => window.testApi('GET', url);
      api.post = (url, body) => window.testApi('POST', url, body);
      api.del = url => window.testApi('DELETE', url);
      api.put = (url, body) => window.testApi('PUT', url, body);
      window.toast = (message, type) => { if (type === 'err') throw new Error(message); };
      App.refreshNavCounts = () => {};
      App.state.lookups = { drivers: [
        { id: driver, name: 'Mohammed Anees' },
        { id: coverAm, name: 'Ahmed Morning', status: 'pool' },
        { id: coverPm, name: 'Sam Afternoon', status: 'pool' }], pas: [] };
      UI.lookups = async () => App.state.lookups;
      // Helpers for the checks below.
      window.driverBox = () => [...document.querySelectorAll('fieldset')].find(f => f.querySelector('legend').textContent === 'Driver');
      window.driverButtons = () => [...window.driverBox().querySelectorAll('button')].map(b => b.textContent);
      window.clickDriver = label => [...window.driverBox().querySelectorAll('button')].find(b => b.textContent === label).click();
      window.recordCover = id => {
        const dialog = [...document.querySelectorAll('.modal')].at(-1);
        dialog.querySelector('[name=cover_staff_id]').value = String(id);
        [...dialog.querySelectorAll('button')].find(b => b.textContent === 'Record absence').click();
      };
      await Ops.dayDialog(contract, date, () => {});
    }, { contract, driver, coverAm, coverPm, date: DATE });

    // Nothing recorded: AM, PM and all day are all on offer.
    assert.deepEqual(await page.evaluate(() => window.driverButtons()), ['Absent AM', 'Absent PM', 'Absent all day']);

    // Morning: absent, covered by Ahmed.
    await page.evaluate(() => window.clickDriver('Absent AM'));
    await page.waitForFunction(() => document.querySelectorAll('.modal').length === 2);
    await page.evaluate(id => window.recordCover(id), coverAm);
    await page.waitForFunction(() => document.querySelectorAll('.modal').length === 1 && window.driverBox().textContent.includes('covered by Ahmed Morning'));
    // The PM journey is still offered; all day is not, because part of it is taken.
    assert.deepEqual(await page.evaluate(() => window.driverButtons()), ['Edit cover', 'Undo absence', 'Absent PM']);

    // Afternoon: absent, covered by Sam.
    await page.evaluate(() => window.clickDriver('Absent PM'));
    await page.waitForFunction(() => document.querySelectorAll('.modal').length === 2);
    await page.evaluate(id => window.recordCover(id), coverPm);
    await page.waitForFunction(() => document.querySelectorAll('.modal').length === 1 && window.driverBox().textContent.includes('covered by Sam Afternoon'));
    assert.deepEqual(await page.evaluate(() => window.driverButtons()), ['Edit cover', 'Undo absence', 'Edit cover', 'Undo absence'], 'every journey is now covered');

    // The engine sees two operated runs, each driven by its own cover, and the day charged in full.
    const day = await page.evaluate(({ contract, date }) => api.get(`/api/contracts/${contract}/day/${date}`), { contract, date: DATE });
    assert.equal(day.trips[0].status, 'operated');
    assert.equal(day.trips[0].driver.cover_name, 'Ahmed Morning');
    assert.equal(day.trips[1].status, 'operated');
    assert.equal(day.trips[1].driver.cover_name, 'Sam Afternoon');
    assert.equal(day.income, 100);
    assert.equal(day.trips[0].driver.pay + day.trips[1].driver.pay, 0, 'the absent driver is not paid');

    // Wages: each cover earns their journey, the absent driver nothing.
    const w = await wages.calculateWages(org, { from: DATE, to: DATE, include_zero: true });
    const due = name => (w.results.find(r => r.staff.name === name) || { totals: { amount_due: 0 } }).totals.amount_due;
    assert.equal(due('Ahmed Morning'), 30);
    assert.equal(due('Sam Afternoon'), 30);
    assert.equal(due('Mohammed Anees'), 0);

    // Edit the afternoon cover in place: new rate, paid immediately.
    const editPm = () => page.evaluate(() => [...window.driverBox().querySelectorAll('.note-box')].find(b => b.textContent.includes('Sam Afternoon')).querySelector('button').click());
    await editPm();
    await page.waitForFunction(() => document.querySelectorAll('.modal').length === 2 && [...document.querySelectorAll('.modal')].at(-1).textContent.includes('Edit cover'));
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.modal')].at(-1).querySelector('[name=cover_staff_id]').value), String(coverPm), 'the current cover is preselected');
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.modal')].at(-1).querySelector('[name=cover_pay]').value), '30', 'and the current rate shown');
    await page.evaluate(() => {
      const dialog = [...document.querySelectorAll('.modal')].at(-1);
      dialog.querySelector('[name=cover_pay]').value = '45';
      dialog.querySelector('[name=paid_immediately]').checked = true;
      [...dialog.querySelectorAll('button')].find(b => b.textContent === 'Save changes').click();
    });
    await page.waitForFunction(() => document.querySelectorAll('.modal').length === 1 && window.driverBox().textContent.includes('£45.00') && window.driverBox().textContent.includes('Paid immediately'));
    let pays = await db.all('SELECT staff_id, amount, source FROM payments WHERE organisation_id = ?', [org]);
    assert.deepEqual(pays.map(p => [p.staff_id, Number(p.amount), p.source]), [[coverPm, 45, 'cover_immediate']], 'an immediate payment is recorded for the new rate');
    let w2 = await wages.calculateWages(org, { from: DATE, to: DATE, include_zero: true });
    const sam = w2.results.find(r => r.staff.name === 'Sam Afternoon');
    assert.equal(sam.totals.gross, 45); assert.equal(sam.totals.already_paid, 45); assert.equal(sam.totals.amount_due, 0);

    // Swap the afternoon cover to a different person, paid via payroll again: the payment record goes.
    const coverAlt = await db.insert('staff', { type: 'driver', first_name: 'Lee', last_name: 'Late', status: 'pool' }, ['type', 'first_name', 'last_name', 'status'], null, org);
    await page.evaluate(id => { App.state.lookups.drivers.push({ id, name: 'Lee Late', status: 'pool' }); }, coverAlt);
    await editPm();
    await page.waitForFunction(() => document.querySelectorAll('.modal').length === 2);
    await page.evaluate(id => {
      const dialog = [...document.querySelectorAll('.modal')].at(-1);
      dialog.querySelector('[name=cover_staff_id]').value = String(id);
      dialog.querySelector('[name=paid_immediately]').checked = false;
      [...dialog.querySelectorAll('button')].find(b => b.textContent === 'Save changes').click();
    }, coverAlt);
    await page.waitForFunction(() => document.querySelectorAll('.modal').length === 1 && window.driverBox().textContent.includes('covered by Lee Late'));
    pays = await db.all('SELECT id FROM payments WHERE organisation_id = ?', [org]);
    assert.equal(pays.length, 0, 'the immediate payment is reversed when cover goes back to payroll');
    const dayAfter = await page.evaluate(({ contract, date }) => api.get(`/api/contracts/${contract}/day/${date}`), { contract, date: DATE });
    assert.equal(dayAfter.trips[1].driver.cover_name, 'Lee Late');
    assert.equal(dayAfter.trips[1].driver.cover_pay, 45, 'the rate is kept when only the person changes');
    w2 = await wages.calculateWages(org, { from: DATE, to: DATE, include_zero: true });
    assert.equal(w2.results.find(r => r.staff.name === 'Lee Late').totals.amount_due, 45);
    assert.equal((w2.results.find(r => r.staff.name === 'Sam Afternoon') || { totals: { amount_due: 0 } }).totals.amount_due, 0);

    // The server refuses a second absence on a journey already covered.
    await assert.rejects(
      page.evaluate(({ contract, date }) => api.post('/api/exceptions', { contract_id: contract, date, type: 'staff_absence', role: 'driver', leg: 'DAY' }), { contract, date: DATE }),
      /already recorded absent AM/);
    // Nor can the absent driver be named as their own cover.
    await assert.rejects(
      page.evaluate(({ id, driver }) => api.put('/api/exceptions/' + id, { cover_staff_id: driver, cover_pay: 30 }), { id: dayAfter.trips[1].driver.exception_id, driver }),
      /cannot cover their own journey/);

    // Undoing the morning absence offers the AM journey again, still without all day.
    await page.evaluate(() => window.clickDriver('Undo absence'));
    await page.waitForFunction(() => !window.driverBox().textContent.includes('Ahmed Morning'));
    assert.deepEqual(await page.evaluate(() => window.driverButtons()), ['Edit cover', 'Undo absence', 'Absent AM']);

    assert.deepEqual(errors, []);
    console.log('Split cover browser checks passed: AM then PM absence with different covers, per-journey cover pay, cover edited in place with the payment record following, clash refused, undo re-offers the journey.');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.close());
