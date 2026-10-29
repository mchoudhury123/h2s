'use strict';
/* Contracts overview: two companies, one account in both, a staff account that
   may not see money, the figures, the exports, editing from the sheet and saved
   views. In-memory SQLite, straight through the route table. */
process.env.H2S_DB_DRIVER = 'sqlite';
process.env.H2S_DB = ':memory:';
process.env.H2S_STRICT_TENANCY = '1';
const assert = require('node:assert/strict');
const db = require('../server/db');
const routes = require('../server/routes');
const overview = require('../server/services/overview');
const cal = require('../server/services/calendar');

(async () => {
  await db.migrate();
  const A = await db.insert('organisations', { name: 'Tyne Test Cars' }, ['name']);
  const B = await db.insert('organisations', { name: 'Shields Test Cars' }, ['name']);
  const C = await db.insert('organisations', { name: 'Unrelated Firm' }, ['name']);
  const add = (table, data, organisation = A) => db.insert(table, data, Object.keys(data), null, organisation);
  const manager = await add('users', { email: 'boss@test.example', password_hash: 'x', name: 'Boss', role: 'admin' });
  await db.run('INSERT INTO user_organisations (organisation_id, user_id, added_by) VALUES (?,?,?)', [B, manager, 'test']);
  const staffUser = await add('users', { email: 'staff@test.example', password_hash: 'x', name: 'Staffer', role: 'staff' });
  const asUser = (id, name, role, org) => ({ id, name, role, organisation_id: org, home_organisation_id: A });
  const boss = asUser(manager, 'Boss', 'admin', A);
  const staffer = asUser(staffUser, 'Staffer', 'staff', A);

  const call = async (method, path, body = {}, user = boss) => {
    const url = new URL(path, 'http://test');
    let status = 200, headers = {}, raw = null;
    const res = { writeHead(s, hdrs) { status = s; headers = hdrs || {}; }, end(v) { raw = v; } };
    await routes.handle({ req: { method }, res, path: url.pathname, query: Object.fromEntries(url.searchParams), body, user });
    const ct = headers['Content-Type'] || '';
    return { status, headers, raw, data: ct.includes('json') && raw ? JSON.parse(raw) : null };
  };

  // ---- company A: two contracts, one with a child at a second school ----
  const schoolA = await add('schools', { name: 'Harbour School', address: '1 Quay Road', postcode: 'NE33 1AA', open_time: '08:45', close_time: '15:15' });
  const schoolA2 = await add('schools', { name: 'Hill School', postcode: 'NE33 2BB' });
  const councilA = await add('councils', { name: 'South Tyneside Council' });
  const driverA = await add('staff', { type: 'driver', first_name: 'Dan', last_name: 'Driver', phone: '07000 000001' });
  const paA = await add('staff', { type: 'pa', first_name: 'Pat', last_name: 'Assistant', phone: '07000 000002' });
  const coverA = await add('staff', { type: 'driver', first_name: 'Cora', last_name: 'Cover' });
  const contract = (org, code, school, council, extra = {}) => add('contracts', { code, school_id: school, council_id: council, driver_id: extra.driver_id, pa_id: extra.pa_id, requires_pa: extra.requires_pa ?? 1,
    status: 'active', start_date: '2026-09-01', days_of_week: '1,2,3,4,5', income_per_day: 100, driver_pay_per_day: 60, pa_pay_per_day: 40, other_costs_per_day: 0,
    pay_basis: 'per_journey', income_basis: 'per_journey', po_number: extra.po || 'PO-A1', ...extra.fields }, org);
  const a1 = await contract(A, 'ALPHA ROUTE', schoolA, councilA, { driver_id: driverA, pa_id: paA, po: 'PO-SHARED' });
  const a2 = await contract(A, 'BETA ROUTE', schoolA, councilA, { driver_id: driverA, pa_id: paA, po: 'PO-SHARED', fields: { status: 'pending' } });
  const kid1 = await add('children', { first_name: 'Amy', last_name: 'Able', contract_id: a1, school_id: schoolA, address: '5 Sea View', postcode: 'NE33 3CC', pickup_time: '08:00', dropoff_time: '15:45', status: 'active', wheelchair: 1, sen_needs: 'Needs harness' });
  await add('children', { first_name: 'Ben', last_name: 'Baker', contract_id: a1, school_id: schoolA2, address: '9 Cliff Top', postcode: 'NE34 4DD', status: 'active' });
  // A recorded week in the past: a driver absence with paid cover, and a child absence that must not reduce income.
  await add('exceptions', { contract_id: a1, date: '2026-10-06', type: 'staff_absence', role: 'driver', staff_id: driverA, cover_staff_id: coverA, cover_pay: 150, leg: 'DAY' });
  await add('exceptions', { contract_id: a1, date: '2026-10-07', type: 'child_absence', child_id: kid1, leg: 'DAY' });
  await add('invoices', { number: 1, invoice_no: 'TT 1', contract_id: a1, contract_code: 'ALPHA ROUTE', period_from: '2026-10-05', period_to: '2026-10-09', invoice_date: '2026-10-09', days: 5, daily_rate: 100, subtotal: 500, vat: 100, total: 600, snapshot: '{}', status: 'issued' });

  // ---- company B: one contract ----
  const schoolB = await add('schools', { name: 'Shields Academy', postcode: 'NE33 9ZZ' }, B);
  const driverB = await add('staff', { type: 'driver', first_name: 'Bob', last_name: 'Bus', phone: '07000 000003' }, B);
  const b1 = await contract(B, 'SHIELDS 1', schoolB, null, { driver_id: driverB, requires_pa: 0, po: 'PO-B' });
  await add('children', { first_name: 'Cal', last_name: 'Carr', contract_id: b1, school_id: schoolB, status: 'active' }, B);
  // ---- an unrelated firm the manager is not part of ----
  const schoolC = await add('schools', { name: 'Elsewhere School' }, C);
  await contract(C, 'ELSEWHERE 1', schoolC, null, { requires_pa: 0, po: 'PO-C' });

  const WEEK = 'from=2026-10-05&to=2026-10-09';

  // 1. Every company the account belongs to, nothing else; restricted figures absent until asked for.
  let r = await call('GET', `/api/contracts-overview?${WEEK}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.rows.map(x => x.code).sort(), ['ALPHA ROUTE', 'BETA ROUTE', 'SHIELDS 1']);
  assert.equal(r.data.companies.length, 2);
  assert.equal(r.data.can_see_finance, true); assert.equal(r.data.confidential, false);
  assert(!r.data.columns.some(c => c.restricted), 'restricted columns are not sent until revealed');
  const alpha = r.data.rows.find(x => x.code === 'ALPHA ROUTE');
  assert.equal(alpha.company_name, 'Tyne Test Cars');
  assert.equal(alpha.staff_cost_range, undefined); assert.equal(alpha.gross_per_day, undefined);
  assert.equal(alpha.income_range, 500, 'a child absence never reduces council income');
  assert.equal(alpha.income_actual, 500); assert.equal(alpha.income_projected, 0);
  assert.equal(alpha.invoiced_range, 500); assert.equal(alpha.invoices_in_range, 1);
  assert.equal(alpha.value_per_day, 100); assert.equal(alpha.value_per_week, 500); assert.equal(alpha.value_per_month, 2166.67);
  assert.equal(alpha.child_count, 2); assert.equal(alpha.daily_trips, 2); assert.equal(alpha.operating_days, 'Monday to Friday');
  assert.equal(alpha.driver_name, 'Dan Driver'); assert.equal(alpha.driver_phone, '07000 000001'); assert.equal(alpha.pa_phone, '07000 000002');
  assert.equal(alpha.school_address, '1 Quay Road, NE33 1AA');
  assert(alpha.children_names.includes('Amy Able') && alpha.children_names.includes('Ben Baker'));
  assert(alpha.children_pickup.includes('5 Sea View, NE33 3CC'));
  assert(alpha.children_am.includes('Amy Able: pickup 08:00, school start 08:45'), alpha.children_am);
  assert(alpha.children_requirements.includes('Wheelchair') && alpha.children_requirements.includes('Needs harness'), 'transport needs are shown to management');
  assert(/Cover used/.test(alpha.staffing_status) && /Cora Cover \(cover driver, 1 day\)/.test(alpha.other_staff), alpha.other_staff);
  const shields = r.data.rows.find(x => x.code === 'SHIELDS 1');
  assert.equal(shields.company_name, 'Shields Test Cars'); assert.equal(shields.pa_name, 'Not required');
  assert.equal(r.data.summary.all.contracts, 3); assert.equal(r.data.summary.all.active_contracts, 2);
  assert.equal(r.data.summary.all.children, 3); assert.equal(r.data.summary.all.schools, 2);
  assert.deepEqual(r.data.summary.companies.map(c => c.contracts), [2, 1]);

  // 2. One company only.
  r = await call('GET', `/api/contracts-overview?${WEEK}&company=${B}`);
  assert.deepEqual(r.data.rows.map(x => x.code), ['SHIELDS 1']); assert.equal(r.data.companies.length, 1);
  r = await call('GET', `/api/contracts-overview?${WEEK}&company=${C}`);
  assert.equal(r.data.rows.length, 0, 'a business the account is not part of is never shown');

  // 3. Revealed: staff costs, cover rates and gross profit from the wage engine.
  r = await call('GET', `/api/contracts-overview?${WEEK}&confidential=1`);
  assert.equal(r.data.confidential, true);
  assert(r.data.columns.some(c => c.key === 'gross_per_day'));
  const alphaC = r.data.rows.find(x => x.code === 'ALPHA ROUTE');
  assert.equal(alphaC.driver_cost_per_day, 60); assert.equal(alphaC.pa_cost_per_day, 40); assert.equal(alphaC.staff_cost_per_day, 100);
  assert.equal(alphaC.gross_per_day, 0);
  // Four normal days at £100 plus the covered day: PA £40 and cover driver £150, the absent driver unpaid.
  assert.equal(alphaC.staff_cost_range, 590, `cover rate respected (got ${alphaC.staff_cost_range})`);
  assert.equal(alphaC.staff_cost_actual, 590); assert.equal(alphaC.staff_cost_projected, 0);
  assert.equal(alphaC.gross_range, -90); assert.equal(alphaC.margin_range, -18);
  const betaC = r.data.rows.find(x => x.code === 'BETA ROUTE');
  assert.equal(betaC.income_range, 0, 'a pending contract runs nothing yet'); assert.equal(betaC.staff_cost_range, 0);
  assert.equal(r.data.summary.all.staff_cost, 590 + 300, 'alpha with its cover day, shields at £60 a day with no PA');
  assert.equal(r.data.summary.all.gross_profit, r.data.summary.all.revenue - r.data.summary.all.staff_cost);
  const shieldsC = r.data.rows.find(x => x.code === 'SHIELDS 1');
  assert.equal(shieldsC.pa_cost_per_day, 0); assert.equal(shieldsC.staff_cost_per_day, 60);

  // 4. A future period is projected, not recorded.
  const nextFrom = cal.addDays(cal.today(), 7), nextTo = cal.addDays(cal.today(), 11);
  r = await call('GET', `/api/contracts-overview?from=${nextFrom}&to=${nextTo}&confidential=1`);
  const alphaF = r.data.rows.find(x => x.code === 'ALPHA ROUTE');
  assert.equal(alphaF.income_actual, 0); assert(alphaF.income_projected > 0); assert.equal(alphaF.staff_cost_actual, 0); assert(alphaF.staff_cost_projected > 0);
  assert.equal(alphaF.invoiced_range, 0);
  assert.equal((await call('GET', '/api/contracts-overview?from=2026-01-01&to=2027-12-31')).status, 400, 'a period over 400 days is refused');

  // 5. A staff account: never the money, never the transport needs, nowhere.
  r = await call('GET', `/api/contracts-overview?${WEEK}&confidential=1`, {}, staffer);
  assert.equal(r.status, 200); assert.equal(r.data.can_see_finance, false); assert.equal(r.data.confidential, false);
  assert(!r.data.columns.some(c => c.restricted || c.sensitive));
  const alphaS = r.data.rows.find(x => x.code === 'ALPHA ROUTE');
  assert.equal(alphaS.staff_cost_range, undefined); assert.equal(alphaS.gross_range, undefined); assert.equal(alphaS.children_requirements, undefined);
  assert.equal(alphaS.children[0].requirements, undefined);
  assert.equal(alphaS.value_per_day, 100, 'contract value stays visible');
  assert.deepEqual(r.data.rows.map(x => x.code).sort(), ['ALPHA ROUTE', 'BETA ROUTE'], 'only the businesses that account belongs to');
  assert.equal((await call('GET', `/api/profitability?${WEEK}`, {}, staffer)).status, 403, 'profitability is closed to staff');
  assert.equal((await call('GET', `/api/wages?${WEEK}`, {}, staffer)).status, 403, 'wages are closed to staff');
  assert.equal((await call('GET', `/api/reports/contract-profitability.csv?${WEEK}`, {}, staffer)).status, 403, 'wage reports are closed to staff');
  assert.equal((await call('GET', `/api/contracts?${WEEK}`, {}, staffer)).status, 200, 'ordinary records stay open');

  // 6. Exports respect the account, the request and the filters.
  r = await call('GET', `/api/contracts-overview/export?${WEEK}&format=xlsx&confidential=1&columns=company_name,code,po_number,value_per_day,staff_cost_per_day,gross_range,margin_range`);
  assert.equal(r.status, 200); assert.equal(r.raw.slice(0, 2).toString(), 'PK', 'an .xlsx is a zip');
  assert(/spreadsheetml/.test(r.headers['Content-Type']));
  let xml = r.raw.toString('latin1');
  assert(xml.includes('Contracts Overview') && xml.includes('Gross profit for period') && xml.includes('Includes staff costs and gross profit'));
  assert(xml.includes('ALPHA ROUTE') && xml.includes('SHIELDS 1') && xml.includes('Summary by company'));
  r = await call('GET', `/api/contracts-overview/export?${WEEK}&format=xlsx&confidential=1&columns=code,gross_range&q=shields`);
  xml = r.raw.toString('latin1');
  assert(xml.includes('SHIELDS 1') && !xml.includes('ALPHA ROUTE'), 'the search filter applies to the export');
  r = await call('GET', `/api/contracts-overview/export?${WEEK}&format=xlsx&columns=code,gross_range,staff_cost_per_day,value_per_day`);
  xml = r.raw.toString('latin1');
  assert(!xml.includes('Gross profit') && xml.includes('Contract value per day') && xml.includes('without staff costs'), 'hidden on screen means absent from the file');
  r = await call('GET', `/api/contracts-overview/export?${WEEK}&format=xlsx&confidential=1&columns=code,gross_range,children_requirements,value_per_day`, {}, staffer);
  xml = r.raw.toString('latin1');
  assert(!xml.includes('Gross profit') && !xml.includes('Special transport') && xml.includes('Contract value per day'), 'a staff account cannot export money or transport needs even when it asks');
  r = await call('GET', `/api/contracts-overview/export?${WEEK}&format=pdf&confidential=1&columns=company_name,code,school_name,children_names,driver_name,value_per_day,gross_per_day`);
  assert.equal(r.status, 200); assert.equal(r.raw.slice(0, 5).toString(), '%PDF-'); assert(/pdf/.test(r.headers['Content-Type']));
  const pdfText = r.raw.toString('latin1');
  assert(pdfText.includes('Contracts Overview') && pdfText.includes('/MediaBox [0 0 841.89 595.28]'), 'the PDF is landscape');
  assert.equal((await call('GET', `/api/contracts-overview/export?${WEEK}&format=xlsx&columns=nonsense`)).status, 400);
  const exportAudit = await db.all("SELECT summary FROM audit_log WHERE organisation_id = ? AND action = 'export'", [A]);
  assert(exportAudit.length >= 5 && exportAudit.every(a => /contracts overview/.test(a.summary)), 'every export is audited');

  // 7. Editing from the sheet writes to the right business and is audited there.
  r = await call('PUT', `/api/contracts-overview/${B}/contracts/${b1}`, { po_number: 'PO-B-NEW', status: 'suspended' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const bRow = await db.get('SELECT po_number, status FROM contracts WHERE id = ? AND organisation_id = ?', [b1, B]);
  assert.equal(bRow.po_number, 'PO-B-NEW'); assert.equal(bRow.status, 'suspended');
  const bAudit = await db.all("SELECT * FROM audit_log WHERE organisation_id = ? AND entity_type = 'contracts' AND entity_id = ?", [B, b1]);
  assert(bAudit.some(a => a.field === 'po number' && a.new_value === 'PO-B-NEW') && bAudit.some(a => /contracts overview/.test(a.summary)), 'the change is in that business\'s audit history');
  assert.equal((await call('PUT', `/api/contracts-overview/${C}/contracts/1`, { po_number: 'x' })).status, 403, 'not for a business the account is outside');
  assert.equal((await call('PUT', `/api/contracts-overview/${A}/contracts/${b1}`, { po_number: 'x' })).status, 404, 'a contract is only found in its own business');
  r = await call('PUT', `/api/contracts-overview/${A}/contracts/${a1}`, { driver_id: coverA, income_per_day: 120 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const aRow = await db.get('SELECT driver_id, income_per_day FROM contracts WHERE id = ? AND organisation_id = ?', [a1, A]);
  assert.equal(aRow.driver_id, coverA); assert.equal(Number(aRow.income_per_day), 120);
  assert.equal((await call('PUT', `/api/contracts-overview/${A}/contracts/${a1}`, { driver_id: driverB })).status, 400, 'a driver from another business is refused');
  assert.equal((await call('PUT', `/api/contracts-overview/${A}/contracts/${a1}`, { driver_id: paA })).status, 400, 'a PA cannot be the driver');
  assert.equal((await call('PUT', `/api/contracts-overview/${A}/contracts/${a1}`, { income_per_day: 130 }, staffer)).status, 403, 'staff cannot change contract values');
  assert.equal((await call('PUT', `/api/contracts-overview/${A}/contracts/${a1}`, { po_number: 'PO-STAFF' }, staffer)).status, 200, 'staff can correct a PO number');
  assert.equal((await call('PUT', `/api/contracts-overview/${A}/contracts/${a1}`, { income_per_day: -1 })).status, 400);
  assert.equal((await call('PUT', `/api/contracts-overview/${A}/contracts/${a1}`, { status: 'odd' })).status, 400);
  r = await call('GET', `/api/contracts-overview?${WEEK}&po=PO-SHARED`);
  assert.equal(overview.filterRows(r.data.rows, { po: 'PO-SHARED' }).length, 1, 'the PO filter finds every contract on that number');
  assert.equal(overview.filterRows(r.data.rows, { q: 'NE34' }).map(x => x.code).join(), 'ALPHA ROUTE', 'search by a child\'s postcode');
  assert.equal(overview.filterRows(r.data.rows, { school_id: schoolA2 }).map(x => x.code).join(), 'ALPHA ROUTE', 'a school filter follows the children aboard');
  assert.equal(overview.sortRows(r.data.rows, 'value_per_day', -1)[0].code, 'ALPHA ROUTE', 'numeric sort, highest first');

  // 8. Saved views: per account, validated, and never more than the account may see.
  r = await call('PUT', '/api/contracts-overview/views', { views: [{ name: 'Mine', columns: ['code', 'gross_range', 'bogus'], confidential: true, filters: { company: String(B), q: 'x' } }] });
  assert.equal(r.status, 200); assert.deepEqual(r.data.views[0].columns, ['code', 'gross_range']); assert.equal(r.data.views[0].filters.company, String(B));
  r = await call('GET', '/api/contracts-overview/views');
  assert.equal(r.data.views.length, 1); assert(r.data.presets.some(v => v.id === 'management'));
  r = await call('GET', '/api/contracts-overview/views', {}, staffer);
  assert.equal(r.data.views.length, 0, 'views belong to the account that saved them');
  assert(!r.data.presets.some(v => v.confidential), 'confidential presets are not offered to staff');
  assert.equal((await call('PUT', '/api/contracts-overview/views', { views: [{ name: 'Empty', columns: ['bogus'] }] })).status, 400);
  assert.equal((await call('PUT', '/api/contracts-overview/views', { views: [{ name: 'A', columns: ['code'] }, { name: 'a', columns: ['code'] }] })).status, 400, 'names must differ');
  assert.deepEqual(overview.allowedColumns(staffer, ['code', 'gross_range', 'children_requirements', 'po_number'], true), ['code', 'po_number']);
  assert.deepEqual(overview.allowedColumns(boss, ['code', 'gross_range'], false), ['code'], 'hidden means hidden, even for a manager');

  // 9. Team screen: roles are set and guarded.
  assert.equal((await call('PUT', `/api/users/${manager}`, { role: 'staff' })).status, 400, 'nobody removes their own management access');
  assert.equal((await call('PUT', `/api/users/${staffUser}`, { role: 'manager' }, staffer)).status, 403);
  r = await call('PUT', `/api/users/${staffUser}`, { role: 'manager' });
  assert.equal(r.status, 200); assert.equal(r.data.role, 'manager');
  assert.equal((await call('PUT', `/api/users/${staffUser}`, { role: 'king' })).status, 400);

  console.log('Contracts overview passed: both companies, company filter, outside firms excluded, recorded and projected figures, cover rates, child absences, staff role, exports (Excel, PDF, filters, confidentiality), editing with audit, PO filter, saved views and roles.');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => db.close());
