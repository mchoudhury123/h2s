'use strict';
// Compliance traffic-light engine. Status is always CALCULATED from documents, never stored.
const { all, getSetting, inClause } = require('../db');
const { today, addDays } = require('./calendar');

const DEFAULT_REQUIRED = {
  driver: ['Driving Licence', 'Driver Badge', 'DBS', 'Vehicle Insurance', 'MOT', 'Vehicle Licence', 'Safeguarding Training'],
  pa: ['DBS', 'Safeguarding Training', 'PA Training'],
};
const DOC_TYPES = {
  staff: ['Driving Licence', 'Driver Badge', 'DBS', 'Vehicle Insurance', 'MOT', 'Vehicle Licence', 'Safeguarding Training', 'PA Training', 'First Aid', 'Right to Work', 'Medical', 'Contract of Employment', 'Other'],
  vehicle: ['MOT', 'Vehicle Insurance', 'Vehicle Licence', 'V5C', 'Service Record', 'Other'],
  child: ['Council Award Letter', 'Care Plan', 'Medical Plan', 'Risk Assessment', 'Consent Form', 'Photo ID', 'Other'],
  contract: ['Council Contract', 'Purchase Order', 'Route Sheet', 'Risk Assessment', 'Other'],
  school: ['Term Dates', 'Contact Sheet', 'Other'],
};

async function amberDays() { return Number(await getSetting('amber_days', 30)) || 30; }
async function requiredDocs(type) {
  const v = await getSetting('required_docs_' + type);
  if (v) { try { const arr = JSON.parse(v); if (Array.isArray(arr) && arr.length) return arr; } catch (_) {} }
  return DEFAULT_REQUIRED[type] || [];
}

function docStatus(doc, amber, ref) {
  if (!doc) return 'red';
  if (doc.status === 'invalid') return 'red';
  if (!doc.expiry_date) return 'green';
  if (doc.expiry_date < ref) return 'red';
  if (doc.expiry_date <= addDays(ref, amber)) return 'amber';
  return 'green';
}

function daysBetween(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 86400000); }
function ukDate(s) { if (!s) return ''; const [y, m, d] = String(s).slice(0, 10).split('-'); return `${d}/${m}/${y}`; }

/** Works out one staff member's picture from documents already in memory. */
function evaluate(docs, required, amber, ref) {
  const items = required.map(docType => {
    const candidates = docs.filter(d => d.doc_type === docType && d.status !== 'superseded');
    // best doc = the healthiest one, and among equals the one that lasts longest
    let best = null;
    const rank = { green: 0, amber: 1, red: 2 };
    for (const d of candidates) {
      if (!best) { best = d; continue; }
      const bs = docStatus(best, amber, ref), ds = docStatus(d, amber, ref);
      if (rank[ds] < rank[bs]) best = d;
      else if (rank[ds] === rank[bs] && (d.expiry_date || '9999') > (best.expiry_date || '9999')) best = d;
    }
    const status = docStatus(best, amber, ref);
    let reason = 'Valid';
    if (!best) reason = 'Missing';
    else if (best.status === 'invalid') reason = 'Marked invalid';
    else if (status === 'red') reason = `Expired ${ukDate(best.expiry_date)}`;
    else if (status === 'amber') { const n = daysBetween(ref, best.expiry_date); reason = `Expires ${ukDate(best.expiry_date)} (${n} ${n === 1 ? 'day' : 'days'})`; }
    else if (best.expiry_date) reason = `Expires ${ukDate(best.expiry_date)}`;
    return { doc_type: docType, status, reason, document: best, days_left: best && best.expiry_date ? daysBetween(ref, best.expiry_date) : null };
  });
  const other = docs.filter(d => !required.includes(d.doc_type));
  const overall = items.some(i => i.status === 'red') ? 'red' : items.some(i => i.status === 'amber') ? 'amber' : 'green';
  return { status: overall, items, other_documents: other, amber_days: amber };
}

