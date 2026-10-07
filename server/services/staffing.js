'use strict';
// Who holds the driver and PA seats on a contract, on any date.
//
// A contract's driver_id and pa_id name the latest holder of each seat, which
// is what lists, search and the dashboard show. A handover is recorded as a
// dated change in contract_staff, and the journey engine asks this module who
// was in force on each date. So the outgoing driver keeps every day before
// the change, the incoming one is paid from it, and nothing already worked,
// paid or invoiced is rewritten.
//
// A contract with no recorded change behaves exactly as before: its driver_id
// and pa_id apply to every date.
const { all, get, run, insert, transaction, inClause } = require('../db');

const ROLES = ['driver', 'pa'];
// The opening row written the first time a seat changes hands, so the person
// who held it before the change keeps every earlier date.
const OPENING = '1900-01-01';
const OPENING_NOTE = 'Before any recorded change';
const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

function requireOrg(orgId) { if (!orgId) throw new Error('An organisation id is required'); }
function roleName(role) { return role === 'driver' ? 'driver' : 'PA'; }

/**
 * Every dated assignment for a set of contracts, newest first per role, with
 * the person's name. Returns a Map of contract id -> { driver: [], pa: [] }.
 */
async function loadStaffHistory(orgId, contractIds, client = null) {
  requireOrg(orgId);
  const out = new Map(contractIds.map(id => [id, { driver: [], pa: [] }]));
  const list = inClause(contractIds);
  if (!list) return out;
  const rows = await (client || { all }).all(
    `SELECT cs.id, cs.contract_id, cs.role, cs.staff_id, cs.effective_from, cs.note, cs.created_by,
            s.first_name || ' ' || s.last_name AS staff_name
     FROM contract_staff cs
     LEFT JOIN staff s ON s.id = cs.staff_id
     WHERE cs.organisation_id = ? AND cs.contract_id IN (${list})
     ORDER BY cs.contract_id, cs.role, cs.effective_from DESC`, [orgId, ...contractIds]);
  for (const r of rows) {
    r.effective_from = String(r.effective_from).slice(0, 10);
    out.get(r.contract_id)[r.role].push(r);
  }
  return out;
}

/** The assignment in force on a date: the newest starting on or before it, else the oldest. */
function versionOn(versions, date) {
  if (!versions || !versions.length) return null;
  for (const v of versions) if (v.effective_from <= date) return v;   // newest first
  return versions[versions.length - 1];
}

/**
 * Who holds a role on a contract on a date. With no recorded change this is
 * the contract's own driver_id or pa_id. Returns { staff_id, staff_name, change }.
 */
function assignedOn(contract, role, date) {
  const history = contract.staff_history ? contract.staff_history[role] : null;
  const v = versionOn(history, date);
  if (!v) {
    return role === 'driver'
      ? { staff_id: contract.driver_id || null, staff_name: contract.driver_id ? contract.driver_name : null, change: null }
      : { staff_id: contract.pa_id || null, staff_name: contract.pa_id ? contract.pa_name : null, change: null };
  }
  return { staff_id: v.staff_id || null, staff_name: v.staff_id ? v.staff_name : null, change: v };
}

/** Does this person hold, or have they ever held, a seat on this contract? */
function everAssigned(contract, staffId) {
  if (contract.driver_id === staffId || contract.pa_id === staffId) return true;
  const h = contract.staff_history;
  return !!h && ROLES.some(role => h[role].some(v => v.staff_id === staffId));
}

