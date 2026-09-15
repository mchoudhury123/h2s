const puppeteer = require('puppeteer-core');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOTS = path.join(__dirname, '..', 'shots');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const errors = [];

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', defaultViewport: { width: 1500, height: 1000 } });

  for (const [user, pass, label, expectHidden, lightTheme] of [
    ['ops', 'ops123', 'operations', ['Wages', 'Profitability', 'Expenses', 'Payroll history', 'Audit log'], true],
    ['finance', 'finance123', 'finance', [], false],
    ['viewer', 'viewer123', 'readonly', ['Wages', 'Profitability', 'Reports', 'Audit log'], false],
  ]) {
    // Each role needs its own cookie jar, otherwise the previous sign-in carries over.
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    if (lightTheme) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    page.on('pageerror', e => errors.push(`${label}: PAGEERROR ${e.message}`));
    page.on('console', m => { if (m.type() === 'error' && !/401|403/.test(m.text())) errors.push(`${label}: CONSOLE ${m.text()}`); });
    await page.goto('http://localhost:4000', { waitUntil: 'networkidle2' });
    await page.waitForSelector('input[name=username]', { timeout: 10000 });
    await page.type('input[name=username]', user);
    await page.type('input[name=password]', pass);
    await Promise.all([page.click('button[type=submit]'), page.waitForSelector('#app')]);
    await page.waitForSelector('.stats'); await sleep(600);
    await page.screenshot({ path: path.join(SHOTS, `role-${label}.png`) });

    const nav = await page.$$eval('#nav a', els => els.map(e => e.textContent.trim()));
    for (const item of expectHidden) {
      if (nav.some(n => n.includes(item))) errors.push(`${label}: nav should NOT show "${item}" (got ${nav.join(', ')})`);
    }
    // money must not leak into the contracts list for operations staff
    if (label === 'operations') {
      await page.goto('http://localhost:4000/#/contracts', { waitUntil: 'networkidle2' });
      await page.waitForSelector('table.tbl'); await sleep(400);
      const heads = await page.$$eval('table.tbl th', els => els.map(e => e.textContent));
      if (heads.some(h => /Income|Profit|Margin/i.test(h))) errors.push(`operations: contract list exposes money columns: ${heads.join(', ')}`);
      const body = await page.$eval('table.tbl', e => e.textContent);
      if (/£1[45]\d/.test(body)) errors.push('operations: contract list shows income figures');
      await page.screenshot({ path: path.join(SHOTS, 'role-operations-contracts.png') });
      // direct API call must be refused too
      const res = await page.evaluate(async () => {
        const r = await fetch('/api/wages?from=2026-09-01&to=2026-09-15');
        return { status: r.status, body: await r.text() };
      });
      if (res.status !== 403) errors.push(`operations: /api/wages returned ${res.status}, expected 403`);
      const prof = await page.evaluate(async () => (await fetch('/api/profitability?from=2026-09-01&to=2026-09-15')).status);
      if (prof !== 403) errors.push(`operations: /api/profitability returned ${prof}, expected 403`);
      const contract = await page.evaluate(async () => (await fetch('/api/contracts/1')).json());
      if (contract.income_per_day !== null) errors.push(`operations: contract detail leaked income_per_day = ${contract.income_per_day}`);
    }
    if (label === 'readonly') {
      const res = await page.evaluate(async () => (await fetch('/api/children', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ first_name: 'X', last_name: 'Y' }) })).status);
      if (res !== 403) errors.push(`readonly: creating a child returned ${res}, expected 403`);
      const ex = await page.evaluate(async () => (await fetch('/api/exceptions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contract_id: 1, date: '2026-09-16', type: 'note', note: 'x' }) })).status);
      if (ex !== 403) errors.push(`readonly: recording an exception returned ${ex}, expected 403`);
      // Read-only users may navigate, but no control that writes data may be offered.
      const quickException = await page.evaluate(() => [...document.querySelectorAll('.topbar button')].some(b => /Exception/.test(b.textContent)));
      if (quickException) errors.push('readonly: topbar offers the quick-exception button');
      await page.goto('http://localhost:4000/#/children', { waitUntil: 'networkidle2' });
      await page.waitForSelector('table.tbl'); await sleep(300);
      const newBtn = await page.evaluate(() => [...document.querySelectorAll('.actions button, .actions a')].some(b => /New|Add/.test(b.textContent)));
      if (newBtn) errors.push('readonly: children list offers a create button');
      await page.goto('http://localhost:4000/#/contracts/1', { waitUntil: 'networkidle2' });
      await page.waitForSelector('.tabs'); await sleep(300);
      const editBtn = await page.evaluate(() => [...document.querySelectorAll('.actions button')].some(b => /Edit|Record/.test(b.textContent)));
      if (editBtn) errors.push('readonly: contract page offers edit controls');
    }
    if (label === 'finance') {
      await page.goto('http://localhost:4000/#/wages', { waitUntil: 'networkidle2' });
      await page.waitForSelector('.stats'); await sleep(500);
      await page.screenshot({ path: path.join(SHOTS, 'role-finance-wages.png') });
      const txt = await page.$eval('#view', e => e.textContent);
      if (!/Total to pay/.test(txt)) errors.push('finance: wages page missing totals');
      const edit = await page.evaluate(async () => (await fetch('/api/children', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ first_name: 'A', last_name: 'B' }) })).status);
      if (edit !== 403) errors.push(`finance: creating a child returned ${edit}, expected 403`);
      const exc = await page.evaluate(async () => (await fetch('/api/exceptions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contract_id: 1, date: '2026-09-16', type: 'note', note: 'x' }) })).status);
      if (exc !== 403) errors.push(`finance: recording an exception returned ${exc}, expected 403`);
    }
    await page.close();
    await context.close();
  }
  await browser.close();
  if (errors.length) { console.log('FAILURES:'); errors.forEach(e => console.log('  - ' + e)); process.exit(1); }
  console.log('ROLE + THEME CHECKS PASSED');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
