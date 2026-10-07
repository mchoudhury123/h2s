'use strict';
// A contract's money figures, dated.
//
// The contract's own income_per_day, driver_pay_per_day, pa_pay_per_day and
// other_costs_per_day name the latest rates, which is what lists, forms and
// the expected-profit figures show. A rate change is recorded as a dated row
// in contract_rates, and the journey engine asks this module which figures
// were in force on each date. So a driver paid 60 a day until the 12th and
// 75 from the 13th earns exactly that, and a wage or profit calculation over
// any earlier period is unchanged by the new rate.
//
// A contract with no recorded change behaves exactly as before: its own four
// figures apply to every date.
const { all, get, run, insert, transaction, inClause } = require('../db');

const FIELDS = ['income_per_day', 'driver_pay_per_day', 'pa_pay_per_day', 'other_costs_per_day'];
const OPENING = '1900-01-01';
const OPENING_NOTE = 'Rates before the first recorded change';
const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

function requireOrg(orgId) { if (!orgId) throw new Error('An organisation id is required'); }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function pick(src) { const o = {}; for (const f of FIELDS) o[f] = round2(src[f]); return o; }

/** Every dated rate change for a set of contracts, newest first. Map of contract id -> rows. */
async function loadRateHistory(orgId, contractIds) {
  requireOrg(orgId);
  const out = new Map(contractIds.map(id => [id, []]));
  const list = inClause(contractIds);
  if (!list) return out;
  const rows = await all(
    `SELECT id, contract_id, effective_from, income_per_day, driver_pay_per_day, pa_pay_per_day, other_costs_per_day,
            note, created_by
     FROM contract_rates WHERE organisation_id = ? AND contract_id IN (${list})
     ORDER BY contract_id, effective_from DESC`, [orgId, ...contractIds]);
  for (const r of rows) {
    r.effective_from = String(r.effective_from).slice(0, 10);
    for (const f of FIELDS) r[f] = round2(r[f]);
    out.get(r.contract_id).push(r);
  }
  return out;
}

/** The change in force on a date: the newest starting on or before it, else the oldest. */
function versionOn(versions, date) {
  if (!versions || !versions.length) return null;
  for (const v of versions) if (v.effective_from <= date) return v;   // newest first
  return versions[versions.length - 1];
}

/** The four figures that apply on a date. With no recorded change, the contract's own. */
function ratesOn(contract, date) {
  const v = versionOn(contract.rate_history, date);
  return v ? { ...pick(v), change: v } : { ...pick(contract), change: null };
}

/** What the contract page says: the rates in force, since when, what is next and what came before. */
function summary(contract, history, date) {
  const versions = history || [];
  const inForce = versionOn(versions, date);
  const later = versions.filter(v => v.effective_from > date);
  const upcoming = later.length ? later[later.length - 1] : null;
  const idx = inForce ? versions.indexOf(inForce) : -1;
  const previous = idx >= 0 && idx + 1 < versions.length ? versions[idx + 1] : null;
  return {
    in_force: pick(ratesOn({ ...contract, rate_history: versions }, date)),
    since: inForce && inForce.note !== OPENING_NOTE ? inForce.effective_from : null,
    upcoming: upcoming ? { id: upcoming.id, effective_from: upcoming.effective_from, note: upcoming.note, ...pick(upcoming) } : null,
    previous: previous ? { id: previous.id, until: addDays(inForce.effective_from, -1), ...pick(previous) } : null,
    changes: versions.filter(v => v.note !== OPENING_NOTE).length,
  };
}

