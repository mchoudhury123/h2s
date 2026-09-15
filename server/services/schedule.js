'use strict';
// Weekly patterns: what a contract normally runs, and when each child normally travels.
//
// Both are versioned by an effective date. Asking what happened last term reads
// the version that was in force then, so changing next term rewrites nothing.
//
// A contract with no version behaves exactly as the system always has: one
// outward and one return trip on each of its operating days. A child with no
// version travels whenever their contract runs. Nothing needs configuring until
// something differs from that, which is why existing records keep working
// untouched.
const { all, inClause } = require('../db');

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---------------------------------------------------------------- loading

/**
 * Loads every schedule version for a set of contracts, newest first, with its trips.
 * Returns a Map of contract id to an array of versions.
 */
async function loadSchedules(orgId, contractIds) {
  const out = new Map(contractIds.map(id => [id, []]));
  const list = inClause(contractIds);
  if (!list) return out;

  const versions = await all(
    `SELECT id, contract_id, effective_from, note FROM contract_schedules
     WHERE organisation_id = ? AND contract_id IN (${list})
     ORDER BY contract_id, effective_from DESC`, [orgId, ...contractIds]);
  if (!versions.length) return out;

  const vIds = versions.map(v => v.id);
  const trips = await all(
    `SELECT id, schedule_id, weekday, seq, label, kind, depart_time, arrive_time,
            driver_pay, pa_pay, income, notes
     FROM contract_trips
     WHERE organisation_id = ? AND schedule_id IN (${inClause(vIds)})
     ORDER BY weekday, seq`, [orgId, ...vIds]);
  const tripChildren = await all(
    `SELECT tc.trip_id, tc.child_id FROM contract_trip_children tc
     JOIN contract_trips t ON t.id = tc.trip_id
     WHERE tc.organisation_id = ? AND t.schedule_id IN (${inClause(vIds)})`, [orgId, ...vIds]);

  const childrenByTrip = new Map();
  for (const r of tripChildren) {
    if (!childrenByTrip.has(r.trip_id)) childrenByTrip.set(r.trip_id, []);
    childrenByTrip.get(r.trip_id).push(r.child_id);
  }
  const tripsByVersion = new Map(vIds.map(id => [id, []]));
  for (const t of trips) {
    tripsByVersion.get(t.schedule_id).push({ ...t, child_ids: childrenByTrip.get(t.id) || [] });
  }
  for (const v of versions) {
    out.get(v.contract_id).push({ ...v, trips: tripsByVersion.get(v.id) || [] });
  }
  return out;
}

/** Loads every timetable version for a set of children, newest first, with its days. */
async function loadTimetables(orgId, childIds) {
  const out = new Map(childIds.map(id => [id, []]));
  const list = inClause(childIds);
  if (!list) return out;

  const versions = await all(
    `SELECT id, child_id, effective_from, same_all_week, start_time, finish_time, note
     FROM child_timetables
     WHERE organisation_id = ? AND child_id IN (${list})
     ORDER BY child_id, effective_from DESC`, [orgId, ...childIds]);
  if (!versions.length) return out;

  const vIds = versions.map(v => v.id);
  const days = await all(
    `SELECT timetable_id, weekday, attends, start_time, finish_time
     FROM child_timetable_days
     WHERE organisation_id = ? AND timetable_id IN (${inClause(vIds)})
     ORDER BY weekday`, [orgId, ...vIds]);
  const byVersion = new Map(vIds.map(id => [id, []]));
  for (const d of days) byVersion.get(d.timetable_id).push(d);
  for (const v of versions) out.get(v.child_id).push({ ...v, days: byVersion.get(v.id) || [] });
  return out;
}

// ---------------------------------------------------------------- resolving

/** The version in force on a date: the latest one that had already started. */
function versionFor(versions, date) {
  if (!versions || !versions.length) return null;
  for (const v of versions) if (v.effective_from <= date) return v;   // already sorted newest first
  return null;
}

