'use strict';
// A contract's rates change from a date, recorded through the real
// "Change rates" dialog against an in-memory DB. Days before the date keep
// their old rates in wages; days from it use the new ones. Run: npm run test:rates
process.env.H2S_DB_DRIVER = 'sqlite';
process.env.H2S_DB = ':memory:';
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');
const db = require('../server/db');
const routes = require('../server/routes');
const wages = require('../server/services/wages');

const WEEK = { from: '2026-09-07', to: '2026-09-11' };   // a clean Monday to Friday
const FROM = '2026-09-10';                                // the Thursday

async function main() {
  await db.migrate();
  const org = await db.driver.insertReturningId('INSERT INTO organisations (name) VALUES (?)', ['Rates test']);
  const staff = async (type, first, last) => db.insert('staff', { type, first_name: first, last_name: last, status: 'active' },
    ['type', 'first_name', 'last_name', 'status'], null, org);
  const john = await staff('driver', 'John', 'Normal');
  const linda = await staff('pa', 'Linda', 'Assist');
  const data = { code: 'RATES TEST', driver_id: john, pa_id: linda, requires_pa: 1, status: 'active', start_date: '2026-09-01',
    days_of_week: '1,2,3,4,5', income_per_day: 100, income_basis: 'per_journey', driver_pay_per_day: 60, pa_pay_per_day: 40, pay_basis: 'per_journey' };
  const contract = await db.insert('contracts', data, Object.keys(data), null, org);
  const due = async (name, range = WEEK) => {
    const w = await wages.calculateWages(org, { ...range, include_zero: true });
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
    await page.evaluate(id => {
      api.get = url => window.testApi('GET', url);
      api.post = (url, body) => window.testApi('POST', url, body);
      api.del = url => window.testApi('DELETE', url);
      api.put = (url, body) => window.testApi('PUT', url, body);
      window.toast = (message, type) => { if (type === 'err') throw new Error(message); };
      App.can = () => true;
      App.refreshNavCounts = () => {};
      window.reloads = 0;
      window.dialog = () => [...document.querySelectorAll('.modal')].at(-1);
      window.click = label => [...window.dialog().querySelectorAll('button')].find(b => b.textContent === label).click();
      window.inputs = () => [...window.dialog().querySelectorAll('input[type=number]')];
      window.openDialog = async () => {
        const c = await api.get('/api/contracts/' + id);
        await Rec.rateChange(c, () => { window.reloads++; });
      };
    }, contract);

    // The dialog opens with today's figures filled in and nothing recorded.
    await page.evaluate(() => window.openDialog());
    await page.waitForFunction(() => document.querySelectorAll('.modal').length === 1);
    assert.ok((await page.evaluate(() => window.dialog().textContent)).includes('No rate change recorded yet'));
    assert.deepEqual(await page.evaluate(() => window.inputs().map(i => i.value)), ['100.00', '60.00', '40.00', '0.00'], 'the four figures are prefilled');

    // Driver pay to 75 and income to 120 from the Thursday. A past date asks first.
    await page.evaluate(from => {
      window.dialog().querySelector('input[type=date]').value = from;
      window.dialog().querySelector('input[type=date]').dispatchEvent(new Event('change'));
      const [income, driver] = window.inputs();
      income.value = '120'; driver.value = '75';
      window.dialog().querySelector('input[type=text]').value = 'New driver rate';
      window.click('Record new rates');
    }, FROM);
    await page.waitForFunction(() => document.querySelectorAll('.modal').length === 2 && window.dialog().textContent.includes('is in the past'));
    await page.evaluate(() => window.click('Record anyway'));
    await page.waitForFunction(() => document.querySelectorAll('.modal').length === 0 && window.reloads === 1);
    assert.deepEqual(errors, [], 'no page errors');

    const rows = await db.all('SELECT effective_from, income_per_day, driver_pay_per_day, pa_pay_per_day, note FROM contract_rates WHERE organisation_id = ? AND contract_id = ? ORDER BY effective_from', [org, contract]);
    assert.deepEqual(rows.map(r => [r.effective_from, Number(r.income_per_day), Number(r.driver_pay_per_day), Number(r.pa_pay_per_day)]),
      [['2026-09-01', 100, 60, 40], [FROM, 120, 75, 40]], 'an opening row keeps the old rates from the contract start; the PA rate was kept');
    assert.equal(rows[1].note, 'New driver rate');
    const after = await db.get('SELECT income_per_day, driver_pay_per_day FROM contracts WHERE id = ? AND organisation_id = ?', [contract, org]);
    assert.deepEqual([Number(after.income_per_day), Number(after.driver_pay_per_day)], [120, 75], 'the contract carries the latest rates');
    assert.equal(await due('John Normal'), 330, 'John: three days at 60, two at 75');
    assert.equal(await due('John Normal', { from: '2026-09-07', to: '2026-09-09' }), 180, 'the days before the change are worth what they were');
    assert.equal(await due('Linda Assist'), 200, 'the PA is untouched');

    // The contract page reports the rates in force and what came before.
    let detail = await page.evaluate(id => api.get('/api/contracts/' + id), contract);
    assert.equal(detail.rate_summary.in_force.driver_pay_per_day, 75);
    assert.equal(detail.rate_summary.since, FROM);
    assert.equal(detail.rate_summary.previous.driver_pay_per_day, 60);
    assert.equal(detail.rate_summary.previous.until, '2026-09-09');
    assert.equal(detail.rate_summary.changes, 1);

    // Cover without an agreed figure on either side of the change takes that day's rate.
    const wed = await page.evaluate(({ id }) => api.post('/api/exceptions', { date: '2026-09-09', type: 'staff_absence', role: 'driver', leg: 'DAY', contract_id: id, cover_staff_id: id ? undefined : null }), { id: contract });
    assert.equal(wed[0].staff_id, john);
    await db.run('DELETE FROM exceptions WHERE organisation_id = ? AND contract_id = ?', [org, contract]);

    // Reopen: the dialog prefills with the rates in force on the chosen date, and lists the change.
    await page.evaluate(() => window.openDialog());
    await page.waitForFunction(() => document.querySelectorAll('.modal').length === 1 && window.dialog().textContent.includes('Recorded:'));
    assert.deepEqual(await page.evaluate(() => window.inputs().map(i => i.value)), ['120.00', '75.00', '40.00', '0.00'], 'today is after the change, so the new rates show');
    await page.evaluate(() => {
      const d = window.dialog().querySelector('input[type=date]');
      d.value = '2026-09-08'; d.dispatchEvent(new Event('change'));
    });
    assert.deepEqual(await page.evaluate(() => window.inputs().map(i => i.value)), ['100.00', '60.00', '40.00', '0.00'], 'an earlier date shows the old rates');
    const badges = await page.evaluate(() => [...window.dialog().querySelectorAll('.sd-versions .badge')].map(b => b.textContent.replace('×', '').trim()));
    assert.equal(badges.length, 2);
    assert.ok(badges[0].startsWith('From ') && badges[0].includes('Driver pay £75.00') && badges[0].endsWith('(in force)'), badges[0]);
    assert.ok(badges[1].startsWith('Before the first change') && badges[1].includes('Driver pay £60.00'), badges[1]);

    // Remove the change from the dialog: everything goes back.
    await page.evaluate(() => [...window.dialog().querySelectorAll('.sd-versions .badge')][0].querySelector('button').click());
    await page.waitForFunction(() => document.querySelectorAll('.modal').length === 2 && window.dialog().textContent.includes('Remove the rate change dated'));
    await page.evaluate(() => window.click('Confirm'));
    await page.waitForFunction(() => document.querySelectorAll('.modal').length === 0 && window.reloads === 2);
    assert.equal((await db.all('SELECT id FROM contract_rates WHERE organisation_id = ? AND contract_id = ?', [org, contract])).length, 0, 'the opening row goes with the last change');
    const restored = await db.get('SELECT income_per_day, driver_pay_per_day FROM contracts WHERE id = ? AND organisation_id = ?', [contract, org]);
    assert.deepEqual([Number(restored.income_per_day), Number(restored.driver_pay_per_day)], [100, 60], 'the contract is back on the old rates');
    assert.equal(await due('John Normal'), 300);
    assert.deepEqual(errors, [], 'no page errors');
    console.log('test-rates: all checks passed');
  } finally {
    await browser.close();
    await db.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
