'use strict';
// Wage calculation engine. Every figure is derived from the journeys a contract
// was scheduled to run, plus the exceptions recorded against them, and every
// line traces back to a date, a contract, a trip and a reason.
const { all, get, insert, transaction } = require('../db');
const cal = require('./calendar');
const { round2 } = cal;

/**
 * Calculate wages for a date range.
 * opts: { from, to, staff_ids?, contract_id?, type? ('driver'|'pa'), include_zero?, all_staff? }
 * all_staff lists every active and pool member of staff, including anyone
 * who did no runs in the period, so nobody is missing from the wages page.
 */
async function calculateWages(orgId, opts) {
  if (!orgId) throw new Error('An organisation id is required');
  const { from, to } = opts;
  const ctx = await cal.loadContext(orgId, from, to, " AND c.status IN ('active','suspended','ended')");
  const dates = cal.dateRange(from, to);

  const ledger = new Map();
  const staffRows = await all(
    'SELECT id, type, first_name, last_name, default_day_rate, status FROM staff WHERE organisation_id = ?', [orgId]);
  const staffById = new Map(staffRows.map(s => [s.id, s]));
  function entry(staffId) {
    if (!staffId) return null;
    if (!ledger.has(staffId)) {
      const s = staffById.get(staffId);
      if (!s) return null;
      ledger.set(staffId, { staff: { ...s, name: `${s.first_name} ${s.last_name}` }, lines: [] });
    }
    return ledger.get(staffId);
  }
  // Everyone on the books gets a row, even with nothing to pay. Someone marked
  // inactive only appears if they actually have lines in the period.
  const onTheBooks = s => s.status === 'active' || s.status === 'pool';
  if (opts.all_staff) for (const s of staffRows) if (onTheBooks(s)) entry(s.id);

  for (const c of ctx.contracts) {
    if (opts.contract_id && c.id !== opts.contract_id) continue;
    for (const date of dates) {
      const day = cal.evaluateContractDay(c, date, ctx.childMap[c.id] || [], ctx.exceptions, ctx);
      if (!day.trips.length) continue;

      // Two-trip days keep reading as AM and PM; busier days name the trip.
      const simple = day.trips.filter(x => x.source !== 'extra').length <= 2;
      const tripName = t => (t.source === 'extra' ? 'Extra'
        : simple ? (t.kind === 'outbound' ? 'AM' : 'PM') : `Trip ${t.seq}`);

      for (const t of day.trips) {
        for (const role of ['driver', 'pa']) {
          const info = t[role];
          if (!info || info.status === 'not_required') continue;
          const who = role === 'driver' ? 'Driver' : 'PA';

          if (!info.absent && info.normal_staff_id && info.pay > 0) {
            const e = entry(info.normal_staff_id);
            if (e) e.lines.push({
              kind: 'normal', date, leg: tripName(t), trip_seq: t.seq, trip_label: t.label,
              contract_id: c.id, contract_code: c.code, role,
              description: `${c.code} ${tripName(t)} — ${t.label} (${who})`,
              rate: info.rate, amount: info.pay,
              note: info.override ? 'Pay override applied' : null,
            });
          }
          if (info.absent && info.normal_staff_id) {
            const e = entry(info.normal_staff_id);
            if (e) e.lines.push({
              kind: 'absence', date, leg: tripName(t), trip_seq: t.seq, trip_label: t.label,
              contract_id: c.id, contract_code: c.code, role,
              description: `${c.code} ${tripName(t)} — absent, not paid${info.cover_name ? ` (covered by ${info.cover_name})` : ''}`,
              rate: info.rate, amount: 0,
            });
          }
          if (!info.absent && info.normal_staff_id && info.pay === 0 && t.status !== 'operated') {
            const e = entry(info.normal_staff_id);
            if (e) e.lines.push({
              kind: 'not_operated', date, leg: tripName(t), trip_seq: t.seq, trip_label: t.label,
              contract_id: c.id, contract_code: c.code, role,
              description: `${c.code} ${tripName(t)} not operated — ${t.reason}`,
              rate: info.rate, amount: 0,
            });
          }
        }
      }

      // Cover is paid once per absence, however many trips it spans.
      for (const ce of day.exceptions.filter(e => e.type === 'staff_absence' && e.cover_staff_id)) {
        const e = entry(ce.cover_staff_id);
        if (!e) continue;
        const who = ce.role === 'driver' ? 'Driver' : 'PA';
        const covered = day.trips.filter(t => cal.appliesToTrip(ce, t));
        const operated = covered.filter(t => t.status === 'operated');
        // Without an agreed figure, cover is worth what those journeys are worth.
        const standard = round2(covered.reduce((a, t) => a + (ce.role === 'driver' ? t.driver_rate : t.pa_rate), 0));
        const amount = cal.coverAmount(day, ce);
        const span = ce.trip_seq != null ? `trip ${ce.trip_seq}` : ce.leg === 'DAY' ? 'full day' : ce.leg;
        e.lines.push({
          kind: 'cover', date, leg: span, trip_seq: ce.trip_seq,
          contract_id: c.id, contract_code: c.code, role: ce.role,
          description: `COVER ${who} ${c.code} ${span}${operated.length ? '' : ' - journey not operated'}`,
          rate: ce.cover_pay != null ? Number(ce.cover_pay) : standard,
          amount: operated.length ? round2(amount) : 0,
          exception_id: ce.id,
          paid_immediately: !!ce.paid_immediately,
          note: ce.cover_pay != null ? 'Agreed cover rate' : 'Rate for the journeys covered',
          journeys: covered.length,
        });
      }
    }
  }

  // Payments already made in the period, so nothing is paid twice. A payment
  // for cover belongs to the contract that was covered. A payroll payment
  // covers everything the person did, so it belongs to no single contract.
  const paidRows = await all(`SELECT p.*, s.first_name || ' ' || s.last_name AS staff_name,
      e.contract_id AS paid_contract_id, c.code AS paid_contract_code
    FROM payments p
    JOIN staff s ON s.id = p.staff_id
    LEFT JOIN exceptions e ON e.id = p.exception_id AND e.organisation_id = p.organisation_id
    LEFT JOIN contracts c ON c.id = e.contract_id AND c.organisation_id = p.organisation_id
    WHERE p.organisation_id = ? AND p.work_date >= ? AND p.work_date <= ?`, [orgId, from, to]);
  for (const p of paidRows) {
    // A view of one contract only deducts payments for work on that contract.
    // Deducting the rest would show someone owing money for a route they
    // were never paid on.
    if (opts.contract_id && p.paid_contract_id !== opts.contract_id) continue;
    const e = entry(p.staff_id);
    if (!e) continue;
    const label = p.source === 'cover_immediate' ? 'Cover paid immediately'
      : p.source === 'payroll' ? 'Paid through payroll'
        : (p.note || 'Payment already made');
    e.lines.push({
      kind: 'already_paid', date: p.work_date, leg: null,
      contract_id: p.paid_contract_id || null, contract_code: p.paid_contract_code || null,
      description: `${label} on ${ukDate(p.paid_date)}${p.paid_contract_code ? ' for ' + p.paid_contract_code : ''}${p.reference ? ' (ref ' + p.reference + ')' : ''}`,
      rate: null, amount: -round2(p.amount), payment_id: p.id, source: p.source,
      paid_date: p.work_date && p.paid_date ? String(p.paid_date).slice(0, 10) : null,
      batch: p.batch || null, payroll_run_id: p.payroll_run_id || null, exception_id: p.exception_id || null,
    });
  }

  let results = [...ledger.values()].map(e => {
    const lines = e.lines.sort((a, b) => (a.date || '').localeCompare(b.date || '')
      || (a.trip_seq || 0) - (b.trip_seq || 0)
      || a.kind.localeCompare(b.kind));
    const normal = sum(lines.filter(l => l.kind === 'normal'));
    const cover = sum(lines.filter(l => l.kind === 'cover'));
    const already = sum(lines.filter(l => l.kind === 'already_paid'));
    const gross = round2(normal + cover);
    return {
      staff: e.staff, from, to, lines,
      totals: {
        normal_earnings: round2(normal), cover_earnings: round2(cover),
        gross, already_paid: round2(-already), amount_due: round2(gross + already),
        normal_days: countDays(lines.filter(l => l.kind === 'normal')),
        cover_days: countDays(lines.filter(l => l.kind === 'cover' && l.amount > 0)),
        journeys: lines.filter(l => l.kind === 'normal').length,
        cover_journeys: lines.filter(l => l.kind === 'cover' && l.amount > 0)
          .reduce((a, l) => a + (l.journeys || 1), 0),
        missed_journeys: lines.filter(l => l.kind === 'absence' || l.kind === 'not_operated').length,
      },
    };
  });

  if (opts.type) results = results.filter(r => r.staff.type === opts.type);
  if (opts.staff_ids && opts.staff_ids.length) results = results.filter(r => opts.staff_ids.includes(r.staff.id));
  if (opts.all_staff) results = results.filter(r => r.lines.some(l => l.amount !== 0) || onTheBooks(r.staff));
  else if (!opts.include_zero) results = results.filter(r => r.lines.some(l => l.amount !== 0));
  results.sort((a, b) => a.staff.type.localeCompare(b.staff.type) || a.staff.name.localeCompare(b.staff.name));

  return {
    from, to, results,
    totals: {
      drivers: round2(sumBy(results.filter(r => r.staff.type === 'driver'), r => r.totals.amount_due)),
      pas: round2(sumBy(results.filter(r => r.staff.type === 'pa'), r => r.totals.amount_due)),
      gross: round2(sumBy(results, r => r.totals.gross)),
      already_paid: round2(sumBy(results, r => r.totals.already_paid)),
      total_due: round2(sumBy(results, r => r.totals.amount_due)),
      staff_count: results.length,
      // Listed is everyone shown; due is the people actually owed something.
      staff_due: results.filter(r => r.totals.amount_due > 0).length,
    },
  };
}

