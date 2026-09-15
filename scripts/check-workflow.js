/* End-to-end workflow through the real UI: create records, record an exception,
   upload a document, check the wage effect, export a report.

   This one runs against whatever database the server is using, including a live
   Supabase one, because it drives the real interface. It creates records with a
   timestamped name and deletes them again at the end, but it does write. The
   other suites only read. */
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://localhost:4000';
const SHOTS = path.join(__dirname, '..', 'shots');
const TMP = path.join(require('os').tmpdir(), 'h2s-wf');
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

const errors = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ok = (cond, label) => { if (cond) console.log('  ok   ' + label); else { errors.push(label); console.log('  FAIL ' + label); } };

// fill a modal form field by its label text
async function setField(page, label, value) {
  const done = await page.evaluate(({ label, value }) => {
    const fields = [...document.querySelectorAll('.modal .field, .modal .field.full')];
    const f = fields.find(x => { const l = x.querySelector('label'); return l && l.textContent.replace(' *', '').trim() === label; });
    if (!f) return false;
    const el = f.querySelector('input, select, textarea');
    if (!el) return false;
    if (el.type === 'checkbox') { el.checked = !!value; }
    else { el.value = value; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, { label, value });
  if (!done) errors.push(`could not find form field "${label}"`);
  return done;
}
async function clickButton(page, text, scope = '.modal-foot') {
  return page.evaluate(({ text, scope }) => {
    const b = [...document.querySelectorAll(`${scope} button, ${scope} a`)].find(x => x.textContent.trim() === text);
    if (b) { b.click(); return true; }
    return false;
  }, { text, scope });
}


// Navigating by hash re-renders asynchronously, and the previous page's markup can still
// be on screen, so always wait for the new page's own heading before touching it.
async function go(page, hash, heading) {
  await page.goto(BASE + '/#' + hash, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { const v = document.getElementById('view'); if (v) v.dataset.pending = '1'; });
  await page.waitForFunction(t => {
    const hEl = document.querySelector('#view h1');
    return hEl && hEl.textContent.includes(t);
  }, { timeout: 25000 }, heading);
  await sleep(350);
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', defaultViewport: { width: 1500, height: 1000 } });
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  let expect404 = false; // the cleanup step deliberately fetches a deleted record
  page.on('console', m => { if (m.type() === 'error' && !/401 \(Unauthorized\)/.test(m.text()) && !(expect404 && /404/.test(m.text()))) errors.push('CONSOLE: ' + m.text()); });

  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForSelector('input[name=email]', { timeout: 25000 });
  await page.type('input[name=email]', 'demo@northgate-transport.example');
  await page.type('input[name=password]', 'demo1234');
  await Promise.all([page.click('button[type=submit]'), page.waitForSelector('#app')]);
  await page.waitForSelector('.stats', { timeout: 25000 });

  const stamp = Date.now().toString().slice(-6);
  const CODE = 'WF TEST ' + stamp;

  console.log('\n1. Create a school through the UI');
  await go(page, '/schools', 'Schools');
  await clickButton(page, '+ New school', '.actions');
  await page.waitForSelector('.modal', { timeout: 25000 });
  await setField(page, 'School name', 'Workflow Test School ' + stamp);
  await setField(page, 'Postcode', 'SR9 9ZZ');
  await setField(page, 'Opening time', '09:00');
  await setField(page, 'Closing time', '15:00');
  await clickButton(page, 'Save');
  await page.waitForFunction(() => /^#\/schools\/\d+$/.test(location.hash), { timeout: 25000 });
  await page.waitForSelector('.tabs', { timeout: 25000 }); await sleep(400);
  const schoolId = Number(page.url().split('/').pop());
  ok(schoolId > 0, 'school created and opened at its own page');
  await page.screenshot({ path: path.join(SHOTS, 'wf-01-school.png') });

  console.log('\n2. Create a contract for that school');
  await go(page, '/contracts', 'Contracts');
  await clickButton(page, '+ New contract', '.actions');
  await page.waitForSelector('.modal', { timeout: 25000 });
  await setField(page, 'Contract / job code', CODE);
  await setField(page, 'Description', 'Created by the workflow test');
  await setField(page, 'School', String(schoolId));
  await setField(page, 'Start date', '2026-09-01');
  await setField(page, 'End date', '2026-12-18');
  await setField(page, 'AM pick-up time', '08:00');
  await setField(page, 'PM home drop-off', '16:00');
  await setField(page, 'Contract income per day (£)', '120');
  await setField(page, 'Driver pay per day (£)', '50');
  await setField(page, 'PA pay per day (£)', '30');
  // assign the first driver and PA in the lists
  const staffIds = await page.evaluate(() => {
    const pick = label => {
      const f = [...document.querySelectorAll('.modal .field')].find(x => x.querySelector('label')?.textContent.trim() === label);
      const sel = f.querySelector('select');
      sel.selectedIndex = 1;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return { id: sel.value, name: sel.options[1].textContent };
    };
    return { driver: pick('Assigned driver'), pa: pick('Assigned PA') };
  });
  await clickButton(page, 'Save');
  await page.waitForFunction(() => /^#\/contracts\/\d+$/.test(location.hash), { timeout: 25000 });
  await page.waitForSelector('.tabs', { timeout: 25000 }); await sleep(500);
  const contractId = Number(page.url().split('/').pop());
  ok(contractId > 0, 'contract created and opened');
  const cText = await page.$eval('#view', e => e.textContent);
  ok(cText.includes(CODE), 'contract page shows the new code');
  ok(cText.includes(staffIds.driver.name.replace(' (pool)', '')), 'assigned driver appears on the contract');
  await page.screenshot({ path: path.join(SHOTS, 'wf-02-contract.png') });

  console.log('\n3. Add a child to the contract');
  await go(page, '/children', 'Children');
  await clickButton(page, '+ New child', '.actions');
  await page.waitForSelector('.modal', { timeout: 25000 });
  await setField(page, 'First name', 'Workflow');
  await setField(page, 'Last name', 'Child' + stamp);
  await setField(page, 'Date of birth', '2014-05-05');
  await setField(page, 'Postcode', 'SR9 8YY');
  await setField(page, 'Parent / carer name', 'Test Parent');
  await setField(page, 'Contract / route', String(contractId));
  await setField(page, 'Allergies', 'Peanuts');
  await setField(page, 'Wheelchair user — requires an accessible vehicle', true);
  await clickButton(page, 'Save');
  await page.waitForFunction(() => /^#\/children\/\d+$/.test(location.hash), { timeout: 25000 });
  await page.waitForSelector('.tabs', { timeout: 25000 }); await sleep(500);
  const childId = Number(page.url().split('/').pop());
  const chText = await page.$eval('#view', e => e.textContent);
  ok(chText.includes('Workflow Test School'), 'child inherited the school from the contract');
  ok(chText.includes(CODE), 'child is linked to the contract');
  ok(chText.includes('Peanuts'), 'allergy flag is shown');
  ok(chText.includes('Wheelchair user'), 'wheelchair flag is shown');
  await page.screenshot({ path: path.join(SHOTS, 'wf-03-child.png') });

  console.log('\n4. Upload a document against the child');
  const docPath = path.join(TMP, 'care-plan.txt');
  fs.writeFileSync(docPath, 'Workflow test care plan.');
  await page.evaluate(() => { const b = [...document.querySelectorAll('.tabs button')].find(x => x.textContent.startsWith('Documents')); b.click(); });
  await sleep(400);
  await clickButton(page, '+ Add document', '.card-body');
  await page.waitForSelector('.modal input[type=file]');
  await setField(page, 'Document type', 'Care Plan');
  await setField(page, 'Expiry date', '2027-06-30');
  const fileInput = await page.$('.modal input[type=file]');
  await fileInput.uploadFile(docPath);
  await clickButton(page, 'Save document');
  await sleep(1500);
  const docText = await page.$eval('#view', e => e.textContent);
  ok(docText.includes('Care Plan'), 'document row appears on the child profile');
  ok(docText.includes('care-plan.txt'), 'the uploaded file is linked');
  const dl = await page.evaluate(async () => {
    const a = [...document.querySelectorAll('#view a')].find(x => x.textContent === 'care-plan.txt');
    if (!a) return null;
    const r = await fetch(a.getAttribute('href'));
    return { status: r.status, body: await r.text() };
  });
  ok(dl && dl.status === 200 && dl.body.includes('Workflow test care plan'), 'the stored file downloads with its original contents');
  await page.screenshot({ path: path.join(SHOTS, 'wf-04-document.png') });

  console.log('\n5. Record a driver absence with cover, paid immediately');
  const baseline = await page.evaluate(async (id) => {
    const w = await (await fetch('/api/wages?from=2026-09-07&to=2026-09-11&include_zero=1')).json();
    const r = w.results.find(x => x.staff.id === Number(id));
    return r ? r.totals.amount_due : 0;
  }, staffIds.driver.id);

  await go(page, `/calendar?from=2026-09-07&to=2026-09-11&contract=${contractId}`, 'Operations calendar');
  await page.waitForSelector('.cell', { timeout: 25000 }); await sleep(400);
  await page.evaluate(() => document.querySelectorAll('.cell')[1].click()); // Tuesday
  await page.waitForSelector('.modal fieldset'); await sleep(500);
  const absClicked = await page.evaluate(() => {
    const legends = [...document.querySelectorAll('.modal fieldset')];
    const driverBox = legends.find(f => f.querySelector('legend')?.textContent === 'Driver');
    const b = [...driverBox.querySelectorAll('button')].find(x => x.textContent === 'Absent all day');
    if (b) { b.click(); return true; } return false;
  });
  ok(absClicked, 'driver "Absent all day" control is available from the calendar cell');
  await page.waitForSelector('.modal .form-grid select[name=cover_staff_id]', { timeout: 20000 });
  await sleep(300);
  const coverName = await page.evaluate(() => {
    const s = document.querySelector('.modal select[name=cover_staff_id]');
    s.selectedIndex = 1; s.dispatchEvent(new Event('change', { bubbles: true }));
    return s.options[1].textContent;
  });
  await setField(page, 'Cover pay (£)', '75');
  await setField(page, 'Paid immediately (cash/bank today) — exclude from the next payroll', true);
  await setField(page, 'Reason / note', 'Workflow test absence');
  await page.screenshot({ path: path.join(SHOTS, 'wf-05-cover.png') });
  await clickButton(page, 'Record absence');
  await sleep(1800);

  const after = await page.evaluate(async (ids) => {
    const w = await (await fetch('/api/wages?from=2026-09-07&to=2026-09-11&include_zero=1')).json();
    const normal = w.results.find(x => x.staff.id === Number(ids.driver));
    const cover = w.results.find(x => x.staff.name === ids.coverName.replace(' (pool)', ''));
    return {
      normal: normal ? normal.totals.amount_due : null,
      coverGross: cover ? cover.totals.gross : null,
      coverPaid: cover ? cover.totals.already_paid : null,
      coverDue: cover ? cover.totals.amount_due : null,
    };
  }, { driver: staffIds.driver.id, coverName });

  ok(after.normal === baseline - 50, `normal driver loses exactly one day's pay (${baseline} -> ${after.normal})`);
  ok(after.coverGross >= 75, 'cover staff member earns the £75 override');
  ok(after.coverPaid >= 75, 'the immediate payment is recorded');
  ok(after.coverDue === after.coverGross - after.coverPaid, 'amount due excludes what was already paid');

  console.log('\n6. Calendar reflects the cover once the dialog is closed');
  await clickButton(page, 'Done');            // closing the day dialog refreshes the grid behind it
  await page.waitForFunction(() => !document.querySelector('.modal-bg'), { timeout: 20000 });
  await sleep(1200);
  await page.waitForSelector('.cell', { timeout: 25000 });
  const cells = await page.$$eval('.cell', els => els.map(e => e.textContent));
  const coverCell = cells[1] || '';
  ok(/Cover/.test(coverCell), `the calendar cell shows cover in use (cells: ${JSON.stringify(cells)})`);
  await page.screenshot({ path: path.join(SHOTS, 'wf-06-calendar-cover.png') });

  console.log('\n7. Profitability includes the new contract');
  await go(page, '/finance?from=2026-09-07&to=2026-09-11', 'Contract profitability');
  const finText = await page.$eval('#view', e => e.textContent);
  ok(finText.includes(CODE), 'the new contract appears in profitability');
  await page.screenshot({ path: path.join(SHOTS, 'wf-07-finance.png') });

  console.log('\n8. Reports export as CSV');
  for (const [name, qs, expect] of [
    ['payroll', 'from=2026-09-07&to=2026-09-11', 'Amount due'],
    ['cover-staff', 'from=2026-09-07&to=2026-09-11', 'Paid immediately'],
    ['children', '', 'SEN/Additional needs'],
    ['compliance', '', 'Compliance'],
    ['journeys', 'from=2026-09-07&to=2026-09-11', 'Children travelling'],
  ]) {
    const r = await page.evaluate(async ({ name, qs }) => {
      const res = await fetch(`/api/reports/${name}.csv?${qs}`);
      return { status: res.status, body: (await res.text()).slice(0, 4000) };
    }, { name, qs });
    ok(r.status === 200 && r.body.includes(expect), `${name}.csv exports with the expected columns`);
  }
  const coverCsv = await page.evaluate(async () => (await fetch('/api/reports/cover-staff.csv?from=2026-09-07&to=2026-09-11')).text());
  ok(/YES/.test(coverCsv), 'cover report marks the immediate payment as paid');

  console.log('\n9. Audit trail recorded the changes');
  const audit = await page.evaluate(async () => (await fetch('/api/audit?limit=500')).json());
  ok(audit.some(a => a.action === 'create' && String(a.entity_label).includes('WF TEST')), 'contract creation is in the audit log');
  ok(audit.some(a => a.entity_type === 'exceptions' && a.action === 'create'), 'the exception is in the audit log');
  ok(audit.some(a => a.action === 'document'), 'the document upload is in the audit log');

  console.log('\n10. Editing a contract flows through to the children');
  await go(page, '/contracts/' + contractId, CODE);
  await clickButton(page, 'Edit', '.actions');
  await page.waitForSelector('.modal', { timeout: 25000 });
  const newDriverName = await page.evaluate(() => {
    const f = [...document.querySelectorAll('.modal .field')].find(x => x.querySelector('label')?.textContent.trim() === 'Assigned driver');
    const s = f.querySelector('select');
    s.selectedIndex = 3; s.dispatchEvent(new Event('change', { bubbles: true }));
    return s.options[3].textContent.replace(' (pool)', '');
  });
  await clickButton(page, 'Save');
  await sleep(1500);
  await go(page, '/children/' + childId, 'Workflow Child');
  const childAfter = await page.$eval('#view', e => e.textContent);
  ok(childAfter.includes(newDriverName), `the child's profile now shows the new driver (${newDriverName}) without being edited`);
  const auditAfter = await page.evaluate(async (id) => (await fetch('/api/audit?entity_type=contracts&limit=50')).json(), contractId);
  ok(auditAfter.some(a => a.field === 'Driver' && a.new_value === newDriverName), 'the driver change is recorded with its previous and new value');
  await page.screenshot({ path: path.join(SHOTS, 'wf-08-child-updated.png') });

  console.log('\n11. Clean up the test records');
  expect404 = true;
  await page.evaluate(async ({ childId, contractId, schoolId }) => {
    await fetch('/api/children/' + childId, { method: 'DELETE' });
    await fetch('/api/contracts/' + contractId, { method: 'DELETE' });
    await fetch('/api/schools/' + schoolId, { method: 'DELETE' });
  }, { childId, contractId, schoolId });
  const gone = await page.evaluate(async (id) => (await fetch('/api/contracts/' + id)).status, contractId);
  ok(gone === 404, 'test records removed');
  const leftover = await page.evaluate(async (id) => {
    const docs = await (await fetch(`/api/documents?entity_type=child&entity_id=${id}`)).json();
    return docs.length;
  }, childId);
  ok(leftover === 0, 'the deleted child left no orphaned document records behind');

  await browser.close();
  console.log(errors.length ? `\nFAILURES (${errors.length}):\n  - ${errors.join('\n  - ')}` : '\nWORKFLOW CHECKS PASSED');
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
