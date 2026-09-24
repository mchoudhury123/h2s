'use strict';
// Journey engine: knows what is SUPPOSED to happen each day and overlays exceptions.
//
// A day is a list of trips, not a fixed morning-and-afternoon pair. Most days
// are still two trips, but a contract can run three on a Friday, or one on a
// Wednesday, and each trip is tracked and paid in its own right.
const { all, inClause } = require('../db');
const sched = require('./schedule');

function toDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function fmt(d) { return d.toISOString().slice(0, 10); }
function addDays(s, n) { const d = toDate(s); d.setUTCDate(d.getUTCDate() + n); return fmt(d); }
function dow(s) { return toDate(s).getUTCDay(); } // 0=Sun..6=Sat
function today() { return fmt(new Date()); }
function dateRange(from, to) {
  const out = [];
  let d = from;
  while (d <= to) { out.push(d); d = addDays(d, 1); }
  return out;
}
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function requireOrg(orgId) { if (!orgId) throw new Error('An organisation id is required'); }

/** Is the contract live on this date at all (status and term dates)? */
function contractLiveOn(c, date) {
  if (c.status !== 'active') return false;
  if (c.start_date && date < c.start_date) return false;
  if (c.end_date && date > c.end_date) return false;
  return true;
}

/** Whether a contract runs at all on a date. */
function contractOperatesOn(c, date, schedules) {
  if (!contractLiveOn(c, date)) return false;
  const versions = schedules && schedules.get ? schedules.get(c.id) : schedules;
  return sched.plannedTrips(c, date, dow(date), versions).length > 0;
}

// ---------------------------------------------------------------- loading

async function loadContracts(orgId, where = '', params = []) {
  requireOrg(orgId);
  return all(`SELECT c.*, s.name AS school_name, s.postcode AS school_postcode, cl.name AS council_name,
      d.first_name || ' ' || d.last_name AS driver_name, p.first_name || ' ' || p.last_name AS pa_name
    FROM contracts c
    LEFT JOIN schools s ON s.id = c.school_id
    LEFT JOIN councils cl ON cl.id = c.council_id
    LEFT JOIN staff d ON d.id = c.driver_id
    LEFT JOIN staff p ON p.id = c.pa_id
    WHERE c.organisation_id = ? ${where} ORDER BY c.code`, [orgId, ...params]);
}

async function loadChildrenByContract(orgId, contractIds) {
  requireOrg(orgId);
  const list = inClause(contractIds);
  if (!list) return {};
  const rows = await all(`SELECT id, first_name, last_name, contract_id, wheelchair, status,
      pickup_time, arrival_time, finish_time, dropoff_time
    FROM children WHERE organisation_id = ? AND status = 'active' AND contract_id IN (${list})
    ORDER BY last_name, first_name`, [orgId, ...contractIds]);
  const map = {};
  for (const r of rows) { (map[r.contract_id] ||= []).push({ ...r, name: `${r.first_name} ${r.last_name}` }); }
  return map;
}

async function loadExceptions(orgId, from, to, contractIds = null) {
  requireOrg(orgId);
  let sql = `SELECT e.*, cs.first_name || ' ' || cs.last_name AS cover_name,
      ch.first_name || ' ' || ch.last_name AS child_name,
      st.first_name || ' ' || st.last_name AS staff_name
    FROM exceptions e
    LEFT JOIN staff cs ON cs.id = e.cover_staff_id
    LEFT JOIN staff st ON st.id = e.staff_id
    LEFT JOIN children ch ON ch.id = e.child_id
    WHERE e.organisation_id = ? AND e.date >= ? AND e.date <= ?`;
  const params = [orgId, from, to];
  const list = inClause(contractIds);
  if (list) {
    sql += ` AND (e.contract_id IN (${list}) OR e.contract_id IS NULL)`;
    params.push(...contractIds);
  }
  sql += ' ORDER BY e.date, e.id';
  return all(sql, params);
}

/** Everything one date range needs, in a handful of queries. */
async function loadContext(orgId, from, to, where = '', params = []) {
  const contracts = await loadContracts(orgId, where, params);
  const contractIds = contracts.map(c => c.id);
  const childMap = await loadChildrenByContract(orgId, contractIds);
  const childIds = Object.values(childMap).flat().map(c => c.id);
  const exceptions = await loadExceptions(orgId, from, to);
  const schedules = await sched.loadSchedules(orgId, contractIds);
  const timetables = await sched.loadTimetables(orgId, childIds);
  return { contracts, childMap, exceptions, schedules, timetables };
}

