/**
 * Proves one operating firm cannot reach another firm's data.
 *
 * Creates two businesses through the real registration screen, fills each with
 * its own records, then attacks every endpoint from firm A using firm B's ids.
 * Nothing belonging to B may ever appear, and no write from A may touch it.
 *
 * Run with the server already running:  npm run test:isolation
 */
'use strict';
require('../server/env').load();

const BASE = process.env.BASE || 'http://localhost:4000';
const stamp = Date.now().toString().slice(-8);

let pass = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { failures.push(label); console.log('  FAIL ' + label); }
}
function section(t) { console.log('\n' + t); }

/** A signed-in session for one firm. */
class Firm {
  constructor(label) { this.label = label; this.cookie = null; this.ids = {}; }

  async call(method, path, body, raw) {
    const opts = { method, headers: {}, redirect: 'manual' };
    if (this.cookie) opts.headers.Cookie = this.cookie;
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(BASE + path, opts);
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    if (raw) return { status: res.status, text: await res.text() };
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  }
  get(p) { return this.call('GET', p); }
  post(p, b) { return this.call('POST', p, b); }
  put(p, b) { return this.call('PUT', p, b); }
  del(p) { return this.call('DELETE', p); }

  async register(businessName, email, password) {
    this.password = password;
    const r = await this.post('/api/register', { business_name: businessName, email, password, name: 'Owner of ' + businessName });
    if (r.status !== 201) throw new Error(`${this.label}: registration failed: ${JSON.stringify(r.data)}`);
    this.user = r.data.user;
    return r.data.user;
  }

  /** Builds a small but complete set of records for this firm. */
  async seed(tag) {
    const mk = async (path, body, key) => {
      const r = await this.post(path, body);
      if (r.status !== 201) throw new Error(`${this.label}: could not create ${path}: ${JSON.stringify(r.data)}`);
      this.ids[key] = r.data.id;
      return r.data;
    };
    await mk('/api/councils', { name: `${tag} Council` }, 'council');
    await mk('/api/schools', { name: `${tag} School`, postcode: 'AA1 1AA' }, 'school');
    await mk('/api/staff', { type: 'driver', first_name: tag, last_name: 'Driver', default_day_rate: 50, postcode: 'AA1 2BB' }, 'driver');
    await mk('/api/staff', { type: 'pa', first_name: tag, last_name: 'Assistant', default_day_rate: 30 }, 'pa');
    await mk('/api/vehicles', { registration: `${tag}123`, seats: 8, driver_id: this.ids.driver }, 'vehicle');
    await mk('/api/contracts', {
      code: `${tag} ROUTE 1`, school_id: this.ids.school, council_id: this.ids.council,
      driver_id: this.ids.driver, pa_id: this.ids.pa, vehicle_id: this.ids.vehicle,
      status: 'active', start_date: '2026-09-01', end_date: '2027-07-01', days_of_week: '1,2,3,4,5',
      income_per_day: 120, driver_pay_per_day: 50, pa_pay_per_day: 30,
    }, 'contract');
    await mk('/api/children', {
      first_name: tag, last_name: 'Child', contract_id: this.ids.contract,
      medical_info: `${tag} confidential medical note`, postcode: 'AA1 3CC',
    }, 'child');
    await mk('/api/expenses', { date: '2026-09-07', contract_id: this.ids.contract, category: 'Fuel', amount: 10 }, 'expense');
    const ex = await this.post('/api/exceptions', {
      contract_id: this.ids.contract, date: '2026-09-08', type: 'staff_absence', leg: 'DAY', role: 'driver',
      cover_staff_id: this.ids.pa, cover_pay: 60, note: `${tag} absence`,
    });
    if (ex.status !== 201) throw new Error(`${this.label}: could not create exception: ${JSON.stringify(ex.data)}`);
    this.ids.exception = ex.data[0].id;
    const doc = await this.post('/api/documents', {
      entity_type: 'child', entity_id: this.ids.child, doc_type: 'Care Plan', expiry_date: '2027-01-01',
    });
    if (doc.status !== 201) throw new Error(`${this.label}: could not create document: ${JSON.stringify(doc.data)}`);
    this.ids.document = doc.data.id;
    const pay = await this.post('/api/payments', { staff_id: this.ids.driver, amount: 25, work_date: '2026-09-09' });
    this.ids.payment = pay.data.id;
  }
}

