'use strict';
// Profitability: council income from operated and cancelled runs minus real costs.
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
  const ctx = await cal.loadContext(orgId, from, to, where, params);
  const { contracts, childMap, exceptions } = ctx;
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
      const day = cal.evaluateContractDay(c, d, childMap[c.id] || [], exceptions, ctx);
      if (!day.trips.length) continue;
      scheduled += day.planned_trips;
      income += day.income;
      otherCosts += day.other_costs;
      journeys += day.operated_trips;
      if (day.operated) daysOperated++;
      series.push({ date: d, income: day.income, journeys: day.operated_trips });
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
  const ctx = await cal.loadContext(orgId, date, date, " AND c.status = 'active'");
  let income = 0, driverCost = 0, paCost = 0, other = 0, operating = 0, trips = 0;
  for (const c of ctx.contracts) {
    const day = cal.evaluateContractDay(c, date, ctx.childMap[c.id] || [], ctx.exceptions, ctx);
    if (!day.trips.length) continue;
    operating++;
    trips += day.operated_trips;
    income += day.income;
    other += day.other_costs;
    for (const t of day.trips) {
      if (t.driver && t.driver.pay) driverCost += t.driver.pay;
      if (t.pa && t.pa.pay) paCost += t.pa.pay;
    }
    for (const ce of day.exceptions.filter(e => e.type === 'staff_absence' && e.cover_staff_id)) {
      const base = cal.coverAmount(day, ce);
      if (ce.role === 'driver') driverCost += base; else paCost += base;
    }
  }
  const cost = round2(driverCost + paCost + other);
  return {
    date, contracts_operating: operating, journeys: trips,
    income: round2(income), driver_cost: round2(driverCost), pa_cost: round2(paCost),
    other_costs: round2(other), total_cost: cost, gross_profit: round2(income - cost),
    margin: income > 0 ? round2((income - cost) / income * 100) : 0,
  };
}

module.exports = { profitability, expectedDaily, aggregate };