function addDays(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** Points the contract's own four figures at the latest recorded rates. */
async function syncCurrent(orgId, contractId, tx) {
  const newest = await tx.get(
    `SELECT ${FIELDS.join(', ')} FROM contract_rates WHERE organisation_id = ? AND contract_id = ?
     ORDER BY effective_from DESC LIMIT 1`, [orgId, contractId]);
  if (!newest) return;
  await tx.run(`UPDATE contracts SET ${FIELDS.map(f => `${f} = ?`).join(', ')} WHERE id = ? AND organisation_id = ?`,
    [...FIELDS.map(f => round2(newest[f])), contractId, orgId]);
}

/**
 * Records new rates from a date. Any figure left out keeps the value in
 * force on that date. The first change also writes an opening row holding
 * the rates before it, so earlier dates keep what they were worth. A change
 * already recorded for the same date is replaced.
 */
async function recordChange(orgId, contract, { effective_from, note, created_by, ...figures }) {
  requireOrg(orgId);
  const from = String(effective_from || '').slice(0, 10);
  if (!DATE_RX.test(from)) throw new Error('Choose the date the new rates take effect');
  const history = (await loadRateHistory(orgId, [contract.id])).get(contract.id);
  const was = ratesOn({ ...contract, rate_history: history }, from);
  const next = {};
  for (const f of FIELDS) {
    const given = figures[f];
    if (given === undefined || given === null || given === '') { next[f] = was[f]; continue; }
    const n = Number(given);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${label(f)} must be a number of pounds, zero or more`);
    next[f] = round2(n);
  }
  const replacing = history.find(v => v.effective_from === from);
  if (!replacing && FIELDS.every(f => next[f] === was[f])) throw new Error(`Those are already the rates on ${from}`);

  const cols = ['contract_id', 'effective_from', ...FIELDS, 'note', 'created_by'];
  let id;
  await transaction(async tx => {
    if (!history.length) {
      const start = contract.start_date ? String(contract.start_date).slice(0, 10) : null;
      const opening = start && start < from ? start : OPENING;
      if (opening < from) {
        await insert('contract_rates', { contract_id: contract.id, effective_from: opening, ...pick(contract), note: OPENING_NOTE, created_by }, cols, tx, orgId);
      }
    }
    if (replacing) await tx.run('DELETE FROM contract_rates WHERE id = ? AND organisation_id = ?', [replacing.id, orgId]);
    id = await insert('contract_rates', { contract_id: contract.id, effective_from: from, ...next, note: note || null, created_by }, cols, tx, orgId);
    await syncCurrent(orgId, contract.id, tx);
  });
  return { id, was: pick(was), now: next, replaced: !!replacing };
}

/** Removes one recorded change. Dates from it follow whichever earlier rates apply. */
async function removeChange(orgId, contract, rowId) {
  requireOrg(orgId);
  const row = await get('SELECT * FROM contract_rates WHERE id = ? AND contract_id = ? AND organisation_id = ?',
    [Number(rowId), contract.id, orgId]);
  if (!row) return null;
  await transaction(async tx => {
    await tx.run('DELETE FROM contract_rates WHERE id = ? AND organisation_id = ?', [row.id, orgId]);
    await syncCurrent(orgId, contract.id, tx);
    const left = await tx.all('SELECT id, note FROM contract_rates WHERE organisation_id = ? AND contract_id = ?', [orgId, contract.id]);
    if (left.length && left.every(r => r.note === OPENING_NOTE)) {
      await tx.run('DELETE FROM contract_rates WHERE organisation_id = ? AND contract_id = ?', [orgId, contract.id]);
    }
  });
  return row;
}

/**
 * The contract form changed a money figure directly. With dated changes on
 * record that is a correction of the latest rates, so the newest row follows
 * it and earlier dates keep theirs.
 */
async function correctLatest(orgId, contract) {
  requireOrg(orgId);
  const newest = await get('SELECT id FROM contract_rates WHERE organisation_id = ? AND contract_id = ? ORDER BY effective_from DESC LIMIT 1',
    [orgId, contract.id]);
  if (!newest) return false;
  await run(`UPDATE contract_rates SET ${FIELDS.map(f => `${f} = ?`).join(', ')} WHERE id = ? AND organisation_id = ?`,
    [...FIELDS.map(f => round2(contract[f])), newest.id, orgId]);
  return true;
}

function label(f) {
  return { income_per_day: 'Income per day', driver_pay_per_day: 'Driver pay per day', pa_pay_per_day: 'PA pay per day', other_costs_per_day: 'Other costs per day' }[f];
}

module.exports = { FIELDS, OPENING, OPENING_NOTE, loadRateHistory, versionOn, ratesOn, summary, recordChange, removeChange, correctLatest, label };