/**
 * What one person is still owed on each day of a range: what the journeys
 * earned that day, less any payment already recorded against that day.
 */
async function daysOwed(orgId, staffId, from, to) {
  const calc = await calculateWages(orgId, { from, to, staff_ids: [Number(staffId)], include_zero: true });
  const r = calc.results[0] || null;
  const byDate = new Map(cal.dateRange(from, to).map(d => [d, { date: d, earned: 0, already_paid: 0, journeys: 0 }]));
  for (const l of (r ? r.lines : [])) {
    const d = byDate.get(l.date);
    if (!d) continue;
    if (l.kind === 'normal' || l.kind === 'cover') { d.earned += l.amount; if (l.amount) d.journeys += l.journeys || 1; }
    else if (l.kind === 'already_paid') d.already_paid += -l.amount;
  }
  const days = [...byDate.values()].map(d => ({
    ...d, earned: round2(d.earned), already_paid: round2(d.already_paid),
    due: round2(Math.max(0, d.earned - d.already_paid)),
  }));
  return {
    staff: r ? r.staff : null, from, to, days,
    total_earned: round2(days.reduce((a, d) => a + d.earned, 0)),
    total_already_paid: round2(days.reduce((a, d) => a + d.already_paid, 0)),
    total_due: round2(days.reduce((a, d) => a + d.due, 0)),
  };
}

