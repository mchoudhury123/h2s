/**
 * Drives the weekly schedule and child timetable screens in a real browser.
 *
 * Sets up a Friday with three journeys and a child who does not attend on a
 * Wednesday, then checks the contract page, the calendar and the exception
 * dialog all show it. Everything it creates is removed at the end.
 *
 * Run with the server already running:  npm run test:schedules
 */
'use strict';
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE || 'http://localhost:4000';
const SHOT_DIR = process.env.SHOT_DIR || path.join(__dirname, '..', 'shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

const errors = [];
let pass = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function ok(cond, label) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { errors.push(label); console.log('  FAIL ' + label); }
}
function section(t) { console.log('\n' + t); }

/** The next Friday at least a week away, so it never lands on a past date. */
function nextFriday() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7);
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
function isoToday() { return new Date().toISOString().slice(0, 10); }

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--window-size=1500,1000'], defaultViewport: { width: 1500, height: 1000 },
  });
  const page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error' && !/401 \(Unauthorized\)/.test(m.text())) errors.push('CONSOLE: ' + m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  const shot = n => page.screenshot({ path: path.join(SHOT_DIR, n + '.png') });
  const clickTab = label => page.evaluate(l => {
    const b = [...document.querySelectorAll('.tabs button')].find(x => x.textContent.startsWith(l));
    if (b) b.click();
    return !!b;
  }, label);

  let cleanup = null;
  try {
    section('Signing in');
    await page.goto(BASE, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.login-card', { timeout: 25000 });
    await page.type('input[name=email]', process.env.USER_EMAIL || 'demo@northgate-transport.example');
    await page.type('input[name=password]', process.env.USER_PASS || 'demo1234');
    await Promise.all([page.click('button[type=submit]'), page.waitForSelector('#app', { timeout: 25000 })]);
    await page.waitForSelector('.stats', { timeout: 25000 });
    ok(true, 'signed in');

    // A contract with at least two children, so a split collection means something.
    const ids = await page.evaluate(async () => {
      const contracts = await (await fetch('/api/contracts?status=active')).json();
      const c = contracts.find(x => x.child_count >= 2) || contracts[0];
      const kids = await (await fetch('/api/children?contract_id=' + c.id)).json();
      return { contract: c.id, code: c.code, child: kids[0] ? kids[0].id : null, childName: kids[0] ? kids[0].name : null };
    });
    ok(!!ids.contract && !!ids.child, `using contract ${ids.code} and ${ids.childName}`);
    cleanup = ids;

    // ---------------------------------------------------------------
    section('1. Setting up a Friday with three journeys');
    await page.goto(`${BASE}/#/contracts/${ids.contract}`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.tabs', { timeout: 20000 });
    ok(await clickTab('Weekly schedule'), 'the contract has a Weekly schedule tab');
    await page.waitForSelector('.weekgrid', { timeout: 20000 });
    await sleep(300);
    const before = await page.$eval('.weekgrid', e => e.textContent);
    ok(/MON2 Trips|MON.*2 Trips/.test(before.replace(/\s+/g, ' ')) || /2 Trips/.test(before), 'the standard week shows two journeys a day');
    await shot('40-weekly-schedule-panel');

    await page.evaluate(() => [...document.querySelectorAll('.card button')].find(b => /weekly schedule/i.test(b.textContent)).click());
    await page.waitForSelector('.modal .schedule-day', { timeout: 20000 });
    await sleep(400);
    ok((await page.$$('.modal .schedule-day')).length === 7, 'the editor lists all seven days');
    const mondayTrips = await page.evaluate(() => document.querySelectorAll('.modal .schedule-day')[0].querySelectorAll('.sd-trip').length);
    ok(mondayTrips === 2, 'Monday starts from the contract\u2019s own two journeys');

    // Add a third journey to Friday and name it.
    await page.evaluate(() => {
      const friday = [...document.querySelectorAll('.modal .schedule-day')]
        .find(d => /Friday/.test(d.querySelector('.sd-name').textContent));
      [...friday.querySelectorAll('button')].find(b => /Add journey/.test(b.textContent)).click();
    });
    await sleep(300);
    await page.evaluate(() => {
      const friday = [...document.querySelectorAll('.modal .schedule-day')]
        .find(d => /Friday/.test(d.querySelector('.sd-name').textContent));
      const trips = friday.querySelectorAll('.sd-trip');
      const last = trips[trips.length - 1];
      const name = last.querySelector('input[type=text]');
      name.value = '1pm early collection';
      name.dispatchEvent(new Event('input', { bubbles: true }));
      const time = last.querySelector('input[type=time]');
      time.value = '13:00';
      time.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const fridayTrips = await page.evaluate(() => {
      const friday = [...document.querySelectorAll('.modal .schedule-day')]
        .find(d => /Friday/.test(d.querySelector('.sd-name').textContent));
      return friday.querySelectorAll('.sd-trip').length;
    });
    ok(fridayTrips === 3, 'Friday now has three journeys in the editor');
    await shot('41-weekly-schedule-editor');

    // Start the pattern from a future Friday so nothing already recorded changes.
    const friday = nextFriday();
    const startFrom = friday;
    await page.evaluate(d => {
      const input = document.querySelector('.modal input[type=date]');
      input.value = d;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, startFrom);
    await page.evaluate(() => [...document.querySelectorAll('.modal-foot button')].find(b => /Save weekly schedule/.test(b.textContent)).click());
    await page.waitForFunction(() => !document.querySelector('.modal-bg'), { timeout: 25000 });
    await page.waitForSelector('.weekgrid', { timeout: 20000 });
    await sleep(600);

    const after = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.weekrow')];
      return rows.map(r => r.querySelector('.wd').textContent + ' ' + r.querySelector('.wn').textContent);
    });
    ok(after.some(r => /^FRI 3 Trips/.test(r)), 'the contract page shows FRI 3 Trips (' + after.join(' | ') + ')');
    ok(after.some(r => /^MON 2 Trips/.test(r)), 'and MON 2 Trips');
    await shot('42-weekly-schedule-saved');

    // ---------------------------------------------------------------
    section('2. The calendar generates the third journey by itself');
    await page.goto(`${BASE}/#/calendar?from=${friday}&to=${friday}&contract=${ids.contract}`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.cell', { timeout: 25000 });
    await sleep(500);
    const legs = await page.$$eval('.cell .leg', els => els.map(e => e.textContent));
    ok(legs.length === 3, `the Friday cell shows three journeys (${JSON.stringify(legs)})`);
    ok(legs.some(t => /^T3/.test(t)), 'and names the third one T3');
    await shot('43-calendar-three-journeys');

    section('3. The exception dialog offers the journeys that really run');
    await page.evaluate(() => document.querySelector('.cell').click());
    await page.waitForSelector('.modal-bg fieldset', { timeout: 25000 });
    await sleep(500);
    const dialog = await page.$eval('.modal', e => e.textContent);
    ok(/1pm early collection/.test(dialog), 'the dialog lists the 1pm collection by name');
    ok(/3 planned journeys/.test(dialog), 'and says three journeys are planned');
    ok((await page.$$('.modal .trip-head')).length === 3, 'each journey has its own row');
    ok(/Extra journey this date only/.test(dialog), 'a one-off extra journey can be added');
    await shot('44-exception-dialog-three-journeys');
    await page.keyboard.press('Escape');
    await sleep(300);

    // ---------------------------------------------------------------
    section('4. A child who does not attend on a Wednesday');
    await page.goto(`${BASE}/#/children/${ids.child}`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.tabs', { timeout: 20000 });
    ok(await clickTab('Weekly timetable'), 'the child has a Weekly timetable tab');
    await page.waitForSelector('.weekgrid', { timeout: 20000 });
    await sleep(300);
    await shot('45-timetable-panel');

    await page.evaluate(() => [...document.querySelectorAll('.card button')].find(b => /timetable/i.test(b.textContent)).click());
    await page.waitForSelector('.modal .tt-row', { timeout: 20000 });
    await sleep(400);
    ok((await page.$$('.modal .tt-row')).length === 7, 'the timetable editor lists all seven days');
    ok(!!(await page.$('.modal .tt-modes')), 'and offers Same all week or Different times by day');

    await page.evaluate(() => {
      const modal = document.querySelector('.modal');
      modal.querySelectorAll('input[type=time]')[0].value = '09:00';
      modal.querySelectorAll('input[type=time]')[0].dispatchEvent(new Event('input', { bubbles: true }));
      modal.querySelectorAll('input[type=time]')[1].value = '15:00';
      modal.querySelectorAll('input[type=time]')[1].dispatchEvent(new Event('input', { bubbles: true }));
      const wed = [...modal.querySelectorAll('.tt-row')].find(r => /Wednesday/.test(r.textContent));
      wed.querySelector('input[type=checkbox]').click();
    });
    await sleep(300);
    const wedOff = await page.evaluate(() => {
      const r = [...document.querySelectorAll('.modal .tt-row')].find(x => /Wednesday/.test(x.textContent));
      return r.textContent;
    });
    ok(/DOES NOT ATTEND/.test(wedOff), 'Wednesday reads DOES NOT ATTEND in the editor');
    await shot('46-timetable-editor');

    await page.evaluate(d => {
      const input = document.querySelector('.modal input[type=date]');
      input.value = d;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, isoToday());
    await page.evaluate(() => [...document.querySelectorAll('.modal-foot button')].find(b => /Save timetable/.test(b.textContent)).click());
    await page.waitForFunction(() => !document.querySelector('.modal-bg'), { timeout: 25000 });
    await page.waitForSelector('.weekgrid', { timeout: 20000 });
    await sleep(600);

    const ttRows = await page.evaluate(() => [...document.querySelectorAll('.weekrow')]
      .map(r => r.querySelector('.wd').textContent + ': ' + r.querySelector('.wn').textContent));
    ok(ttRows.some(r => /^WED: Does Not Attend/.test(r)), 'the child page shows Wed: Does Not Attend (' + ttRows.join(' | ') + ')');
    ok(ttRows.some(r => /^MON: 09:00 – 15:00/.test(r)), 'and Mon: 09:00 – 15:00');
    await shot('47-timetable-saved');

    section('5. A normal day off is not an absence');
    const state = await page.evaluate(async (childId, contractId) => {
      const child = await (await fetch('/api/children/' + childId)).json();
      const today = new Date();
      today.setUTCDate(today.getUTCDate() + 1);
      while (today.getUTCDay() !== 3) today.setUTCDate(today.getUTCDate() + 1);
      const date = today.toISOString().slice(0, 10);
      const day = await (await fetch(`/api/contracts/${contractId}/day/${date}`)).json();
      const me = day.children ? day.children.find(c => c.id === childId) : null;
      return { date, attending: child.timetable.attending_days, status: me ? me.status : null, operated: day.operated, absent: (day.trips || []).reduce((a, t) => a + t.children_absent, 0) };
    }, ids.child, ids.contract);
    ok(state.attending === 4, 'the child now travels four days a week');
    ok(state.status === 'not_scheduled', `on ${state.date} the child is a normal day off, not absent`);
    ok(state.absent === 0, 'nobody is counted absent that day');
    ok(state.operated === true, 'and the contract still runs for the other children');

  } catch (e) {
    errors.push('FATAL: ' + (e.stack || e.message));
  } finally {
    section('Cleaning up');
    try {
      if (cleanup) {
        const removed = await page.evaluate(async ids => {
          const out = [];
          const sc = await (await fetch(`/api/contracts/${ids.contract}/schedule`)).json();
          for (const v of sc.versions || []) {
            const r = await fetch(`/api/contracts/${ids.contract}/schedule/${v.id}`, { method: 'DELETE' });
            out.push('schedule ' + r.status);
          }
          const tt = await (await fetch(`/api/children/${ids.child}/timetable`)).json();
          for (const v of tt.versions || []) {
            const r = await fetch(`/api/children/${ids.child}/timetable/${v.id}`, { method: 'DELETE' });
            out.push('timetable ' + r.status);
          }
          return out;
        }, cleanup);
        ok(removed.every(r => / 200$/.test(r)), 'the test schedule and timetable were removed (' + removed.join(', ') + ')');
      }
    } catch (e) { errors.push('CLEANUP: ' + e.message); }
    await browser.close();
  }

  console.log(`\n${pass} passed, ${errors.length} failed`);
  if (errors.length) { errors.forEach(e => console.log('  - ' + e)); process.exit(1); }
})();
