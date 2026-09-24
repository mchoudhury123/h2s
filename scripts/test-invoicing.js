/**
 * Invoicing checks against a running server.
 *
 * Registers a throwaway business, sets up contracts and exceptions, and proves
 * the invoice numbers, the day counting and the snapshots behave. Removes the
 * business afterwards.
 *
 * Run with the server already running:  npm run test:invoicing
 */
'use strict';
require('../server/env').load();
const db = require('../server/db');

const BASE = process.env.BASE || 'http://localhost:4000';
const stamp = Date.now().toString().slice(-8);
let pass = 0;
const failures = [];
function ok(cond, label) { if (cond) { pass++; console.log('  ok   ' + label); } else { failures.push(label); console.log('  FAIL ' + label); } }
function section(t) { console.log('\n' + t); }

let cookie = null;
async function call(method, path, body, raw) {
  const opts = { method, headers: {} };
  if (cookie) opts.headers.Cookie = cookie;
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(BASE + path, opts);
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  if (raw) return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text() };
}
const get = p => call('GET', p);
const post = (p, b) => call('POST', p, b);
const put = (p, b) => call('PUT', p, b);
const del = p => call('DELETE', p);

let orgId = null;
async function main() {
  section('Setting up a throwaway business');
  const reg = await post('/api/register', { business_name: `Invoice Test ${stamp}`, email: `inv${stamp}@example.test`, password: 'invoice1234', name: 'Tester' });
  if (reg.status !== 201) throw new Error('registration failed: ' + JSON.stringify(reg.data));
  orgId = reg.data.user.organisation_id;
  const school = (await post('/api/schools', { name: 'Bamburgh Secondary' })).data;
  const mk = async (code, days, income, po) => (await post('/api/contracts', {
    code, school_id: school.id, status: 'active', start_date: '2026-09-01', days_of_week: days,
    income_per_day: income, income_basis: 'per_journey', po_number: po, requires_pa: 0,
  })).data;
  const alpha = await mk('ALPHA ROUTE', '1,2,3,4,5', 155, '20558595');
  const beta = await mk('BETA ROUTE', '1,2,3,4,5', 100, '20558595');
  const gamma = await mk('GAMMA ROUTE', '2,3,5', 90, '20558463');
  const nopo = await mk('NOPO ROUTE', '1,2,3,4,5', 80, '');
  ok(alpha.id && beta.id && gamma.id && nopo.id, 'four contracts created, one without a PO number');
  ok(alpha.po_number === '20558595', 'the PO number is stored on the contract');

  const st = await post('/api/invoicing/settings', {
    prefix: 'BLSOLO', next_number: 300, vat_rate: 20,
    from: { name: 'Test Cars LTD', address: '1 Test Street, South Shields, NE33 1AA', tel: '07000 000000', vat_no: '123456789' },
    bill_to: 'Invoice management\nCorporate Procurement service\nSouth Tyneside Council', footer: 'Payment to company account\nSort code: 00-00-00\nAccount number: 00000000',
  });
  ok(st.status === 200 && st.data.next_number === 300 && st.data.prefix === 'BLSOLO', 'invoice settings saved: BLSOLO from 300');

  // October 2026: Mon 5 to Fri 23 is three clean weeks, 15 weekdays.
  const OCT = { from: '2026-10-05', to: '2026-10-23' };
  const ex = (c, body) => post('/api/exceptions', { contract_id: c.id, ...body });
  await ex(alpha, { date: '2026-10-07', type: 'journey_removed', leg: 'PM', note: 'PM not needed' });     // half day
  await ex(alpha, { date: '2026-10-08', type: 'journey_cancelled', leg: 'DAY', note: 'Council cancelled late' }); // still billed
  await ex(alpha, { date: '2026-10-09', type: 'journey_removed', leg: 'DAY', note: 'Whole day off' });    // nothing
  await ex(alpha, { date: '2026-10-12', type: 'extra_journey', leg: 'DAY', trip_label: 'Extra hospital run', trip_kind: 'other' }); // added, still 1
  await ex(beta, { date: '2026-10-06', type: 'journey_removed', leg: 'PM', note: 'PM taken off' });       // 14.5

  section('1. Preview counts days the way the calendar does');
  const pv = (await get(`/api/invoicing/preview?from=${OCT.from}&to=${OCT.to}`)).data;
  const row = code => pv.rows.find(r => r.code === code);
  ok(row('ALPHA ROUTE').breakdown.scheduled_days === 15, 'ALPHA has 15 scheduled days in three weeks');
  ok(row('ALPHA ROUTE').days === 13.5, `ALPHA bills 13.5 days: one half day, one day taken off, a cancelled day still counted (got ${row('ALPHA ROUTE').days})`);
  ok(row('ALPHA ROUTE').breakdown.half_days === 1 && row('ALPHA ROUTE').breakdown.days_removed === 1 && row('ALPHA ROUTE').breakdown.cancelled_days === 1 && row('ALPHA ROUTE').breakdown.days_added === 1,
    'the breakdown shows 1 half, 1 removed, 1 cancelled (billed), 1 added');
  ok(row('ALPHA ROUTE').subtotal === 2092.5 && row('ALPHA ROUTE').vat === 418.5 && row('ALPHA ROUTE').total === 2511, 'ALPHA: 13.5 × £155 = £2,092.50, VAT £418.50, total £2,511.00');
  ok(row('BETA ROUTE').days === 14.5 && row('BETA ROUTE').subtotal === 1450, 'BETA: a PM taken off makes 14.5 days, £1,450.00');
  ok(row('GAMMA ROUTE').breakdown.scheduled_days === 9 && row('GAMMA ROUTE').days === 9, 'GAMMA (Tue/Wed/Fri) counts only those weekdays: 9 days');
  ok(row('NOPO ROUTE').can_invoice === false && row('NOPO ROUTE').warnings.some(w => w.level === 'block'), 'a contract with no PO number is blocked');
  ok(pv.next_number === 300, 'the preview says the next number is 300 and assigns nothing');
  ok((await get('/api/invoicing/settings')).data.next_number === 300, 'previewing did not move the counter');

  section('1b. Cancelling the PM instead of taking it off keeps the full day');
  const betaEx = (await get(`/api/exceptions?from=2026-10-06&to=2026-10-06&contract_id=${beta.id}`)).data;
  await del('/api/exceptions/' + betaEx[0].id);
  await ex(beta, { date: '2026-10-06', type: 'journey_cancelled', leg: 'PM', note: 'Council cancelled the PM' });
  const pv2 = (await get(`/api/invoicing/preview?from=${OCT.from}&to=${OCT.to}&contract_ids=${beta.id}`)).data;
  ok(pv2.rows[0].days === 15 && pv2.rows[0].breakdown.cancelled_days === 1, 'BETA is back to 15 days with the cancellation billed');

  section('2. Generating assigns sequential numbers from 300, alphabetically');
  const items = pv.rows.map(r => ({ contract_id: r.contract_id }));
  const blocked = await post('/api/invoicing/generate', { ...OCT, items });
  ok(blocked.status === 400 && /NOPO ROUTE/.test(blocked.data.error), 'a batch containing the no-PO contract is refused with its name');
  const g1 = await post('/api/invoicing/generate', { ...OCT, invoice_date: '2026-10-26', items: items.filter(i => i.contract_id !== nopo.id) });
  ok(g1.status === 201, 'first batch generated');
  const nums1 = g1.data.invoices.map(i => i.number);
  ok(JSON.stringify(nums1) === '[300,301,302]', `numbers are 300, 301, 302 (got ${nums1})`);
  ok(g1.data.invoices.map(i => i.code).join(',') === 'ALPHA ROUTE,BETA ROUTE,GAMMA ROUTE', 'in alphabetical order of contract code');
  ok(g1.data.invoices[0].invoice_no === 'BLSOLO 300 - Bamburgh Secondary', 'the invoice number reads BLSOLO 300 - Bamburgh Secondary');
  ok(g1.data.invoices[0].days === 13.5 && g1.data.invoices[0].total === 2511, 'the invoice carries the previewed figures');
  ok((await get('/api/invoicing/settings')).data.next_number === 303, 'the counter now says 303');

  section('3. A second batch carries on from where the first ended');
  const NOV = { from: '2026-11-02', to: '2026-11-27' };
  const g2 = await post('/api/invoicing/generate', { ...NOV, items: [{ contract_id: alpha.id }, { contract_id: gamma.id }] });
  ok(g2.status === 201 && JSON.stringify(g2.data.invoices.map(i => i.number)) === '[303,304]', 'second batch is 303, 304');

  section('4. Two batches fired at the same time never share a number');
  const [c1, c2] = await Promise.all([
    post('/api/invoicing/generate', { from: '2026-12-01', to: '2026-12-11', items: [{ contract_id: alpha.id }, { contract_id: beta.id }, { contract_id: gamma.id }] }),
    post('/api/invoicing/generate', { from: '2026-12-14', to: '2026-12-18', items: [{ contract_id: alpha.id }, { contract_id: beta.id }, { contract_id: gamma.id }] }),
  ]);
  ok(c1.status === 201 && c2.status === 201, 'both concurrent batches succeeded');
  const all6 = [...c1.data.invoices, ...c2.data.invoices].map(i => i.number).sort((a, b) => a - b);
  ok(new Set(all6).size === 6, `six distinct numbers (${all6})`);
  ok(all6[0] === 305 && all6[5] === 310, 'contiguous from 305 to 310 with no gaps');
  const register = (await get('/api/invoices')).data;
  ok(new Set(register.map(i => i.number)).size === register.length, 'no duplicate numbers in the register');

  section('5. Overlapping periods are blocked unless confirmed');
  const again = await post('/api/invoicing/generate', { ...OCT, items: [{ contract_id: alpha.id }] });
  ok(again.status === 400 && again.data.overlap === true && /BLSOLO 300/.test(again.data.error), 'invoicing October again is refused and names BLSOLO 300');
  const forced = await post('/api/invoicing/generate', { ...OCT, items: [{ contract_id: alpha.id, days: 13, reason: 'Council disputed one half day' }], allow_overlap: true });
  ok(forced.status === 201 && forced.data.invoices[0].number === 311, 'confirmed, it gets the next new number, 311');
  ok(forced.data.invoices[0].days === 13 && forced.data.invoices[0].calculated_days === 13.5 && forced.data.invoices[0].override_reason === 'Council disputed one half day', 'the manual day count and its reason are saved');
  const badOverride = await post('/api/invoicing/generate', { ...NOV, items: [{ contract_id: beta.id, days: 12.25, reason: 'x' }] });
  ok(badOverride.status === 400, 'a quarter day is refused');
  const noReason = await post('/api/invoicing/generate', { ...NOV, items: [{ contract_id: beta.id, days: 12 }] });
  ok(noReason.status === 400 && /reason/i.test(noReason.data.error), 'an override without a reason is refused');

  section('6. Void keeps its number; the next invoice gets a new one');
  const v = await put('/api/invoices/' + forced.data.invoices[0].id, { status: 'void', reason: 'Wrong day count' });
  ok(v.status === 200 && v.data.status === 'void' && v.data.number === 311, 'BLSOLO 311 is void and keeps its number');
  ok((await put('/api/invoices/' + forced.data.invoices[0].id, { status: 'void' })).status === 400, 'a void without a reason is refused');
  const after = await post('/api/invoicing/generate', { ...OCT, items: [{ contract_id: alpha.id }], allow_overlap: true });
  ok(after.status === 201 && after.data.invoices[0].number === 312, 'the replacement is 312, never 311 again');
  const paid = await put('/api/invoices/' + g1.data.invoices[1].id, { status: 'paid' });
  ok(paid.status === 200 && paid.data.status === 'paid' && paid.data.paid_date, 'an invoice can be marked paid');

  section('7. The next number can be raised but never lowered');
  ok((await post('/api/invoicing/settings', { next_number: 305 })).status === 400, 'lowering to an issued number is refused');
  ok((await post('/api/invoicing/settings', { next_number: 312 })).status === 400, 'lowering below the current next number is refused');
  ok((await post('/api/invoicing/settings', { next_number: 400 })).status === 200, 'raising to 400 is allowed');
  const g3 = await post('/api/invoicing/generate', { from: '2027-01-04', to: '2027-01-08', items: [{ contract_id: gamma.id }] });
  ok(g3.status === 201 && g3.data.invoices[0].number === 400, 'the next invoice is 400');

  section('8. PDFs, the ZIP and the combined PDF');
  const pdf = await call('GET', `/api/invoices/${g1.data.invoices[0].id}/pdf`, undefined, true);
  ok(pdf.status === 200 && pdf.buf.slice(0, 5).toString() === '%PDF-', 'the invoice PDF downloads');
  ok(/BLSOLO 300 - Bamburgh Secondary\.pdf/.test(pdf.headers.get('content-disposition') || ''), 'named "BLSOLO 300 - Bamburgh Secondary.pdf"');
  const text = pdf.buf.toString('latin1');
  ok(/20558595/.test(text) && /13\.5/.test(text) && /2,092\.50/.test(text) && /2,511\.00/.test(text) && /05\/10\/2026 - 23\/10\/2026/.test(text), 'the PDF carries the PO, the days, the amounts and the period in UK dates');
  const zipRes = await call('GET', `/api/invoicing/batch/${g1.data.batch_id}/zip`, undefined, true);
  ok(zipRes.status === 200 && zipRes.buf.slice(0, 2).toString() === 'PK', 'the batch ZIP downloads');
  ok((zipRes.buf.toString('latin1').match(/BLSOLO 30[012] - Bamburgh Secondary\.pdf/g) || []).length >= 3, 'and holds one PDF per invoice');
  const combined = await call('GET', `/api/invoicing/batch/${g1.data.batch_id}/pdf`, undefined, true);
  ok(combined.status === 200 && /\/Count 3/.test(combined.buf.toString('latin1')), 'the combined PDF has three pages');

  section('9. Changing a rate updates the contract everywhere but not issued invoices');
  const before = await call('GET', `/api/invoices/${g1.data.invoices[0].id}/pdf`, undefined, true);
  const edit = await put('/api/contracts/' + alpha.id, { income_per_day: 160 });
  ok(edit.status === 200 && Number(edit.data.income_per_day) === 160, 'the daily rate is edited through the contract');
  const listed = (await get('/api/contracts')).data.find(c => c.id === alpha.id);
  ok(Number(listed.income_per_day) === 160, 'the Contracts list shows £160');
  const prof = (await get(`/api/profitability?from=${OCT.from}&to=${OCT.to}&contract_id=${alpha.id}`)).data;
  ok(prof.rows.length && prof.rows[0].income > 0, 'profitability still calculates for the contract');
  const inv300 = (await get('/api/invoices/' + g1.data.invoices[0].id)).data;
  ok(Number(inv300.daily_rate) === 155 && inv300.total === 2511, 'BLSOLO 300 still says £155 and £2,511.00');
  const afterPdf = await call('GET', `/api/invoices/${g1.data.invoices[0].id}/pdf`, undefined, true);
  ok(before.buf.equals(afterPdf.buf), 'and re-downloading gives the identical PDF');
  const nextPv = (await get(`/api/invoicing/preview?from=2027-02-01&to=2027-02-05&contract_ids=${alpha.id}`)).data;
  ok(nextPv.rows[0].daily_rate === 160, 'the next invoice would use £160');
  const audit = (await get('/api/audit?entity_type=contracts&entity_id=' + alpha.id)).data;
  ok(JSON.stringify(audit).includes('160'), 'the rate change is in the audit log');

  section('10. The register and its export');
  const reg2 = (await get('/api/invoices?q=blsolo 300')).data;
  ok(reg2.length === 1 && reg2[0].number === 300, 'searching by invoice number finds it');
  ok((await get('/api/invoices?status=void')).data.every(i => i.status === 'void'), 'the status filter works');
  const csv = await call('GET', '/api/reports/invoices.csv', undefined, true);
  ok(csv.status === 200 && /Invoice number/.test(csv.buf.toString()) && /BLSOLO 300 - Bamburgh Secondary/.test(csv.buf.toString()), 'the register exports to CSV');
}

main()
  .catch(e => { failures.push('FATAL: ' + (e.stack || e.message)); })
  .then(async () => {
    section('Cleaning up');
    try {
      if (orgId) { await db.run('DELETE FROM organisations WHERE id = ?', [orgId]); ok(true, 'the throwaway business was removed'); }
    } catch (e) { failures.push('CLEANUP: ' + e.message); }
    try { await db.close(); } catch (_) {}
    console.log(`\n${pass} passed, ${failures.length} failed`);
    if (failures.length) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
  });
