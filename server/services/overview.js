'use strict';
// Contracts overview: every contract of every business the account belongs
// to, on one spreadsheet-style page. Every figure comes from the same engine,
// wage and invoice rules as the rest of the CRM, read live; nothing is stored
// separately and nothing here is a second source of truth.
const { all, getSetting, setSetting, update, get } = require('../db');
const cal = require('./calendar');
const sched = require('./schedule');
const wages = require('./wages');
const rateService = require('./rates');
const staffing = require('./staffing');
const auth = require('./auth');
const audit = require('./audit');
const { round2 } = cal;

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const STATUS_LABEL = { active: 'Active', pending: 'Pending', suspended: 'Suspended', ended: 'Completed' };
const NOT_PROVIDED = 'Not provided';

/** Who may see staff costs and profit. Every account administers its firm unless it is marked as staff. */
function canSeeFinance(user) { return !user || (user.role || 'admin') !== 'staff'; }

/**
 * The column catalogue the page, the exports and the saved views all share.
 * `restricted` columns are staff costs and profit: only sent to accounts that
 * may see them, and only when they ask to reveal them. `sensitive` columns
 * hold children's transport needs and are never sent to a staff account.
 */
const COLUMNS = [
  { key: 'company_name', label: 'Operating company', section: 'Contract', main: true },
  { key: 'code', label: 'Contract / route reference', section: 'Contract', main: true, frozen: true },
  { key: 'po_number', label: 'PO number', section: 'Contract', main: true },
  { key: 'council_name', label: 'Local authority / council', section: 'Contract' },
  { key: 'school_name', label: 'School', section: 'Contract', main: true, frozen: true },
  { key: 'start_date', label: 'Contract start', section: 'Contract', type: 'date' },
  { key: 'end_date', label: 'Contract end', section: 'Contract', type: 'date' },
  { key: 'status_label', label: 'Status', section: 'Contract', main: true },
  { key: 'child_count', label: 'Children assigned', section: 'Contract', type: 'int' },
  { key: 'operating_days', label: 'Operating days', section: 'Contract' },
  { key: 'daily_trips', label: 'Daily trips', section: 'Contract', type: 'int' },
  { key: 'children_names', label: 'Children', section: 'Children and journeys', main: true },
  { key: 'children_pickup', label: 'Home / pickup address', section: 'Children and journeys' },
  { key: 'children_dropoff', label: 'Drop-off address (if different)', section: 'Children and journeys' },
  { key: 'school_address', label: 'School address', section: 'Children and journeys' },
  { key: 'children_am', label: 'Morning pickup / school start', section: 'Children and journeys' },
  { key: 'children_pm', label: 'School finish / afternoon drop-off', section: 'Children and journeys' },
  { key: 'children_requirements', label: 'Special transport requirements', section: 'Children and journeys', sensitive: true },
  { key: 'driver_name', label: 'Driver', section: 'Staff', main: true },
  { key: 'driver_phone', label: 'Driver contact number', section: 'Staff' },
  { key: 'pa_name', label: 'Passenger assistant', section: 'Staff', main: true },
  { key: 'pa_phone', label: 'PA contact number', section: 'Staff' },
  { key: 'other_staff', label: 'Additional assigned staff', section: 'Staff' },
  { key: 'staffing_status', label: 'Regular or cover', section: 'Staff' },
  { key: 'value_per_day', label: 'Contract value per day', section: 'Contract value', type: 'money', main: true },
  { key: 'value_per_week', label: 'Contract value per week', section: 'Contract value', type: 'money' },
  { key: 'value_per_month', label: 'Estimated value per month', section: 'Contract value', type: 'money' },
  { key: 'income_range', label: 'Contract value for period', section: 'Contract value', type: 'money' },
  { key: 'invoiced_range', label: 'Invoiced in period (actual)', section: 'Contract value', type: 'money' },
  { key: 'driver_cost_per_day', label: 'Driver cost per day', section: 'Staff costs', type: 'money', restricted: true },
  { key: 'pa_cost_per_day', label: 'PA cost per day', section: 'Staff costs', type: 'money', restricted: true },
  { key: 'other_cost_per_day', label: 'Additional staff costs per day', section: 'Staff costs', type: 'money', restricted: true },
  { key: 'staff_cost_per_day', label: 'Total staff cost per day', section: 'Staff costs', type: 'money', restricted: true, main: true },
  { key: 'staff_cost_range', label: 'Staff cost for period', section: 'Staff costs', type: 'money', restricted: true },
  { key: 'gross_per_day', label: 'Gross profit per day', section: 'Profit', type: 'money', restricted: true, main: true },
  { key: 'gross_range', label: 'Gross profit for period', section: 'Profit', type: 'money', restricted: true },
  { key: 'margin_range', label: 'Gross profit margin', section: 'Profit', type: 'pct', restricted: true },
];
const RESTRICTED = COLUMNS.filter(c => c.restricted).map(c => c.key);
const SENSITIVE = COLUMNS.filter(c => c.sensitive).map(c => c.key);

