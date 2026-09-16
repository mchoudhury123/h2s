'use strict';
// Imports the Staff Records template. Workbook content is data only.
const fs = require('node:fs');
const path = require('node:path');
const db = require('../server/db');
const { complianceForMany } = require('../server/services/compliance');
const org = Number(process.argv[2]);
const apply = process.argv.includes('--apply');
const clean = s => String(s || '').trim().replace(/\s+/g, ' ');
const nameKey = s => clean(s).toLowerCase();
function date(value) {
  if (!/^\d{5}$/.test(value || '')) return null;
  return new Date(Date.UTC(1899, 11, 30) + Number(value) * 86400000).toISOString().slice(0, 10);
}
async function main() {
  if (!org) throw new Error('Provide an organisation id');
  const rows = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));
  const headers = rows.shift();
  if (headers.A !== 'Name' || headers.E !== 'Job role' || headers.F !== 'DBS number') throw new Error('Unexpected workbook columns');
  const organisation = await db.get('SELECT id,name FROM organisations WHERE id=?', [org]);
  if (!organisation) throw new Error('Unknown organisation');
  const existing = await db.all('SELECT * FROM staff WHERE organisation_id=?', [org]);
  const vehicles = await db.all('SELECT * FROM vehicles WHERE organisation_id=?', [org]);
  const seen = new Set();
  const planned = rows.filter(r => r.A).map(r => {
    const name = clean(r.A);
    const type = { driver: 'driver', 'passenger assistant': 'pa' }[nameKey(r.E)];
    if (!type) throw new Error(`Unknown role in row ${r.row}`);
    const phone = clean(r.B).replace(/[^\d+]/g, '').replace(/^7(\d{9})$/, '07$1');
    const key = nameKey(name);
    if (seen.has(key)) throw new Error(`Duplicate name in row ${r.row}`);
    seen.add(key);
    const matches = existing.filter(s => nameKey(`${s.first_name} ${s.last_name}`) === key || (s.dbs_number && s.dbs_number === r.F) || (s.phone && s.phone.replace(/\D/g, '').replace(/^44/, '0') === phone));
    if (matches.length) {
      if (matches.length === 1 && (matches[0].notes || '').includes(`Imported from Staff Records.xlsx, row ${r.row}.`)) return { skip: matches[0].id, type };
      throw new Error(`Existing staff match in row ${r.row}; reconcile before import`);
    }
    const issues = ['Provide home address/postcode, email and emergency contact name/telephone.', 'Confirm pay rate and current employment/availability status.', 'Provide supporting DBS, safeguarding and first-aid records and applicable validity/renewal dates.', 'Confirm whether a DBS risk assessment is required; spreadsheet records N.'];
    if (!/^\d{12}$/.test(r.F || '')) issues.push(`Verify DBS number: source value ${r.F || '(missing)'}; leading zeros may have been lost.`);
    if (!date(r.G)) issues.push(`Confirm DBS valid-from date: source value ${r.G || '(missing)'}.`);
    if (!r.S) issues.push('Confirm South Tyneside ID status.');
    if (type === 'driver') {
      issues.push('Confirm licensing authority and whether taxi licence number is a driver badge or vehicle licence reference.');
      issues.push('Provide driving licence, driver badge, vehicle insurance, MOT and vehicle licence evidence; confirm last MOT/service dates and wheelchair accessibility.');
      if (r.I === 'NGL68ZWG') issues.push('Verify vehicle registration NGL68ZWG as entered in the spreadsheet.');
    } else issues.push('Provide passenger assistant training evidence.');
    const source = Object.keys(headers).filter(k => k !== 'row').map(k => `${clean(headers[k])}: ${r[k] || '(not supplied)'}`).join('\n');
    const words = name.split(' ');
    const staff = { type, first_name: words.slice(0, -1).join(' '), last_name: words.at(-1), phone, start_date: date(r.C), dbs_number: r.F,
      notes: `ACTION REQUIRED\n${issues.map(i => '- ' + i).join('\n')}\n\nImported from Staff Records.xlsx, row ${r.row}.\nDBS valid from: ${date(r.G) || 'unconfirmed; see source below'}.\nSpreadsheet declarations have not been verified against supporting documents.\n\nSource record (dates retained as supplied, numeric dates are Excel serials):\n${source}` };
    if (!staff.first_name || !staff.start_date || !/^07\d{9}$/.test(phone)) throw new Error(`Invalid identity/contact/start date in row ${r.row}`);
    const vehicle = type === 'driver' && r.I ? { registration: r.I, seats: Number.parseInt(r.M, 10), notes: `Imported from Staff Records.xlsx, row ${r.row}. Taxi licence reference (classification unconfirmed): ${r.J || 'not supplied'}. ACTION REQUIRED: verify registration, passenger capacity, wheelchair accessibility, insurance, MOT, licence and servicing. Source vehicle type: ${r.M}.` } : null;
    if (vehicle && vehicles.some(v => nameKey(v.registration) === nameKey(vehicle.registration))) throw new Error(`Existing vehicle in row ${r.row}`);
    return { staff, vehicle, type };
  });
  console.log(JSON.stringify({ organisation: organisation.name, apply, drivers: planned.filter(p => p.type === 'driver').length, pas: planned.filter(p => p.type === 'pa').length, skipped: planned.filter(p => p.skip).length }));
  if (!apply) return;
  const backupDir = path.join(__dirname, '../data/backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(backupDir, `staff-import-before-${org}-${stamp}.json`), JSON.stringify({ organisation, existing, vehicles }, null, 2), { flag: 'wx' });
  const ids = await db.transaction(async tx => {
    const ids = [];
    for (const p of planned) {
      if (p.skip) { ids.push(p.skip); continue; }
      const id = await db.insert('staff', p.staff, Object.keys(p.staff), tx, org);
      ids.push(id);
      if (p.vehicle) await db.insert('vehicles', { ...p.vehicle, driver_id: id }, [...Object.keys(p.vehicle), 'driver_id'], tx, org);
      const audit = { user_name: 'Staff spreadsheet import', entity_type: 'staff', entity_id: id, entity_label: `${p.staff.first_name} ${p.staff.last_name}`, action: 'create', summary: 'Imported Staff Records.xlsx with source values and ACTION REQUIRED follow-up notes. Supporting compliance documents remain outstanding.' };
      await db.insert('audit_log', audit, Object.keys(audit), tx, org);
    }
    return ids;
  });
  const imported = (await db.all('SELECT * FROM staff WHERE organisation_id=?', [org])).filter(s => ids.includes(s.id));
  const compliance = await complianceForMany(org, imported);
  const flagged = imported.filter(s => compliance.get(s.id)?.status === 'red' && s.notes.startsWith('ACTION REQUIRED')).length;
  if (imported.length !== planned.length || flagged !== imported.length) throw new Error('Post-import count/action-required verification failed');
  console.log(JSON.stringify({ verifiedStaff: imported.length, actionRequired: flagged, staffIds: ids, totalStaff: existing.length + planned.filter(p => !p.skip).length }));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => db.close());