function addDays(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/**
 * What the contract page says about one role on a date: who is in force,
 * who is next, who came before, and how many changes are recorded.
 */
function summary(contract, history, date) {
  const out = {};
  for (const role of ROLES) {
    const versions = (history && history[role]) || [];
    const inForce = versionOn(versions, date);
    const later = versions.filter(v => v.effective_from > date);
    const upcoming = later.length ? later[later.length - 1] : null;   // the soonest
    const idx = inForce ? versions.indexOf(inForce) : -1;
    const previous = idx >= 0 && idx + 1 < versions.length ? versions[idx + 1] : null;
    const current = assignedOn({ ...contract, staff_history: history }, role, date);
    out[role] = {
      staff_id: current.staff_id, staff_name: current.staff_name,
      since: inForce && inForce.effective_from > OPENING ? inForce.effective_from : null,
      upcoming: upcoming ? { id: upcoming.id, staff_id: upcoming.staff_id, staff_name: upcoming.staff_id ? upcoming.staff_name : null, effective_from: upcoming.effective_from } : null,
      previous: previous ? { id: previous.id, staff_id: previous.staff_id, staff_name: previous.staff_id ? previous.staff_name : null, until: addDays(inForce.effective_from, -1) } : null,
      changes: versions.filter(v => v.effective_from > OPENING).length,
    };
  }
  return out;
}

/** Points the contract's own driver_id / pa_id at the latest recorded holder. */
async function syncCurrent(orgId, contractId, role, tx) {
  const newest = await tx.get(
    `SELECT staff_id FROM contract_staff WHERE organisation_id = ? AND contract_id = ? AND role = ?
     ORDER BY effective_from DESC LIMIT 1`, [orgId, contractId, role]);
  if (!newest) return;
  const column = role === 'driver' ? 'driver_id' : 'pa_id';
  await tx.run(`UPDATE contracts SET ${column} = ? WHERE id = ? AND organisation_id = ?`,
    [newest.staff_id || null, contractId, orgId]);
}

/**
 * Records a handover: from `effective_from` the seat is held by `staff_id`
 * (null for nobody). The first change on a seat also writes an opening row
 * for whoever held it before, so earlier dates keep their person. A change
 * already recorded for the same date is replaced.
 */
async function recordChange(orgId, contract, { role, staff_id, effective_from, note, created_by }) {
  requireOrg(orgId);
  if (!ROLES.includes(role)) throw new Error('Choose whether the driver or the PA is changing');
  const from = String(effective_from || '').slice(0, 10);
  if (!DATE_RX.test(from)) throw new Error('Choose the date the change takes effect');
  const staffId = staff_id ? Number(staff_id) : null;
  if (staffId) {
    const person = await get('SELECT id, type, first_name, last_name FROM staff WHERE id = ? AND organisation_id = ?', [staffId, orgId]);
    if (!person) throw new Error(`That ${roleName(role)} is not in your records`);
    if (person.type !== role) throw new Error(`${person.first_name} ${person.last_name} is a ${roleName(person.type)}, not a ${roleName(role)}`);
  }
  const history = (await loadStaffHistory(orgId, [contract.id])).get(contract.id)[role];
  const replacing = history.find(v => v.effective_from === from);
  const inForce = assignedOn({ ...contract, staff_history: { [role]: history } }, role, from);
  if (!replacing && (inForce.staff_id || null) === staffId) {
    throw new Error(`${inForce.staff_name || 'Nobody'} already holds the ${roleName(role)} seat on ${from}`);
  }

  let id;
  await transaction(async tx => {
    if (!history.length) {
      // First change on this seat: keep whoever held it before the change.
      const before = role === 'driver' ? contract.driver_id : contract.pa_id;
      const start = contract.start_date ? String(contract.start_date).slice(0, 10) : null;
      const opening = start && start < from ? start : OPENING;
      if (opening < from) {
        await insert('contract_staff', {
          contract_id: contract.id, role, staff_id: before || null, effective_from: opening,
          note: OPENING_NOTE, created_by,
        }, ['contract_id', 'role', 'staff_id', 'effective_from', 'note', 'created_by'], tx, orgId);
      }
    }
    if (replacing) await tx.run('DELETE FROM contract_staff WHERE id = ? AND organisation_id = ?', [replacing.id, orgId]);
    id = await insert('contract_staff', {
      contract_id: contract.id, role, staff_id: staffId, effective_from: from, note: note || null, created_by,
    }, ['contract_id', 'role', 'staff_id', 'effective_from', 'note', 'created_by'], tx, orgId);
    await syncCurrent(orgId, contract.id, role, tx);
  });
  return { id, was: inForce, replaced: !!replacing };
}

/** Removes one recorded change. Dates from it follow whichever earlier change applies. */
async function removeChange(orgId, contract, rowId) {
  requireOrg(orgId);
  const row = await get('SELECT * FROM contract_staff WHERE id = ? AND contract_id = ? AND organisation_id = ?',
    [Number(rowId), contract.id, orgId]);
  if (!row) return null;
  await transaction(async tx => {
    await tx.run('DELETE FROM contract_staff WHERE id = ? AND organisation_id = ?', [row.id, orgId]);
    await syncCurrent(orgId, contract.id, row.role, tx);
    // With no real change left, the opening row has nothing to open: the
    // contract goes back to its own driver_id or pa_id applying to every date.
    const left = await tx.all('SELECT id, note FROM contract_staff WHERE organisation_id = ? AND contract_id = ? AND role = ?',
      [orgId, contract.id, row.role]);
    if (left.length && left.every(r => r.note === OPENING_NOTE)) {
      await tx.run('DELETE FROM contract_staff WHERE organisation_id = ? AND contract_id = ? AND role = ?', [orgId, contract.id, row.role]);
    }
  });
  return row;
}

/**
 * The contract form changed driver_id or pa_id directly. With dated changes
 * on record that is a correction of the latest holder, so the newest row
 * follows it and earlier dates keep their person.
 */
async function correctLatest(orgId, contractId, role, staffId) {
  requireOrg(orgId);
  const newest = await get(
    `SELECT id FROM contract_staff WHERE organisation_id = ? AND contract_id = ? AND role = ?
     ORDER BY effective_from DESC LIMIT 1`, [orgId, contractId, role]);
  if (!newest) return false;
  await run('UPDATE contract_staff SET staff_id = ? WHERE id = ? AND organisation_id = ?', [staffId || null, newest.id, orgId]);
  return true;
}

module.exports = {
  ROLES, OPENING, OPENING_NOTE, loadStaffHistory, versionOn, assignedOn, everAssigned, summary,
  recordChange, removeChange, correctLatest,
};
