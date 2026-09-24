/**
 * Looks after whole businesses: list them, empty one, or remove one.
 *
 *   npm run business -- --list
 *   npm run business -- --empty  --id 7        show what emptying would remove
 *   npm run business -- --empty  --id 7 --yes  remove every record, keep the
 *                                              business, its accounts, its
 *                                              settings and its audit log
 *   npm run business -- --delete --id 7        show what deleting would remove
 *   npm run business -- --delete --id 7 --yes  remove the business entirely,
 *                                              accounts included
 *
 * Nothing changes without --yes. Before anything is removed, every row that
 * belongs to the business is written to data/backups/ as JSON, so a mistake
 * can be put back by hand.
 */
'use strict';
require('../server/env').load();

const fs = require('fs');
const path = require('path');
const database = require('../server/db');
const { all, get, transaction } = database;
const { TENANT_TABLES } = require('../server/schema');

const args = process.argv.slice(2);
const LIST = args.includes('--list');
const EMPTY = args.includes('--empty');
const DELETE = args.includes('--delete');
const YES = args.includes('--yes');
const ID_AT = args.indexOf('--id');
const ORG_ID = ID_AT >= 0 && args[ID_AT + 1] ? Number(args[ID_AT + 1]) : null;

// What emptying removes, in an order the foreign keys allow.
// Accounts, settings and the audit log are deliberately not here.
const RECORD_TABLES = [
  'payroll_run_lines', 'payroll_runs', 'payments', 'exceptions', 'expenses', 'documents',
  'contract_trip_children', 'contract_trips', 'contract_schedules',
  'child_timetable_days', 'child_timetables', 'children', 'contracts',
  'vehicles', 'staff', 'schools', 'councils',
];
const KEPT_ON_EMPTY = ['settings', 'audit_log'];

async function counts(orgId, tables) {
  const out = {};
  for (const t of tables) {
    const r = await get(`SELECT COUNT(*) AS n FROM ${t} WHERE organisation_id = ?`, [orgId]);
    if (Number(r.n)) out[t] = Number(r.n);
  }
  return out;
}

function describe(c) {
  const parts = Object.entries(c).map(([t, n]) => `${n} ${t.replace(/_/g, ' ')}`);
  return parts.length ? parts.join(', ') : 'nothing';
}

async function list() {
  const orgs = await all('SELECT id, name, created_at FROM organisations ORDER BY id');
  console.log('\nBusinesses on this system:');
  for (const o of orgs) {
    const c = await counts(o.id, TENANT_TABLES);
    const users = await all('SELECT email FROM users WHERE organisation_id = ? ORDER BY id', [o.id]);
    console.log(`\n  ${String(o.id).padStart(3)}  ${o.name}   (registered ${o.created_at.slice(0, 10)})`);
    console.log(`       accounts: ${users.map(u => u.email).join(', ') || 'none'}`);
    console.log(`       records:  ${describe(c)}`);
  }
  console.log('');
}

/** Writes every row belonging to the business to a JSON file and returns its path. */
async function backup(org, mode) {
  const dir = path.join(__dirname, '..', 'data', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const dump = { organisation: org, taken_at: new Date().toISOString(), mode, tables: {} };
  for (const t of TENANT_TABLES) {
    const rows = await all(`SELECT * FROM ${t} WHERE organisation_id = ?`, [org.id]);
    if (rows.length) dump.tables[t] = rows;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `${stamp}-business-${org.id}-${mode}.json`);
  fs.writeFileSync(file, JSON.stringify(dump, null, 1));
  return file;
}

async function main() {
  await database.migrate();

  if (LIST || (!EMPTY && !DELETE)) return list();
  if (EMPTY && DELETE) throw new Error('Choose --empty or --delete, not both.');
  if (!ORG_ID) throw new Error('Say which business with --id <number>. Run with --list to see them.');

  const org = await get('SELECT id, name, created_at FROM organisations WHERE id = ?', [ORG_ID]);
  if (!org) throw new Error(`No business with id ${ORG_ID}. Run with --list to see them.`);

  const users = await all('SELECT email FROM users WHERE organisation_id = ? ORDER BY id', [org.id]);
  const records = await counts(org.id, RECORD_TABLES);
  const kept = await counts(org.id, KEPT_ON_EMPTY);

  console.log(`\n${EMPTY ? 'Emptying' : 'Deleting'} business ${org.id}: "${org.name}"`);
  console.log(`  accounts: ${users.map(u => u.email).join(', ') || 'none'}`);
  console.log(`  records:  ${describe(records)}`);
  if (EMPTY) {
    console.log(`  kept:     the business, its ${plural(users.length, 'account')}, ${describe(kept).replace('audit log', 'audit log entries')}`);
  } else {
    console.log('  removed:  the business itself, every account, every record, its settings and its audit log');
  }

  if (!YES) {
    console.log('\n  Nothing has been changed. Add --yes to go ahead.\n');
    return;
  }

  const file = await backup(org, EMPTY ? 'empty' : 'delete');
  console.log(`\n  Backup written to ${path.relative(process.cwd(), file)}`);

  await transaction(async tx => {
    if (EMPTY) {
      for (const t of RECORD_TABLES) {
        await tx.run(`DELETE FROM ${t} WHERE organisation_id = ?`, [org.id]);
      }
    } else {
      // An account created here that also belongs to another business moves
      // there instead of vanishing with this one.
      const shared = await tx.all(
        `SELECT u.id, MIN(m.organisation_id) AS next FROM users u
         JOIN user_organisations m ON m.user_id = u.id
         WHERE u.organisation_id = ? GROUP BY u.id`, [org.id]);
      for (const s of shared) {
        await tx.run('/* cross-org: the account moves its home to another of its businesses */ UPDATE users SET organisation_id = ? WHERE id = ?', [s.next, s.id]);
        await tx.run('DELETE FROM user_organisations WHERE organisation_id = ? AND user_id = ?', [s.next, s.id]);
      }
      // Every table of firm data cascades from the business, accounts and
      // their sessions included.
      await tx.run('DELETE FROM organisations WHERE id = ?', [org.id]);
    }
  });

  if (EMPTY) {
    const after = await counts(org.id, RECORD_TABLES);
    if (Object.keys(after).length) throw new Error('Some records survived: ' + describe(after));
    console.log(`  Done. "${org.name}" is empty and ready to be filled. ${users.map(u => u.email).join(', ')} can still sign in.\n`);
  } else {
    const gone = !(await get('SELECT id FROM organisations WHERE id = ?', [org.id]));
    if (!gone) throw new Error('The business is still there.');
    console.log(`  Done. "${org.name}" and its ${plural(users.length, 'account')} are gone.\n`);
  }
}

function plural(n, one) { return `${n} ${n === 1 ? one : one + 's'}`; }

main()
  .then(() => database.close())
  .catch(async e => {
    console.error('\n' + e.message + '\n');
    try { await database.close(); } catch (_) {}
    process.exit(1);
  });
