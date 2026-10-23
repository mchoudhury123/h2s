'use strict';
process.env.H2S_DB_DRIVER = 'sqlite';
process.env.H2S_DB = ':memory:';
process.env.H2S_STRICT_TENANCY = '1';
const assert = require('node:assert/strict');
const db = require('../server/db');
const routes = require('../server/routes');
const wages = require('../server/services/wages');
const puppeteer = require('puppeteer-core');
const period = { from: '2026-10-19', to: '2026-10-23' };
(async () => {
  await db.migrate();
  // Upgrade an existing installation and prove rerunning it is harmless.
  await db.run('ALTER TABLE staff DROP COLUMN cash_payment');
  await db.run('DELETE FROM h2s_schema_version');
  await db.migrate(); await db.migrate();
  const org = await db.insert('organisations', { name: 'Cash test' }, ['name']);
  const other = await db.insert('organisations', { name: 'Other firm' }, ['name']);
  const add = (table, data, organisation = org) => db.insert(table, data, Object.keys(data), null, organisation);
  const driver = await add('staff', { type: 'driver', first_name: 'Cash', last_name: 'Driver', cash_payment: 1 });
  const pa = await add('staff', { type: 'pa', first_name: 'Bank', last_name: 'PA' });
  await add('contracts', { code: 'CASH', driver_id: driver, pa_id: pa, requires_pa: 1, status: 'active', start_date: '2026-01-01',
    days_of_week: '1,2,3,4,5', driver_pay_per_day: 60.25, pa_pay_per_day: 40, income_per_day: 150 });
  await add('payments', { staff_id: driver, work_date: period.from, amount: 50, method: 'Cash' });
  const call = async (method, path, body = {}, organisation = org) => {
    const url = new URL(path, 'http://test');
    const res = { writeHead(status) { this.status = status; }, end(value) { this.body = JSON.parse(value); } };
    await routes.handle({ req: { method }, res, path: url.pathname, query: Object.fromEntries(url.searchParams), body, files: [], user: { organisation_id: organisation, name: 'Tester' } });
    return { status: res.status, data: res.body };
  };
  const calculate = () => wages.calculateWages(org, { ...period, all_staff: true });
  const initial = await calculate();
  assert.equal(initial.totals.cash_due, 251.3);
  assert.equal(initial.totals.bank_due, 200);
  assert.equal(initial.totals.total_due, 451.3);
  assert.equal((await call('PUT', '/api/staff/' + driver, { cash_payment: 0 }, other)).status, 404);
  assert.equal((await wages.calculateWages(other, period)).totals.cash_due, 0);
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage(); const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setContent('<body><div id="view"></div><div id="modal-root"></div><div id="toasts"></div></body>');
    for (const file of ['core.js', 'icons.js', 'ui.js', 'views-records.js', 'views-finance.js']) await page.addScriptTag({ path: require('node:path').join(__dirname, '../public/js', file) });
    await page.exposeFunction('testApi', async (method, path, body) => {
      const r = await call(method, path, body); if (r.status >= 400) throw new Error(r.data.error); return r.data;
    });
    await page.evaluate(async period => {
      App.can = () => true;
      api.get = (url, params) => window.testApi('GET', params ? url + '?' + new URLSearchParams(params) : url);
      api.put = (url, body) => window.testApi('PUT', url, body);
      api.post = (url, body) => window.testApi('POST', url, body);
      UI.lookups = () => api.get('/api/lookups');
      Router.handle = async () => { const view = document.getElementById('view'); view.replaceChildren(await App.views.wages({ query: period })); };
      await Router.handle();
      window.cashBox = () => document.querySelector('[aria-label="Pay Cash Driver in cash"]');
      if (!window.cashBox().checked) throw new Error('Cash choice was not loaded');
      window.cashBox().click();
    }, period);
    await page.waitForFunction(() => window.cashBox() && !window.cashBox().checked && !window.cashBox().disabled);
    assert.equal((await calculate()).totals.cash_due, 0);
    await page.evaluate(() => window.cashBox().click());
    await page.waitForFunction(() => window.cashBox() && window.cashBox().checked && !window.cashBox().disabled);
    assert.equal((await calculate()).totals.cash_due, 251.3);
    await page.evaluate(() => {
      [...document.querySelectorAll('#view button')].find(b => b.textContent === 'Mark period as paid').click();
      if (!document.querySelector('.modal').textContent.includes('Cash:')) throw new Error('Cash missing from confirmation');
      [...document.querySelectorAll('.modal button')].find(b => b.textContent === 'Yes, record as paid').click();
    });
    await page.waitForFunction(() => document.getElementById('view').textContent.includes('No cash payments due for this period'));
    assert.deepEqual(errors, []);
    // The profile editor must also expose the persistent cash checkbox.
    await page.evaluate(async driver => {
      Rec.staffEditor(await api.get('/api/staff/' + driver));
      if (!document.querySelector('[name="cash_payment"]').checked) throw new Error('Staff editor lost cash preference');
      UI.closeAll();
    }, driver);
  } finally { await browser.close(); }
  const payments = await db.all("SELECT * FROM payments WHERE organisation_id = ? AND source = 'payroll'", [org]);
  assert.equal(payments.find(p => p.staff_id === driver).method, 'Cash');
  assert.equal(payments.find(p => p.staff_id === pa).method, 'Bank transfer');
  assert.equal((await calculate()).totals.total_due, 0);
  const history = (await call('GET', '/api/payroll-runs')).data;
  assert.equal(history[0].cash_total, 251.3);
  await call('PUT', '/api/staff/' + driver, { cash_payment: 0 });
  assert.equal((await call('GET', '/api/payroll-runs')).data[0].cash_total, 251.3, 'historical cash total does not follow current preference');
  const detail = (await call('GET', '/api/payroll-runs/' + history[0].id)).data;
  assert.equal(detail.cash_total, 251.3);
  await call('DELETE', '/api/payroll-runs/' + history[0].id);
  assert.equal((await calculate()).totals.bank_due, 451.3, 'undo restores wages using current payment preference');
  const filtered = await call('POST', '/api/payroll-runs', { ...period, staff_ids: [pa] });
  assert.equal(filtered.data.total, 200, 'payroll pays only staff included in the calculation');
  assert.equal((await calculate()).totals.bank_due, 251.3);
  console.log('Cash wages: migration, saved preferences, split totals, partial payments, browser checkbox, payroll methods, history, undo, filtering and tenant isolation passed.');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => db.close());
