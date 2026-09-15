'use strict';
// Wage calculation engine. Every figure is derived from scheduled journeys +/- exceptions,
// and every line is traceable back to a date, contract and reason.
const { all, get } = require('../db');
const cal = require('./calendar');
const { round2 } = cal;

/**
 * Calculate wages for a date range.
 * opts: { from, to, staff_ids?, contract_id?, type? ('driver'|'pa'), include_paid? }
 * Returns one entry per staff member with a fully itemised breakdown.
 */
function calculateWages(opts) {
  const { from, to } = opts;
  const contracts = cal.loadContracts(" WHERE c.status IN ('active','suspended','ended')");
  const childMap = cal.loadChildrenByContract(contracts.map(c => c.id));
  const exceptions = cal.loadExceptions(from, to);
  const dates = cal.dateRange(from, to);

  // staff ledger
  const ledger = new Map(); // staff_id -> { staff, lines: [] }
  const staffRows = all('SELECT id, type, first_name, last_name, default_day_rate, status FROM staff');
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

  for (const c of contracts) {
    if (opts.contract_id && c.id !== opts.contract_id) continue;
    for (const date of dates) {
      if (!cal.contractOperatesOn(c, date)) continue;
      const day = cal.evaluateContractDay(c, date, childMap[c.id] || [], exceptions);
      for (const leg of cal.LEGS) {
        const L = day.legs[leg];
        for (const role of ['driver', 'pa']) {
          const info = L[role];
          if (!info || info.status === 'not_required') continue;
          // normal staff pay
          if (!info.absent && info.normal_staff_id && info.pay > 0) {
            const e = entry(info.normal_staff_id);
            if (e) e.lines.push({
              kind: 'normal', date, leg, contract_id: c.id, contract_code: c.code, role,
              description: `${c.code} ${leg} (${role === 'driver' ? 'Driver' : 'PA'})`,
              rate: info.override ? info.override.amount : (role === 'driver' ? c.driver_pay_per_day : c.pa_pay_per_day),
              amount: info.pay,
              note: info.override ? 'Pay override applied' : null,
            });
          }
          // withheld pay explanation (zero-value, for transparency)
          if (info.absent && info.normal_staff_id) {
            const e = entry(info.normal_staff_id);
            if (e) e.lines.push({
              kind: 'absence', date, leg, contract_id: c.id, contract_code: c.code, role,
              description: `${c.code} ${leg} - absent, not paid${info.cover_name ? ` (covered by ${info.cover_name})` : ''}`,
              rate: 0, amount: 0,
            });
          }
          if (!info.absent && info.normal_staff_id && info.pay === 0 && L.status !== 'operated') {
            const e = entry(info.normal_staff_id);
            if (e) e.lines.push({
              kind: 'not_operated', date, leg, contract_id: c.id, contract_code: c.code, role,
              description: `${c.code} ${leg} not operated - ${L.reason}`,
              rate: 0, amount: 0,
            });
          }
        }
      }
      // cover payments: one per absence exception (not per leg) so a DAY cover pays once
      const coverEx = day.exceptions.filter(e => e.type === 'staff_absence' && e.cover_staff_id);
      for (const ce of coverEx) {
        const e = entry(ce.cover_staff_id);
        if (!e) continue;
        const roleLabel = ce.role === 'driver' ? 'Driver' : 'PA';
        const defaultRate = ce.role === 'driver' ? c.driver_pay_per_day : c.pa_pay_per_day;
        const fullDay = ce.leg === 'DAY';
        const baseAmount = ce.cover_pay != null ? ce.cover_pay : round2(defaultRate * (fullDay ? 1 : 0.5));
        // if the contract did not operate at all that day, no cover pay is due
        const operatedLegs = cal.LEGS.filter(l => day.legs[l].status === 'operated');
        const relevant = fullDay ? operatedLegs.length > 0 : day.legs[ce.leg].status === 'operated';
        e.lines.push({
          kind: 'cover', date, leg: ce.leg, contract_id: c.id, contract_code: c.code, role: ce.role,
          description: `COVER ${roleLabel} ${c.code} ${ce.leg === 'DAY' ? 'full day' : ce.leg}${relevant ? '' : ' - journey not operated'}`,
          rate: ce.cover_pay != null ? ce.cover_pay : defaultRate,
          amount: relevant ? round2(baseAmount) : 0,
          exception_id: ce.id,
          paid_immediately: !!ce.paid_immediately,
          note: ce.cover_pay != null ? 'Cover rate override' : 'Contract rate',
        });
      }
    }
  }

  // Payments already made in the period (deducted so nothing is paid twice)
  const paidRows = all(`SELECT p.*, s.first_name || ' ' || s.last_name AS staff_name FROM payments p JOIN staff s ON s.id = p.staff_id WHERE p.work_date >= ? AND p.work_date <= ?`, [from, to]);
  for (const p of paidRows) {
    const e = entry(p.staff_id);
    if (!e) continue;
    const label = p.source === 'cover_immediate' ? 'Cover paid immediately'
      : p.source === 'payroll' ? 'Paid through payroll'
      : (p.note || 'Payment already made');
    e.lines.push({
      kind: 'already_paid', date: p.work_date, leg: null, contract_id: null, contract_code: null,
      description: `${label} on ${ukDate(p.paid_date)}${p.reference ? ' (ref ' + p.reference + ')' : ''}`,
      rate: null, amount: -round2(p.amount), payment_id: p.id, source: p.source,
    });
  }

  // Build results
  let results = [...ledger.values()].map(e => {
    const lines = e.lines.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.kind).localeCompare(b.kind));
    const normal = sum(lines.filter(l => l.kind === 'normal'));
    const cover = sum(lines.filter(l => l.kind === 'cover'));
    const already = sum(lines.filter(l => l.kind === 'already_paid'));
    const gross = round2(normal + cover);
    const due = round2(gross + already);
    const normalDays = countDays(lines.filter(l => l.kind === 'normal'));
    const coverDays = countDays(lines.filter(l => l.kind === 'cover' && l.amount > 0));
    return {
      staff: e.staff, from, to, lines,
      totals: {
        normal_earnings: round2(normal), cover_earnings: round2(cover),
        gross: gross, already_paid: round2(-already), amount_due: due,
        normal_days: normalDays, cover_days: coverDays,
        journeys: lines.filter(l => l.kind === 'normal').length,
        missed_journeys: lines.filter(l => l.kind === 'absence' || l.kind === 'not_operated').length,
      },
    };
  });

  if (opts.type) results = results.filter(r => r.staff.type === opts.type);
  if (opts.staff_ids && opts.staff_ids.length) results = results.filter(r => opts.staff_ids.includes(r.staff.id));
  if (!opts.include_zero) results = results.filter(r => r.lines.some(l => l.amount !== 0));
  results.sort((a, b) => a.staff.type.localeCompare(b.staff.type) || a.staff.name.localeCompare(b.staff.name));

  const grand = {
    drivers: round2(sumBy(results.filter(r => r.staff.type === 'driver'), r => r.totals.amount_due)),
    pas: round2(sumBy(results.filter(r => r.staff.type === 'pa'), r => r.totals.amount_due)),
    gross: round2(sumBy(results, r => r.totals.gross)),
    already_paid: round2(sumBy(results, r => r.totals.already_paid)),
    total_due: round2(sumBy(results, r => r.totals.amount_due)),
    staff_count: results.length,
  };
  return { from, to, results, totals: grand };
}

function ukDate(s) { if (!s) return ''; const [y, m, d] = String(s).slice(0, 10).split('-'); return `${d}/${m}/${y}`; }
function sum(lines) { return lines.reduce((a, l) => a + (l.amount || 0), 0); }
function sumBy(arr, fn) { return arr.reduce((a, x) => a + (fn(x) || 0), 0); }
function countDays(lines) { return new Set(lines.map(l => l.date)).size; }

/** Staff cost for a set of contracts over a range - used by profitability. */
function staffCostForRange(from, to, contractId = null) {
  const w = calculateWages({ from, to, contract_id: contractId || undefined, include_zero: true });
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

module.exports = { calculateWages, staffCostForRange };
