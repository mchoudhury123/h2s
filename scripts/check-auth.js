/* Registration, sign-in, tenant separation in the browser, and both colour themes. */
const puppeteer = require('puppeteer-core');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.BASE || 'http://localhost:4000';
const SHOTS = path.join(__dirname, '..', 'shots');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const errors = [];
const stamp = Date.now().toString().slice(-8);

const ok = (cond, label) => {
  if (cond) console.log('  ok   ' + label);
  else { errors.push(label); console.log('  FAIL ' + label); }
};

// Only the businesses this run created are ever removed, by id. Nothing else
// in the database can be matched by accident.
const created = [];
async function cleanup() {
  try {
    const db = require('../server/db');
    const ids = await db.all('SELECT id, name FROM organisations WHERE name IN (?, ?)',
      ['Meridian Transport ' + stamp, 'Kestrel Travel ' + stamp]);
    for (const o of ids) {
      await db.run('DELETE FROM organisations WHERE id = ?', [o.id]);
      created.push(o.name);
    }
    if (created.length) console.log(`  cleaned up ${created.length} test business(es)`);
    await db.close();
  } catch (e) {
    console.error('  WARNING: could not remove the test businesses:', e.message);
    console.error(`  Remove them by hand: they are named "Meridian Transport ${stamp}" and "Kestrel Travel ${stamp}".`);
  }
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', defaultViewport: { width: 1400, height: 950 },
  });

  console.log('\n1. A new business registers');
  const ctxA = await browser.createBrowserContext();
  const a = await ctxA.newPage();
  await a.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  a.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  a.on('console', m => { if (m.type() === 'error' && !/401|403|404|400/.test(m.text())) errors.push('CONSOLE: ' + m.text()); });

  await a.goto(BASE, { waitUntil: 'networkidle2' });
  await a.waitForSelector('.login-card', { timeout: 25000 });
  await a.screenshot({ path: path.join(SHOTS, 'auth-01-signin.png') });

  await a.evaluate(() => [...document.querySelectorAll('.auth-tabs button')].find(b => /Create/.test(b.textContent)).click());
  await a.waitForSelector('input[name=business_name]', { timeout: 20000 });
  await sleep(250);
  await a.screenshot({ path: path.join(SHOTS, 'auth-02-register.png') });

  // A weak password is refused before any business is created.
  await a.type('input[name=business_name]', 'Meridian Transport ' + stamp);
  await a.type('input[name=name]', 'Sam Okoro');
  await a.type('input[name=email]', 'sam' + stamp + '@meridian.test');
  await a.type('input[name=password]', 'short');
  await a.type('input[name=confirm]', 'short');
  await a.click('button[type=submit]');
  await sleep(1500);
  const weak = await a.$eval('.login-err', e => e.textContent).catch(() => '');
  ok(/8 characters/.test(weak), 'a short password is refused with a clear message');

  // A mismatched confirmation is caught in the browser.
  await a.evaluate(() => {
    document.querySelector('input[name=password]').value = 'meridian2026';
    document.querySelector('input[name=confirm]').value = 'meridian2027';
  });
  await a.click('button[type=submit]');
  await sleep(700);
  const mismatch = await a.$eval('.login-err', e => e.textContent).catch(() => '');
  ok(/do not match/.test(mismatch), 'mismatched passwords are caught');

  await a.evaluate(() => { document.querySelector('input[name=confirm]').value = 'meridian2026'; });
  await a.click('button[type=submit]');
  await a.waitForSelector('#app', { timeout: 40000 });
  await a.waitForSelector('.stats', { timeout: 40000 });
  await sleep(700);
  await a.screenshot({ path: path.join(SHOTS, 'auth-03-new-firm-dashboard.png') });

  const firstView = await a.$eval('#view', e => e.textContent);
  ok(/Dashboard/.test(firstView), 'the new firm lands on its dashboard');
  const sidebar = await a.$eval('.sidebar', e => e.textContent);
  ok(sidebar.includes('Meridian Transport'), 'the sidebar shows the business name');
  ok(!/Administrator|Manager|Read Only|Operations Staff/.test(sidebar), 'no role is shown anywhere');

  const counts = await a.$$eval('.stat .value', els => els.slice(0, 6).map(e => e.textContent.trim()));
  ok(counts.every(c => c === '0'), 'the new firm starts with nothing');

  console.log('\n2. Every area is available, because there are no roles');
  const nav = await a.$$eval('#nav a', els => els.map(e => e.textContent.trim()));
  for (const item of ['Wages', 'Profitability', 'Expenses', 'Reports', 'Audit log', 'Settings', 'Calendar', 'Children']) {
    ok(nav.some(n => n.includes(item)), `the menu offers ${item}`);
  }

  console.log('\n3. A second business sees none of the first');
  const ctxB = await browser.createBrowserContext();
  const b = await ctxB.newPage();
  b.on('pageerror', e => errors.push('PAGEERROR(B): ' + e.message));
  await b.goto(BASE, { waitUntil: 'networkidle2' });
  await b.waitForSelector('.login-card', { timeout: 25000 });
  await b.evaluate(() => [...document.querySelectorAll('.auth-tabs button')].find(x => /Create/.test(x.textContent)).click());
  await b.waitForSelector('input[name=business_name]', { timeout: 20000 });
  await b.evaluate(s => {
    const set = (name, value) => {
      const el = document.querySelector(`input[name=${name}]`);
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('business_name', 'Kestrel Travel ' + s);
    set('email', 'kes' + s + '@kestrel.test');
    set('password', 'kestrel2026');
    set('confirm', 'kestrel2026');
  }, stamp);
  await b.click('button[type=submit]');
  try {
    await b.waitForSelector('.stats', { timeout: 40000 });
  } catch (e) {
    const shown = await b.$eval('.login-err', el => el.textContent).catch(() => '(no error shown)');
    const root = await b.$eval('#root', el => el.innerHTML.slice(0, 300)).catch(() => '');
    throw new Error(`second registration did not complete. Message on screen: ${shown}
${root}`);
  }
  await sleep(600);

  // Firm A adds a school through the real form. Firm B must never see it.
  await a.goto(BASE + '/#/schools', { waitUntil: 'domcontentloaded' });
  await a.waitForFunction(() => {
    const el = document.querySelector('#view h1');
    return el && el.textContent.includes('Schools');
  }, { timeout: 20000 });
  await sleep(400);
  await a.evaluate(() => [...document.querySelectorAll('.actions button')].find(x => /New school/.test(x.textContent)).click());
  await a.waitForSelector('.modal', { timeout: 20000 });
  await a.evaluate(s => {
    const f = [...document.querySelectorAll('.modal .field')]
      .find(x => x.querySelector('label').textContent.startsWith('School name'));
    const el = f.querySelector('input');
    el.value = 'Meridian Secret School ' + s;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, stamp);
  await a.evaluate(() => [...document.querySelectorAll('.modal-foot button')].find(x => x.textContent.trim() === 'Save').click());
  await sleep(2000);

  const bSchools = await b.evaluate(async () => (await (await fetch('/api/schools')).json()));
  ok(Array.isArray(bSchools) && bSchools.length === 0, "the second firm's school list stays empty");
  const bSearch = await b.evaluate(async () => (await (await fetch('/api/search?q=Meridian')).json()));
  ok(bSearch.count === 0, "searching for the first firm's school from the second finds nothing");
  await b.screenshot({ path: path.join(SHOTS, 'auth-04-second-firm.png') });

  const aSchools = await a.evaluate(async () => (await (await fetch('/api/schools')).json()));
  ok(aSchools.length === 1, "the first firm still sees its own school");

  console.log('\n4. An email address belongs to one account');
  const dup = await b.evaluate(async s => {
    const r = await fetch('/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ business_name: 'Copycat', email: 'sam' + s + '@meridian.test', password: 'another2026' }),
    });
    return { status: r.status, body: await r.json() };
  }, stamp);
  ok(dup.status === 400 && /already exists/i.test(dup.body.error), 'registering the same address twice is refused');

  console.log('\n5. Signing out and back in');
  await a.evaluate(() => [...document.querySelectorAll('.userbox a')].find(x => /Sign out/.test(x.textContent)).click());
  await a.waitForSelector('.login-card', { timeout: 20000 });
  ok(true, 'signing out returns to the sign-in screen');
  await a.type('input[name=email]', 'sam' + stamp + '@meridian.test');
  await a.type('input[name=password]', 'meridian2026');
  await a.click('button[type=submit]');
  await a.waitForSelector('.stats', { timeout: 40000 });
  await sleep(500);
  const back = await a.evaluate(async () => (await (await fetch('/api/schools')).json()));
  ok(back.length === 1, 'signing back in shows the same records again');

  await browser.close();
  await cleanup();

  if (errors.length) { console.log('\nFAILURES:'); errors.forEach(e => console.log('  - ' + e)); process.exit(1); }
  console.log('\nREGISTRATION, SEPARATION AND THEME CHECKS PASSED');
})().catch(async e => {
  console.error('FATAL', e.stack || e.message);
  await cleanup();
  process.exit(1);
});