/** Full compliance picture for one staff member (drivers include their vehicles' documents). */
async function staffCompliance(staffId, type) {
  const amber = await amberDays();
  const ref = today();
  const docs = await all(
    `SELECT * FROM documents
     WHERE (entity_type = 'staff' AND entity_id = ?)
        OR (entity_type = 'vehicle' AND entity_id IN (SELECT id FROM vehicles WHERE driver_id = ? AND active = 1))
     ORDER BY expiry_date DESC, id DESC`, [staffId, staffId]);
  return evaluate(docs, await requiredDocs(type), amber, ref);
}

/**
 * Compliance for many staff in two queries rather than two per person.
 * Used by the dashboard, the staff lists and the compliance centre, where the
 * per-person version would otherwise mean dozens of round trips.
 */
async function complianceForMany(staffRows) {
  const out = new Map();
  if (!staffRows.length) return out;
  const amber = await amberDays();
  const ref = today();
  const required = { driver: await requiredDocs('driver'), pa: await requiredDocs('pa') };
  const ids = staffRows.map(s => s.id);
  const list = inClause(ids);

  const staffDocs = await all(`SELECT * FROM documents WHERE entity_type = 'staff' AND entity_id IN (${list})`, ids);
  const vehicleDocs = await all(
    `SELECT d.*, v.driver_id FROM documents d
     JOIN vehicles v ON v.id = d.entity_id
     WHERE d.entity_type = 'vehicle' AND v.active = 1 AND v.driver_id IN (${list})`, ids);

  const byStaff = new Map(ids.map(id => [id, []]));
  for (const d of staffDocs) byStaff.get(d.entity_id)?.push(d);
  for (const d of vehicleDocs) byStaff.get(d.driver_id)?.push(d);

  for (const s of staffRows) {
    out.set(s.id, evaluate(byStaff.get(s.id) || [], required[s.type] || [], amber, ref));
  }
  return out;
}

/** All documents expiring within N days, or already expired, across every record type. */
async function expiringDocuments(days, includeExpired = true) {
  const window = days === undefined ? await amberDays() : days;
  const ref = today();
  const limit = addDays(ref, window);
  const rows = await all(`SELECT d.*,
      CASE d.entity_type
        WHEN 'staff' THEN (SELECT first_name || ' ' || last_name FROM staff WHERE id = d.entity_id)
        WHEN 'vehicle' THEN (SELECT v.registration || ' (' || COALESCE((SELECT first_name || ' ' || last_name FROM staff WHERE id = v.driver_id), 'no driver') || ')' FROM vehicles v WHERE v.id = d.entity_id)
        WHEN 'child' THEN (SELECT first_name || ' ' || last_name FROM children WHERE id = d.entity_id)
        WHEN 'contract' THEN (SELECT code FROM contracts WHERE id = d.entity_id)
        WHEN 'school' THEN (SELECT name FROM schools WHERE id = d.entity_id)
      END AS entity_label,
      CASE d.entity_type WHEN 'vehicle' THEN (SELECT driver_id FROM vehicles WHERE id = d.entity_id) END AS vehicle_driver_id,
      CASE d.entity_type WHEN 'staff' THEN (SELECT type FROM staff WHERE id = d.entity_id) END AS staff_type
    FROM documents d
    WHERE d.status = 'valid' AND d.expiry_date IS NOT NULL AND d.expiry_date <= ?
      ${includeExpired ? '' : 'AND d.expiry_date >= ?'}
    ORDER BY d.expiry_date`, includeExpired ? [limit] : [limit, ref]);
  return rows.map(r => ({ ...r, days_left: daysBetween(ref, r.expiry_date), status: r.expiry_date < ref ? 'red' : 'amber' }));
}

module.exports = {
  DOC_TYPES, DEFAULT_REQUIRED, amberDays, requiredDocs, docStatus,
  staffCompliance, complianceForMany, expiringDocuments, daysBetween, ukDate,
};