/** The operating weekdays of a contract, as numbers. */
function operatingDays(contract) {
  return String(contract.days_of_week || '1,2,3,4,5')
    .split(',').map(s => s.trim()).filter(Boolean).map(Number);
}

/**
 * The journeys a contract normally runs on one date, before any exception.
 * Falls back to the classic outward-and-return pair when nothing is configured.
 */
function plannedTrips(contract, date, weekday, versions) {
  const version = versionFor(versions, date);
  if (version) {
    const trips = version.trips.filter(t => t.weekday === weekday);
    return trips
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map((t, i) => ({
        seq: i + 1,
        label: t.label,
        kind: t.kind,
        depart_time: t.depart_time,
        arrive_time: t.arrive_time,
        driver_pay: t.driver_pay,
        pa_pay: t.pa_pay,
        income: t.income,
        child_ids: t.child_ids,
        notes: t.notes,
        source: 'schedule',
      }));
  }
  // No weekly schedule configured: the contract's own operating days, one
  // outward and one return trip, exactly as before.
  if (!operatingDays(contract).includes(weekday)) return [];
  return [
    {
      seq: 1, label: 'AM school drop-off', kind: 'outbound',
      depart_time: contract.am_pickup_time, arrive_time: contract.am_arrival_time,
      driver_pay: null, pa_pay: null, income: null, child_ids: [], source: 'default',
    },
    {
      seq: 2, label: 'PM school collection', kind: 'return',
      depart_time: contract.pm_finish_time, arrive_time: contract.pm_dropoff_time,
      driver_pay: null, pa_pay: null, income: null, child_ids: [], source: 'default',
    },
  ];
}

/**
 * Whether a child normally travels on a date, and at what times.
 * A child with no timetable travels whenever their contract runs.
 */
function childDay(child, contract, date, weekday, versions) {
  const version = versionFor(versions, date);
  if (!version) {
    return {
      attends: operatingDays(contract).includes(weekday),
      start_time: child.pickup_time || contract.am_pickup_time,
      finish_time: child.finish_time || contract.pm_finish_time,
      source: 'default',
    };
  }
  if (version.same_all_week) {
    // The same times every day the contract runs, unless a day says otherwise.
    const day = version.days.find(d => d.weekday === weekday);
    const attends = day ? !!day.attends : operatingDays(contract).includes(weekday);
    return {
      attends,
      start_time: (day && day.start_time) || version.start_time,
      finish_time: (day && day.finish_time) || version.finish_time,
      source: 'timetable',
    };
  }
  const day = version.days.find(d => d.weekday === weekday);
  if (!day) return { attends: false, start_time: null, finish_time: null, source: 'timetable' };
  return {
    attends: !!day.attends,
    start_time: day.start_time || version.start_time,
    finish_time: day.finish_time || version.finish_time,
    source: 'timetable',
  };
}

/**
 * How many journeys a normal day on this contract has.
 *
 * The contract's day rate buys a normal day, so this is what a single journey
 * is worth. A week of two-journey days with a three-journey Friday has a normal
 * day of two, and Friday's third journey is paid on top rather than making all
 * three worth less. Where the week is evenly split the lower count wins, so an
 * unusual day always adds pay rather than quietly taking it away.
 */
function normalTripCount(contract, versions, date) {
  const version = versionFor(versions, date);
  if (!version) return 2;                       // the classic there-and-back day
  const counts = [];
  for (const weekday of [0, 1, 2, 3, 4, 5, 6]) {
    const n = version.trips.filter(t => t.weekday === weekday).length;
    if (n > 0) counts.push(n);
  }
  if (!counts.length) return 2;
  const tally = new Map();
  for (const n of counts) tally.set(n, (tally.get(n) || 0) + 1);
  let best = null;
  for (const [n, freq] of [...tally.entries()].sort((a, b) => a[0] - b[0])) {
    if (!best || freq > best[1]) best = [n, freq];
  }
  return best[0];
}

