'use strict';
const db = require('../db');

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value + 'T00:00:00Z'))
    && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}
async function list(org) {
  const rows = await db.all('SELECT * FROM school_holidays WHERE organisation_id = ? ORDER BY start_date DESC, id DESC', [org]);
  const links = await db.all(`SELECT hs.*, s.name FROM school_holiday_schools hs
    JOIN schools s ON s.id = hs.school_id AND s.organisation_id = hs.organisation_id
    WHERE hs.organisation_id = ? ORDER BY s.name`, [org]);
  return rows.map(row => ({ ...row, schools: links.filter(link => link.holiday_id === row.id).map(link => ({ id: link.school_id, name: link.name })) }));
}
async function save(org, user, body, id = null) {
  const name = String(body.name || '').trim();
  if (!name || name.length > 200) throw new Error('Enter a holiday name of up to 200 characters.');
  if (!validDate(body.start_date) || !validDate(body.end_date) || body.end_date < body.start_date) throw new Error('Enter valid dates with the last day on or after the first day.');
  const all = body.all_schools === true || body.all_schools === 1;
  const ids = Array.isArray(body.school_ids) ? [...new Set(body.school_ids.map(Number))] : [];
  if (!all && (!ids.length || ids.some(value => !Number.isInteger(value) || value <= 0))) throw new Error('Choose at least one school or select all schools.');
  if (!all) {
    const schools = await db.all('SELECT id FROM schools WHERE organisation_id = ?', [org]);
    if (ids.some(id => !schools.some(s => s.id === id))) throw new Error('One of the selected schools was not found.');
  }
  return db.transaction(async tx => {
    const data = { name, start_date: body.start_date, end_date: body.end_date, all_schools: all ? 1 : 0, note: String(body.note || '').trim() };
    if (id) {
      if (!await tx.get('SELECT id FROM school_holidays WHERE organisation_id = ? AND id = ?', [org, id])) throw new Error('School holiday not found');
      await db.update('school_holidays', id, data, Object.keys(data), tx, org);
      await tx.run('DELETE FROM school_holiday_schools WHERE organisation_id = ? AND holiday_id = ?', [org, id]);
    } else id = await db.insert('school_holidays', { ...data, created_by: user.name }, [...Object.keys(data), 'created_by'], tx, org);
    if (!all) for (const schoolId of ids) await db.insert('school_holiday_schools', { holiday_id: id, school_id: schoolId }, ['holiday_id', 'school_id'], tx, org);
    await tx.run(`INSERT INTO audit_log (organisation_id, user_name, entity_type, entity_id, entity_label, action, summary)
      VALUES (?,?,?,?,?,?,?)`, [org, user.name, 'school_holidays', id, name, 'holiday', `Saved ${name}: ${data.start_date} to ${data.end_date}; ${all ? 'all schools' : 'schools ' + ids.join(', ')}; no staff pay or council income`]);
    return id;
  });
}
async function remove(org, user, id) {
  return db.transaction(async tx => {
    const row = await tx.get('SELECT * FROM school_holidays WHERE organisation_id = ? AND id = ?', [org, id]);
    if (!row) throw new Error('School holiday not found');
    await tx.run('DELETE FROM school_holiday_schools WHERE organisation_id = ? AND holiday_id = ?', [org, id]);
    await tx.run('DELETE FROM school_holidays WHERE organisation_id = ? AND id = ?', [org, id]);
    await tx.run(`INSERT INTO audit_log (organisation_id, user_name, entity_type, entity_id, entity_label, action, summary)
      VALUES (?,?,?,?,?,?,?)`, [org, user.name, 'school_holidays', id, row.name, 'delete', `Cancelled ${row.name}: ${row.start_date} to ${row.end_date}`]);
  });
}
// Expand only the requested dates. No per-contract copies to become stale when
// a contract is added or a holiday is changed; all consumers use school_closed.
async function exceptions(org, from, to) {
  const rows = await db.all(`SELECT h.*, s.id AS school_id FROM school_holidays h
    JOIN schools s ON s.organisation_id = h.organisation_id
    WHERE h.organisation_id = ? AND h.start_date <= ? AND h.end_date >= ?
      AND (h.all_schools = 1 OR EXISTS (SELECT 1 FROM school_holiday_schools hs
        WHERE hs.organisation_id = h.organisation_id AND hs.holiday_id = h.id AND hs.school_id = s.id))`, [org, to, from]);
  const result = [];
  for (const row of rows) {
    const end = row.end_date < to ? row.end_date : to;
    let date = row.start_date > from ? row.start_date : from;
    while (date <= end) {
      result.push({ id: `holiday-${row.id}-${row.school_id}-${date}`, holiday_id: row.id,
        type: 'school_closed', date, school_id: row.school_id, contract_id: null, leg: 'DAY',
        trip_seq: null, note: row.name + (row.note ? ': ' + row.note : ''), created_by: row.created_by });
      if (date === end) break;
      const next = new Date(date + 'T00:00:00Z'); next.setUTCDate(next.getUTCDate() + 1); date = next.toISOString().slice(0, 10);
    }
  }
  return result;
}
async function review(org, row) {
  if (!row) return [];
  const invoices = await db.get(`SELECT COUNT(*) AS n FROM invoices i WHERE i.organisation_id = ?
    AND i.status <> 'void' AND i.period_from <= ? AND i.period_to >= ?
    AND (? = 1 OR i.contract_id IN (SELECT c.id FROM contracts c WHERE c.organisation_id = ? AND c.school_id IN
      (SELECT school_id FROM school_holiday_schools WHERE organisation_id = ? AND holiday_id = ?)))`,
  [org, row.end_date, row.start_date, row.all_schools, org, org, row.id]);
  // Payment records may be unallocated to a contract. Flag the period rather
  // than silently rewriting historical payments or payroll snapshots.
  const payments = await db.get('SELECT COUNT(*) AS n FROM payments WHERE organisation_id = ? AND work_date >= ? AND work_date <= ?', [org, row.start_date, row.end_date]);
  const payroll = await db.get('SELECT COUNT(*) AS n FROM payroll_runs WHERE organisation_id = ? AND from_date <= ? AND to_date >= ?', [org, row.end_date, row.start_date]);
  return [Number(invoices.n) ? 'Issued invoices overlap this holiday. Review and correct them separately; saved invoices have not been changed.' : null,
    Number(payments.n) || Number(payroll.n) ? 'Payments or payroll already exist in these dates. Review them separately; recorded payments have not been changed.' : null].filter(Boolean);
}
module.exports = { list, save, remove, exceptions, review };
