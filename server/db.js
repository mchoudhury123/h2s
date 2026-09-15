'use strict';
// Data access. One async interface over either SQLite or Postgres (Supabase).
// Set DATABASE_URL to use Postgres; without it the local SQLite file is used.
//
// Every operating firm is an organisation, and every table of firm data carries
// organisation_id. Two guards below make a forgotten filter fail loudly rather
// than quietly showing one firm another firm's records:
//
//   1. insert() refuses to write a row of firm data without an organisation_id.
//   2. With H2S_STRICT_TENANCY=1 (the test suites set it), any statement that
//      touches a table of firm data without mentioning organisation_id throws.
require('./env').load();

const schemaDef = require('./schema');
const migrations = require('./migrations');

function chooseDialect() {
  const forced = (process.env.H2S_DB_DRIVER || '').toLowerCase();
  if (forced) return forced;
  return process.env.DATABASE_URL ? 'postgres' : 'sqlite';
}

const dialect = chooseDialect();
// Only the driver actually in use is loaded. A Postgres deployment then never
// touches node:sqlite, which is still behind a flag on some Node versions.
let driver;
if (dialect === 'postgres') driver = require('./drivers/postgres').create();
else if (dialect === 'sqlite') driver = require('./drivers/sqlite').create();
else throw new Error(`Unknown database driver "${dialect}". Use "sqlite" or "postgres".`);

// ---------- tenancy guards ----------
const TENANT_TABLES = new Set(schemaDef.TENANT_TABLES);
const STRICT = process.env.H2S_STRICT_TENANCY === '1';
// Statements that legitimately have no organisation to filter by.
const EXEMPT = /^\s*(CREATE|DROP|ALTER|PRAGMA|SET|BEGIN|COMMIT|ROLLBACK|SELECT\s+1\b|SELECT\s+setval|SELECT\s+nspname|SELECT\s+column_name|SELECT\s+name\s+FROM\s+sqlite_master)/i;

function referencedTables(sql) {
  const found = new Set();
  const rx = /\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_][a-z0-9_]*)/gi;
  let m;
  while ((m = rx.exec(sql))) found.add(m[1].toLowerCase());
  return found;
}
function assertScoped(sql) {
  if (!STRICT) return;
  if (EXEMPT.test(sql)) return;
  if (/organisation_id/i.test(sql)) return;
  // A statement may opt out by explaining itself, for the few cases that are
  // deliberately system-wide: signing in looks an email address up across every
  // firm, because one address belongs to one person in one firm.
  if (/\/\*\s*cross-org:/i.test(sql)) return;
  for (const t of referencedTables(sql)) {
    if (TENANT_TABLES.has(t)) {
      const err = new Error(`Tenancy guard: this statement reads or writes "${t}" without filtering on organisation_id.\n  ${sql.trim().slice(0, 300)}`);
      err.code = 'TENANCY';
      throw err;
    }
  }
}

// ---------- core query helpers ----------
const all = (sql, params) => { assertScoped(sql); return driver.all(sql, params); };
const get = (sql, params) => { assertScoped(sql); return driver.get(sql, params); };
const run = (sql, params) => { assertScoped(sql); return driver.run(sql, params); };
const exec = sql => driver.exec(sql);
const transaction = fn => driver.transaction(tx => fn(guarded(tx)));
const resetSequences = () => driver.resetSequences();
const close = () => driver.close();
const dropSchema = () => (driver.dropSchema ? driver.dropSchema() : Promise.resolve());

/** Wraps a transaction client so statements inside a transaction are checked too. */
function guarded(tx) {
  return {
    all: (sql, p) => { assertScoped(sql); return tx.all(sql, p); },
    get: (sql, p) => { assertScoped(sql); return tx.get(sql, p); },
    run: (sql, p) => { assertScoped(sql); return tx.run(sql, p); },
    exec: sql => tx.exec(sql),
    insertReturningId: (sql, p) => { assertScoped(sql); return tx.insertReturningId(sql, p); },
  };
}

async function migrate(log = () => {}) {
  if (driver.ensureSchema) await driver.ensureSchema();
  await migrations.run(driver, log);
}

// ---------- settings, per organisation ----------
async function getSetting(orgId, key, fallback = null) {
  requireOrg(orgId, 'getSetting');
  const row = await get('SELECT value FROM settings WHERE organisation_id = ? AND key = ?', [orgId, key]);
  return row ? row.value : fallback;
}
async function setSetting(orgId, key, value) {
  requireOrg(orgId, 'setSetting');
  await run(`INSERT INTO settings (organisation_id, key, value) VALUES (?,?,?)
             ON CONFLICT (organisation_id, key) DO UPDATE SET value = excluded.value`,
    [orgId, key, String(value)]);
}

// ---------- write helpers, restricted to whitelisted columns ----------
/**
 * Inserts one row. For a table of firm data the caller must supply
 * organisation_id, either in `data` or as the `orgId` argument.
 */
async function insert(table, data, columns, client, orgId) {
  const row = { ...data };
  if (TENANT_TABLES.has(table)) {
    if (orgId) row.organisation_id = orgId;
    if (!row.organisation_id) {
      throw new Error(`Refusing to insert into "${table}" without an organisation_id.`);
    }
    if (!columns.includes('organisation_id')) columns = [...columns, 'organisation_id'];
  }
  // Columns that normalise to null are omitted so the table's own default applies.
  // Without this, leaving an optional numeric field blank would break a NOT NULL DEFAULT 0 column.
  const cols = columns.filter(c => row[c] !== undefined && norm(row[c]) !== null);
  const placeholders = cols.map(() => '?').join(',');
  const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`;
  const target = client || driver;
  if (client) assertScoped(sql);
  return target.insertReturningId(sql, cols.map(c => norm(row[c])));
}

/** Updates one row, scoped to the firm that owns it. */
async function update(table, id, data, columns, client, orgId) {
  const cols = columns.filter(c => data[c] !== undefined && c !== 'organisation_id');
  if (!cols.length) return 0;
  const sets = cols.map(c => `${c} = ?`).join(', ');
  const scoped = TENANT_TABLES.has(table);
  if (scoped && !orgId) throw new Error(`Refusing to update "${table}" without an organisation_id.`);
  const sql = `UPDATE ${table} SET ${sets} WHERE id = ?` + (scoped ? ' AND organisation_id = ?' : '');
  const params = [...cols.map(c => norm(data[c])), id];
  if (scoped) params.push(orgId);
  const target = client || driver;
  if (client) assertScoped(sql);
  const res = await target.run(sql, params);
  return res.changes;
}

function norm(v) {
  if (v === '' || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}
function requireOrg(orgId, where) {
  if (!orgId) throw new Error(`${where} needs an organisation id.`);
}

/** Builds an "IN (?,?,?)" clause. Returns null when the list is empty. */
function inClause(values) {
  if (!values || !values.length) return null;
  return values.map(() => '?').join(',');
}

module.exports = {
  dialect, describe: driver.describe, driver,
  all, get, run, exec, transaction, migrate, resetSequences, dropSchema, close,
  getSetting, setSetting, insert, update, norm, inClause,
  TENANT_TABLES, strict: STRICT,
};
