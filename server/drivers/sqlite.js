'use strict';
// SQLite driver. Node's built-in driver is synchronous; the async facade here
// keeps the application code identical to the Postgres path.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const schema = require('../schema');

function create({ file } = {}) {
  const DATA_DIR = path.join(__dirname, '..', '..', 'data');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const dbPath = file || process.env.H2S_DB || path.join(DATA_DIR, 'h2s.db');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  // SQLite has no string_agg; group_concat takes the same arguments.
  const translate = sql => sql.replace(/\bstring_agg\s*\(/gi, 'group_concat(');

  async function all(sql, params = []) {
    return db.prepare(translate(sql)).all(...params).map(row => ({ ...row }));
  }
  async function get(sql, params = []) {
    const row = db.prepare(translate(sql)).get(...params);
    return row === undefined ? undefined : { ...row };
  }
  async function run(sql, params = []) {
    const r = db.prepare(translate(sql)).run(...params);
    return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
  }
  async function exec(sql) { db.exec(translate(sql)); }

  async function insertReturningId(sql, params) {
    const r = await run(sql, params);
    return r.lastInsertRowid;
  }

  // node:sqlite is synchronous, so a transaction cannot be interleaved with
  // another request. BEGIN/COMMIT around the callback is therefore safe.
  async function transaction(fn) {
    db.exec('BEGIN');
    try { const result = await fn({ all, get, run, exec, insertReturningId }); db.exec('COMMIT'); return result; }
    catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
  }

  async function migrate() {
    for (const stmt of schema.statements('sqlite')) db.exec(stmt);
  }

  async function resetSequences() { /* AUTOINCREMENT needs no resynchronisation */ }

  async function tableExists(name) {
    const r = await get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name]);
    return !!r;
  }
  async function columns(name) {
    const rows = await all(`PRAGMA table_info(${name})`);
    return rows.map(r => r.name);
  }
  async function close() { db.close(); }

  return {
    dialect: 'sqlite', describe: `SQLite (${dbPath})`, path: dbPath,
    all, get, run, exec, insertReturningId, transaction, migrate, resetSequences, close,
    tableExists, columns,
  };
}

module.exports = { create };