/** Ready-made views. A user's own saved views sit alongside these. */
const PRESET_VIEWS = [
  { id: 'management', name: 'Management overview', builtin: true, confidential: true,
    columns: ['company_name', 'code', 'po_number', 'school_name', 'children_names', 'driver_name', 'pa_name', 'value_per_day', 'staff_cost_per_day', 'gross_per_day', 'margin_range', 'status_label'] },
  { id: 'council', name: 'Council contract overview', builtin: true, confidential: false,
    columns: ['company_name', 'code', 'po_number', 'council_name', 'school_name', 'children_names', 'start_date', 'end_date', 'value_per_day', 'income_range', 'status_label'] },
  { id: 'staffing', name: 'Staff allocation overview', builtin: true, confidential: false,
    columns: ['company_name', 'code', 'school_name', 'children_names', 'driver_name', 'driver_phone', 'pa_name', 'pa_phone', 'other_staff', 'staffing_status', 'operating_days', 'daily_trips'] },
  { id: 'invoicing', name: 'PO and invoicing overview', builtin: true, confidential: false,
    columns: ['company_name', 'po_number', 'school_name', 'code', 'council_name', 'value_per_day', 'income_range', 'invoiced_range', 'status_label'] },
];

function daysText(contract) {
  const d = sched.operatingDays(contract);
  if (d.join(',') === '1,2,3,4,5') return 'Monday to Friday';
  return d.map(n => DAY_NAMES[n]).filter(Boolean).join(', ') || NOT_PROVIDED;
}
function timeText(t) { return t ? String(t).slice(0, 5) : null; }
function joinLines(parts) { const out = parts.filter(Boolean); return out.length ? out.join('\n') : NOT_PROVIDED; }
function addressText(address, postcode) { return [address, postcode].filter(Boolean).join(', ') || null; }