// ---------------------------------------------------------------- evaluation

/** Does this exception apply to this trip? */
function appliesToTrip(ex, trip) {
  if (ex.trip_seq !== null && ex.trip_seq !== undefined) return Number(ex.trip_seq) === trip.seq;
  if (ex.leg === 'DAY') return true;
  if (ex.leg === 'AM') return trip.kind === 'outbound';
  if (ex.leg === 'PM') return trip.kind === 'return';
  return false;
}

/**
 * Evaluate one contract on one date: what should have run, what did, who
 * travelled, who worked and what it is worth.
 */
function evaluateContractDay(c, date, children, exceptions, ctx = {}) {
  const weekday = dow(date);
  const schedules = ctx.schedules && ctx.schedules.get ? ctx.schedules.get(c.id) : null;
  const timetables = ctx.timetables && ctx.timetables.get ? ctx.timetables : new Map();

  const ex = exceptions.filter(e => e.date === date
    && (e.contract_id === c.id
      || (e.contract_id == null && e.type === 'school_closed'
        && (e.school_id == null || e.school_id === c.school_id))));

  const live = contractLiveOn(c, date);
  const planned = live ? sched.plannedTrips(c, date, weekday, schedules) : [];

  // One-off journeys added to this date only.
  const extras = live ? ex.filter(e => e.type === 'extra_journey').map((e, i) => ({
    seq: planned.length + i + 1,
    label: e.trip_label || e.note || 'Additional journey',
    kind: e.trip_kind || 'other',
    depart_time: null, arrive_time: null,
    driver_pay: e.amount != null ? Number(e.amount) : null,
    pa_pay: null, income: null, child_ids: [],
    source: 'extra', exception_id: e.id,
  })) : [];
  const tripPlan = [...planned, ...extras];

  // Each child's normal week decides whether they are expected at all today.
  const childStates = children.map(ch => {
    const day = sched.childDay(ch, c, date, weekday, timetables.get(ch.id));
    return {
      id: ch.id, name: ch.name, wheelchair: ch.wheelchair,
      scheduled: !!day.attends && live,
      start_time: day.start_time, finish_time: day.finish_time,
      // "not_scheduled" is a normal day off. It is not an absence.
      status: day.attends && live ? 'travelling' : 'not_scheduled',
      trips: {},
    };
  });
  const scheduledChildren = childStates.filter(ch => ch.scheduled);

  const cancelledWholeDay = ex.find(e => e.type === 'contract_cancelled' && e.leg === 'DAY' && e.trip_seq == null);

  const trips = [];
  for (const plan of tripPlan) {
    const t = {
      seq: plan.seq, label: plan.label, kind: plan.kind,
      depart_time: plan.depart_time, arrive_time: plan.arrive_time,
      source: plan.source, exception_id: plan.exception_id || null,
      status: 'operated', reason: null,
      children: [], children_travelling: 0, children_absent: 0, children_not_scheduled: 0,
    };

    const closedHere = ex.find(e => e.type === 'school_closed' && appliesToTrip(e, plan));
    const cancelled = cancelledWholeDay
      || ex.find(e => e.type === 'contract_cancelled' && appliesToTrip(e, plan));
    const journeyCancelled = ex.find(e => e.type === 'journey_cancelled' && appliesToTrip(e, plan));
    // A run taken off was never needed: no council income, no staff pay, not
    // billed. A cancelled run keeps its council income and is billed.
    const removed = ex.find(e => e.type === 'journey_removed' && appliesToTrip(e, plan));
    const cancellation = removed ? null : (closedHere || cancelled || journeyCancelled);
    t.cancelled = !!cancellation;
    t.removed = !!removed;
    t.cancellation_exception_id = cancellation ? cancellation.id : (removed ? removed.id : null);
    if (removed) { t.status = 'not_operated'; t.reason = 'Run taken off'; }
    else if (closedHere) { t.status = 'not_operated'; t.reason = 'School closed'; }
    else if (cancelled) { t.status = 'not_operated'; t.reason = 'Contract not operating'; }
    else if (journeyCancelled) { t.status = 'not_operated'; t.reason = 'Journey cancelled'; }
    if (cancellation && cancellation.note) t.reason += ' — ' + cancellation.note;
    if (removed && removed.note) t.reason += ' — ' + removed.note;

    // Who is on this trip, of the children expected in today.
    const riders = sched.tripChildren(plan, scheduledChildren);
    for (const ch of riders) {
      const absent = ex.find(e => e.type === 'child_absence' && e.child_id === ch.id && appliesToTrip(e, plan));
      let status;
      if (t.status === 'not_operated') status = 'not_operated';
      else if (absent) { status = 'absent'; t.children_absent++; }
      else { status = 'travelling'; t.children_travelling++; }
      ch.trips[plan.seq] = status;
      t.children.push({ id: ch.id, name: ch.name, status });
    }
    t.children_not_scheduled = childStates.length - riders.length;

    // A trip with nobody left to carry does not run, whether that is because
    // everyone is absent or because nobody was due to travel today. A contract
    // with no children at all is left alone, so a brand new one still shows its
    // pattern before anybody is assigned to it.
    if (t.status === 'operated' && childStates.length > 0 && t.children_travelling === 0) {
      t.status = 'not_operated';
      t.reason = riders.length > 0 ? 'All children absent' : 'No children scheduled';
    }

    for (const role of ['driver', 'pa']) t[role] = staffForTrip(c, role, plan, ex);
    if (t.status === 'operated') {
      if (t.driver.status === 'absent_no_cover') { t.status = 'not_operated'; t.reason = 'Driver absent - no cover'; }
      else if (t.pa.required && t.pa.status === 'absent_no_cover') { t.status = 'not_operated'; t.reason = 'PA absent - no cover'; }
      if (t.status === 'not_operated') {
        for (const cc of t.children) cc.status = 'not_operated';
        t.children_travelling = 0;
      }
    }
    trips.push(t);
  }

  // Money. A trip's own figure wins; otherwise the day rate is divided by the
  // journeys on a NORMAL day for this contract, which gives what one journey is
  // worth. A two-journey day is still split in half, exactly as before, and a
  // third journey on a Friday is paid on top instead of making all three worth
  // less. Naming a figure on the journey itself overrides all of this.
  const plannedCount = sched.normalTripCount(c, schedules, date);
  const dayRan = trips.some(t => t.status === 'operated');
  for (const t of trips) {
    const plan = tripPlan.find(p => p.seq === t.seq) || {};
    const isExtra = t.source === 'extra';
    const share = isExtra ? 0 : 1 / plannedCount;
    t.income_value = plan.income != null ? Number(plan.income)
      : (isExtra ? 0 : round2((c.income_per_day || 0) * share));
    t.driver_rate = plan.driver_pay != null ? Number(plan.driver_pay)
      : (isExtra ? 0 : round2((c.driver_pay_per_day || 0) * share));
    t.pa_rate = plan.pa_pay != null ? Number(plan.pa_pay)
      : (isExtra ? 0 : round2((c.pa_pay_per_day || 0) * share));

    for (const role of ['driver', 'pa']) {
      const info = t[role];
      if (!info || info.status === 'not_required') continue;
      const rate = role === 'driver' ? t.driver_rate : t.pa_rate;
      // A pay override naming a trip replaces that trip's rate; one for the
      // whole day replaces the day rate, so it is shared the same way.
      const value = info.override
        ? round2(Number(info.override.amount) * (info.override.trip_seq != null ? 1 : share))
        : rate;
      // Fixed day pay still covers normal non-operating trips when part of the
      // day ran. An explicitly cancelled run is always unpaid.
      const operatedForPay = !t.cancelled && (c.pay_basis === 'per_day'
        ? (dayRan && !isExtra)
        : t.status === 'operated');
      info.rate = round2(value);
      info.pay = (!info.absent && info.normal_staff_id && operatedForPay) ? round2(value) : 0;
    }
  }

  const operatedTrips = trips.filter(t => t.status === 'operated');
  const income = round2(
    c.income_basis === 'per_day'
      ? (!planned.length ? 0 : (c.income_per_day || 0))
      : trips.filter(t => t.status === 'operated' || t.cancelled).reduce((a, t) => a + t.income_value, 0));
  // Allocate a fixed council day rate once across its scheduled runs. Use
  // cumulative rounding so the run amounts add up exactly to the day income.
  const normalTrips = trips.filter(t => t.source !== 'extra');
  let councilTotal = 0, normalIndex = 0;
  for (const t of trips) {
    if (c.income_basis === 'per_day') {
      if (t.source === 'extra') { t.council_income = 0; continue; }
      const cumulative = round2(income * (++normalIndex / normalTrips.length));
      t.council_income = round2(cumulative - councilTotal); councilTotal = cumulative;
    } else t.council_income = t.status === 'operated' || t.cancelled ? t.income_value : 0;
  }

  const result = {
    contract_id: c.id, code: c.code, date, weekday,
    trips,
    planned_trips: planned.length,
    operated_trips: operatedTrips.length,
    cancelled_trips: trips.filter(t => t.cancelled).length,
    children: childStates,
    exceptions: ex,
    notes: ex.filter(e => e.type === 'note'),
    income,
    other_costs: round2((c.other_costs_per_day || 0) * (operatedTrips.length > 0 ? 1 : 0)),
    operated: operatedTrips.length > 0,
  };
  result.summary = summarise(result);
  return result;
}