(async () => {
  section('Setting up two separate operating firms');
  const a = new Firm('Firm A');
  const b = new Firm('Firm B');
  await a.register(`Alpha Transport ${stamp}`, `alpha${stamp}@example.test`, 'alphapass1');
  await b.register(`Bravo Transport ${stamp}`, `bravo${stamp}@example.test`, 'bravopass1');
  ok(a.user.organisation_id !== b.user.organisation_id, 'each registration created its own business');
  await a.seed('ALPHA');
  await b.seed('BRAVO');
  console.log(`  Firm A org ${a.user.organisation_id}, Firm B org ${b.user.organisation_id}`);

  // ---------------------------------------------------------------
  section('1. Lists show only your own records');
  for (const [path, key, otherWord] of [
    ['/api/councils', 'council', 'BRAVO'],
    ['/api/schools', 'school', 'BRAVO'],
    ['/api/staff', 'driver', 'BRAVO'],
    ['/api/vehicles', 'vehicle', 'BRAVO'],
    ['/api/contracts', 'contract', 'BRAVO'],
    ['/api/children', 'child', 'BRAVO'],
    ['/api/expenses', 'expense', 'BRAVO'],
  ]) {
    const r = await a.get(path);
    const rows = Array.isArray(r.data) ? r.data : [];
    const leaked = rows.filter(x => JSON.stringify(x).includes(otherWord));
    const hasOwn = rows.some(x => x.id === a.ids[key]);
    ok(hasOwn && !leaked.length, `${path} returns A's records and none of B's`);
  }

  // ---------------------------------------------------------------
  section("2. Reading B's records by id is refused");
  for (const [path, key] of [
    ['/api/councils/', 'council'], ['/api/schools/', 'school'], ['/api/staff/', 'driver'],
    ['/api/vehicles/', 'vehicle'], ['/api/contracts/', 'contract'], ['/api/children/', 'child'],
    ['/api/expenses/', 'expense'],
  ]) {
    const r = await a.get(path + b.ids[key]);
    ok(r.status === 404, `GET ${path}<B's id> is 404, not B's record`);
  }
  const docFile = await a.get(`/api/documents/${b.ids.document}/file`);
  ok(docFile.status === 404, "GET a document file belonging to B is 404");
  const docList = await a.get(`/api/documents?entity_type=child&entity_id=${b.ids.child}`);
  ok(Array.isArray(docList.data) && docList.data.length === 0, "B's child documents are not listed for A");

  // ---------------------------------------------------------------
  section("3. Writing to B's records is refused");
  for (const [path, key, body] of [
    ['/api/children/', 'child', { first_name: 'HACKED' }],
    ['/api/staff/', 'driver', { first_name: 'HACKED' }],
    ['/api/contracts/', 'contract', { name: 'HACKED' }],
    ['/api/schools/', 'school', { name: 'HACKED' }],
  ]) {
    const r = await a.put(path + b.ids[key], body);
    ok(r.status === 404, `PUT ${path}<B's id> is refused`);
  }
  for (const [path, key] of [
    ['/api/children/', 'child'], ['/api/staff/', 'driver'], ['/api/contracts/', 'contract'],
    ['/api/schools/', 'school'], ['/api/vehicles/', 'vehicle'], ['/api/expenses/', 'expense'],
    ['/api/documents/', 'document'], ['/api/exceptions/', 'exception'], ['/api/payments/', 'payment'],
  ]) {
    const r = await a.del(path + b.ids[key]);
    ok(r.status === 404, `DELETE ${path}<B's id> is refused`);
  }

  // ---------------------------------------------------------------
  section("4. B's records survived every attempt");
  for (const [path, key, expect] of [
    ['/api/children/', 'child', 'BRAVO'],
    ['/api/staff/', 'driver', 'BRAVO'],
    ['/api/contracts/', 'contract', 'BRAVO ROUTE 1'],
    ['/api/schools/', 'school', 'BRAVO School'],
  ]) {
    const r = await b.get(path + b.ids[key]);
    ok(r.status === 200 && JSON.stringify(r.data).includes(expect), `B's ${key} is untouched`);
  }
  const bDocs = await b.get(`/api/documents?entity_type=child&entity_id=${b.ids.child}`);
  ok(bDocs.data.length === 1, "B's document still exists");
  const bPayments = await b.get('/api/payments');
  ok(bPayments.data.length >= 1, "B's payments still exist");

  // ---------------------------------------------------------------
  section('5. Cross-firm links cannot be forged');
  const steal = await a.post('/api/contracts', {
    code: `STOLEN ${stamp}`, school_id: b.ids.school, status: 'active',
  });
  ok(steal.status === 400, "A cannot create a contract pointing at B's school");
  const stealChild = await a.post('/api/children', { first_name: 'X', last_name: 'Y', contract_id: b.ids.contract });
  ok(stealChild.status === 400, "A cannot put a child on B's contract");
  const stealEx = await a.post('/api/exceptions', {
    contract_id: b.ids.contract, date: '2026-09-10', type: 'journey_cancelled', leg: 'AM',
  });
  ok(stealEx.status === 404, "A cannot record an exception against B's contract");
  const stealDoc = await a.post('/api/documents', { entity_type: 'child', entity_id: b.ids.child, doc_type: 'Other' });
  ok(stealDoc.status === 404, "A cannot attach a document to B's child");
  const stealPay = await a.post('/api/payments', { staff_id: b.ids.driver, amount: 999 });
  ok(stealPay.status === 404, "A cannot record a payment against B's driver");
  const stealVehicle = await a.post('/api/vehicles', { registration: 'X1', driver_id: b.ids.driver });
  ok(stealVehicle.status === 400, "A cannot give a vehicle to B's driver");

  // ---------------------------------------------------------------
  section('6. Search, calendar, dashboard and money show only your own firm');
  const searchB = await a.get('/api/search?q=BRAVO');
  ok(searchB.data.count === 0, "searching for B's records from A finds nothing");
  const searchA = await a.get('/api/search?q=ALPHA');
  ok(searchA.data.count > 0, "A can still find its own records");

  const calA = await a.get('/api/calendar?from=2026-09-07&to=2026-09-11');
  const calCodes = calA.data.rows.map(r => r.contract.code);
  ok(calCodes.some(c => c.startsWith('ALPHA')) && !calCodes.some(c => c.startsWith('BRAVO')),
    "the calendar shows A's contracts only");

  const dashA = await a.get('/api/dashboard');
  ok(dashA.data.counts.contracts === 1 && dashA.data.counts.children === 1,
    "the dashboard counts only A's records");
  ok(!JSON.stringify(dashA.data).includes('BRAVO'), "nothing of B's appears anywhere on A's dashboard");

  const wagesA = await a.get('/api/wages?from=2026-09-07&to=2026-09-11&include_zero=1');
  const wageNames = wagesA.data.results.map(r => r.staff.name).join(' ');
  ok(wageNames.includes('ALPHA') && !wageNames.includes('BRAVO'), "wages cover A's staff only");

  const profA = await a.get('/api/profitability?from=2026-09-07&to=2026-09-11');
  ok(profA.data.rows.length === 1 && profA.data.rows[0].code.startsWith('ALPHA'),
    "profitability covers A's contracts only");

  const poolA = await a.get('/api/pool?type=driver&include_assigned=1');
  ok(!JSON.stringify(poolA.data).includes('BRAVO'), "the staff pool shows A's drivers only");

  const compA = await a.get('/api/compliance');
  ok(!JSON.stringify(compA.data).includes('BRAVO'), "compliance covers A's staff only");

  const auditA = await a.get('/api/audit?limit=500');
  ok(!JSON.stringify(auditA.data).includes('BRAVO'), "the audit log shows A's changes only");

  const lookupsA = await a.get('/api/lookups');
  ok(!JSON.stringify(lookupsA.data).includes('BRAVO'), "dropdown lookups offer A's records only");

  // ---------------------------------------------------------------
  section('7. Every report is scoped');
  for (const name of ['payroll', 'contract-profitability', 'children', 'drivers', 'pas', 'compliance',
    'school-contracts', 'journeys', 'cover-staff', 'expiring-documents', 'audit', 'wage-breakdown', 'contract-income']) {
    const r = await a.call('GET', `/api/reports/${name}.csv?from=2026-09-07&to=2026-09-11`, undefined, true);
    const clean = r.status === 200 && !r.text.includes('BRAVO');
    ok(clean, `${name}.csv contains nothing belonging to B`);
  }

  // ---------------------------------------------------------------
  section('8. Team accounts stay inside one firm');
  const usersA = await a.get('/api/users');
  ok(usersA.data.length === 1 && usersA.data[0].email.startsWith('alpha'), "A sees only its own account");
  const bUserId = (await b.get('/api/users')).data[0].id;
  const editOther = await a.put('/api/users/' + bUserId, { name: 'HACKED' });
  ok(editOther.status === 404, "A cannot edit B's account");
  const delOther = await a.del('/api/users/' + bUserId);
  ok(delOther.status === 404, "A cannot delete B's account");
  // ---------------------------------------------------------------
  section('8b. One account can belong to two firms, and sees one at a time');
  const alphaEmail = `alpha${stamp}@example.test`;
  const shared = await b.post('/api/users', { email: alphaEmail, name: 'ignored', password: '' });
  ok(shared.status === 201 && shared.data.existing === true, "B adds A's owner by email, and it joins as the existing account");
  const again = await b.post('/api/users', { email: alphaEmail, name: 'X', password: 'somepass1' });
  ok(again.status === 400, 'adding the same person twice is refused');
  const meA = await a.get('/api/me');
  ok(meA.data.organisations.length === 2 && meA.data.organisation.id === meA.data.user.home_organisation_id,
    "A's owner now belongs to two businesses and is still looking at their own");
  const bOrgId = meA.data.organisations.find(o => !o.home).id;
  ok((await a.get('/api/contracts')).data.every(c => c.id !== b.ids.contract), 'before switching, A still sees only A');

  const sw = await a.post('/api/switch-business', { organisation_id: bOrgId });
  ok(sw.status === 200 && sw.data.organisation.id === bOrgId, 'switching to B works');
  const asB = (await a.get('/api/contracts')).data;
  ok(asB.some(c => c.id === b.ids.contract) && asB.every(c => c.id !== a.ids.contract), 'after switching, the same session sees only B');
  const kidsAsB = (await a.get('/api/children')).data;
  ok(kidsAsB.some(c => c.id === b.ids.child) && kidsAsB.every(c => c.id !== a.ids.child), "and B's children, none of A's");
  ok((await a.get('/api/contracts/' + a.ids.contract)).status === 404, "A's own contract is out of reach while looking at B");
  const teamB = (await a.get('/api/users')).data;
  ok(teamB.some(u => u.email === alphaEmail && !u.home), "B's team lists the shared account as shared");
  const takeover = await b.put('/api/users/' + meA.data.user.id, { password: 'stolen123' });
  ok(takeover.status === 403, "B cannot change the shared account's password");
  ok((await a.post('/api/switch-business', { organisation_id: 999999 })).status === 403, 'switching to a business you are not part of is refused');

  ok((await a.post('/api/switch-business', { organisation_id: meA.data.user.home_organisation_id })).status === 200, 'switching back works');
  ok((await a.get('/api/contracts')).data.some(c => c.id === a.ids.contract) && (await a.get('/api/contracts')).data.every(c => c.id !== b.ids.contract), 'and A sees only A again');

  const dropped = await b.del('/api/users/' + meA.data.user.id);
  ok(dropped.status === 200 && dropped.data.account_closed === false, 'B removes the shared account without closing it');
  const relogin = await a.post('/api/login', { email: alphaEmail, password: a.password });
  ok(relogin.status === 200, "removal ended A's sessions but the account and password survive");
  ok((await a.get('/api/me')).data.organisations.length === 1, 'and it now belongs to one business again');
  ok((await b.get('/api/users')).data.every(u => u.email !== alphaEmail), "B's team no longer lists it");

  // ---------------------------------------------------------------
  section('9. Settings are per firm');
  await a.post('/api/settings', { amber_days: 7 });
  const aSettings = (await a.get('/api/settings')).data;
  const bSettings = (await b.get('/api/settings')).data;
  ok(Number(aSettings.amber_days) === 7, "A's warning window changed");
  ok(Number(bSettings.amber_days) === 30, "B's warning window is unaffected");
  ok(aSettings.company_name !== bSettings.company_name, 'each firm has its own business name');

  // ---------------------------------------------------------------
  section('9b. Weekly schedules and child timetables stay inside one firm');
  const week = {
    effective_from: '2026-09-07', note: 'A pattern',
    days: [{ weekday: 1, trips: [{ label: 'AM run', kind: 'outbound', depart_time: '08:00' }] }],
  };
  ok((await b.put(`/api/contracts/${b.ids.contract}/schedule`, week)).status === 201, 'B can set its own weekly schedule');
  ok((await a.put(`/api/contracts/${b.ids.contract}/schedule`, week)).status === 404, "A cannot set a weekly schedule on B's contract");
  ok((await a.get(`/api/contracts/${b.ids.contract}/schedule`)).status === 404, "A cannot read B's weekly schedule");
  ok((await a.get(`/api/contracts/${b.ids.contract}/day/2026-09-07`)).status === 404, "A cannot read a day of B's contract");

  const bWeek = (await b.get(`/api/contracts/${b.ids.contract}/schedule`)).data;
  ok(bWeek.versions.length === 1, "B's own schedule is still there after A's attempts");
  ok((await a.del(`/api/contracts/${a.ids.contract}/schedule/${bWeek.versions[0].id}`)).status === 404,
    "A cannot delete B's weekly schedule through its own contract");
  ok((await b.get(`/api/contracts/${b.ids.contract}/schedule`)).data.versions.length === 1, "B's schedule survived");

  const crossChild = { ...week, days: [{ weekday: 1, trips: [{ label: 'AM run', kind: 'outbound', child_ids: [b.ids.child] }] }] };
  ok((await a.put(`/api/contracts/${a.ids.contract}/schedule`, crossChild)).status === 400,
    "A cannot put B's child on one of its own journeys");

  const tt = { effective_from: '2026-09-07', same_all_week: 1, start_time: '09:00', finish_time: '15:00', days: [{ weekday: 3, attends: 0 }] };
  ok((await b.put(`/api/children/${b.ids.child}/timetable`, tt)).status === 201, 'B can set its own timetable');
  ok((await a.put(`/api/children/${b.ids.child}/timetable`, tt)).status === 404, "A cannot set a timetable on B's child");
  ok((await a.get(`/api/children/${b.ids.child}/timetable`)).status === 404, "A cannot read B's timetable");
  const bTt = (await b.get(`/api/children/${b.ids.child}/timetable`)).data;
  ok(bTt.versions.length === 1, "B's timetable is still there");
  ok((await a.del(`/api/children/${a.ids.child}/timetable/${bTt.versions[0].id}`)).status === 404,
    "A cannot delete B's timetable through its own child");
  ok((await b.get(`/api/children/${b.ids.child}/timetable`)).data.versions.length === 1, "B's timetable survived");
  ok((await a.get(`/api/contracts/${a.ids.contract}/schedule`)).data.children.every(c => c.id !== b.ids.child),
    "the children offered for A's journeys are A's own");

  // ---------------------------------------------------------------
  section('10. Signing out and back in keeps the firms apart');
  await a.post('/api/logout');
  const afterLogout = await a.get('/api/children');
  ok(afterLogout.status === 401, 'a signed-out session can read nothing');
  await a.post('/api/login', { email: `alpha${stamp}@example.test`, password: 'alphapass1' });
  const backIn = await a.get('/api/children');
  ok(backIn.status === 200 && backIn.data.length === 1 && backIn.data[0].first_name === 'ALPHA',
    'signing back in returns only A\'s records');
  const wrongPassword = await new Firm('x').post('/api/login', { email: `alpha${stamp}@example.test`, password: 'wrong' });
  ok(wrongPassword.status === 401, 'the wrong password is refused');

  // ---------------------------------------------------------------
  section('Cleaning up the two test businesses');
  // Removed by id, so nothing outside this run can be matched by accident.
  const db = require('../server/db');
  for (const org of [a.user.organisation_id, b.user.organisation_id]) {
    await db.run('DELETE FROM organisations WHERE id = ?', [org]);
  }
  const left = await db.get('SELECT COUNT(*) AS n FROM organisations WHERE id IN (?, ?)',
    [a.user.organisation_id, b.user.organisation_id]);
  ok(Number(left.n) === 0, 'test businesses removed, including everything belonging to them');
  await db.close();

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
})().catch(e => { console.error('\nIsolation test failed to run:', e.stack || e.message); process.exit(1); });