/**
 * Record that someone has already been paid for a run of days. One payment is
 * written per day still owed, so a later calculation over any range deducts
 * exactly the days it includes and nothing is paid twice. With no amount the
 * days are paid at what they are worth; a different sum is spread across the
 * days in proportion.
 */
async function payDays(orgId, staffId, { from, to, amount, paid_date, method, reference, note, created_by }) {
  const owed = await daysOwed(orgId, staffId, from, to);
  if (!owed.staff) {
    // Someone with no journeys at all in the range (after a handover, say) is
    // simply owed nothing, which is different from not existing.
    const person = await get('SELECT id FROM staff WHERE id = ? AND organisation_id = ?', [Number(staffId), orgId]);
    if (!person) throw new Error('Staff member not found');
    throw new Error('Nothing is outstanding for those days');
  }
  const days = owed.days.filter(d => d.due > 0);
  if (!days.length) throw new Error('Nothing is outstanding for those days');
  let amounts = days.map(d => d.due);
  const total = amount === undefined || amount === null || amount === '' ? owed.total_due : Number(amount);
  if (!(total > 0)) throw new Error('The amount paid must be more than zero');
  if (total !== owed.total_due) {
    let running = 0;
    amounts = days.map((d, i) => {
      if (i === days.length - 1) return round2(total - running);
      const a = round2(total * d.due / owed.total_due);
      running = round2(running + a);
      return a;
    });
  }
  const label = note || `Paid for ${ukDate(from)} to ${ukDate(to)}`;
  const batch = 'days-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const ids = [];
  await transaction(async tx => {
    for (let i = 0; i < days.length; i++) {
      ids.push(await insert('payments', {
        staff_id: Number(staffId), work_date: days[i].date, paid_date: paid_date || cal.today(), amount: amounts[i],
        source: 'manual', batch, method: method || null, reference: reference || null, note: label, created_by: created_by || null,
      }, ['staff_id', 'work_date', 'paid_date', 'amount', 'source', 'batch', 'method', 'reference', 'note', 'created_by'], tx, orgId));
    }
  });
  return { staff: owed.staff, from, to, paid_days: days.length, total: round2(amounts.reduce((a, b) => a + b, 0)), payment_ids: ids, batch };
}

function ukDate(s) { if (!s) return ''; const [y, m, d] = String(s).slice(0, 10).split('-'); return `${d}/${m}/${y}`; }
function sum(lines) { return lines.reduce((a, l) => a + (l.amount || 0), 0); }
function sumBy(arr, fn) { return arr.reduce((a, x) => a + (fn(x) || 0), 0); }
/**
 * Days worked, at half a day per journey, the same rule the council is
 * charged by: an AM or a PM alone is half a day, a normal day is one, a
 * three-run Friday is one and a half. A cover line spans the journeys it
 * covered.
 */
function countDays(lines) { return round2(lines.reduce((a, l) => a + (l.journeys || 1), 0) / 2); }

/** Staff cost per contract over a range, used by profitability. */
async function staffCostForRange(orgId, from, to, contractId = null) {
  const w = await calculateWages(orgId, { from, to, contract_id: contractId || undefined, include_zero: true });
  const byContract = {};
  for (const r of w.results) {
    for (const l of r.lines) {
      if (!l.contract_id || l.amount <= 0) continue;
      const b = (byContract[l.contract_id] ||= { driver: 0, pa: 0, total: 0 });
      const role = l.role || r.staff.type;
      b[role === 'driver' ? 'driver' : 'pa'] += l.amount;
      b.total += l.amount;
    }
  }
  for (const k of Object.keys(byContract)) {
    byContract[k].driver = round2(byContract[k].driver);
    byContract[k].pa = round2(byContract[k].pa);
    byContract[k].total = round2(byContract[k].total);
  }
  return byContract;
}

module.exports = { calculateWages, staffCostForRange, daysOwed, payDays };
