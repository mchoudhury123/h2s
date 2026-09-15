'use strict';
// Dashboard figures and operational alerts. Every figure carries a drill-down link.
const { all, get } = require('../db');
const cal = require('./calendar');
const compliance = require('./compliance');
const finance = require('./finance');

async function dashboard(date) {
  const today = date || cal.today();

  // One query for all the headline counts, rather than eight round trips.
  const counts = await get(`SELECT
      (SELECT COUNT(*) FROM contracts WHERE status = 'active') AS contracts,
      (SELECT COUNT(*) FROM children WHERE status = 'active') AS children,
      (SELECT COUNT(*) FROM staff WHERE type = 'driver' AND status = 'active') AS drivers,
      (SELECT COUNT(*) FROM staff WHERE type = 'pa' AND status = 'active') AS pas,
      (SELECT COUNT(*) FROM staff WHERE type = 'driver' AND status = 'pool') AS pool_drivers,
      (SELECT COUNT(*) FROM staff WHERE type = 'pa' AND status = 'pool') AS pool_pas,
      (SELECT COUNT(DISTINCT school_id) FROM contracts WHERE status = 'active' AND school_id IS NOT NULL) AS schools,
      (SELECT COUNT(DISTINCT council_id) FROM contracts WHERE status = 'active' AND council_id IS NOT NULL) AS councils`);
  for (const k of Object.keys(counts)) counts[k] = Number(counts[k]);

  const day = await cal.dayOverview(today);
  const operatingToday = day.items.length;
  const absencesToday = [];
  const coversToday = [];
  for (const item of day.items) {
    for (const ex of item.exceptions.filter(e => e.type === 'staff_absence')) {
      const rec = { contract_id: item.contract_id, code: item.code, role: ex.role, leg: ex.leg, staff_name: ex.staff_name, cover_name: ex.cover_name, cover_pay: ex.cover_pay, paid_immediately: !!ex.paid_immediately };
      absencesToday.push(rec);
      if (ex.cover_staff_id) coversToday.push(rec);
    }
  }
  const childAbsencesToday = day.items.reduce((a, i) => a + i.exceptions.filter(e => e.type === 'child_absence').length, 0);
  const notOperatingToday = day.items.filter(i => !i.operated);

  // Staffing gaps. Pending contracts count too: they need staffing before their start date.
  const noDriver = await all(`SELECT c.id, c.code, c.name, c.status, c.start_date, s.name AS school_name
    FROM contracts c LEFT JOIN schools s ON s.id = c.school_id
    WHERE c.status IN ('active','pending') AND c.driver_id IS NULL ORDER BY c.status, c.code`);
  const noPa = await all(`SELECT c.id, c.code, c.name, c.status, c.start_date, s.name AS school_name
    FROM contracts c LEFT JOIN schools s ON s.id = c.school_id
    WHERE c.status IN ('active','pending') AND c.requires_pa = 1 AND c.pa_id IS NULL ORDER BY c.status, c.code`);
  const noVehicle = await all(`SELECT c.id, c.code, c.status FROM contracts c
    WHERE c.status = 'active' AND c.vehicle_id IS NULL ORDER BY c.code`);

  // Compliance, batched into two queries for the whole workforce.
  const activeStaff = await all("SELECT id, type, first_name, last_name, status FROM staff WHERE status IN ('active','pool')");
  const complianceMap = await compliance.complianceForMany(activeStaff);
  const statuses = { green: [], amber: [], red: [] };
  for (const s of activeStaff) {
    const c = complianceMap.get(s.id);
    statuses[c.status].push({
      id: s.id, name: `${s.first_name} ${s.last_name}`, type: s.type, status: s.status,
      problems: c.items.filter(i => i.status !== 'green').map(i => `${i.doc_type}: ${i.reason}`),
    });
  }
  const expiring = await compliance.expiringDocuments(undefined, true);

  const soon = cal.addDays(today, 60);
  const endingSoon = await all(`SELECT id, code, name, end_date FROM contracts
    WHERE status = 'active' AND end_date IS NOT NULL AND end_date <= ? AND end_date >= ? ORDER BY end_date`, [soon, today]);

  // Finances for today, this week and this month.
  const weekStart = cal.addDays(today, -((cal.dow(today) + 6) % 7));
  const weekEnd = cal.addDays(weekStart, 6);
  const monthStart = today.slice(0, 8) + '01';
  const monthEnd = cal.addDays(nextMonth(monthStart), -1);
  const daily = await finance.expectedDaily(today);
  const week = (await finance.profitability({ from: weekStart, to: weekEnd })).totals;
  const month = (await finance.profitability({ from: monthStart, to: monthEnd })).totals;

  const alerts = [];
  for (const c of noDriver) alerts.push({ level: c.status === 'active' ? 'red' : 'amber', category: 'Staffing', text: `${c.code} has no driver assigned${c.status === 'pending' ? ` (starts ${c.start_date ? compliance.ukDate(c.start_date) : 'soon'})` : ''}`, href: `#/contracts/${c.id}` });
  for (const c of noPa) alerts.push({ level: c.status === 'active' ? 'red' : 'amber', category: 'Staffing', text: `${c.code} requires a PA but none is assigned${c.status === 'pending' ? ` (starts ${c.start_date ? compliance.ukDate(c.start_date) : 'soon'})` : ''}`, href: `#/contracts/${c.id}` });
  for (const s of statuses.red) alerts.push({ level: 'red', category: 'Compliance', text: `${s.name} (${s.type.toUpperCase()}) — ${s.problems[0] || 'compliance failure'}`, href: `#/staff/${s.id}` });
  for (const d of expiring.filter(e => e.status === 'amber')) alerts.push({ level: 'amber', category: 'Document', text: `${d.entity_label}: ${d.doc_type} expires ${compliance.ukDate(d.expiry_date)} (${d.days_left} ${d.days_left === 1 ? 'day' : 'days'})`, href: linkForDoc(d) });
  for (const a of absencesToday.filter(a => !a.cover_name)) alerts.push({ level: 'red', category: 'Cover needed', text: `${a.code}: ${a.role === 'driver' ? 'Driver' : 'PA'} ${a.staff_name || ''} absent ${a.leg} with no cover`, href: `#/calendar?contract=${a.contract_id}&date=${today}` });
  for (const c of endingSoon) alerts.push({ level: 'amber', category: 'Contract', text: `${c.code} ends ${compliance.ukDate(c.end_date)}`, href: `#/contracts/${c.id}` });
  for (const c of noVehicle) alerts.push({ level: 'amber', category: 'Vehicle', text: `${c.code} has no vehicle recorded`, href: `#/contracts/${c.id}` });
  alerts.sort((a, b) => (a.level === b.level ? 0 : a.level === 'red' ? -1 : 1));

  return {
    date: today,
    counts,
    today: {
      operating: operatingToday,
      not_operating: notOperatingToday.map(i => ({ contract_id: i.contract_id, code: i.code, reasons: i.summary })),
      staff_absences: absencesToday,
      covers: coversToday,
      child_absences: childAbsencesToday,
      items: day.items.map(i => ({ contract_id: i.contract_id, code: i.code, summary: i.summary, operated: i.operated, legs: { AM: i.legs.AM.status, PM: i.legs.PM.status }, driver: i.legs.AM.driver, pa: i.legs.AM.pa, children: i.children.length })),
    },
    gaps: { no_driver: noDriver, no_pa: noPa, no_vehicle: noVehicle, ending_soon: endingSoon },
    compliance: { green: statuses.green.length, amber: statuses.amber.length, red: statuses.red.length, amber_list: statuses.amber, red_list: statuses.red, expiring },
    finance: { today: daily, week: { ...week, from: weekStart, to: weekEnd }, month: { ...month, from: monthStart, to: monthEnd } },
    alerts,
  };
}

function linkForDoc(d) {
  if (d.entity_type === 'staff') return `#/staff/${d.entity_id}`;
  if (d.entity_type === 'vehicle') return d.vehicle_driver_id ? `#/staff/${d.vehicle_driver_id}` : '#/vehicles';
  if (d.entity_type === 'child') return `#/children/${d.entity_id}`;
  if (d.entity_type === 'contract') return `#/contracts/${d.entity_id}`;
  if (d.entity_type === 'school') return `#/schools/${d.entity_id}`;
  return '#/documents';
}

function nextMonth(d) {
  const [y, m] = d.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

module.exports = { dashboard };
