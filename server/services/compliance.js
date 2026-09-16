'use strict';
// Compliance traffic-light engine. Status is always CALCULATED from documents, never stored.
const { all, getSetting, inClause } = require('../db');
const { today, addDays } = require('./calendar');

const DEFAULT_REQUIRED = {
  driver: ['Driving Licence', 'Driver Badge', 'DBS', 'Vehicle Insurance', 'MOT', 'Vehicle Licence', 'Safeguarding Training', 'Selfie picture', 'GDPR'],
  pa: ['DBS', 'Safeguarding Training', 'PA Training', 'Selfie picture', 'GDPR'],
};
const DOC_TYPES = {
  staff: ['Driving Licence', 'Driver Badge', 'Home to School ID Badge', 'DBS', 'Vehicle Insurance', 'MOT', 'Vehicle Licence', 'Safeguarding Training', 'PA Training', 'First Aid', 'GDPR', 'Right to Work', 'Medical', 'Contract of Employment', 'Selfie picture', 'Other'],
  vehicle: ['MOT', 'Vehicle Insurance', 'Vehicle Licence', 'V5C', 'Service Record', 'Other'],
  child: ['Council Award Letter', 'Care Plan', 'Medical Plan', 'Risk Assessment', 'Consent Form', 'Photo ID', 'Other'],
  contract: ['Council Contract', 'Purchase Order', 'Route Sheet', 'Risk Assessment', 'Other'],
  school: ['Term Dates', 'Contact Sheet', 'Other'],
};

async function amberDays(orgId) { return Number(await getSetting(orgId, 'amber_days', 30)) || 30; }
async function requiredDocs(orgId, type) {
  const v = await getSetting(orgId, 'required_docs_' + type);
  if (v) { try { const arr = JSON.parse(v); if (Array.isArray(arr) && arr.length) return ['driver', 'pa'].includes(type) ? [...new Set([...arr, 'Selfie picture', 'GDPR'])] : arr; } catch (_) {} }
  return DEFAULT_REQUIRED[type] || [];
}

function validIssueDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function docStatus(doc, amber, ref) {
  if (doc && doc.doc_type === 'GDPR' && !validIssueDate(doc.issue_date)) return 'red';
  if (!doc) return 'red';
  if (doc.doc_type === 'Safeguarding Training' && !(doc.has_file || doc.stored_name || doc.file_data)) return 'red';
  if (doc.doc_type === 'Selfie picture' && (!(doc.has_file || doc.stored_name || doc.file_data) || !String(doc.mime_type || '').startsWith('image/'))) return 'red';
  if (doc.status === 'invalid') return 'red';
  if (doc.status === 'needs_review') return doc.expiry_date && doc.expiry_date < ref ? 'red' : 'amber';
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
    const safeguarding = docType === 'Safeguarding Training';
    const attached = safeguarding ? candidates.filter(d => d.has_file || d.stored_name || d.file_data)
      .sort((a, b) => rank[docStatus(a, amber, ref)] - rank[docStatus(b, amber, ref)] || (b.expiry_date || '9999').localeCompare(a.expiry_date || '9999')) : [];
    const certificates = attached.slice(0, 3);
    if (safeguarding && certificates.length) best = certificates[certificates.length - 1];
    const missingCertificates = safeguarding && certificates.length < 3;
    const status = missingCertificates ? 'red' : docStatus(best, amber, ref);
    let reason = safeguarding ? '3 of 3 safeguarding certificates valid' : 'Valid';
    if (missingCertificates) reason = certificates.length + ' of 3 safeguarding certificates uploaded; ' + (3 - certificates.length) + ' missing';
    else if (!best) reason = 'Missing';
    else if (best.doc_type === 'GDPR' && !validIssueDate(best.issue_date)) reason = 'Issue date required';
    else if (best.status === 'invalid') reason = 'Marked invalid';
    else if (best.status === 'needs_review') reason = 'Auto input: details need review';
    else if (best.doc_type === 'Selfie picture' && status === 'red' && (!best.expiry_date || best.expiry_date >= ref)) reason = 'Selfie image required';
    else if (status === 'red') reason = `Expired ${ukDate(best.expiry_date)}`;
    else if (status === 'amber') { const n = daysBetween(ref, best.expiry_date); reason = `Expires ${ukDate(best.expiry_date)} (${n} ${n === 1 ? 'day' : 'days'})`; }
    else if (best.expiry_date) reason = `Expires ${ukDate(best.expiry_date)}`;
    else if (best.doc_type === 'GDPR') reason = `Issued ${ukDate(best.issue_date)}`;
    return { doc_type: docType, status, reason, document: best, ...(safeguarding ? { documents: certificates, uploaded_count: certificates.length, required_count: 3 } : {}), days_left: best && best.expiry_date ? daysBetween(ref, best.expiry_date) : null };
  });
  const other = docs.filter(d => !required.includes(d.doc_type));
  const overall = items.some(i => i.status === 'red') ? 'red' : items.some(i => i.status === 'amber') ? 'amber' : 'green';
  return { status: overall, items, other_documents: other, amber_days: amber };
}