/** Who is meant to work one trip, and whether anyone covered them. */
function staffForTrip(c, role, plan, ex) {
  const normalId = role === 'driver' ? c.driver_id : c.pa_id;
  const normalName = role === 'driver' ? c.driver_name : c.pa_name;
  const required = role === 'driver' ? true : !!c.requires_pa;
  const info = {
    role, required, normal_staff_id: normalId, normal_name: normalName,
    absent: false, cover_staff_id: null, cover_name: null, cover_pay: null,
    paid_immediately: 0, exception_id: null, worked_staff_id: normalId,
    pay: 0, rate: 0, override: null, status: 'normal',
  };
  if (!required && !normalId) { info.status = 'not_required'; return info; }
  if (!normalId) info.status = 'unassigned';

  const absence = ex.find(e => e.type === 'staff_absence' && e.role === role && appliesToTrip(e, plan));
  const override = ex.find(e => e.type === 'pay_override' && e.role === role && appliesToTrip(e, plan));
  if (override) info.override = override;
  if (absence) {
    info.absent = true;
    info.exception_id = absence.id;
    info.status = 'absent';
    if (absence.cover_staff_id) {
      info.cover_staff_id = absence.cover_staff_id;
      info.cover_name = absence.cover_name;
      info.cover_pay = absence.cover_pay;
      info.paid_immediately = absence.paid_immediately;
      info.worked_staff_id = absence.cover_staff_id;
      info.status = 'covered';
    } else {
      info.worked_staff_id = null;
      info.status = 'absent_no_cover';
    }
  }
  return info;
}

