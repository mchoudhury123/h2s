'use strict';
// Audit trail: field-level change history for every important record.
const { all, run } = require('../db');

const LABELS = {
  driver_id: 'Driver', pa_id: 'PA', school_id: 'School', contract_id: 'Contract', council_id: 'Council',
  vehicle_id: 'Vehicle', income_per_day: 'Contract income/day', driver_pay_per_day: 'Driver pay/day',
  pa_pay_per_day: 'PA pay/day', days_of_week: 'Operating days', status: 'Status',
};

function logChange(user, entityType, entityId, entityLabel, field, oldValue, newValue, summary) {
  run(`INSERT INTO audit_log (user_name, entity_type, entity_id, entity_label, action, field, old_value, new_value, summary)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    [user ? user.name : 'system', entityType, entityId, entityLabel || null, 'update', field, str(oldValue), str(newValue), summary || null]);
}
function logAction(user, entityType, entityId, entityLabel, action, summary) {
  run(`INSERT INTO audit_log (user_name, entity_type, entity_id, entity_label, action, summary) VALUES (?,?,?,?,?,?)`,
    [user ? user.name : 'system', entityType, entityId, entityLabel || null, action, summary || null]);
}
/** Diff an existing row against an incoming patch and log each changed field. */
function logDiff(user, entityType, entityId, entityLabel, before, patch, columns, resolve) {
  for (const col of columns) {
    if (patch[col] === undefined) continue;
    const oldV = before ? before[col] : null;
    const newV = patch[col] === '' ? null : patch[col];
    if (String(oldV ?? '') === String(newV ?? '')) continue;
    const label = LABELS[col] || col.replace(/_/g, ' ');
    const o = resolve ? resolve(col, oldV) : oldV;
    const n = resolve ? resolve(col, newV) : newV;
    logChange(user, entityType, entityId, entityLabel, label, o, n, `${label} changed from "${o ?? '(empty)'}" to "${n ?? '(empty)'}"`);
  }
}
function str(v) { return v === null || v === undefined ? null : String(v); }

function history(entityType, entityId, limit = 100) {
  return all('SELECT * FROM audit_log WHERE entity_type = ? AND entity_id = ? ORDER BY id DESC LIMIT ?', [entityType, entityId, limit]);
}
function recent(filters = {}, limit = 200) {
  let sql = 'SELECT * FROM audit_log WHERE 1=1';
  const p = [];
  if (filters.entity_type) { sql += ' AND entity_type = ?'; p.push(filters.entity_type); }
  if (filters.user) { sql += ' AND user_name LIKE ?'; p.push('%' + filters.user + '%'); }
  if (filters.from) { sql += ' AND created_at >= ?'; p.push(filters.from); }
  if (filters.to) { sql += ' AND created_at <= ?'; p.push(filters.to + ' 23:59:59'); }
  sql += ' ORDER BY id DESC LIMIT ?'; p.push(limit);
  return all(sql, p);
}

module.exports = { logChange, logAction, logDiff, history, recent, LABELS };
