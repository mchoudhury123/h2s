'use strict';
process.env.H2S_DB_DRIVER = 'sqlite';
process.env.H2S_DB = ':memory:';
process.env.H2S_STRICT_TENANCY = '1';
const assert = require('node:assert/strict');
const db = require('../server/db');
const routes = require('../server/routes');
const { dashboard } = require('../server/services/dashboard');
const puppeteer = require('puppeteer-core');
(async () => {
  await db.migrate();
  await db.migrate();
  const org = await db.insert('organisations', { name: 'Holiday test' }, ['name']);
  const other = await db.insert('organisations', { name: 'Other firm' }, ['name']);
  const staff = await db.insert('staff', { type: 'driver', first_name: 'Test', last_name: 'Driver' }, ['type', 'first_name', 'last_name'], null, org);
  const pa = await db.insert('staff', { type: 'pa', first_name: 'Test', last_name: 'PA' }, ['type', 'first_name', 'last_name'], null, org);
  const call = async (method, path, body = {}, organisation = org) => {
    const res = { writeHead(status) { this.status = status; }, end(value) { this.body = JSON.parse(value); } };
    await routes.handle({ req: { method }, res, path, query: {}, body, user: { organisation_id: organisation, name: 'Tester' } });
    return { status: res.status, ...res.body };
  };
  const url = `/api/staff/${staff}/holidays`;
  const dates = { start_date: '2026-12-01', end_date: '2026-12-05', note: 'Arrange cover' };
  const saved = await call('POST', url, dates);
  assert.equal(saved.status, 201);
  assert.equal((await call('POST', url, dates)).status, 400);
  assert.equal((await call('POST', url, { start_date: '2026-02-30', end_date: '2026-03-02' })).status, 400);
  assert.equal((await call('POST', url, { start_date: '2026-12-05', end_date: '2026-12-01' })).status, 400);
  assert.equal((await call('POST', url, dates, other)).status, 404);
  assert.equal((await call('PUT', url + '/' + saved.id, dates, other)).status, 404);
  assert.equal((await call('DELETE', url + '/' + saved.id, {}, other)).status, 404);
  for (const [date, count] of [['2026-11-25', 0], ['2026-11-26', 1], ['2026-11-30', 1], ['2026-12-01', 1], ['2026-12-05', 1], ['2026-12-06', 0]]) {
    const d = await dashboard(org, date);
    assert.equal(d.holidays.length, count, date);
    assert.equal(d.alerts.filter(a => a.category === 'Staff holiday').length, count, date);
    if (count) assert.match(d.alerts.find(a => a.category === 'Staff holiday').href, /&from=/);
  }
  assert.equal((await dashboard(other, '2026-11-26')).holidays.length, 0);
  assert.equal((await call('PUT', url + '/' + saved.id, { ...dates, start_date: '2026-12-10', end_date: '2026-12-15' })).status, 200);
  assert.equal((await dashboard(org, '2026-11-26')).holidays.length, 0);
  assert.equal((await call('POST', `/api/staff/${pa}/holidays`, dates)).status, 201);
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setContent('<body><div id="host"></div><div id="modal-root"></div><div id="toasts"></div></body>');
    for (const file of ['core.js', 'icons.js', 'ui.js', 'views-records.js']) await page.addScriptTag({ path: require('node:path').join(__dirname, '../public/js', file) });
    await page.exposeFunction('testApi', async (method, path, body) => {
      const r = await call(method, path, body);
      if (r.status >= 400) throw new Error(r.error);
      return r;
    });
    await page.evaluate(async staff => {
      App.can = () => true;
      api.get = path => window.testApi('GET', path);
      api.post = (path, body) => window.testApi('POST', path, body);
      api.put = (path, body) => window.testApi('PUT', path, body);
      Router.handle = () => {};
      document.getElementById('host').appendChild(await App.views.staffDetail({ params: { id: staff } }));
      Rec.holidayEditor({ id: staff, name: 'Test Driver' }, null, () => {});
      document.querySelector('[name="start_date"]').value = '2027-01-04';
      document.querySelector('[name="end_date"]').value = '2027-01-08';
      [...document.querySelectorAll('.modal button')].find(b => b.textContent === 'Save').click();
    }, staff);
    await page.waitForFunction(() => !document.querySelector('.modal'));
    assert.equal((await db.all('SELECT * FROM staff_holidays WHERE organisation_id = ? AND staff_id = ?', [org, staff])).length, 2);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
  assert.equal((await call('DELETE', url + '/' + saved.id)).status, 200);
  assert.equal((await call('DELETE', url + '/' + saved.id)).status, 404);
  console.log('Holiday API, reminder boundaries, tenant isolation, migration and browser form passed.');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => db.close());