/** Everything the overview needs for one business, one row per contract. */
async function buildCompany(org, { from, to, confidential, sensitive, includeEnded }) {
  const today = cal.today();
  const where = includeEnded ? '' : " AND c.status IN ('active','pending','suspended')";
  const ctx = await cal.loadContext(org.id, from, to, where);
  const ids = ctx.contracts.map(c => c.id);
  const kids = ids.length ? await all(`SELECT id, first_name, last_name, address, postcode, school_id, contract_id,
      pickup_time, arrival_time, finish_time, dropoff_time, wheelchair, mobility, sen_needs
    FROM children WHERE organisation_id = ? AND status = 'active' AND contract_id IN (${ids.map(() => '?').join(',')})
    ORDER BY last_name, first_name`, [org.id, ...ids]) : [];
  const schools = new Map((await all('SELECT id, name, address, postcode, open_time, close_time FROM schools WHERE organisation_id = ?', [org.id])).map(s => [s.id, s]));
  const staff = new Map((await all('SELECT id, first_name, last_name, phone, type, status FROM staff WHERE organisation_id = ?', [org.id]))
    .map(s => [s.id, { ...s, name: `${s.first_name} ${s.last_name}` }]));
  // Invoices whose period falls inside the range: what has actually been billed.
  const invoiced = {};
  for (const r of await all(`SELECT contract_id, SUM(subtotal) AS total, COUNT(*) AS n FROM invoices
      WHERE organisation_id = ? AND status <> 'void' AND period_from >= ? AND period_to <= ? GROUP BY contract_id`, [org.id, from, to])) {
    invoiced[r.contract_id] = { total: round2(Number(r.total) || 0), count: Number(r.n) };
  }
  // Staff costs come from the wage engine, which already applies cover rates,
  // absences, pay overrides and school closures. Dates up to today are what
  // was recorded; later dates are what the schedule projects.
  let costPast = {}, costFuture = {};
  if (confidential) {
    const pastTo = to < today ? to : today;
    if (from <= pastTo) costPast = await wages.staffCostForRange(org.id, from, pastTo);
    const futureFrom = cal.addDays(today, 1);
    if (to >= futureFrom) costFuture = await wages.staffCostForRange(org.id, from > futureFrom ? from : futureFrom, to);
  }
  const dates = cal.dateRange(from, to);
  const rows = [];
  for (const c of ctx.contracts) {
    const children = kids.filter(k => k.contract_id === c.id);
    let incomeActual = 0, incomeProjected = 0, otherActual = 0, otherProjected = 0;
    let planned = 0, operated = 0, closedTrips = 0, runDays = 0;
    const cover = new Map();
    for (const d of dates) {
      const day = cal.evaluateContractDay(c, d, ctx.childMap[c.id] || [], ctx.exceptions, ctx);
      if (!day.trips.length) continue;
      runDays++; planned += day.planned_trips; operated += day.operated_trips; closedTrips += day.closed_trips;
      if (d <= today) { incomeActual += day.income; otherActual += day.other_costs; } else { incomeProjected += day.income; otherProjected += day.other_costs; }
      for (const t of day.trips) for (const role of ['driver', 'pa']) {
        const info = t[role];
        if (info && info.status === 'covered' && info.cover_staff_id) {
          const key = role + ':' + info.cover_staff_id;
          const entry = cover.get(key) || { role, staff_id: info.cover_staff_id, name: info.cover_name, days: new Set() };
          entry.days.add(d); cover.set(key, entry);
        }
      }
    }
    const rates = rateService.ratesOn(c, to < today ? to : today);
    const school = schools.get(c.school_id) || null;
    const seats = staffing.summary(c, c.staff_history, today);
    const driver = seats.driver.staff_id ? staff.get(seats.driver.staff_id) : null;
    const pa = c.requires_pa && seats.pa.staff_id ? staff.get(seats.pa.staff_id) : null;
    const otherStaff = [];
    for (const role of ['driver', 'pa']) {
      const label = role === 'driver' ? 'driver' : 'PA';
      if (seats[role].upcoming && seats[role].upcoming.staff_name) otherStaff.push(`${seats[role].upcoming.staff_name} (${label} from ${seats[role].upcoming.effective_from})`);
      if (seats[role].previous && seats[role].previous.staff_name) otherStaff.push(`${seats[role].previous.staff_name} (${label} until ${seats[role].previous.until})`);
    }
    const coverList = [...cover.values()].map(e => ({ role: e.role, staff_id: e.staff_id, name: e.name, days: e.days.size }));
    for (const e of coverList) otherStaff.push(`${e.name} (cover ${e.role === 'driver' ? 'driver' : 'PA'}, ${e.days} day${e.days === 1 ? '' : 's'})`);

    const opDays = sched.operatingDays(c).length || 0;
    const valuePerDay = round2(rates.income_per_day || 0);
    const driverCost = round2(rates.driver_pay_per_day || 0);
    const paCost = c.requires_pa ? round2(rates.pa_pay_per_day || 0) : 0;
    const otherCost = round2(rates.other_costs_per_day || 0);
    const staffCostDay = round2(driverCost + paCost + otherCost);
    const incomeRange = round2(incomeActual + incomeProjected);
    const past = costPast[c.id] || { driver: 0, pa: 0, total: 0 };
    const future = costFuture[c.id] || { driver: 0, pa: 0, total: 0 };
    const staffCostRange = round2(past.total + future.total + otherActual + otherProjected);
    const grossRange = round2(incomeRange - staffCostRange);

    const row = {
      company_id: org.id, company_name: org.name,
      contract_id: c.id, code: c.code, name: c.name || null, po_number: c.po_number || null,
      council_id: c.council_id || null, council_name: c.council_name || null,
      school_id: c.school_id || null, school_name: c.school_name || null,
      school_address: school ? addressText(school.address, school.postcode) : null,
      school_start: school ? timeText(school.open_time) : null, school_finish: school ? timeText(school.close_time) : null,
      start_date: c.start_date || null, end_date: c.end_date || null,
      status: c.status, status_label: STATUS_LABEL[c.status] || c.status,
      child_count: children.length, operating_days: daysText(c), operating_days_count: opDays,
      daily_trips: sched.normalTripCount(c, ctx.schedules.get(c.id), to < today ? to : today),
      requires_pa: !!c.requires_pa,
      children: children.map(k => ({
        id: k.id, name: `${k.first_name} ${k.last_name}`, school_id: k.school_id,
        school_name: (schools.get(k.school_id) || {}).name || null,
        pickup_address: addressText(k.address, k.postcode), postcode: k.postcode || null,
        dropoff_address: null,
        pickup_time: timeText(k.pickup_time) || timeText(c.am_pickup_time),
        school_start: timeText(k.arrival_time) || timeText(c.am_arrival_time) || (school ? timeText(school.open_time) : null),
        school_finish: timeText(k.finish_time) || timeText(c.pm_finish_time) || (school ? timeText(school.close_time) : null),
        dropoff_time: timeText(k.dropoff_time) || timeText(c.pm_dropoff_time),
        ...(sensitive ? { requirements: [k.wheelchair ? 'Wheelchair' : null, k.mobility, k.sen_needs].filter(Boolean).join('; ') || null } : {}),
      })),
      driver_id: driver ? driver.id : null, driver_name: driver ? driver.name : null, driver_phone: driver ? (driver.phone || null) : null,
      driver_since: seats.driver.since || null,
      pa_id: pa ? pa.id : null, pa_name: pa ? pa.name : (c.requires_pa ? null : 'Not required'), pa_phone: pa ? (pa.phone || null) : null,
      pa_since: seats.pa.since || null,
      other_staff: otherStaff.length ? otherStaff.join('\n') : null,
      cover: coverList,
      staffing_status: coverList.length ? `Cover used on ${[...new Set(coverList.flatMap(e => e.days))].reduce((a, b) => a + b, 0)} staff-day${coverList.length === 1 && coverList[0].days === 1 ? '' : 's'} in period` : 'Regular staff',
      value_per_day: valuePerDay,
      value_per_week: round2(valuePerDay * opDays),
      value_per_month: round2(valuePerDay * opDays * 52 / 12),
      income_range: incomeRange, income_actual: round2(incomeActual), income_projected: round2(incomeProjected),
      invoiced_range: invoiced[c.id] ? invoiced[c.id].total : 0, invoices_in_range: invoiced[c.id] ? invoiced[c.id].count : 0,
      run_days: runDays, planned_trips: planned, operated_trips: operated, closed_trips: closedTrips,
      vehicle_id: c.vehicle_id || null,
    };
    if (confidential) Object.assign(row, {
      driver_cost_per_day: driverCost, pa_cost_per_day: paCost, other_cost_per_day: otherCost, staff_cost_per_day: staffCostDay,
      staff_cost_range: staffCostRange,
      staff_cost_actual: round2(past.total + otherActual), staff_cost_projected: round2(future.total + otherProjected),
      driver_cost_range: round2(past.driver + future.driver), pa_cost_range: round2(past.pa + future.pa),
      gross_per_day: round2(valuePerDay - staffCostDay),
      margin_per_day: valuePerDay > 0 ? round2((valuePerDay - staffCostDay) / valuePerDay * 100) : 0,
      gross_range: grossRange,
      margin_range: incomeRange > 0 ? round2(grossRange / incomeRange * 100) : 0,
    });
    // The text columns the spreadsheet and the exports show for the children.
    row.children_names = row.children.length ? row.children.map(k => k.name).join('\n') : (children.length ? null : 'No children assigned');
    row.children_pickup = joinLines(row.children.map(k => k.pickup_address));
    row.children_dropoff = joinLines(row.children.map(k => k.dropoff_address));
    row.children_am = joinLines(row.children.map(k => `${k.name}: pickup ${k.pickup_time || '—'}, school start ${k.school_start || '—'}`));
    row.children_pm = joinLines(row.children.map(k => `${k.name}: finish ${k.school_finish || '—'}, drop-off ${k.dropoff_time || '—'}`));
    if (sensitive) row.children_requirements = joinLines(row.children.map(k => k.requirements ? `${k.name}: ${k.requirements}` : null));
    rows.push(row);
  }
  return rows;
}

