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
  let pass = 0, fail = 0;
  function is(actual, expected, label) {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a === b) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}\n         expected ${b}\n         actual   ${a}`); }
  }
  function section(t) { console.log('\n' + t); }

  // ---------- fixture ----------
  // A Mon-Fri contract: income 100/day, driver 60/day, PA 40/day, all pro-rata per journey.
  const schoolId = await insert('schools', { name: 'Test School' }, ['name']);
  const driverId = await insert('staff', { type: 'driver', first_name: 'John', last_name: 'Normal', default_day_rate: 60 }, ['type', 'first_name', 'last_name', 'default_day_rate']);
  const coverId = await insert('staff', { type: 'driver', first_name: 'Ahmed', last_name: 'Cover', status: 'pool', default_day_rate: 70 }, ['type', 'first_name', 'last_name', 'status', 'default_day_rate']);
  const paId = await insert('staff', { type: 'pa', first_name: 'Linda', last_name: 'Assist', default_day_rate: 40 }, ['type', 'first_name', 'last_name', 'default_day_rate']);
  const paCoverId = await insert('staff', { type: 'pa', first_name: 'Tracy', last_name: 'Spare', status: 'pool' }, ['type', 'first_name', 'last_name', 'status']);
  const contractId = await insert('contracts', {
    code: 'TEST 1', school_id: schoolId, driver_id: driverId, pa_id: paId, requires_pa: 1, status: 'active',
    start_date: '2026-09-01', end_date: '2026-12-31', days_of_week: '1,2,3,4,5',
    income_per_day: 100, income_basis: 'per_journey', driver_pay_per_day: 60, pa_pay_per_day: 40,
    pay_basis: 'per_journey', other_costs_per_day: 10,
  }, ['code', 'school_id', 'driver_id', 'pa_id', 'requires_pa', 'status', 'start_date', 'end_date', 'days_of_week', 'income_per_day', 'income_basis', 'driver_pay_per_day', 'pa_pay_per_day', 'pay_basis', 'other_costs_per_day']);
  const childA = await insert('children', { first_name: 'Child', last_name: 'A', contract_id: contractId, school_id: schoolId, status: 'active' }, ['first_name', 'last_name', 'contract_id', 'school_id', 'status']);
  const childB = await insert('children', { first_name: 'Child', last_name: 'B', contract_id: contractId, school_id: schoolId, status: 'active' }, ['first_name', 'last_name', 'contract_id', 'school_id', 'status']);

  const EX = ['date', 'type', 'leg', 'contract_id', 'school_id', 'child_id', 'role', 'staff_id', 'cover_staff_id', 'cover_pay', 'paid_immediately', 'amount', 'note'];
  const addEx = d => insert('exceptions', d, EX);
  // Mon 7 Sep to Fri 11 Sep 2026 is a clean 5-day week.
  const WEEK = { from: '2026-09-07', to: '2026-09-11' };
  const day = async (date) => {
    const c = (await cal.loadContracts(' WHERE c.id = ?', [contractId]))[0];
    const kids = (await cal.loadChildrenByContract([contractId]))[contractId] || [];
    return cal.evaluateContractDay(c, date, kids, await cal.loadExceptions(date, date));
  };
  const wagesFor = async (name, range = WEEK) => {
    const w = await wages.calculateWages({ ...range, include_zero: true });
    return w.results.find(r => r.staff.name === name) || { totals: { amount_due: 0, gross: 0, normal_earnings: 0, cover_earnings: 0, already_paid: 0 } };
  };

  // ---------- 1. the baseline: nothing recorded means everything ran ----------
  section('1. Exception management — a normal week needs no data entry');
  const testContract = (await cal.loadContracts(' WHERE c.id=?', [contractId]))[0];
  is(cal.contractOperatesOn(testContract, '2026-09-07'), true, 'operates on a Monday');
  is(cal.contractOperatesOn(testContract, '2026-09-12'), false, 'does not operate on a Saturday');
  is((await day('2026-09-07')).legs.AM.status, 'operated', 'AM assumed operated with no exception recorded');
  is((await day('2026-09-07')).legs.PM.status, 'operated', 'PM assumed operated with no exception recorded');
  is((await wagesFor('John Normal')).totals.amount_due, 300, 'driver earns 5 days at 60 with no data entry');
  is((await wagesFor('Linda Assist')).totals.amount_due, 200, 'PA earns 5 days at 40 with no data entry');

  // ---------- 2. child absence ----------
  section('2. Child absence');
  const exChildPM = await addEx({ date: '2026-09-08', type: 'child_absence', leg: 'PM', contract_id: contractId, child_id: childA });
  is((await day('2026-09-08')).legs.PM.children_absent, 1, 'one child marked absent PM');
  is((await day('2026-09-08')).legs.PM.status, 'operated', 'journey still runs while another child travels');
  is((await wagesFor('John Normal')).totals.amount_due, 300, 'driver pay unchanged when one of two children is absent');
  const exChildPM2 = await addEx({ date: '2026-09-08', type: 'child_absence', leg: 'PM', contract_id: contractId, child_id: childB });
  is((await day('2026-09-08')).legs.PM.status, 'not_operated', 'journey does not run when every child is absent');
  is((await day('2026-09-08')).legs.PM.reason, 'All children absent', 'reason is recorded');
  is((await wagesFor('John Normal')).totals.amount_due, 270, 'driver loses half a day when the PM journey does not run');
  is((await wagesFor('Linda Assist')).totals.amount_due, 180, 'PA loses half a day too');
  await run('DELETE FROM exceptions WHERE id IN (?,?)', [exChildPM, exChildPM2]);
  is((await wagesFor('John Normal')).totals.amount_due, 300, 'removing the absence restores the pay');

  // ---------- 3. staff absence with cover (the worked example from the brief) ----------
  section('3. Cover driver — John absent Tuesday, Ahmed covers at 75');
  const absenceId = await addEx({ date: '2026-09-08', type: 'staff_absence', leg: 'DAY', contract_id: contractId, role: 'driver', staff_id: driverId, cover_staff_id: coverId, cover_pay: 75, paid_immediately: 0 });
  is((await day('2026-09-08')).legs.AM.driver.status, 'covered', 'AM shows cover');
  is((await day('2026-09-08')).legs.PM.driver.cover_name, 'Ahmed Cover', 'PM names the cover driver');
  is((await wagesFor('John Normal')).totals.amount_due, 240, 'John is NOT paid for the covered day (4 days at 60)');
  is((await wagesFor('Ahmed Cover')).totals.amount_due, 75, 'Ahmed is paid the agreed 75 override, not the 60 contract rate');
  is((await wagesFor('Ahmed Cover')).totals.cover_days, 1, 'counted as one cover day');
  is((await get('SELECT driver_id FROM contracts WHERE id=?', [contractId])).driver_id, driverId, 'John remains the permanent driver for the contract');

  // ---------- 4. paid immediately must never be paid twice ----------
  section('4. "Paid immediately" prevents duplicate payment');
  await insert('payments', { staff_id: coverId, work_date: '2026-09-08', paid_date: '2026-09-08', amount: 75, source: 'cover_immediate', exception_id: absenceId, note: 'Cover paid immediately' },
    ['staff_id', 'work_date', 'paid_date', 'amount', 'source', 'exception_id', 'note']);
  const ahmed = await wagesFor('Ahmed Cover');
  is(ahmed.totals.gross, 75, 'gross earnings still show the cover journey');
  is(ahmed.totals.already_paid, 75, 'the immediate payment is recognised');
  is(ahmed.totals.amount_due, 0, 'nothing further is due — no duplicate payment');
  is(ahmed.lines.filter(l => l.kind === 'already_paid').length, 1, 'the deduction appears as its own traceable line');

  // ---------- 5. absence with no cover ----------
  section('5. Staff absence with no cover stops the journey');
  await run('DELETE FROM payments'); await run('DELETE FROM exceptions WHERE id = ?', [absenceId]);
  const noCoverId = await addEx({ date: '2026-09-09', type: 'staff_absence', leg: 'AM', contract_id: contractId, role: 'driver', staff_id: driverId });
  is((await day('2026-09-09')).legs.AM.status, 'not_operated', 'AM does not run without a driver');
  is((await day('2026-09-09')).legs.AM.reason, 'Driver absent - no cover', 'reason names the problem');
  is((await day('2026-09-09')).legs.PM.status, 'operated', 'PM is unaffected by an AM-only absence');
  is((await wagesFor('John Normal')).totals.amount_due, 270, 'John loses only the AM half-day');
  is((await wagesFor('Linda Assist')).totals.amount_due, 180, 'the PA is not paid for a journey that did not run');
  await run('DELETE FROM exceptions WHERE id = ?', [noCoverId]);

  // ---------- 6. PA cover for a single leg ----------
  section('6. PA cover for one leg only');
  await addEx({ date: '2026-09-10', type: 'staff_absence', leg: 'AM', contract_id: contractId, role: 'pa', staff_id: paId, cover_staff_id: paCoverId, cover_pay: 22 });
  is((await day('2026-09-10')).legs.AM.pa.status, 'covered', 'AM PA covered');
  is((await day('2026-09-10')).legs.PM.pa.status, 'normal', 'PM PA is the normal person');
  is((await wagesFor('Linda Assist')).totals.amount_due, 180, 'Linda loses the AM half-day only (200 - 20)');
  is((await wagesFor('Tracy Spare')).totals.amount_due, 22, 'Tracy is paid the agreed 22 for the AM cover');
  await run('DELETE FROM exceptions');

  // ---------- 7. school closure ----------
  section('7. School closure applies to every contract at that school');
  const closureId = await addEx({ date: '2026-09-11', type: 'school_closed', leg: 'DAY', school_id: schoolId });
  is((await day('2026-09-11')).legs.AM.status, 'not_operated', 'AM does not run');
  is((await day('2026-09-11')).legs.PM.reason, 'School closed', 'PM reason is the closure');
  is((await wagesFor('John Normal')).totals.amount_due, 240, 'no pay for a closed day');
  is((await finance.profitability({ ...WEEK, contract_id: contractId })).rows[0].income, 400, 'income drops to 4 days');
  await run('DELETE FROM exceptions WHERE id = ?', [closureId]);

  // ---------- 8. pay override ----------
  section('8. Pay override for a single date');
  const overrideId = await addEx({ date: '2026-09-09', type: 'pay_override', leg: 'DAY', contract_id: contractId, role: 'driver', amount: 90 });
  is((await wagesFor('John Normal')).totals.amount_due, 330, 'one day paid at 90 instead of 60 (240 + 90)');
  await run('DELETE FROM exceptions WHERE id = ?', [overrideId]);

  // ---------- 9. profitability ----------
  section('9. Contract profitability');
  let p = (await finance.profitability({ ...WEEK, contract_id: contractId })).rows[0];
  is(p.income, 500, 'income is 5 days at 100');
  is(p.driver_cost, 300, 'driver cost from journeys actually operated');
  is(p.pa_cost, 200, 'PA cost from journeys actually operated');
  is(p.other_costs, 50, 'other direct costs for 5 operating days');
  is(p.gross_profit, -50, 'gross profit = income minus every cost');
  is(p.journeys_operated, 10, '10 journeys operated');
  is(p.journeys_scheduled, 10, '10 journeys scheduled');

  section('9b. Profitability reacts to a cancelled journey');
  const cancelId = await addEx({ date: '2026-09-07', type: 'journey_cancelled', leg: 'AM', contract_id: contractId });
  p = (await finance.profitability({ ...WEEK, contract_id: contractId })).rows[0];
  is(p.income, 450, 'income loses half a day');
  is(p.driver_cost, 270, 'driver cost loses half a day');
  is(p.journeys_operated, 9, 'nine journeys operated out of ten scheduled');
  await run('DELETE FROM exceptions WHERE id = ?', [cancelId]);

  // ---------- 10. compliance traffic lights ----------
  section('10. Compliance traffic lights are calculated, never stored');
  await setSetting('amber_days', '30');
  await setSetting('required_docs_driver', JSON.stringify(['DBS', 'Driving Licence']));
  const DOC = ['entity_type', 'entity_id', 'doc_type', 'expiry_date', 'status'];
  is((await compliance.staffCompliance(driverId, 'driver')).status, 'red', 'red when required documents are missing');
  const dbsId = await insert('documents', { entity_type: 'staff', entity_id: driverId, doc_type: 'DBS', expiry_date: cal.addDays(cal.today(), 400), status: 'valid' }, DOC);
  is((await compliance.staffCompliance(driverId, 'driver')).status, 'red', 'still red while the licence is missing');
  const licId = await insert('documents', { entity_type: 'staff', entity_id: driverId, doc_type: 'Driving Licence', expiry_date: cal.addDays(cal.today(), 400), status: 'valid' }, DOC);
  is((await compliance.staffCompliance(driverId, 'driver')).status, 'green', 'green when all required documents are valid');
  await run('UPDATE documents SET expiry_date = ? WHERE id = ?', [cal.addDays(cal.today(), 20), dbsId]);
  is((await compliance.staffCompliance(driverId, 'driver')).status, 'amber', 'amber inside the 30-day warning window');
  await setSetting('amber_days', '10');
  is((await compliance.staffCompliance(driverId, 'driver')).status, 'green', 'green again when the warning window is narrowed to 10 days');
  await setSetting('amber_days', '30');
  await run('UPDATE documents SET expiry_date = ? WHERE id = ?', [cal.addDays(cal.today(), -1), dbsId]);
  is((await compliance.staffCompliance(driverId, 'driver')).status, 'red', 'red once the document has expired');
  await run('UPDATE documents SET expiry_date = ?, status = ? WHERE id = ?', [cal.addDays(cal.today(), 400), 'invalid', dbsId]);
  is((await compliance.staffCompliance(driverId, 'driver')).status, 'red', 'red when a document is marked invalid');
  await run('DELETE FROM documents WHERE id IN (?,?)', [dbsId, licId]);

  // ---------- 11. relational integrity ----------
  section('11. Single source of truth');
  const newDriver = await insert('staff', { type: 'driver', first_name: 'New', last_name: 'Driver' }, ['type', 'first_name', 'last_name']);
  await run('UPDATE contracts SET driver_id = ? WHERE id = ?', [newDriver, contractId]);
  const childRow = await get(`SELECT d.first_name || ' ' || d.last_name AS driver FROM children ch JOIN contracts c ON c.id = ch.contract_id JOIN staff d ON d.id = c.driver_id WHERE ch.id = ?`, [childA]);
  is(childRow.driver, 'New Driver', "changing the contract's driver updates every child's assigned driver");
  is((await day('2026-09-07')).legs.AM.driver.normal_name, 'New Driver', 'the calendar picks up the new driver immediately');
  await run('UPDATE contracts SET driver_id = ? WHERE id = ?', [driverId, contractId]);

  // ---------- 12. per-day pay basis ----------
  section('12. Fixed per-day pay basis');
  await run("UPDATE contracts SET pay_basis = 'per_day', income_basis = 'per_day' WHERE id = ?", [contractId]);
  const absent = await addEx({ date: '2026-09-07', type: 'child_absence', leg: 'PM', contract_id: contractId, child_id: childA });
  const absent2 = await addEx({ date: '2026-09-07', type: 'child_absence', leg: 'PM', contract_id: contractId, child_id: childB });
  is((await wagesFor('John Normal')).totals.amount_due, 300, 'on a fixed day rate the driver is still paid when children do not travel');
  const closed = await addEx({ date: '2026-09-07', type: 'journey_cancelled', leg: 'DAY', contract_id: contractId });
  is((await wagesFor('John Normal')).totals.amount_due, 240, 'but not when the journey itself is cancelled');
  await run('DELETE FROM exceptions');
  await run("UPDATE contracts SET pay_basis = 'per_journey', income_basis = 'per_journey' WHERE id = ?", [contractId]);

  // ---------- 13. date filtering ----------
  section('13. Wage period boundaries');
  is((await wagesFor('John Normal', { from: '2026-09-07', to: '2026-09-07' })).totals.amount_due, 60, 'a single day pays one day');
  is((await wagesFor('John Normal', { from: '2026-09-05', to: '2026-09-06' })).totals.amount_due, 0, 'a weekend pays nothing');
  is((await wagesFor('John Normal', { from: '2026-08-25', to: '2026-08-31' })).totals.amount_due, 0, 'nothing before the contract start date');
  is((await wagesFor('John Normal', { from: '2026-09-07', to: '2026-09-18' })).totals.amount_due, 600, 'two full weeks pay ten days');

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