/** Cover for cancelled runs is unpaid, including a cancelled part of a day. */
function coverAmount(day, exception) {
  const covered = day.trips.filter(t => appliesToTrip(exception, t));
  if (!covered.some(t => t.status === 'operated')) return 0;
  const rate = t => exception.role === 'driver' ? t.driver_rate : t.pa_rate;
  const standard = covered.reduce((sum, t) => sum + rate(t), 0);
  const payable = covered.filter(t => !t.cancelled);
  if (exception.cover_pay == null) return round2(payable.reduce((sum, t) => sum + rate(t), 0));
  const proportion = standard > 0 ? payable.reduce((sum, t) => sum + rate(t), 0) / standard
    : covered.length ? payable.length / covered.length : 0;
  return round2(Number(exception.cover_pay) * proportion);
}

function summarise(r) {
  const twoTrips = r.trips.filter(t => t.source !== 'extra').length <= 2;
  const label = t => (t.source === 'extra' ? 'Extra' : twoTrips ? (t.kind === 'outbound' ? 'AM' : 'PM') : `Trip ${t.seq}`);
  const lines = [];
  for (const t of r.trips) {
    if (t.source === 'extra') { lines.push(`Extra journey: ${t.label}`); continue; }
    if (t.status !== 'operated') lines.push(`${label(t)}: ${t.reason}`);
    if (t.driver.status === 'covered') lines.push(`${label(t)}: Driver cover ${t.driver.cover_name}`);
    else if (t.driver.status === 'absent_no_cover' && !/Driver absent/.test(t.reason || '')) lines.push(`${label(t)}: Driver absent (no cover)`);
    if (t.pa.status === 'covered') lines.push(`${label(t)}: PA cover ${t.pa.cover_name}`);
    else if (t.pa.status === 'absent_no_cover' && !/PA absent/.test(t.reason || '')) lines.push(`${label(t)}: PA absent (no cover)`);
    if (t.children_absent) lines.push(`${label(t)}: ${t.children_absent} child${t.children_absent > 1 ? 'ren' : ''} absent`);
  }
  const off = r.children.filter(c => !c.scheduled).length;
  if (off && off === r.children.length && r.trips.length) lines.push('No children scheduled today');

  // Fold an identical message on both trips of a two-trip day into one line.
  const out = [];
  const seen = new Set();
  for (const msg of lines) {
    const body = msg.replace(/^(AM|PM|Trip \d+): /, '');
    if (twoTrips) {
      const twin = out.find(o => o !== msg && o.replace(/^(AM|PM|Trip \d+): /, '') === body && /^(AM|PM): /.test(o));
      if (twin && /^(AM|PM): /.test(msg)) { out[out.indexOf(twin)] = 'All day: ' + body; continue; }
    }
    if (seen.has(msg)) continue;
    seen.add(msg);
    out.push(msg);
  }
  return out;
}

