/* Business-rule tests against a throwaway database. Run: npm test
   On SQLite this is a temporary file. On Postgres it is a temporary schema, so a
   test run can never touch the live tables. Both are removed afterwards. */

// .env must be read before deciding where the test data goes, otherwise
// DATABASE_URL is still unset here and the isolation below is skipped.
require('../server/env').load();

process.env.H2S_DB = require('path').join(require('os').tmpdir(), 'h2s-test-' + Date.now() + '.db');
if (process.env.DATABASE_URL && !process.env.H2S_PG_SCHEMA) {
  process.env.H2S_PG_SCHEMA = 'h2s_test_' + Date.now();
}

const database = require('../server/db');
const { run, get, insert, setSetting } = database;
const cal = require('../server/services/calendar');
const wages = require('../server/services/wages');
const finance = require('../server/services/finance');
const compliance = require('../server/services/compliance');

async function main() {
  // Refuse to run if isolation did not take effect, rather than writing
  // test fixtures into real tables.
  if (database.dialect === 'postgres' && !database.driver.schema) {
    throw new Error('Refusing to run: Postgres tests need an isolated schema. Set H2S_PG_SCHEMA.');
  }
  await database.migrate();
  // Every fixture below belongs to one test business, exactly as a real firm's data would.
  const orgId = await database.driver.insertReturningId(
    'INSERT INTO organisations (name) VALUES (?)', ['Rule test business']);
  let pass = 0, fail = 0;
  function is(actual, expected, label) {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a === b) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}\n         expected ${b}\n         actual   ${a}`); }
  }
  function section(t) { console.log('\n' + t); }

  // ---------- fixture ----------
  // A Mon-Fri contract: income 100/day, driver 60/day, PA 40/day, all pro-rata per journey.
  const schoolId = await insert('schools', { name: 'Test School' }, ['name'], null, orgId);
  const driverId = await insert('staff', { type: 'driver', first_name: 'John', last_name: 'Normal', default_day_rate: 60 }, ['type', 'first_name', 'last_name', 'default_day_rate'], null, orgId);
  const coverId = await insert('staff', { type: 'driver', first_name: 'Ahmed', last_name: 'Cover', status: 'pool', default_day_rate: 70 }, ['type', 'first_name', 'last_name', 'status', 'default_day_rate'], null, orgId);
  const paId = await insert('staff', { type: 'pa', first_name: 'Linda', last_name: 'Assist', default_day_rate: 40 }, ['type', 'first_name', 'last_name', 'default_day_rate'], null, orgId);
  const paCoverId = await insert('staff', { type: 'pa', first_name: 'Tracy', last_name: 'Spare', status: 'pool' }, ['type', 'first_name', 'last_name', 'status'], null, orgId);
  const contractId = await insert('contracts', {
    code: 'TEST 1', school_id: schoolId, driver_id: driverId, pa_id: paId, requires_pa: 1, status: 'active',
    start_date: '2026-09-01', end_date: '2026-12-31', days_of_week: '1,2,3,4,5',
    income_per_day: 100, income_basis: 'per_journey', driver_pay_per_day: 60, pa_pay_per_day: 40,
    pay_basis: 'per_journey', other_costs_per_day: 10,
  }, ['code', 'school_id', 'driver_id', 'pa_id', 'requires_pa', 'status', 'start_date', 'end_date', 'days_of_week', 'income_per_day', 'income_basis', 'driver_pay_per_day', 'pa_pay_per_day', 'pay_basis', 'other_costs_per_day'], null, orgId);
  const childA = await insert('children', { first_name: 'Child', last_name: 'A', contract_id: contractId, school_id: schoolId, status: 'active' }, ['first_name', 'last_name', 'contract_id', 'school_id', 'status'], null, orgId);
  const childB = await insert('children', { first_name: 'Child', last_name: 'B', contract_id: contractId, school_id: schoolId, status: 'active' }, ['first_name', 'last_name', 'contract_id', 'school_id', 'status'], null, orgId);

  const EX = ['date', 'type', 'leg', 'contract_id', 'school_id', 'child_id', 'role', 'staff_id', 'cover_staff_id', 'cover_pay', 'paid_immediately', 'amount', 'note', 'trip_seq', 'trip_label', 'trip_kind'];
  const addEx = d => insert('exceptions', d, EX, null, orgId);
  // Mon 7 Sep to Fri 11 Sep 2026 is a clean 5-day week.
  const WEEK = { from: '2026-09-07', to: '2026-09-11' };
  const day = async (date, cid = contractId) => {
    const ctx = await cal.loadContext(orgId, date, date, ' AND c.id = ?', [cid]);
    return cal.evaluateContractDay(ctx.contracts[0], date, ctx.childMap[cid] || [], ctx.exceptions, ctx);
  };
  // A normal day is one journey out and one back, so these read the same as before.
  const AM = d => d.trips.find(t => t.kind === 'outbound');
  const PM = d => d.trips.filter(t => t.kind === 'return').pop();
  const trip = (d, seq) => d.trips.find(t => t.seq === seq);
  const wagesFor = async (name, range = WEEK) => {
    const w = await wages.calculateWages(orgId, { ...range, include_zero: true });
    return w.results.find(r => r.staff.name === name) || { totals: { amount_due: 0, gross: 0, normal_earnings: 0, cover_earnings: 0, already_paid: 0 } };
  };

  // ---------- 1. the baseline: nothing recorded means everything ran ----------
  section('1. Exception management — a normal week needs no data entry');
  const testContract = (await cal.loadContracts(orgId, ' AND c.id=?', [contractId]))[0];
  is(cal.contractOperatesOn(testContract, '2026-09-07'), true, 'operates on a Monday');
  is(cal.contractOperatesOn(testContract, '2026-09-12'), false, 'does not operate on a Saturday');
  is(AM(await day('2026-09-07')).status, 'operated', 'AM assumed operated with no exception recorded');
  is(PM(await day('2026-09-07')).status, 'operated', 'PM assumed operated with no exception recorded');
  is((await wagesFor('John Normal')).totals.amount_due, 300, 'driver earns 5 days at 60 with no data entry');
  is((await wagesFor('Linda Assist')).totals.amount_due, 200, 'PA earns 5 days at 40 with no data entry');

  // ---------- 2. child absence ----------
  section('2. Child absence');
  const exChildPM = await addEx({ date: '2026-09-08', type: 'child_absence', leg: 'PM', contract_id: contractId, child_id: childA });
  is(PM(await day('2026-09-08')).children_absent, 1, 'one child marked absent PM');
  is(PM(await day('2026-09-08')).status, 'operated', 'journey still runs while another child travels');
  is((await wagesFor('John Normal')).totals.amount_due, 300, 'driver pay unchanged when one of two children is absent');
  const exChildPM2 = await addEx({ date: '2026-09-08', type: 'child_absence', leg: 'PM', contract_id: contractId, child_id: childB });
  is(PM(await day('2026-09-08')).status, 'not_operated', 'journey does not run when every child is absent');
  is(PM(await day('2026-09-08')).reason, 'All children absent', 'reason is recorded');
  is((await wagesFor('John Normal')).totals.amount_due, 270, 'driver loses half a day when the PM journey does not run');
  is((await wagesFor('Linda Assist')).totals.amount_due, 180, 'PA loses half a day too');
  await run('DELETE FROM exceptions WHERE organisation_id = ? AND id IN (?,?)', [orgId, exChildPM, exChildPM2]);
  is((await wagesFor('John Normal')).totals.amount_due, 300, 'removing the absence restores the pay');

  // ---------- 3. staff absence with cover (the worked example from the brief) ----------
  section('3. Cover driver — John absent Tuesday, Ahmed covers at 75');
  const absenceId = await addEx({ date: '2026-09-08', type: 'staff_absence', leg: 'DAY', contract_id: contractId, role: 'driver', staff_id: driverId, cover_staff_id: coverId, cover_pay: 75, paid_immediately: 0 });
  is(AM(await day('2026-09-08')).driver.status, 'covered', 'AM shows cover');
  is(PM(await day('2026-09-08')).driver.cover_name, 'Ahmed Cover', 'PM names the cover driver');
  is((await wagesFor('John Normal')).totals.amount_due, 240, 'John is NOT paid for the covered day (4 days at 60)');
  is((await wagesFor('Ahmed Cover')).totals.amount_due, 75, 'Ahmed is paid the agreed 75 override, not the 60 contract rate');
  is((await wagesFor('Ahmed Cover')).totals.cover_days, 1, 'counted as one cover day');
  is((await get('SELECT driver_id FROM contracts WHERE organisation_id = ? AND id = ?', [orgId, contractId])).driver_id, driverId, 'John remains the permanent driver for the contract');

  // ---------- 4. paid immediately must never be paid twice ----------
  section('4. "Paid immediately" prevents duplicate payment');
  await insert('payments', { staff_id: coverId, work_date: '2026-09-08', paid_date: '2026-09-08', amount: 75, source: 'cover_immediate', exception_id: absenceId, note: 'Cover paid immediately' },
    ['staff_id', 'work_date', 'paid_date', 'amount', 'source', 'exception_id', 'note'], null, orgId);
  const ahmed = await wagesFor('Ahmed Cover');
  is(ahmed.totals.gross, 75, 'gross earnings still show the cover journey');
  is(ahmed.totals.already_paid, 75, 'the immediate payment is recognised');
  is(ahmed.totals.amount_due, 0, 'nothing further is due — no duplicate payment');
  is(ahmed.lines.filter(l => l.kind === 'already_paid').length, 1, 'the deduction appears as its own traceable line');

  // ---------- 5. absence with no cover ----------
  section('5. Staff absence with no cover stops the journey');
  await run('DELETE FROM payments WHERE organisation_id = ?', [orgId]); await run('DELETE FROM exceptions WHERE organisation_id = ? AND id = ?', [orgId, absenceId]);
  const noCoverId = await addEx({ date: '2026-09-09', type: 'staff_absence', leg: 'AM', contract_id: contractId, role: 'driver', staff_id: driverId });
  is(AM(await day('2026-09-09')).status, 'not_operated', 'AM does not run without a driver');
  is(AM(await day('2026-09-09')).reason, 'Driver absent - no cover', 'reason names the problem');
  is(PM(await day('2026-09-09')).status, 'operated', 'PM is unaffected by an AM-only absence');
  is((await wagesFor('John Normal')).totals.amount_due, 270, 'John loses only the AM half-day');
  is((await wagesFor('Linda Assist')).totals.amount_due, 180, 'the PA is not paid for a journey that did not run');
  await run('DELETE FROM exceptions WHERE organisation_id = ? AND id = ?', [orgId, noCoverId]);

  // ---------- 6. PA cover for a single leg ----------
  section('6. PA cover for one leg only');
  await addEx({ date: '2026-09-10', type: 'staff_absence', leg: 'AM', contract_id: contractId, role: 'pa', staff_id: paId, cover_staff_id: paCoverId, cover_pay: 22 });
  is(AM(await day('2026-09-10')).pa.status, 'covered', 'AM PA covered');
  is(PM(await day('2026-09-10')).pa.status, 'normal', 'PM PA is the normal person');
  is((await wagesFor('Linda Assist')).totals.amount_due, 180, 'Linda loses the AM half-day only (200 - 20)');
  is((await wagesFor('Tracy Spare')).totals.amount_due, 22, 'Tracy is paid the agreed 22 for the AM cover');
  await run('DELETE FROM exceptions WHERE organisation_id = ?', [orgId]);

  // ---------- 7. school closure ----------
  section('7. School closure applies to every contract at that school');
  const closureId = await addEx({ date: '2026-09-11', type: 'school_closed', leg: 'DAY', school_id: schoolId });
  is(AM(await day('2026-09-11')).status, 'not_operated', 'AM does not run');
  is(PM(await day('2026-09-11')).reason, 'School closed', 'PM reason is the closure');
  is((await wagesFor('John Normal')).totals.amount_due, 240, 'no pay for a closed day');
  is((await finance.profitability(orgId, { ...WEEK, contract_id: contractId })).rows[0].income, 500, 'school closure retains council income');
  await run('DELETE FROM exceptions WHERE organisation_id = ? AND id = ?', [orgId, closureId]);

  // ---------- 8. pay override ----------
  section('8. Pay override for a single date');
  const overrideId = await addEx({ date: '2026-09-09', type: 'pay_override', leg: 'DAY', contract_id: contractId, role: 'driver', amount: 90 });
  is((await wagesFor('John Normal')).totals.amount_due, 330, 'one day paid at 90 instead of 60 (240 + 90)');
  await run('DELETE FROM exceptions WHERE organisation_id = ? AND id = ?', [orgId, overrideId]);

  // ---------- 9. profitability ----------
  section('9. Contract profitability');
  let p = (await finance.profitability(orgId, { ...WEEK, contract_id: contractId })).rows[0];
  is(p.income, 500, 'income is 5 days at 100');
  is(p.driver_cost, 300, 'driver cost from journeys actually operated');
  is(p.pa_cost, 200, 'PA cost from journeys actually operated');
  is(p.other_costs, 50, 'other direct costs for 5 operating days');
  is(p.gross_profit, -50, 'gross profit = income minus every cost');
  is(p.journeys_operated, 10, '10 journeys operated');
  is(p.journeys_scheduled, 10, '10 journeys scheduled');

  section('9b. Profitability reacts to a cancelled journey');
  const cancelId = await addEx({ date: '2026-09-07', type: 'journey_cancelled', leg: 'AM', contract_id: contractId, note: 'Illness' });
  p = (await finance.profitability(orgId, { ...WEEK, contract_id: contractId })).rows[0];
  is(p.income, 500, 'cancelled run retains full council income');
  is(p.driver_cost, 270, 'driver cost loses half a day');
  is(p.pa_cost, 180, 'PA is not paid for the cancelled run');
  is(p.gross_profit, 0, 'saved staff costs increase profit without reducing council income');
  is(p.journeys_operated, 9, 'nine journeys operated out of ten scheduled');
  is((await wagesFor('John Normal')).totals.amount_due, 270, 'cancelled AM run is excluded from payroll');
  const cancelledDay = await day('2026-09-07');
  is(AM(cancelledDay).driver.pay, 0, 'cancelled run has zero driver pay');
  is(AM(cancelledDay).driver.rate, 30, 'original driver rate remains visible');
  is(PM(cancelledDay).driver.pay, 30, 'other run is still paid');
  is(AM(cancelledDay).reason, 'Journey cancelled — Illness', 'cancellation reason is retained');
  const cancellationDashboard = await require('../server/services/dashboard').dashboard(orgId, '2026-09-07');
  is(cancellationDashboard.today.cancellations, { count: 1, council_income: 50, driver_pay_saved: 30 }, 'dashboard shows cancelled run, retained council income and saved pay');
  is(cancellationDashboard.today.cancelled_runs[0].label, AM(cancelledDay).label, 'dashboard identifies the cancelled run');
  is(cancellationDashboard.finance.today.income, 100, 'dashboard retains council income');
  is(cancellationDashboard.finance.today.driver_cost, 30, 'dashboard removes cancelled driver pay');
  is(cancellationDashboard.finance.today.gross_profit, 40, 'dashboard profit reflects the saved costs');
  await run("UPDATE contracts SET pay_basis = 'per_day', income_basis = 'per_day' WHERE organisation_id = ? AND id = ?", [orgId, contractId]);
  const fixedCancelledDay = await day('2026-09-07');
  is(AM(fixedCancelledDay).driver.pay, 0, 'fixed day pay does not pay an explicitly cancelled run');
  is(PM(fixedCancelledDay).driver.pay, 30, 'fixed day pay retains the remaining run share');
  is(fixedCancelledDay.income, 100, 'fixed day council income is retained');
  is((await wagesFor('John Normal')).totals.amount_due, 270, 'fixed day payroll deducts cancelled run share');
  const wholeDayCancellation = await addEx({ date: '2026-09-08', type: 'contract_cancelled', leg: 'DAY', contract_id: contractId, note: 'School closure' });
  const fullyCancelled = await day('2026-09-08');
  is(fullyCancelled.cancelled_trips, 2, 'full day cancellation counts each run');
  is(fullyCancelled.income, 100, 'fully cancelled day retains fixed council income');
  is(fullyCancelled.trips.reduce((total, trip) => total + trip.driver.pay, 0), 0, 'fully cancelled day has no driver pay');
  is(fullyCancelled.other_costs, 0, 'cancelled full day has no operating costs');
  await run('DELETE FROM exceptions WHERE organisation_id = ? AND id = ?', [orgId, wholeDayCancellation]);
  await run("UPDATE contracts SET pay_basis = 'per_journey', income_basis = 'per_journey' WHERE organisation_id = ? AND id = ?", [orgId, contractId]);
  const cancelledCover = await addEx({ date: '2026-09-07', type: 'staff_absence', leg: 'DAY', contract_id: contractId, role: 'driver', cover_staff_id: coverId, cover_pay: 70 });
  is((await wagesFor('Ahmed Cover')).totals.amount_due, 35, 'cover pay loses the cancelled half of the agreed day rate');
  is((await finance.expectedDaily(orgId, '2026-09-07')).driver_cost, 35, 'dashboard cover cost matches payroll after cancellation');
  await run('DELETE FROM exceptions WHERE organisation_id = ? AND id = ?', [orgId, cancelledCover]);
  await run('DELETE FROM exceptions WHERE organisation_id = ? AND id = ?', [orgId, cancelId]);
  is((await wagesFor('John Normal')).totals.amount_due, 300, 'undoing cancellation restores driver pay');
  is((await finance.expectedDaily(orgId, '2026-09-07')).gross_profit, -10, 'undoing cancellation restores normal profit');

  // ---------- 10. compliance traffic lights ----------
  section('10. Compliance traffic lights are calculated, never stored');
  await setSetting(orgId, 'amber_days', '30');
  await setSetting(orgId, 'required_docs_driver', JSON.stringify(['DBS', 'Driving Licence']));
  const DOC = ['entity_type', 'entity_id', 'doc_type', 'expiry_date', 'status'];
  is((await compliance.staffCompliance(orgId, driverId, 'driver')).status, 'red', 'red when required documents are missing');
  const dbsId = await insert('documents', { entity_type: 'staff', entity_id: driverId, doc_type: 'DBS', expiry_date: cal.addDays(cal.today(), 400), status: 'valid' }, DOC, null, orgId);
  is((await compliance.staffCompliance(orgId, driverId, 'driver')).status, 'red', 'still red while the licence is missing');
  const licId = await insert('documents', { entity_type: 'staff', entity_id: driverId, doc_type: 'Driving Licence', expiry_date: cal.addDays(cal.today(), 400), status: 'valid' }, DOC, null, orgId);
  is((await compliance.staffCompliance(orgId, driverId, 'driver')).status, 'red', 'selfie required even with customised document requirements');
  const selfieId = await insert('documents', { entity_type: 'staff', entity_id: driverId, doc_type: 'Selfie picture', status: 'valid' }, DOC, null, orgId);
  is((await compliance.staffCompliance(orgId, driverId, 'driver')).status, 'red', 'selfie record without an image does not satisfy verification');
  await run('UPDATE documents SET file_data = ?, mime_type = ? WHERE organisation_id = ? AND id = ?', ['aW1hZ2U=', 'image/jpeg', orgId, selfieId]);
  is((await compliance.staffCompliance(orgId, driverId, 'driver')).status, 'red', 'GDPR required even with customised requirements');
  const gdprId = await insert('documents', { entity_type: 'staff', entity_id: driverId, doc_type: 'GDPR', status: 'valid' }, DOC, null, orgId);
  is((await compliance.staffCompliance(orgId, driverId, 'driver')).items.find(item => item.doc_type === 'GDPR').reason, 'Issue date required', 'GDPR without issue date is flagged');
  await run('UPDATE documents SET issue_date = ? WHERE organisation_id = ? AND id = ?', ['2026-09-01', orgId, gdprId]);
  is((await compliance.staffCompliance(orgId, driverId, 'driver')).items.find(item => item.doc_type === 'GDPR').reason, 'Issued 01/09/2026', 'GDPR issue date shown in compliance');
  is((await compliance.requiredDocs(orgId, 'pa')).includes('GDPR'), true, 'PAs require GDPR');
  is((await compliance.staffCompliance(orgId, driverId, 'driver')).status, 'green', 'green when all required documents are valid');
  await run('UPDATE documents SET status = ? WHERE organisation_id = ? AND id = ?', ['needs_review', orgId, dbsId]);
  is((await compliance.staffCompliance(orgId, driverId, 'driver')).status, 'amber', 'auto input review flag is persisted and shown in compliance');
  await run('UPDATE documents SET status = ? WHERE organisation_id = ? AND id = ?', ['valid', orgId, dbsId]);
  await run('UPDATE documents SET expiry_date = ? WHERE organisation_id = ? AND id = ?', [cal.addDays(cal.today(), 20), orgId, dbsId]);
  is((await compliance.staffCompliance(orgId, driverId, 'driver')).status, 'amber', 'amber inside the 30-day warning window');
  await setSetting(orgId, 'amber_days', '10');
  is((await compliance.staffCompliance(orgId, driverId, 'driver')).status, 'green', 'green again when the warning window is narrowed to 10 days');
  await setSetting(orgId, 'amber_days', '30');
  await run('UPDATE documents SET expiry_date = ? WHERE organisation_id = ? AND id = ?', [cal.addDays(cal.today(), -1), orgId, dbsId]);
  is((await compliance.staffCompliance(orgId, driverId, 'driver')).status, 'red', 'red once the document has expired');
  await run('UPDATE documents SET expiry_date = ?, status = ? WHERE organisation_id = ? AND id = ?', [cal.addDays(cal.today(), 400), 'invalid', orgId, dbsId]);
  is((await compliance.staffCompliance(orgId, driverId, 'driver')).status, 'red', 'red when a document is marked invalid');
  await setSetting(orgId, 'required_docs_driver', JSON.stringify(['Safeguarding Training']));
  const safeguardingIds = [];
  const safeguardingColumns = [...DOC, 'file_data', 'file_name'];
  for (let index = 0; index < 3; index++) {
    safeguardingIds.push(await insert('documents', { entity_type: 'staff', entity_id: driverId,
      doc_type: 'Safeguarding Training', expiry_date: cal.addDays(cal.today(), 400), status: 'valid',
      file_data: Buffer.from('certificate ' + index).toString('base64'), file_name: 'safeguarding-' + index + '.pdf',
    }, safeguardingColumns, null, orgId));
    const result = await compliance.staffCompliance(orgId, driverId, 'driver');
    is(result.status, index < 2 ? 'red' : 'green', (index + 1) + ' safeguarding certificates: requires all 3');
    is(result.items.find(item => item.doc_type === 'Safeguarding Training').uploaded_count, index + 1, 'safeguarding certificate count is shown');
  }
  await run('UPDATE documents SET status = ? WHERE organisation_id = ? AND id = ?', ['needs_review', orgId, safeguardingIds[1]]);
  is((await compliance.staffCompliance(orgId, driverId, 'driver')).status, 'amber', 'each safeguarding certificate needs review independently');
  await run('UPDATE documents SET expiry_date = ?, status = ? WHERE organisation_id = ? AND id = ?', [cal.addDays(cal.today(), -1), 'valid', orgId, safeguardingIds[1]]);
  is((await compliance.staffCompliance(orgId, driverId, 'driver')).status, 'red', 'one expired safeguarding certificate flags compliance');
  await run('UPDATE documents SET status = ? WHERE organisation_id = ? AND id = ?', ['superseded', orgId, safeguardingIds[1]]);
  is((await compliance.staffCompliance(orgId, driverId, 'driver')).items.find(item => item.doc_type === 'Safeguarding Training').uploaded_count, 2, 'superseded safeguarding certificates do not count');
  for (const id of safeguardingIds) await run('DELETE FROM documents WHERE organisation_id = ? AND id = ?', [orgId, id]);
  const documentRoutes = require('../server/routes');
  const documentRequest = async (method, path, body, files = [], query = {}) => {
    const res = { writeHead(status) { this.status = status; }, end(value) { this.body = JSON.parse(value); } };
    await documentRoutes.handle({ req: { method }, res, path, body, files, query,
      user: { organisation_id: orgId, name: 'Document test' } });
    return res;
  };
  const certificates = Array.from({ length: 3 }, (_, index) => ({ doc_type: 'Safeguarding Training', reference: 'BATCH-' + index,
    issue_date: '2026-09-01', expiry_date: '2028-09-0' + (index + 1), status: index === 1 ? 'needs_review' : 'valid' }));
  const certificateFiles = certificates.map((certificate, index) => ({ field: 'file_' + index,
    filename: 'batch-' + index + '.txt', mime: 'text/plain', data: Buffer.from(certificate.reference) }));
  const batchBody = { entity_type: 'staff', entity_id: driverId, documents: JSON.stringify(certificates) };
  const badBatch = await documentRequest('POST', '/api/documents/batch', batchBody, certificateFiles.slice(0, 2));
  is(badBatch.status, 400, 'incomplete safeguarding batch is rejected before saving');
  const batch = await documentRequest('POST', '/api/documents/batch', batchBody, certificateFiles);
  is(batch.status, 201, 'three safeguarding certificates save together');
  is(batch.body.documents.map(document => document.reference), ['BATCH-0', 'BATCH-1', 'BATCH-2'], 'batch preserves each certificate reference');
  is(batch.body.documents.map(document => document.expiry_date), ['2028-09-01', '2028-09-02', '2028-09-03'], 'batch preserves each certificate expiry date');
  is(batch.body.documents.map(document => document.status), ['valid', 'needs_review', 'valid'], 'batch preserves independent certificate review statuses');
  for (const document of batch.body.documents) {
    const stored = await get('SELECT file_data FROM documents WHERE organisation_id = ? AND id = ?', [orgId, document.id]);
    is(Buffer.from(stored.file_data, 'base64').toString(), document.reference, 'certificate metadata is paired with its own file');
    await run('DELETE FROM documents WHERE organisation_id = ? AND id = ?', [orgId, document.id]);
  }
  const insurance = await documentRequest('POST', '/api/documents', { entity_type: 'staff', entity_id: driverId,
    doc_type: 'Vehicle Insurance', vehicle_registration: 'AB12CDE', status: 'needs_review' });
  is(insurance.body.vehicle_registration, 'AB12CDE', 'car registration survives document saving');
  const insuranceUpdate = await documentRequest('PUT', '/api/documents/' + insurance.body.id, { vehicle_registration: 'XY23ZAB' });
  is(insuranceUpdate.body.vehicle_registration, 'XY23ZAB', 'car registration can be corrected during review');
  const listedDocuments = await documentRequest('GET', '/api/documents', {}, [], { entity_type: 'staff', entity_id: driverId });
  is(listedDocuments.body.find(document => document.id === insurance.body.id).vehicle_registration, 'XY23ZAB', 'car registration is included in document listings');
  await run('DELETE FROM documents WHERE organisation_id = ? AND id = ?', [orgId, insurance.body.id]);
  is((await documentRequest('POST', '/api/documents', { entity_type: 'staff', entity_id: driverId, doc_type: 'GDPR' })).status, 400, 'GDPR creation requires issue date');
  is((await documentRequest('PUT', '/api/documents/' + gdprId, { issue_date: '2026-02-30' })).status, 400, 'GDPR rejects invalid calendar dates');
  is((await documentRequest('PUT', '/api/documents/' + gdprId, { notes: 'Reviewed' })).status, 200, 'GDPR metadata edits preserve issue date');
  await run('DELETE FROM documents WHERE organisation_id = ? AND id IN (?,?,?,?)', [orgId, dbsId, licId, selfieId, gdprId]);

  // ---------- 11. relational integrity ----------
  section('11. Single source of truth');
  const newDriver = await insert('staff', { type: 'driver', first_name: 'New', last_name: 'Driver' }, ['type', 'first_name', 'last_name'], null, orgId);
  await run('UPDATE contracts SET driver_id = ? WHERE organisation_id = ? AND id = ?', [newDriver, orgId, contractId]);
  const childRow = await get(`SELECT d.first_name || ' ' || d.last_name AS driver
    FROM children ch JOIN contracts c ON c.id = ch.contract_id JOIN staff d ON d.id = c.driver_id
    WHERE ch.organisation_id = ? AND ch.id = ?`, [orgId, childA]);
  is(childRow.driver, 'New Driver', "changing the contract's driver updates every child's assigned driver");
  is(AM(await day('2026-09-07')).driver.normal_name, 'New Driver', 'the calendar picks up the new driver immediately');
  await run('UPDATE contracts SET driver_id = ? WHERE organisation_id = ? AND id = ?', [driverId, orgId, contractId]);

  // ---------- 12. per-day pay basis ----------
  section('12. Fixed per-day pay basis');
  await run("UPDATE contracts SET pay_basis = 'per_day', income_basis = 'per_day' WHERE organisation_id = ? AND id = ?", [orgId, contractId]);
  const absent = await addEx({ date: '2026-09-07', type: 'child_absence', leg: 'PM', contract_id: contractId, child_id: childA });
  const absent2 = await addEx({ date: '2026-09-07', type: 'child_absence', leg: 'PM', contract_id: contractId, child_id: childB });
  is((await wagesFor('John Normal')).totals.amount_due, 300, 'on a fixed day rate the driver is still paid when children do not travel');
  const closed = await addEx({ date: '2026-09-07', type: 'journey_cancelled', leg: 'DAY', contract_id: contractId });
  is((await wagesFor('John Normal')).totals.amount_due, 240, 'but not when the journey itself is cancelled');
  await run('DELETE FROM exceptions WHERE organisation_id = ?', [orgId]);
  await run("UPDATE contracts SET pay_basis = 'per_journey', income_basis = 'per_journey' WHERE organisation_id = ? AND id = ?", [orgId, contractId]);

  // ---------- 13. date filtering ----------
  section('13. Wage period boundaries');
  is((await wagesFor('John Normal', { from: '2026-09-07', to: '2026-09-07' })).totals.amount_due, 60, 'a single day pays one day');
  is((await wagesFor('John Normal', { from: '2026-09-05', to: '2026-09-06' })).totals.amount_due, 0, 'a weekend pays nothing');
  is((await wagesFor('John Normal', { from: '2026-08-25', to: '2026-08-31' })).totals.amount_due, 0, 'nothing before the contract start date');
  is((await wagesFor('John Normal', { from: '2026-09-07', to: '2026-09-18' })).totals.amount_due, 600, 'two full weeks pay ten days');


  // ---------- 14. a week that is not the same every day ----------
  section('14. Weekly contract schedules — a Friday with three journeys');
  const AMT = { label: 'AM school drop-off', kind: 'outbound', depart_time: '07:45' };
  const PMT = { label: 'PM school collection', kind: 'return', depart_time: '15:15' };
  const saveSchedule = async (from, days, note) => {
    const sid = await insert('contract_schedules',
      { contract_id: contractId, effective_from: from, note: note || null },
      ['contract_id', 'effective_from', 'note'], null, orgId);
    for (const [weekday, trips] of Object.entries(days)) {
      let seq = 0;
      for (const t of trips) {
        seq += 1;
        const tid = await insert('contract_trips', { ...t, schedule_id: sid, weekday: Number(weekday), seq },
          ['schedule_id', 'weekday', 'seq', 'label', 'kind', 'depart_time', 'driver_pay', 'pa_pay', 'income'], null, orgId);
        for (const cid of t.children || []) {
          await insert('contract_trip_children', { trip_id: tid, child_id: cid }, ['trip_id', 'child_id'], null, orgId);
        }
      }
    }
    return sid;
  };
  // Mon-Thu as normal. Friday: the AM run, a 1pm collection for Child A, a 3pm for Child B.
  const autumnId = await saveSchedule('2026-09-07', {
    1: [AMT, PMT], 2: [AMT, PMT], 3: [AMT, PMT], 4: [AMT, PMT],
    5: [AMT,
      { label: '1pm early collection', kind: 'return', depart_time: '13:00', children: [childA] },
      { label: '3pm collection', kind: 'return', depart_time: '15:00', children: [childB] }],
  }, 'Autumn term');

  const friday = await day('2026-09-11');
  const thursday = await day('2026-09-10');
  is(thursday.planned_trips, 2, 'Thursday still runs two journeys');
  is(friday.planned_trips, 3, 'Friday runs three journeys');
  is(friday.trips.map(t => t.label), ['AM school drop-off', '1pm early collection', '3pm collection'], 'the journeys are named and in order');
  is(trip(friday, 2).children.map(c => c.name), ['Child A'], 'the 1pm collection carries Child A only');
  is(trip(friday, 3).children.map(c => c.name), ['Child B'], 'the 3pm collection carries Child B only');
  is(trip(friday, 2).children_not_scheduled, 1, 'Child B is not on the 1pm run');
  is((await day('2026-09-12')).trips.length, 0, 'Saturday still runs nothing');

  section('14b. The extra Friday journey is paid');
  is(trip(thursday, 1).driver_rate, 30, 'a normal day is two journeys at half the day rate');
  is(trip(friday, 3).driver_rate, 30, 'the third Friday journey is worth the same as any other journey');
  is((await wagesFor('John Normal')).totals.amount_due, 330, 'the driver earns an extra journey on top of five days (300 + 30)');
  is((await wagesFor('Linda Assist')).totals.amount_due, 220, 'the PA is paid for the extra journey too (200 + 20)');
  is((await wagesFor('John Normal')).totals.journeys, 11, 'eleven journeys in the week, not ten');
  const fridayLines = (await wagesFor('John Normal')).lines.filter(l => l.date === '2026-09-11');
  is(fridayLines.map(l => l.leg), ['Trip 1', 'Trip 2', 'Trip 3'], 'each Friday journey is its own wage line');

  section('14c. A journey with its own rate overrides the share');
  const paidId = await saveSchedule('2026-09-14', {
    1: [AMT, PMT], 2: [AMT, PMT], 3: [AMT, PMT], 4: [AMT, PMT],
    5: [AMT, PMT, { label: 'Late swimming run', kind: 'return', depart_time: '17:00', driver_pay: 45, pa_pay: 25, income: 80 }],
  }, 'From 14 September');
  const lateFriday = await day('2026-09-18');
  is(trip(lateFriday, 3).driver_rate, 45, 'the named rate wins over the share of the day rate');
  is(trip(lateFriday, 3).income_value, 80, 'the named income wins too');
  const cancelledLateRun = await addEx({ date: '2026-09-18', type: 'journey_cancelled', leg: 'PM', contract_id: contractId, trip_seq: 3, note: 'Vehicle breakdown' });
  const lateCancelled = await day('2026-09-18');
  is(trip(lateCancelled, 3).driver.pay, 0, 'named journey pay is zero after cancellation');
  is(trip(lateCancelled, 3).driver_rate, 45, 'cancelled journey preserves its named driver rate');
  is(trip(lateCancelled, 3).council_income, 80, 'cancelled journey retains its named council income');
  is(lateCancelled.income, 180, 'custom journey income remains included in daily council revenue');
  is(trip(lateCancelled, 2).status, 'operated', 'cancelling a numbered journey leaves another PM journey running');
  await run('DELETE FROM exceptions WHERE organisation_id = ? AND id = ?', [orgId, cancelledLateRun]);
  is((await wagesFor('John Normal', { from: '2026-09-14', to: '2026-09-18' })).totals.amount_due, 345, 'the week pays five days plus the 45 swimming run');

  section('14d. An effective date never rewrites what already happened');
  is((await day('2026-09-11')).trips.map(t => t.label), ['AM school drop-off', '1pm early collection', '3pm collection'],
    'the Friday before the change keeps the pattern it had');
  is((await wagesFor('John Normal', { from: '2026-09-07', to: '2026-09-11' })).totals.amount_due, 330,
    'and its wages are unchanged by next week’s pattern');
  await run('DELETE FROM contract_schedules WHERE organisation_id = ? AND id = ?', [orgId, paidId]);

  // ---------- 15. child timetables ----------
  section('15. Child timetables — a normal day off is not an absence');
  const ttId = await insert('child_timetables',
    { child_id: childA, effective_from: '2026-09-07', same_all_week: 1, start_time: '09:00', finish_time: '15:00' },
    ['child_id', 'effective_from', 'same_all_week', 'start_time', 'finish_time'], null, orgId);
  for (const [weekday, attends] of [[1, 1], [2, 1], [3, 0], [4, 1], [5, 1]]) {
    await insert('child_timetable_days', { timetable_id: ttId, weekday, attends },
      ['timetable_id', 'weekday', 'attends'], null, orgId);
  }
  const wed = await day('2026-09-09');
  const childAWed = wed.children.find(c => c.name === 'Child A');
  const childBWed = wed.children.find(c => c.name === 'Child B');
  is(childAWed.scheduled, false, 'Child A is not expected in on a Wednesday');
  is(childAWed.status, 'not_scheduled', 'and that is recorded as a normal day off, not an absence');
  is(childBWed.status, 'travelling', 'Child B still travels');
  is(wed.operated, true, 'the contract still runs for the other child');
  is(AM(wed).children_absent, 0, 'nobody is counted absent');
  is(AM(wed).children_travelling, 1, 'one child travels');
  is(wed.children.filter(c => !c.scheduled).length, 1, 'one child has a normal day off');
  is(childAWed.start_time, '09:00', 'the timetable supplies the start time');
  is((await wagesFor('John Normal')).totals.amount_due, 330, 'a normal day off costs the driver nothing');

  section('15b. Every child off means the journey does not run');
  const ttB = await insert('child_timetables',
    { child_id: childB, effective_from: '2026-09-07', same_all_week: 1, start_time: '09:00', finish_time: '15:00' },
    ['child_id', 'effective_from', 'same_all_week', 'start_time', 'finish_time'], null, orgId);
  await insert('child_timetable_days', { timetable_id: ttB, weekday: 3, attends: 0 },
    ['timetable_id', 'weekday', 'attends'], null, orgId);
  const wedEmpty = await day('2026-09-09');
  is(wedEmpty.operated, false, 'with nobody travelling the contract does not run that day');
  is(AM(wedEmpty).reason, 'No children scheduled', 'and the reason says so');
  is((await wagesFor('John Normal')).totals.amount_due, 270, 'the driver is not paid for a day nobody travels');
  await run('DELETE FROM child_timetables WHERE organisation_id = ? AND id = ?', [orgId, ttB]);

  section('15c. A timetable change from a date leaves earlier weeks alone');
  const ttLater = await insert('child_timetables',
    { child_id: childA, effective_from: '2026-09-14', same_all_week: 1, start_time: '08:30', finish_time: '16:00' },
    ['child_id', 'effective_from', 'same_all_week', 'start_time', 'finish_time'], null, orgId);
  for (const weekday of [1, 2, 3, 4, 5]) {
    await insert('child_timetable_days', { timetable_id: ttLater, weekday, attends: 1 },
      ['timetable_id', 'weekday', 'attends'], null, orgId);
  }
  is((await day('2026-09-09')).children.find(c => c.name === 'Child A').scheduled, false,
    'the Wednesday before the change is still a day off');
  is((await day('2026-09-16')).children.find(c => c.name === 'Child A').scheduled, true,
    'the Wednesday after the change is a travelling day');
  is((await day('2026-09-16')).children.find(c => c.name === 'Child A').start_time, '08:30', 'with the new start time');
  await run('DELETE FROM child_timetables WHERE organisation_id = ? AND child_id = ?', [orgId, childA]);

  // ---------- 16. one-off journeys and journey-level exceptions ----------
  section('16. One-off changes to a single date');
  const extraId = await addEx({
    date: '2026-09-08', type: 'extra_journey', contract_id: contractId, leg: 'DAY',
    trip_label: 'Hospital appointment run', trip_kind: 'other', amount: 25,
  });
  const tue = await day('2026-09-08');
  is(tue.trips.length, 3, 'the extra journey appears on that date');
  is(tue.planned_trips, 2, 'but the weekly pattern still plans two');
  is(trip(tue, 3).source, 'extra', 'it is marked as a one-off');
  is((await day('2026-09-15')).trips.length, 2, 'and it does not repeat the following week');
  await run('DELETE FROM exceptions WHERE organisation_id = ? AND id = ?', [orgId, extraId]);

  section('16b. An absence can name one journey of the day');
  const tripAbsence = await addEx({
    date: '2026-09-11', type: 'child_absence', contract_id: contractId, child_id: childB,
    leg: 'DAY', trip_seq: 3, trip_label: '3pm collection',
  });
  const friAbs = await day('2026-09-11');
  is(trip(friAbs, 1).children_absent, 0, 'the AM run is unaffected');
  is(trip(friAbs, 3).children_absent, 1, 'the 3pm collection records the absence');
  is(trip(friAbs, 3).status, 'not_operated', 'and does not run, since Child B was its only passenger');
  is(trip(friAbs, 2).status, 'operated', 'the 1pm collection still runs for Child A');
  is((await wagesFor('John Normal')).totals.amount_due, 300, 'the driver loses only that one journey (330 - 30)');
  await run('DELETE FROM exceptions WHERE organisation_id = ? AND id = ?', [orgId, tripAbsence]);

  section('16c. A school closure stops the journeys and blames nobody');
  const holiday = await addEx({ date: '2026-09-11', type: 'school_closed', leg: 'DAY', contract_id: contractId, note: 'Teacher training' });
  const closedFri = await day('2026-09-11');
  is(closedFri.trips.every(t => t.status === 'not_operated'), true, 'no journey runs');
  is(closedFri.trips.every(t => t.reason === 'School closed — Teacher training'), true, 'the closure reason is shown on each cancelled run');
  is(closedFri.children.every(c => c.scheduled), true, 'the children were still expected in — they are not absent');
  is(closedFri.trips.reduce((a, t) => a + t.children_absent, 0), 0, 'nobody is marked absent');
  is((await wagesFor('John Normal')).totals.amount_due, 240, 'and the day is not paid');
  await run('DELETE FROM exceptions WHERE organisation_id = ? AND id = ?', [orgId, holiday]);
  await run('DELETE FROM contract_schedules WHERE organisation_id = ? AND id = ?', [orgId, autumnId]);
  is((await day('2026-09-11')).planned_trips, 2, 'removing the pattern returns the contract to a standard week');
  is((await wagesFor('John Normal')).totals.amount_due, 300, 'and to five ordinary days of pay');

  console.log(`\n${pass} passed, ${fail} failed on ${database.describe}`);
  return fail;
}

main()
  .then(async fail => {
    try { await database.dropSchema(); } catch (_) {}
    try { await database.close(); } catch (_) {}
    if (database.dialect === 'sqlite') { try { require('fs').unlinkSync(process.env.H2S_DB); } catch (_) {} }
    process.exit(fail ? 1 : 0);
  })
  .catch(async e => {
    console.error('\nTest run failed:', e.stack || e.message);
    try { await database.close(); } catch (_) {}
    process.exit(1);
  });
