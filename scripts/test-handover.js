'use strict';
// A driver hands a route over from a date, recorded through the real
// "Change driver / PA" dialog against an in-memory DB. The outgoing driver
// keeps his earlier days, the incoming one is paid from the date, and the
// change can be removed again. Run: npm run test:handover
process.env.H2S_DB_DRIVER = 'sqlite';
process.env.H2S_DB = ':memory:';
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');
const db = require('../server/db');
const routes = require('../server/routes');
const wages = require('../server/services/wages');

const WEEK = { from: '2026-09-07', to: '2026-09-11' };   // a clean Monday to Friday
const HANDOVER = '2026-09-10';                             // the Thursday

async function main() {
  await db.migrate();
  const org = await db.driver.insertReturningId('INSERT INTO organisations (name) VALUES (?)', ['Handover test']);
  const staff = async (type, first, last, status) => db.insert('staff', { type, first_name: first, last_name: last, status },
    ['type', 'first_name', 'last_name', 'status'], null, org);
  const john = await staff('driver', 'John', 'Normal', 'active');
  const sam = await staff('driver', 'Sam', 'Second', 'pool');
  const linda = await staff('pa', 'Linda', 'Assist', 'active');
  const data = { code: 'HANDOVER TEST', driver_id: john, pa_id: linda, requires_pa: 1, status: 'active', start_date: '2026-09-01',
    days_of_week: '1,2,3,4,5', income_per_day: 100, income_basis: 'per_journey', driver_pay_per_day: 60, pa_pay_per_day: 40, pay_basis: 'per_journey' };
  const contract = await db.insert('contracts', data, Object.keys(data), null, org);
  const due = async name => {
    const w = await wages.calculateWages(org, { ...WEEK, include_zero: true });
    return (w.results.find(r => r.staff.name === name) || { totals: { amount_due: 0 } }).totals.amount_due;
  };

  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<body><div id="test-host"></div><div id="modal-root"></div><div id="toasts"></div></body>');
    for (const file of ['core.js', 'icons.js', 'ui.js', 'views-records.js']) await page.addScriptTag({ path: require('node:path').join(__dirname, '../public/js', file) });
    await page.exposeFunction('testApi', async (method, url, body = {}) => {
      const parsed = new URL(url, 'http://test');
      const res = { writeHead(status) { this.status = status; }, end(value) { this.body = JSON.parse(value); } };
      await routes.handle({ req: { method }, res, path: parsed.pathname, query: Object.fromEntries(parsed.searchParams),
        body, files: [], user: { organisation_id: org, name: 'Browser tester' } });
      if (res.status >= 400) throw new Error(res.body.error);
      return res.body;
    });
    await page.evaluate(({ john, sam, linda }) => {
      api.get = url => window.testApi('GET', url);
      api.post = (url, body) => window.testApi('POST', url, body);
      api.del = url => window.testApi('DELETE', url);
      api.put = (url, body) => window.testApi('PUT', url, body);
      window.toast = (message, type) => { if (type === 'err') throw new Error(message); };
      App.can = () => true;
      App.refreshNavCounts = () => {};
      App.state.lookups = {
        drivers: [{ id: john, name: 'John Normal' }, { id: sam, name: 'Sam Second', status: 'pool' }],
        pas: [{ id: linda, name: 'Linda Assist' }],
      };
      UI.lookups = async () => App.state.lookups;
      UI.invalidateLookups = () => {};
      window.reloads = 0;
      window.dialog = () => [...document.querySelectorAll('.modal')].at(-1);
      window.buttons = () => [...window.dialog().querySelectorAll('button')].map(b => b.textContent);
      window.click = label => [...window.dialog().querySelectorAll('button')].find(b => b.textContent === label).click();
      window.openDialog = () => Rec.staffChange({ id: window.contractId, code: 'HANDOVER TEST' }, () => { window.reloads++; });
    }, { john, sam, linda });
    await page.evaluate(id => { window.contractId = id; }, contract);

    // The dialog opens showing who holds each seat now and no history yet.
    await page.evaluate(() => window.openDialog());
    await page.waitForFunction(() => document.querySelectorAll('.modal').length === 1);
    const text = await page.evaluate(() => window.dialog().textContent);
    assert.ok(text.includes('Change driver or PA — HANDOVER TEST'));
    assert.ok(text.includes('Driver (now John Normal)'), 'the driver seat names John');
    assert.ok(text.includes('PA (now Linda Assist)'), 'the PA seat names Linda');
    assert.ok(text.includes('No handover recorded yet'), 'nothing recorded');
    assert.deepEqual(await page.evaluate(() => [...window.dialog().querySelectorAll('select')][1].options.length), 3, 'nobody, John and Sam are offered for the driver seat');

    // Sam takes the route from Thursday. The date is in the past, so it asks first.
    await page.evaluate(({ sam, from }) => {
      const [, who] = window.dialog().querySelectorAll('select');
      who.value = String(sam);
      window.dialog().querySelector('input[type=date]').value = from;
      window.dialog().querySelector('input[type=text]').value = 'John leaving';
      window.click('Record handover');
    }, { sam, from: HANDOVER });
    await page.waitForFunction(() => document.querySelectorAll('.modal').length === 2 && window.dialog().textContent.includes('is in the past'));
    await page.evaluate(() => window.click('Record anyway'));
    await page.waitForFunction(() => document.querySelectorAll('.modal').length === 0 && window.reloads === 1);
    assert.deepEqual(errors, [], 'no page errors');

    const after = await db.get('SELECT driver_id, pa_id FROM contracts WHERE id = ? AND organisation_id = ?', [contract, org]);
    assert.equal(after.driver_id, sam, 'the contract now names Sam');
    assert.equal(after.pa_id, linda, 'the PA is untouched');
    const rows = await db.all('SELECT staff_id, effective_from, note FROM contract_staff WHERE organisation_id = ? AND contract_id = ? ORDER BY effective_from', [org, contract]);
    assert.deepEqual(rows.map(r => [r.staff_id, r.effective_from]), [[john, '2026-09-01'], [sam, HANDOVER]], 'an opening row keeps John from the contract start');
    assert.equal(rows[1].note, 'John leaving');
    assert.equal(await due('John Normal'), 180, 'John is owed Monday to Wednesday');
    assert.equal(await due('Sam Second'), 120, 'Sam is owed Thursday and Friday');
    assert.equal(await due('Linda Assist'), 200, 'Linda is owed the week');

    // The contract page knows who holds the seat and who came before.
    let detail = await page.evaluate(id => api.get('/api/contracts/' + id), contract);
    assert.equal(detail.staffing.driver.staff_name, 'Sam Second');
    assert.equal(detail.staffing.driver.since, HANDOVER);
    assert.equal(detail.staffing.driver.previous.staff_name, 'John Normal');
    assert.equal(detail.staffing.driver.previous.until, '2026-09-09');
    assert.equal(detail.staffing.pa.changes, 0);

    // An absence recorded on either side of the handover belongs to the right person.
    const wedAbsence = await page.evaluate(({ id }) => api.post('/api/exceptions', { date: '2026-09-09', type: 'staff_absence', role: 'driver', leg: 'DAY', contract_id: id }), { id: contract });
    assert.equal(wedAbsence[0].staff_id, john, "Wednesday's absence is John's");
    const thuAbsence = await page.evaluate(({ id, date }) => api.post('/api/exceptions', { date, type: 'staff_absence', role: 'driver', leg: 'DAY', contract_id: id }), { id: contract, date: HANDOVER });
    assert.equal(thuAbsence[0].staff_id, sam, "Thursday's is Sam's");
    assert.equal(await due('John Normal'), 120, 'John loses Wednesday');
    assert.equal(await due('Sam Second'), 60, 'Sam loses Thursday');
    await db.run('DELETE FROM exceptions WHERE organisation_id = ? AND contract_id = ?', [org, contract]);

    // Handing the seat to the same person again is refused.
    await assert.rejects(
      page.evaluate(({ id, sam }) => api.post(`/api/contracts/${id}/staff`, { role: 'driver', staff_id: sam, effective_from: '2026-09-14' }), { id: contract, sam }),
      /Sam Second already holds the driver seat/);

    // A change dated ahead: the page still says John today, with Sam next.
    await db.run('DELETE FROM contract_staff WHERE organisation_id = ? AND contract_id = ?', [org, contract]);
    await db.run('UPDATE contracts SET driver_id = ? WHERE id = ? AND organisation_id = ?', [john, contract, org]);
    const ahead = await page.evaluate(({ id, sam }) => api.post(`/api/contracts/${id}/staff`, { role: 'driver', staff_id: sam, effective_from: '2099-01-05' }), { id: contract, sam });
    assert.equal(ahead.rewrites_history, false);
    detail = await page.evaluate(id => api.get('/api/contracts/' + id), contract);
    assert.equal(detail.driver_id, sam, 'the contract names the incoming driver');
    assert.equal(detail.staffing.driver.staff_name, 'John Normal', 'but John holds the seat today');
    assert.equal(detail.staffing.driver.upcoming.staff_name, 'Sam Second');
    assert.equal(detail.staffing.driver.upcoming.effective_from, '2099-01-05');
    assert.equal(await due('John Normal'), 300, 'and is paid the whole week');

    // Removing the change from the dialog hands the seat back.
    await page.evaluate(() => window.openDialog());
    await page.waitForFunction(() => document.querySelectorAll('.modal').length === 1 && window.dialog().textContent.includes('Recorded:'));
    const history = await page.evaluate(() => [...window.dialog().querySelectorAll('.sd-versions .badge')].map(b => b.textContent.replace('×', '').trim()));
    assert.equal(history.length, 2);
    assert.ok(history[0].startsWith('Sam Second from'), 'the handover is listed first');
    assert.ok(history[1].startsWith('John Normal before the first change') && history[1].endsWith('(in force)'), 'John is in force');
    await page.evaluate(() => [...window.dialog().querySelectorAll('.sd-versions .badge')][0].querySelector('button').click());
    await page.waitForFunction(() => document.querySelectorAll('.modal').length === 2 && window.dialog().textContent.includes('Remove the change dated'));
    await page.evaluate(() => window.click('Confirm'));
    await page.waitForFunction(() => document.querySelectorAll('.modal').length === 0 && window.reloads === 2);
    assert.equal((await db.all('SELECT id FROM contract_staff WHERE organisation_id = ? AND contract_id = ?', [org, contract])).length, 0, 'the opening row goes with the last change');
    assert.equal((await db.get('SELECT driver_id FROM contracts WHERE id = ? AND organisation_id = ?', [contract, org])).driver_id, john, 'John is the driver again');
    assert.deepEqual(errors, [], 'no page errors');
    console.log('test-handover: all checks passed');
  } finally {
    await browser.close();
    await db.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