// ---------------------------------------------------------------- views

/** The calendar grid for a date range. */
async function buildCalendar(orgId, from, to, filter = {}) {
  requireOrg(orgId);
  let where = " AND c.status IN ('active','suspended')";
  const params = [];
  if (filter.contract_id) { where += ' AND c.id = ?'; params.push(filter.contract_id); }
  if (filter.school_id) { where += ' AND c.school_id = ?'; params.push(filter.school_id); }
  if (filter.staff_id) { where += ' AND (c.driver_id = ? OR c.pa_id = ?)'; params.push(filter.staff_id, filter.staff_id); }

  const ctx = await loadContext(orgId, from, to, where, params);
  const dates = dateRange(from, to);
  const rows = [];

  for (const c of ctx.contracts) {
    if (filter.staff_id) {
      const isNormal = c.driver_id === filter.staff_id || c.pa_id === filter.staff_id;
      const isCover = ctx.exceptions.some(e => e.contract_id === c.id && e.cover_staff_id === filter.staff_id);
      if (!isNormal && !isCover) continue;
    }
    const days = {};
    let any = false;
    for (const d of dates) {
      const day = evaluateContractDay(c, d, ctx.childMap[c.id] || [], ctx.exceptions, ctx);
      if (!day.trips.length) { days[d] = null; continue; }
      any = true;
      days[d] = day;
    }
    if (!any && filter.hide_inactive) continue;
    rows.push({ contract: c, children: ctx.childMap[c.id] || [], days });
  }

  // A contract someone only covered still belongs in their calendar.
  if (filter.staff_id) {
    const coverContractIds = [...new Set(ctx.exceptions
      .filter(e => e.cover_staff_id === filter.staff_id && e.contract_id)
      .map(e => e.contract_id))];
    for (const cid of coverContractIds) {
      if (rows.some(r => r.contract.id === cid)) continue;
      const extra = await loadContext(orgId, from, to, ' AND c.id = ?', [cid]);
      const c = extra.contracts[0];
      if (!c) continue;
      const kids = extra.childMap[c.id] || [];
      const days = {};
      for (const d of dates) {
        const day = evaluateContractDay(c, d, kids, ctx.exceptions, extra);
        days[d] = day.trips.length ? day : null;
      }
      rows.push({ contract: c, children: kids, days, cover_only: true });
    }
  }
  return { from, to, dates, rows };
}

/** Everything happening on one date. */
async function dayOverview(orgId, date) {
  const cal = await buildCalendar(orgId, date, date);
  return {
    date,
    items: cal.rows.map(r => r.days[date]).filter(Boolean),
    contracts: cal.rows.map(r => r.contract),
  };
}

module.exports = {
  toDate, fmt, addDays, dow, today, dateRange, round2,
  contractLiveOn, contractOperatesOn,
  loadContracts, loadChildrenByContract, loadExceptions, loadContext,
  evaluateContractDay, appliesToTrip, coverAmount, buildCalendar, dayOverview,
};
