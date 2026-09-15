'use strict';
// Journey engine: knows what is SUPPOSED to happen each day and overlays exceptions.
const { all, get, inClause } = require('../db');

const LEGS = ['AM', 'PM'];

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

function contractOperatesOn(c, date) {
  if (c.status !== 'active') return false;
  if (c.start_date && date < c.start_date) return false;
  if (c.end_date && date > c.end_date) return false;
  const days = String(c.days_of_week || '1,2,3,4,5').split(',').map(s => s.trim()).filter(Boolean).map(Number);
  return days.includes(dow(date));
}

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
  const rows = await all(`SELECT id, first_name, last_name, contract_id, wheelchair, status
    FROM children WHERE organisation_id = ? AND status = 'active' AND contract_id IN (${list})
    ORDER BY last_name, first_name`, [orgId, ...contractIds]);
  const map = {};
  for (const r of rows) { (map[r.contract_id] ||= []).push({ ...r, name: `${r.first_name} ${r.last_name}` }); }
  return map;
}

async function loadExceptions(orgId, from, to, contractIds = null) {
  requireOrg(orgId);
  let sql = `SELECT e.*, cs.first_name || ' ' || cs.last_name AS cover_name, ch.first_name || ' ' || ch.last_name AS child_name,
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

function legCovered(exLeg, leg) { return exLeg === 'DAY' || exLeg === leg; }
function requireOrg(orgId) { if (!orgId) throw new Error('An organisation id is required'); }

/**
 * Evaluate one contract on one date. Returns the expected-vs-actual picture for both legs
 * plus who worked and what they should be paid, and the income for the day.
 */
function evaluateContractDay(c, date, children, exceptions) {
  const ex = exceptions.filter(e => e.date === date && (e.contract_id === c.id || (e.contract_id == null && e.type === 'school_closed' && (e.school_id == null || e.school_id === c.school_id))));
  const result = { contract_id: c.id, code: c.code, date, legs: {}, exceptions: ex, children: children.map(ch => ({ id: ch.id, name: ch.name, AM: 'expected', PM: 'expected' })), notes: [] };

  for (const leg of LEGS) {
    const L = { leg, status: 'operated', reason: null, driver: null, pa: null, children_travelling: 0, children_absent: 0 };
    // cancellations
    const closed = ex.find(e => e.type === 'school_closed' && legCovered(e.leg, leg));
    const cancelled = ex.find(e => e.type === 'contract_cancelled' && legCovered(e.leg, leg));
    const jcancel = ex.find(e => e.type === 'journey_cancelled' && legCovered(e.leg, leg));
    if (closed) { L.status = 'not_operated'; L.reason = 'School closed'; }
    else if (cancelled) { L.status = 'not_operated'; L.reason = 'Contract cancelled'; }
    else if (jcancel) { L.status = 'not_operated'; L.reason = 'Journey cancelled'; }

    // children
    for (const ch of result.children) {
      const abs = ex.find(e => e.type === 'child_absence' && e.child_id === ch.id && legCovered(e.leg, leg));
      if (L.status === 'not_operated') ch[leg] = 'not_operated';
      else if (abs) { ch[leg] = 'absent'; L.children_absent++; }
      else { ch[leg] = 'travelling'; L.children_travelling++; }
    }
    if (L.status === 'operated' && result.children.length > 0 && L.children_travelling === 0) {
      L.status = 'not_operated'; L.reason = 'All children absent';
    }

    // staff for each role
    for (const role of ['driver', 'pa']) {
      const normalId = role === 'driver' ? c.driver_id : c.pa_id;
      const rate = role === 'driver' ? c.driver_pay_per_day : c.pa_pay_per_day;
      const required = role === 'driver' ? true : !!c.requires_pa;
      const info = { role, required, normal_staff_id: normalId, normal_name: role === 'driver' ? c.driver_name : c.pa_name, absent: false, cover_staff_id: null, cover_name: null, cover_pay: null, paid_immediately: 0, exception_id: null, worked_staff_id: normalId, pay: 0, override: null, status: 'normal' };
      if (!required && !normalId) { info.status = 'not_required'; L[role] = info; continue; }
      if (!normalId) info.status = 'unassigned';
      const absence = ex.find(e => e.type === 'staff_absence' && e.role === role && legCovered(e.leg, leg));
      const override = ex.find(e => e.type === 'pay_override' && e.role === role && legCovered(e.leg, leg));
      if (override) info.override = override;
      if (absence) {
        info.absent = true; info.exception_id = absence.id; info.status = 'absent';
        if (absence.cover_staff_id) {
          info.cover_staff_id = absence.cover_staff_id; info.cover_name = absence.cover_name;
          info.cover_pay = absence.cover_pay; info.paid_immediately = absence.paid_immediately;
          info.worked_staff_id = absence.cover_staff_id; info.status = 'covered';
          info.cover_leg = absence.leg;
        } else {
          info.worked_staff_id = null; info.status = 'absent_no_cover';
          if (L.status === 'operated' && required) { L.status = 'not_operated'; L.reason = `${role === 'driver' ? 'Driver' : 'PA'} absent - no cover`; }
        }
      }
      // pay for this leg for the NORMAL staff member (cover pay handled as a whole-exception amount)
      const legShare = c.pay_basis === 'per_day' ? 0.5 : 0.5; // half a day per leg
      if (!info.absent && info.normal_staff_id) {
        const dayRate = override ? override.amount : rate;
        const operatedForPay = c.pay_basis === 'per_day' ? !(closed || cancelled || jcancel) : L.status === 'operated';
        info.pay = operatedForPay ? round2(dayRate * legShare) : 0;
      }
      L[role] = info;
    }
    result.legs[leg] = L;
  }

  // income for the day
  const legsOperated = LEGS.filter(l => result.legs[l].status === 'operated').length;
  const legsCancelled = LEGS.filter(l => ['School closed', 'Contract cancelled', 'Journey cancelled'].includes(result.legs[l].reason)).length;
  if (c.income_basis === 'per_day') result.income = round2(c.income_per_day * (2 - legsCancelled) / 2);
  else result.income = round2(c.income_per_day * legsOperated / 2);
  result.other_costs = round2((c.other_costs_per_day || 0) * (legsOperated > 0 ? 1 : 0));
  result.operated = legsOperated > 0;
  result.notes = ex.filter(e => e.type === 'note');
  result.summary = summarise(result);
  return result;
}

function summarise(r) {
  const s = [];
  for (const leg of LEGS) {
    const L = r.legs[leg];
    // The leg reason already names an uncovered absence, so do not repeat it below.
    if (L.status !== 'operated') s.push(`${leg}: ${L.reason}`);
    if (L.driver.status === 'covered') s.push(`${leg}: Driver cover ${L.driver.cover_name}`);
    else if (L.driver.status === 'absent_no_cover' && !/Driver absent/.test(L.reason || '')) s.push(`${leg}: Driver absent (no cover)`);
    if (L.pa.status === 'covered') s.push(`${leg}: PA cover ${L.pa.cover_name}`);
    else if (L.pa.status === 'absent_no_cover' && !/PA absent/.test(L.reason || '')) s.push(`${leg}: PA absent (no cover)`);
    if (L.children_absent) s.push(`${leg}: ${L.children_absent} child${L.children_absent > 1 ? 'ren' : ''} absent`);
  }
  // Collapse identical AM and PM messages into one "All day" line.
  const out = [];
  const seen = new Set();
  for (const msg of s) {
    const body = msg.slice(4);
    const other = (msg.startsWith('AM:') ? 'PM: ' : 'AM: ') + body;
    if (seen.has(other)) { out[out.indexOf(other)] = 'All day: ' + body; continue; }
    seen.add(msg); out.push(msg);
  }
  return out;
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/** Build the calendar grid for a date range. */
async function buildCalendar(orgId, from, to, filter = {}) {
  requireOrg(orgId);
  let where = " AND c.status IN ('active','suspended')";
  const params = [];
  if (filter.contract_id) { where += ' AND c.id = ?'; params.push(filter.contract_id); }
  if (filter.school_id) { where += ' AND c.school_id = ?'; params.push(filter.school_id); }
  if (filter.staff_id) { where += ' AND (c.driver_id = ? OR c.pa_id = ?)'; params.push(filter.staff_id, filter.staff_id); }
  const contracts = await loadContracts(orgId, where, params);
  const childMap = await loadChildrenByContract(orgId, contracts.map(c => c.id));
  const exceptions = await loadExceptions(orgId, from, to);
  const dates = dateRange(from, to);
  const rows = [];
  for (const c of contracts) {
    const days = {};
    let any = false;
    for (const d of dates) {
      if (!contractOperatesOn(c, d)) { days[d] = null; continue; }
      any = true;
      days[d] = evaluateContractDay(c, d, childMap[c.id] || [], exceptions);
    }
    // include cover staff appearing on this contract for the staff filter
    if (filter.staff_id) {
      const isNormal = c.driver_id === filter.staff_id || c.pa_id === filter.staff_id;
      const isCover = exceptions.some(e => e.contract_id === c.id && e.cover_staff_id === filter.staff_id);
      if (!isNormal && !isCover) continue;
    }
    if (!any && filter.hide_inactive) continue;
    rows.push({ contract: c, children: childMap[c.id] || [], days });
  }
  // cover-only contracts when filtering by staff (staff is not normal but covers)
  if (filter.staff_id) {
    const coverContractIds = [...new Set(exceptions.filter(e => e.cover_staff_id === filter.staff_id && e.contract_id).map(e => e.contract_id))];
    for (const cid of coverContractIds) {
      if (rows.some(r => r.contract.id === cid)) continue;
      const c = (await loadContracts(orgId, ' AND c.id = ?', [cid]))[0];
      if (!c) continue;
      const extra = childMap[c.id] || (await loadChildrenByContract(orgId, [c.id]))[c.id] || [];
      const days = {};
      for (const d of dates) days[d] = contractOperatesOn(c, d) ? evaluateContractDay(c, d, extra, exceptions) : null;
      rows.push({ contract: c, children: childMap[c.id] || [], days, cover_only: true });
    }
  }
  return { from, to, dates, rows };
}

/** Everything happening on one date (used by dashboard + day view). */
async function dayOverview(orgId, date) {
  const cal = await buildCalendar(orgId, date, date);
  const items = cal.rows.map(r => r.days[date]).filter(Boolean);
  return { date, items, contracts: cal.rows.map(r => r.contract) };
}

module.exports = { LEGS, toDate, fmt, addDays, dow, today, dateRange, contractOperatesOn, loadContracts, loadChildrenByContract, loadExceptions, evaluateContractDay, buildCalendar, dayOverview, round2 };