/**
 * Which children a trip carries.
 * An explicit list wins. Otherwise everyone travelling that day travels on it.
 */
function tripChildren(trip, scheduledChildren) {
  if (trip.child_ids && trip.child_ids.length) {
    const wanted = new Set(trip.child_ids);
    return scheduledChildren.filter(c => wanted.has(c.id));
  }
  return scheduledChildren;
}

// ---------------------------------------------------------------- summaries

/** The next version due to start after a date, if there is one. */
function nextVersion(versions, date) {
  const later = (versions || []).filter(v => v.effective_from > date);
  if (!later.length) return null;
  return later.reduce((a, b) => (a.effective_from <= b.effective_from ? a : b));
}

/**
 * A plain-language summary of a contract's week, for the contract page.
 *
 * Normally this is the week in force today. When a pattern has been set up for
 * a date that has not arrived yet and none is in force, it shows that one
 * instead, labelled with its start date, so the firm can see what they saved.
 */
function weekSummary(contract, versions, date) {
  const inForce = versionFor(versions, date);
  const upcoming = nextVersion(versions, date);
  const shown = inForce || upcoming;
  const showFrom = inForce ? date : (upcoming ? upcoming.effective_from : date);
  const days = [];
  for (const weekday of [1, 2, 3, 4, 5, 6, 0]) {
    const trips = plannedTrips(contract, showFrom, weekday, versions);
    if (!trips.length && ![1, 2, 3, 4, 5].includes(weekday)) continue;
    days.push({
      weekday,
      name: WEEKDAY_NAMES[weekday],
      short: SHORT_DAYS[weekday],
      trips: trips.map(t => ({
        seq: t.seq, label: t.label, kind: t.kind,
        depart_time: t.depart_time, arrive_time: t.arrive_time,
        driver_pay: t.driver_pay, pa_pay: t.pa_pay, income: t.income,
        child_ids: t.child_ids,
      })),
      trip_count: trips.length,
    });
  }
  return {
    configured: !!shown,
    in_force: !!inForce,
    effective_from: shown ? shown.effective_from : null,
    starts_on: inForce ? null : (upcoming ? upcoming.effective_from : null),
    upcoming: inForce && upcoming ? { effective_from: upcoming.effective_from, note: upcoming.note } : null,
    note: shown ? shown.note : null,
    normal_trips: normalTripCount(contract, versions, showFrom),
    days,
  };
}

/** A child's week, for the child page. Shows a future timetable the same way. */
function timetableSummary(child, contract, versions, date) {
  const inForce = versionFor(versions, date);
  const upcoming = nextVersion(versions, date);
  const shown = inForce || upcoming;
  const showFrom = inForce ? date : (upcoming ? upcoming.effective_from : date);
  const days = [1, 2, 3, 4, 5, 6, 0].map(weekday => {
    const d = childDay(child, contract || {}, showFrom, weekday, versions);
    return { weekday, name: WEEKDAY_NAMES[weekday], short: SHORT_DAYS[weekday], ...d };
  }).filter(d => [1, 2, 3, 4, 5].includes(d.weekday) || d.attends);
  return {
    configured: !!shown,
    in_force: !!inForce,
    effective_from: shown ? shown.effective_from : null,
    starts_on: inForce ? null : (upcoming ? upcoming.effective_from : null),
    upcoming: inForce && upcoming ? { effective_from: upcoming.effective_from, note: upcoming.note } : null,
    same_all_week: shown ? !!shown.same_all_week : true,
    start_time: shown ? shown.start_time : (child.pickup_time || null),
    finish_time: shown ? shown.finish_time : (child.finish_time || null),
    note: shown ? shown.note : null,
    days,
    attending_days: days.filter(d => d.attends).length,
  };
}

module.exports = {
  WEEKDAY_NAMES, SHORT_DAYS,
  loadSchedules, loadTimetables, versionFor, operatingDays,
  plannedTrips, childDay, tripChildren, normalTripCount, nextVersion, weekSummary, timetableSummary,
};