/** Totals for one set of rows, with the confidential part only when present. */
function summarise(rows, confidential) {
  const sum = k => round2(rows.reduce((a, r) => a + (Number(r[k]) || 0), 0));
  const distinct = k => new Set(rows.map(r => r[k]).filter(Boolean)).size;
  const out = {
    contracts: rows.length,
    active_contracts: rows.filter(r => r.status === 'active').length,
    schools: distinct('school_id'),
    children: rows.reduce((a, r) => a + r.child_count, 0),
    drivers: distinct('driver_id'),
    pas: distinct('pa_id'),
    revenue: sum('income_range'), revenue_actual: sum('income_actual'), revenue_projected: sum('income_projected'),
    invoiced: sum('invoiced_range'),
  };
  if (confidential) {
    out.staff_cost = sum('staff_cost_range'); out.staff_cost_actual = sum('staff_cost_actual'); out.staff_cost_projected = sum('staff_cost_projected');
    out.gross_profit = round2(out.revenue - out.staff_cost);
    out.margin = out.revenue > 0 ? round2(out.gross_profit / out.revenue * 100) : 0;
  }
  return out;
}

/** The businesses this account may see, as [{id, name}], or just the one asked for. */
async function companiesFor(user, companyId) {
  const all_ = await auth.memberships(user.id, user.home_organisation_id);
  if (!companyId || companyId === 'all') return all_;
  const one = all_.find(o => o.id === Number(companyId));
  return one ? [one] : [];
}

