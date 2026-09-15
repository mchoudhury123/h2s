'use strict';
// Data access. One async interface over either SQLite or Postgres (Supabase).
// Set DATABASE_URL to use Postgres; without it the local SQLite file is used.
require('./env').load();

const DRIVERS = { sqlite: require('./drivers/sqlite'), postgres: require('./drivers/postgres') };

function chooseDialect() {
  const forced = (process.env.H2S_DB_DRIVER || '').toLowerCase();
  if (forced) return forced;
  return process.env.DATABASE_URL ? 'postgres' : 'sqlite';
}

const dialect = chooseDialect();
if (!DRIVERS[dialect]) throw new Error(`Unknown database driver "${dialect}". Use "sqlite" or "postgres".`);
const driver = DRIVERS[dialect].create();

// ---------- core query helpers ----------
const all = (sql, params) => driver.all(sql, params);
const get = (sql, params) => driver.get(sql, params);
const run = (sql, params) => driver.run(sql, params);
const exec = sql => driver.exec(sql);
const transaction = fn => driver.transaction(fn);
const migrate = () => driver.migrate();
const resetSequences = () => driver.resetSequences();
const close = () => driver.close();
const dropSchema = () => (driver.dropSchema ? driver.dropSchema() : Promise.resolve());

// ---------- settings ----------
async function getSetting(key, fallback = null) {
  const row = await get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : fallback;
}
async function setSetting(key, value) {
  await run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, String(value)]);
}

// ---------- write helpers, restricted to whitelisted columns ----------
async function insert(table, data, columns, client) {
  // Columns that normalise to null are omitted so the table's own default applies.
  // Without this, leaving an optional numeric field blank would break a NOT NULL DEFAULT 0 column.
  const cols = columns.filter(c => data[c] !== undefined && norm(data[c]) !== null);
  const placeholders = cols.map(() => '?').join(',');
  const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`;
  const target = client || driver;
  return target.insertReturningId(sql, cols.map(c => norm(data[c])));
}
async function update(table, id, data, columns, client) {
  const cols = columns.filter(c => data[c] !== undefined);
  if (!cols.length) return 0;
  const sets = cols.map(c => `${c} = ?`).join(', ');
  const target = client || driver;
  const res = await target.run(`UPDATE ${table} SET ${sets} WHERE id = ?`, [...cols.map(c => norm(data[c])), id]);
  return res.changes;
}
function norm(v) {
  if (v === '' || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
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
};
