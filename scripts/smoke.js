/* Browser smoke test: signs in and walks every page, failing on any console error. */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE || 'http://localhost:4000';
const SHOT_DIR = process.env.SHOT_DIR || path.join(__dirname, '..', 'shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

const errors = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--window-size=1500,1000'], defaultViewport: { width: 1500, height: 1000 } });
  const page = await browser.newPage();
  const IGNORE = [/401 \(Unauthorized\)/];
  page.on('console', m => { if (m.type() === 'error' && !IGNORE.some(r => r.test(m.text()))) errors.push('CONSOLE: ' + m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('requestfailed', r => errors.push('REQFAIL: ' + r.url() + ' ' + (r.failure() || {}).errorText));

  const shot = async name => { await page.screenshot({ path: path.join(SHOT_DIR, name + '.png'), fullPage: false }); };
  const check = async (label) => {
    const bad = await page.$('.card-body h2[style*="red"]');
    if (bad) errors.push(`VIEW ERROR on ${label}: ` + await page.evaluate(e => e.parentElement.textContent, bad));
  };

  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.login-card', { timeout: 10000 });
  await shot('01-login');

  await page.type('input[name=username]', process.env.USER_NAME || 'admin');
  await page.type('input[name=password]', process.env.USER_PASS || 'admin123');
  await Promise.all([page.click('button[type=submit]'), page.waitForSelector('#app', { timeout: 10000 })]);
  await page.waitForSelector('.stats', { timeout: 10000 });
  await sleep(500);
  await shot('02-dashboard');
  await check('dashboard');

  const pages = [
    ['/calendar', '.cal', '03-calendar'],
    ['/contracts', 'table.tbl', '04-contracts'],
    ['/children', 'table.tbl', '05-children'],
    ['/staff/list/driver', 'table.tbl', '06-drivers'],
    ['/staff/list/pa', 'table.tbl', '07-pas'],
    ['/schools', 'table.tbl', '08-schools'],
    ['/councils', 'table.tbl', '09-councils'],
    ['/vehicles', 'table.tbl', '10-vehicles'],
    ['/pool', 'table.tbl', '11-pool'],
    ['/compliance', '.stats', '12-compliance'],
    ['/wages', '.stats', '13-wages'],
    ['/payroll', '.card', '14-payroll'],
    ['/finance', '.stats', '15-finance'],
    ['/expenses', '.card', '16-expenses'],
    ['/reports', '.grid', '17-reports'],
    ['/audit', 'table.tbl', '18-audit'],
    ['/settings', '.tabs', '19-settings'],
  ];
  for (const [route, sel, name] of pages) {
    await page.goto(BASE + '/#' + route, { waitUntil: 'networkidle2' });
    try { await page.waitForSelector(sel, { timeout: 8000 }); }
    catch (e) { errors.push(`TIMEOUT waiting for ${sel} on ${route}`); }
    await sleep(250);
    await shot(name);
    await check(route);
  }

  // detail pages
  await page.goto(BASE + '/#/contracts/1', { waitUntil: 'networkidle2' });
  await page.waitForSelector('.tabs', { timeout: 8000 }); await sleep(300); await shot('20-contract-detail'); await check('contract detail');
  for (const t of ['Children', 'Financials', 'Recent exceptions', 'Documents', 'History']) {
    const clicked = await page.evaluate(label => { const b = [...document.querySelectorAll('.tabs button')].find(x => x.textContent.startsWith(label)); if (b) { b.click(); return true; } return false; }, t);
    if (clicked) { await sleep(350); await check('contract tab ' + t); }
  }
  await shot('21-contract-children');

  await page.goto(BASE + '/#/children/1', { waitUntil: 'networkidle2' });
  await page.waitForSelector('.tabs', { timeout: 8000 }); await sleep(300); await shot('22-child-detail'); await check('child detail');
  for (const t of ['Needs', 'Absence', 'Documents', 'History']) {
    await page.evaluate(label => { const b = [...document.querySelectorAll('.tabs button')].find(x => x.textContent.startsWith(label)); if (b) b.click(); }, t);
    await sleep(300); await check('child tab ' + t);
  }
  await shot('23-child-needs');

  await page.goto(BASE + '/#/staff/1', { waitUntil: 'networkidle2' });
  await page.waitForSelector('.tabs', { timeout: 8000 }); await sleep(300); await shot('24-driver-detail'); await check('driver detail');
  for (const t of ['Compliance', 'Profile', 'Documents', 'Absence']) {
    await page.evaluate(label => { const b = [...document.querySelectorAll('.tabs button')].find(x => x.textContent.startsWith(label)); if (b) b.click(); }, t);
    await sleep(300); await check('driver tab ' + t);
  }
  await shot('25-driver-compliance');

  await page.goto(BASE + '/#/schools/1', { waitUntil: 'networkidle2' });
  await page.waitForSelector('.tabs', { timeout: 8000 }); await sleep(300); await shot('26-school-detail'); await check('school detail');

  // universal search
  await page.goto(BASE + '/#/', { waitUntil: 'networkidle2' });
  await page.waitForSelector('#usearch');
  await page.type('#usearch', 'thornhill');
  await page.waitForSelector('#sresults .item', { timeout: 6000 });
  await sleep(200); await shot('27-search');
  const groups = await page.$$eval('#sresults .glabel', els => els.map(e => e.textContent));
  if (!groups.length) errors.push('SEARCH returned no groups');

  // exception dialog
  await page.goto(BASE + '/#/calendar', { waitUntil: 'networkidle2' });
  await page.waitForSelector('.cell', { timeout: 8000 });
  await sleep(700);
  await page.evaluate(() => document.querySelector('.cell').click());
  await page.waitForSelector('.modal-bg fieldset', { timeout: 10000 });
  await sleep(400); await shot('28-exception-dialog');
  const dialogText = await page.$eval('.modal', e => e.textContent);
  if (!/Children/.test(dialogText)) errors.push('EXCEPTION DIALOG missing children section');

  // wage breakdown
  await page.goto(BASE + '/#/wages', { waitUntil: 'networkidle2' });
  await page.waitForSelector('table.tbl tbody tr', { timeout: 8000 });
  await sleep(300);
  await sleep(500);
  const hasBreakdownBtn = await page.$('table.tbl .btn.primary');
  if (hasBreakdownBtn) {
    await page.evaluate(() => document.querySelector('table.tbl .btn.primary').click());
    await page.waitForSelector('.breakdown', { timeout: 6000 });
    await sleep(300); await shot('29-wage-breakdown');
  } else errors.push('WAGES: no breakdown button found');

  // mobile
  await page.setViewport({ width: 400, height: 860 });
  await page.goto(BASE + '/#/', { waitUntil: 'networkidle2' });
  await page.waitForSelector('.stats'); await sleep(400); await shot('30-mobile-dashboard');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
  if (overflow) errors.push('MOBILE: dashboard scrolls horizontally');
  await page.goto(BASE + '/#/children/1', { waitUntil: 'networkidle2' });
  await page.waitForSelector('.tabs'); await sleep(400); await shot('31-mobile-child');

  await browser.close();

  if (errors.length) { console.log('FAILURES (' + errors.length + '):'); errors.forEach(e => console.log('  - ' + e)); process.exit(1); }
  console.log('ALL CHECKS PASSED. Screenshots in ' + SHOT_DIR);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
