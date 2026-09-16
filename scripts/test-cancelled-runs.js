'use strict';
// Exercise the real browser controls and API handlers against an in-memory DB.
process.env.H2S_DB_DRIVER = 'sqlite';
process.env.H2S_DB = ':memory:';
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer-core');
const db = require('../server/db');
const routes = require('../server/routes');

async function main() {
  await db.migrate();
  const org = await db.driver.insertReturningId('INSERT INTO organisations (name) VALUES (?)', ['Cancellation test']);
  const driver = await db.insert('staff', { type: 'driver', first_name: 'Test', last_name: 'Driver' }, ['type', 'first_name', 'last_name'], null, org);
  const data = { code: 'CANCEL TEST', driver_id: driver, status: 'active', start_date: '2026-09-01',
    days_of_week: '1,2,3,4,5', income_per_day: 100, income_basis: 'per_journey', driver_pay_per_day: 60, pay_basis: 'per_day' };
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
      if (parsed.pathname === '/api/dashboard') parsed.searchParams.set('date', '2026-09-16');
      const res = { writeHead(status) { this.status = status; }, end(value) { this.body = JSON.parse(value); } };
      await routes.handle({ req: { method }, res, path: parsed.pathname, query: Object.fromEntries(parsed.searchParams),
        body, files: [], user: { organisation_id: org, name: 'Browser tester' } });
      if (res.status >= 400) throw new Error(res.body.error);
      return res.body;
    });
    await page.evaluate(async ({ contract, driver }) => {
      api.get = url => window.testApi('GET', url);
      api.post = (url, body) => window.testApi('POST', url, body);
      api.del = url => window.testApi('DELETE', url);
      window.toast = (message, type) => { if (type === 'err') throw new Error(message); };
      App.refreshNavCounts = () => {};
      App.state.lookups = { drivers: [{ id: driver, name: 'Test Driver' }], pas: [] };
      UI.lookups = async () => App.state.lookups;
      await Ops.dayDialog(contract, '2026-09-16', () => {});
    }, { contract, driver });
    await page.evaluate(() => [...document.querySelectorAll('.trip-head button')].find(button => button.textContent === 'Run cancelled').click());
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.modal')].at(-1).querySelector('[name=which]').selectedIndex), 1, 'clicked run is preselected');
    await page.evaluate(() => {
      const dialog = [...document.querySelectorAll('.modal')].at(-1);
      dialog.querySelector('[name=reason]').value = 'Illness';
      dialog.querySelector('[name=note]').value = 'Child unwell';
      [...dialog.querySelectorAll('button')].find(button => button.textContent === 'Mark run cancelled').click();
    });
    await page.waitForFunction(() => document.querySelectorAll('.modal').length === 1 && document.querySelector('.modal').textContent.includes('Illness: Child unwell'));
    const cancelled = await page.evaluate(contract => api.get('/api/contracts/' + contract + '/day/2026-09-16'), contract);
    assert.equal(cancelled.trips[0].driver.pay, 0);
    assert.equal(cancelled.trips[1].driver.pay, 30);
    assert.equal(cancelled.income, 100);
    await page.evaluate(async () => document.getElementById('test-host').append(await App.views.dashboard()));
    const dashboardText = await page.$eval('#test-host', host => host.textContent);
    assert(dashboardText.includes('Runs cancelled today (1)'));
    assert(dashboardText.includes('Illness: Child unwell'));
    assert(dashboardText.includes('Driver pay saved'));
    await page.evaluate(() => [...document.querySelectorAll('.trip-head button')].find(button => button.textContent === 'Undo cancellation').click());
    await page.waitForFunction(() => ![...document.querySelectorAll('.trip-head button')].some(button => button.textContent === 'Undo cancellation'));
    const restored = await page.evaluate(contract => api.get('/api/contracts/' + contract + '/day/2026-09-16'), contract);
    assert.equal(restored.trips[0].driver.pay, 30);
    assert.equal(restored.cancelled_trips, 0);
    assert.deepEqual(errors, []);
    console.log('Cancelled run browser checks passed: reason, selected run, fixed-day pay deduction, retained council income, dashboard and undo.');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.close());