/**
 * The whole overview. opts: { from, to, company ('all' | id), confidential, include_ended }.
 * Restricted figures are only built when the account may see them and asked to.
 */
async function build(user, opts) {
  const today = cal.today();
  const from = opts.from || today.slice(0, 8) + '01';
  const to = opts.to || cal.addDays(cal.addDays(from.slice(0, 8) + '01', 32).slice(0, 8) + '01', -1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) throw new Error('Choose a valid period');
  if (cal.dateRange(from, to).length > 400) throw new Error('Choose a period of up to 400 days');
  const finance = canSeeFinance(user);
  const confidential = finance && !!opts.confidential;
  const companies = await companiesFor(user, opts.company);
  const rows = [];
  for (const org of companies) rows.push(...await buildCompany(org, { from, to, confidential, sensitive: finance, includeEnded: !!opts.include_ended }));
  const summary = { all: summarise(rows, confidential), companies: companies.map(o => ({ id: o.id, name: o.name, ...summarise(rows.filter(r => r.company_id === o.id), confidential) })) };
  const columns = COLUMNS.filter(c => (!c.restricted || confidential) && (!c.sensitive || finance));
  return {
    from, to, today, generated_at: new Date().toISOString(),
    can_see_finance: finance, confidential, companies, columns, rows, summary,
    presets: PRESET_VIEWS.filter(v => !v.confidential || finance),
  };
}

