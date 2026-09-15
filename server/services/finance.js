'use strict';
// Profitability: income from operated journeys minus real staff cost minus other direct costs.
const { all } = require('../db');
const cal = require('./calendar');
const wages = require('./wages');
const { round2 } = cal;

/**
 * Profitability over a range, itemised per contract, with roll-ups by school and council.
 * opts: { from, to, contract_id?, school_id?, council_id? }
 */
async function profitability(orgId, opts) {
  if (!orgId) throw new Error('An organisation id is required');
  const { from, to } = opts;
  let where = " AND c.status IN ('active','suspended','ended')";
  const params = [];
  if (opts.contract_id) { where += ' AND c.id = ?'; params.push(opts.contract_id); }
  if (opts.school_id) { where += ' AND c.school_id = ?'; params.push(opts.school_id); }
  if (opts.council_id) { where += ' AND c.council_id = ?'; params.push(opts.council_id); }
  const contracts = await cal.loadContracts(orgId, where, params);
  const childMap = await cal.loadChildrenByContract(orgId, contracts.map(c => c.id));
  const exceptions = await cal.loadExceptions(orgId, from, to);
  const dates = cal.dateRange(from, to);
  const costMap = await wages.staffCostForRange(orgId, from, to, opts.contract_id || null);

  const expenseRows = await all(`SELECT contract_id, SUM(amount) AS total FROM expenses
    WHERE organisation_id = ? AND date >= ? AND date <= ? GROUP BY contract_id`, [orgId, from, to]);
  const expenseMap = Object.fromEntries(expenseRows.map(r => [r.contract_id, r.total]));

  const rows = [];
  for (const c of contracts) {
    let income = 0, otherCosts = 0, daysOperated = 0, journeys = 0, scheduled = 0;
    const series = [];
    for (const d of dates) {
      if (!cal.contractOperatesOn(c, d)) continue;
      scheduled += 2;
      const day = cal.evaluateContractDay(c, d, childMap[c.id] || [], exceptions);
      const legs = cal.LEGS.filter(l => day.legs[l].status === 'operated').length;
      income += day.income; otherCosts += day.other_costs;
      journeys += legs;
      if (day.operated) daysOperated++;
      series.push({ date: d, income: day.income, journeys: legs });
    }
    const staffCost = costMap[c.id] || { driver: 0, pa: 0, total: 0 };
    const adhoc = expenseMap[c.id] || 0;
    const totalCost = round2(staffCost.total + otherCosts + adhoc);
    const gross = round2(income - totalCost);
    rows.push({
      contract_id: c.id, code: c.code, name: c.name, school_id: c.school_id, school_name: c.school_name,
      council_id: c.council_id, council_name: c.council_name, status: c.status,
      children: (childMap[c.id] || []).length,
      income: round2(income), driver_cost: staffCost.driver, pa_cost: staffCost.pa,
      other_costs: round2(otherCosts), adhoc_expenses: round2(adhoc), total_cost: totalCost,
      gross_profit: gross, margin: income > 0 ? round2(gross / income * 100) : 0,
      days_operated: daysOperated, journeys_operated: journeys, journeys_scheduled: scheduled,
      series,
    });
  }
  rows.sort((a, b) => b.gross_profit - a.gross_profit);

  const totals = aggregate(rows);
  const bySchool = groupBy(rows, r => r.school_id, r => r.school_name || 'No school');
  const byCouncil = groupBy(rows, r => r.council_id, r => r.council_name || 'No council');
  // daily series across everything
  const dayTotals = {};
  for (const r of rows) for (const s of r.series) {
    const t = (dayTotals[s.date] ||= { date: s.date, income: 0, journeys: 0 });
    t.income = round2(t.income + s.income); t.journeys += s.journeys;
  }
  return { from, to, rows, totals, by_school: bySchool, by_council: byCouncil, daily: Object.values(dayTotals).sort((a, b) => a.date.localeCompare(b.date)) };
}

function aggregate(rows) {
  const income = round2(rows.reduce((a, r) => a + r.income, 0));
  const driver = round2(rows.reduce((a, r) => a + r.driver_cost, 0));
  const pa = round2(rows.reduce((a, r) => a + r.pa_cost, 0));
  const other = round2(rows.reduce((a, r) => a + r.other_costs + r.adhoc_expenses, 0));
  const cost = round2(driver + pa + other);
  const gross = round2(income - cost);
  return { income, driver_cost: driver, pa_cost: pa, other_costs: other, total_cost: cost, gross_profit: gross, margin: income > 0 ? round2(gross / income * 100) : 0, contracts: rows.length };
}

function groupBy(rows, keyFn, labelFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r) ?? 0;
    if (!map.has(k)) map.set(k, { id: k, label: labelFn(r), rows: [] });
    map.get(k).rows.push(r);
  }
  return [...map.values()].map(g => ({ id: g.id, label: g.label, ...aggregate(g.rows), contract_codes: g.rows.map(r => r.code) }))
    .sort((a, b) => b.gross_profit - a.gross_profit);
}

/** Forward-looking expected weekly/annual run-rate used on the dashboard. */
async function expectedDaily(orgId, date) {
  const contracts = await cal.loadContracts(orgId, " AND c.status = 'active'");
  const childMap = await cal.loadChildrenByContract(orgId, contracts.map(c => c.id));
  const exceptions = await cal.loadExceptions(orgId, date, date);
  let income = 0, driverCost = 0, paCost = 0, other = 0, operating = 0;
  for (const c of contracts) {
    if (!cal.contractOperatesOn(c, date)) continue;
    operating++;
    const day = cal.evaluateContractDay(c, date, childMap[c.id] || [], exceptions);
    income += day.income; other += day.other_costs;
    for (const leg of cal.LEGS) {
      const L = day.legs[leg];
      if (L.driver && L.driver.pay) driverCost += L.driver.pay;
      if (L.pa && L.pa.pay) paCost += L.pa.pay;
    }
    for (const ce of day.exceptions.filter(e => e.type === 'staff_absence' && e.cover_staff_id)) {
      const base = ce.cover_pay != null ? ce.cover_pay : (ce.role === 'driver' ? c.driver_pay_per_day : c.pa_pay_per_day) * (ce.leg === 'DAY' ? 1 : 0.5);
      if (ce.role === 'driver') driverCost += base; else paCost += base;
    }
  }
  const cost = round2(driverCost + paCost + other);
  return { date, contracts_operating: operating, income: round2(income), driver_cost: round2(driverCost), pa_cost: round2(paCost), other_costs: round2(other), total_cost: cost, gross_profit: round2(income - cost), margin: income > 0 ? round2((income - cost) / income * 100) : 0 };
}

module.exports = { profitability, expectedDaily, aggregate };