/** Full compliance picture for one staff member (drivers include their vehicles' documents). */
async function staffCompliance(orgId, staffId, type) {
  const amber = await amberDays(orgId);
  const ref = today();
  const docs = await all(
    `SELECT id, organisation_id, entity_type, entity_id, doc_type, reference, vehicle_registration, file_name, stored_name,
       mime_type, size, upload_date, issue_date, expiry_date, status, notes, uploaded_by,
       CASE WHEN file_data IS NULL THEN 0 ELSE 1 END AS has_file
     FROM documents
     WHERE organisation_id = ?
       AND ((entity_type = 'staff' AND entity_id = ?)
         OR (entity_type = 'vehicle' AND entity_id IN
             (SELECT id FROM vehicles WHERE organisation_id = ? AND driver_id = ? AND active = 1)))
     ORDER BY expiry_date DESC, id DESC`, [orgId, staffId, orgId, staffId]);
  return evaluate(docs, await requiredDocs(orgId, type), amber, ref);
}

/**
 * Compliance for many staff in two queries rather than two per person.
 * Used by the dashboard, the staff lists and the compliance centre, where the
 * per-person version would otherwise mean dozens of round trips.
 */
async function complianceForMany(orgId, staffRows) {
  const out = new Map();
  if (!staffRows.length) return out;
  const amber = await amberDays(orgId);
  const ref = today();
  const required = { driver: await requiredDocs(orgId, 'driver'), pa: await requiredDocs(orgId, 'pa') };
  const ids = staffRows.map(s => s.id);
  const list = inClause(ids);

  const staffDocs = await all(
    `SELECT id, organisation_id, entity_type, entity_id, doc_type, reference, vehicle_registration, file_name, stored_name,
       mime_type, size, upload_date, issue_date, expiry_date, status, notes, uploaded_by,
       CASE WHEN file_data IS NULL THEN 0 ELSE 1 END AS has_file
     FROM documents WHERE organisation_id = ? AND entity_type = 'staff' AND entity_id IN (${list})`,
    [orgId, ...ids]);
  const vehicleDocs = await all(
    `SELECT d.id, d.organisation_id, d.entity_type, d.entity_id, d.doc_type, d.reference, d.vehicle_registration, d.file_name,
       d.stored_name, d.mime_type, d.size, d.upload_date, d.issue_date, d.expiry_date, d.status,
       d.notes, d.uploaded_by,
       CASE WHEN d.file_data IS NULL THEN 0 ELSE 1 END AS has_file,
       v.driver_id
     FROM documents d
     JOIN vehicles v ON v.id = d.entity_id
     WHERE d.organisation_id = ? AND d.entity_type = 'vehicle' AND v.active = 1 AND v.driver_id IN (${list})`,
    [orgId, ...ids]);

  const byStaff = new Map(ids.map(id => [id, []]));
  for (const d of staffDocs) byStaff.get(d.entity_id)?.push(d);
  for (const d of vehicleDocs) byStaff.get(d.driver_id)?.push(d);

  for (const s of staffRows) {
    out.set(s.id, evaluate(byStaff.get(s.id) || [], required[s.type] || [], amber, ref));
  }
  return out;
}

/** All documents expiring within N days, or already expired, across every record type. */
async function expiringDocuments(orgId, days, includeExpired = true) {
  const window = days === undefined ? await amberDays(orgId) : days;
  const ref = today();
  const limit = addDays(ref, window);
  const rows = await all(`SELECT d.id, d.organisation_id, d.entity_type, d.entity_id, d.doc_type,
      d.reference, d.vehicle_registration, d.file_name, d.stored_name, d.mime_type, d.size, d.upload_date, d.issue_date,
      d.expiry_date, d.status, d.notes, d.uploaded_by,
      CASE WHEN d.file_data IS NULL THEN 0 ELSE 1 END AS has_file,
      CASE d.entity_type
        WHEN 'staff' THEN (SELECT first_name || ' ' || last_name FROM staff WHERE id = d.entity_id AND organisation_id = d.organisation_id)
        WHEN 'vehicle' THEN (SELECT v.registration || ' (' || COALESCE((SELECT first_name || ' ' || last_name FROM staff WHERE id = v.driver_id), 'no driver') || ')' FROM vehicles v WHERE v.id = d.entity_id)
        WHEN 'child' THEN (SELECT first_name || ' ' || last_name FROM children WHERE id = d.entity_id AND organisation_id = d.organisation_id)
        WHEN 'contract' THEN (SELECT code FROM contracts WHERE id = d.entity_id AND organisation_id = d.organisation_id)
        WHEN 'school' THEN (SELECT name FROM schools WHERE id = d.entity_id AND organisation_id = d.organisation_id)
      END AS entity_label,
      CASE d.entity_type WHEN 'vehicle' THEN (SELECT driver_id FROM vehicles WHERE id = d.entity_id) END AS vehicle_driver_id,
      CASE d.entity_type WHEN 'staff' THEN (SELECT type FROM staff WHERE id = d.entity_id) END AS staff_type
    FROM documents d
    WHERE d.organisation_id = ? AND d.status = 'valid' AND d.expiry_date IS NOT NULL AND d.expiry_date <= ?
      ${includeExpired ? '' : 'AND d.expiry_date >= ?'}
    ORDER BY d.expiry_date`, includeExpired ? [orgId, limit] : [orgId, limit, ref]);
  return rows.map(r => ({ ...r, days_left: daysBetween(ref, r.expiry_date), status: r.expiry_date < ref ? 'red' : 'amber' }));
}

module.exports = {
  DOC_TYPES, DEFAULT_REQUIRED, amberDays, requiredDocs, docStatus, validIssueDate,
  staffCompliance, complianceForMany, expiringDocuments, daysBetween, ukDate,
};