/** The same filters the page applies, so an export matches what is on screen. */
function filterRows(rows, q = {}) {
  const text = String(q.q || '').trim().toLowerCase();
  const num = v => (v === undefined || v === null || v === '' ? null : Number(v));
  const school = num(q.school_id), council = num(q.council_id), driver = num(q.driver_id), pa = num(q.pa_id);
  const status = q.status ? String(q.status) : null, po = q.po ? String(q.po).trim().toLowerCase() : null;
  return rows.filter(r => {
    if (school !== null && r.school_id !== school && !r.children.some(k => k.school_id === school)) return false;
    if (council !== null && r.council_id !== council) return false;
    if (driver !== null && r.driver_id !== driver) return false;
    if (pa !== null && r.pa_id !== pa) return false;
    if (status && r.status !== status) return false;
    if (po && String(r.po_number || '').toLowerCase() !== po) return false;
    if (q.starts_from && (!r.start_date || r.start_date < q.starts_from)) return false;
    if (q.starts_to && (!r.start_date || r.start_date > q.starts_to)) return false;
    if (q.ends_from && (!r.end_date || r.end_date < q.ends_from)) return false;
    if (q.ends_to && (!r.end_date || r.end_date > q.ends_to)) return false;
    if (text) {
      const hay = [r.code, r.name, r.po_number, r.school_name, r.council_name, r.company_name, r.driver_name, r.pa_name,
        ...r.children.map(k => k.name), ...r.children.map(k => k.postcode)].filter(Boolean).join(' | ').toLowerCase();
      if (!hay.includes(text)) return false;
    }
    return true;
  });
}

/** Sorts rows by a column key, text or number, in the given direction. */
function sortRows(rows, key, dir = 1) {
  if (!key) return rows;
  const col = COLUMNS.find(c => c.key === key);
  const numeric = col && ['money', 'pct', 'int'].includes(col.type);
  return [...rows].sort((a, b) => {
    const x = a[key], y = b[key];
    if (x === y) return 0;
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    return (numeric ? Number(x) - Number(y) : String(x).localeCompare(String(y))) * dir;
  });
}

// ---------------------------------------------------------------- editing

const EDITABLE = ['code', 'po_number', 'status', 'school_id', 'council_id', 'driver_id', 'pa_id'];
const FINANCE_FIELDS = ['income_per_day', 'driver_pay_per_day', 'pa_pay_per_day', 'other_costs_per_day'];

/**
 * Edits a contract from the overview. The contract may belong to any business
 * the account is part of; the change is written to that business and audited
 * there, exactly as the contract form would. Money fields need finance access.
 */
async function editContract(user, companyId, contractId, body) {
  const org = await auth.membership(user.id, user.home_organisation_id, Number(companyId));
  if (!org) return { error: 'You are not part of that business', status: 403 };
  const before = await get('SELECT * FROM contracts WHERE id = ? AND organisation_id = ?', [Number(contractId), org.id]);
  if (!before) return { error: 'Contract not found', status: 404 };
  const data = {};
  for (const f of EDITABLE) if (body[f] !== undefined) data[f] = body[f];
  const moneyChange = FINANCE_FIELDS.some(f => body[f] !== undefined);
  if (moneyChange) {
    if (!canSeeFinance(user)) return { error: 'Only management accounts can change contract values or pay rates', status: 403 };
    for (const f of FINANCE_FIELDS) if (body[f] !== undefined) {
      const v = Number(body[f]);
      if (!Number.isFinite(v) || v < 0) return { error: 'Money figures must be zero or more', status: 400 };
      data[f] = round2(v);
    }
  }
  if (data.code !== undefined) { data.code = String(data.code).trim().toUpperCase(); if (!data.code) return { error: 'A contract reference is required', status: 400 }; }
  if (data.po_number !== undefined) data.po_number = String(data.po_number || '').trim() || null;
  if (data.status !== undefined && !STATUS_LABEL[data.status]) return { error: 'Unknown status', status: 400 };
  for (const [field, table, msg] of [['school_id', 'schools', 'That school is not in this business'], ['council_id', 'councils', 'That council is not in this business'],
    ['driver_id', 'staff', 'That driver is not in this business'], ['pa_id', 'staff', 'That PA is not in this business']]) {
    if (data[field] === undefined) continue;
    if (data[field] === '' || data[field] === null) { data[field] = null; continue; }
    data[field] = Number(data[field]);
    const row = await get(`SELECT * FROM ${table} WHERE id = ? AND organisation_id = ?`, [data[field], org.id]);
    if (!row) return { error: msg, status: 400 };
    if (field === 'driver_id' && row.type !== 'driver') return { error: 'That person is not a driver', status: 400 };
    if (field === 'pa_id' && row.type !== 'pa') return { error: 'That person is not a passenger assistant', status: 400 };
  }
  if (!Object.keys(data).length) return { error: 'Nothing to change', status: 400 };
  const actor = { ...user, organisation_id: org.id, organisation_name: org.name };
  const cols = Object.keys(data);
  try { await update('contracts', before.id, data, cols, null, org.id); }
  catch (e) { return { error: /unique|duplicate/i.test(e.message) ? 'That contract reference is already in use' : e.message.split('\n')[0], status: 400 }; }
  const after = await get('SELECT * FROM contracts WHERE id = ? AND organisation_id = ?', [before.id, org.id]);
  await audit.logDiff(actor, 'contracts', after.id, after.code, before, data, cols, async (col, v) => {
    if (!v) return v;
    if (col === 'school_id') return ((await get('SELECT name FROM schools WHERE id = ? AND organisation_id = ?', [v, org.id])) || {}).name || v;
    if (col === 'council_id') return ((await get('SELECT name FROM councils WHERE id = ? AND organisation_id = ?', [v, org.id])) || {}).name || v;
    if (col === 'driver_id' || col === 'pa_id') { const s = await get('SELECT first_name, last_name FROM staff WHERE id = ? AND organisation_id = ?', [v, org.id]); return s ? `${s.first_name} ${s.last_name}` : v; }
    return v;
  });
  // A driver or PA picked here is a correction of the latest holder, as on the
  // contract form; dated handovers stay on the contract page.
  for (const [col, role] of [['driver_id', 'driver'], ['pa_id', 'pa']]) {
    if (data[col] !== undefined && (after[col] || null) !== (before[col] || null)) await staffing.correctLatest(org.id, after.id, role, after[col]);
  }
  if (moneyChange && rateService.FIELDS.some(f => Number(after[f] || 0) !== Number(before[f] || 0))) await rateService.correctLatest(org.id, after);
  await audit.logAction(actor, 'contracts', after.id, after.code, 'update', `Edited from the contracts overview: ${cols.join(', ')}`);
  return { contract: after, company: org };
}

// ---------------------------------------------------------------- saved views

const VIEW_KEY = userId => `overview_views:user_${userId}`;

async function listViews(user, orgId) {
  try { const v = JSON.parse(await getSetting(orgId, VIEW_KEY(user.id), '[]')); return Array.isArray(v) ? v : []; }
  catch (_) { return []; }
}

async function saveViews(user, orgId, views) {
  if (!Array.isArray(views) || views.length > 30) return { error: 'Save up to 30 views' };
  const clean = [];
  const seen = new Set();
  for (const v of views) {
    const name = String((v && v.name) || '').trim().slice(0, 60);
    if (!name || seen.has(name.toLowerCase())) return { error: 'Every view needs its own name' };
    seen.add(name.toLowerCase());
    const columns = Array.isArray(v.columns) ? v.columns.filter(k => COLUMNS.some(c => c.key === k)).slice(0, COLUMNS.length) : [];
    if (!columns.length) return { error: `Choose at least one column for "${name}"` };
    const filters = v.filters && typeof v.filters === 'object' ? Object.fromEntries(Object.entries(v.filters).filter(([k, val]) => ['q', 'company', 'school_id', 'council_id', 'driver_id', 'pa_id', 'status', 'po', 'range'].includes(k) && typeof val !== 'object').map(([k, val]) => [k, String(val).slice(0, 120)])) : {};
    clean.push({ id: v.id && /^[a-z0-9-]{4,40}$/.test(String(v.id)) ? String(v.id) : 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, columns, filters, confidential: !!v.confidential });
  }
  await setSetting(orgId, VIEW_KEY(user.id), JSON.stringify(clean));
  return { views: clean };
}

/** A view applied for an account: restricted or sensitive columns the account may not see are dropped. */
function allowedColumns(user, keys, confidential) {
  const finance = canSeeFinance(user);
  return keys.filter(k => { const c = COLUMNS.find(x => x.key === k); return c && (!c.restricted || (finance && confidential)) && (!c.sensitive || finance); });
}

module.exports = { COLUMNS, RESTRICTED, SENSITIVE, PRESET_VIEWS, NOT_PROVIDED, canSeeFinance, build, filterRows, sortRows, editContract, listViews, saveViews, allowedColumns, summarise };
