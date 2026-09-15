'use strict';
// Database layer: opens SQLite (Node built-in), applies schema, exposes helpers.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.H2S_DB || path.join(DATA_DIR, 'h2s.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'readonly',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS councils (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact_name TEXT, phone TEXT, email TEXT, address TEXT, notes TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS schools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT, postcode TEXT, phone TEXT, contact_name TEXT, email TEXT,
  open_time TEXT, close_time TEXT, notes TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('driver','pa')),
  first_name TEXT NOT NULL, last_name TEXT NOT NULL,
  address TEXT, postcode TEXT, phone TEXT, email TEXT,
  emergency_contact_name TEXT, emergency_contact_phone TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pool','inactive')),
  licensing_authority TEXT, badge_number TEXT, dbs_number TEXT,
  default_day_rate REAL NOT NULL DEFAULT 0,
  availability TEXT, preferred_areas TEXT,
  start_date TEXT, photo TEXT, notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  registration TEXT NOT NULL, make TEXT, model TEXT,
  seats INTEGER, wheelchair_accessible INTEGER NOT NULL DEFAULT 0,
  colour TEXT, notes TEXT, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT,
  council_id INTEGER REFERENCES councils(id) ON DELETE SET NULL,
  council_ref TEXT,
  school_id INTEGER REFERENCES schools(id) ON DELETE SET NULL,
  driver_id INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  pa_id INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE SET NULL,
  requires_pa INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','suspended','ended')),
  start_date TEXT, end_date TEXT,
  days_of_week TEXT NOT NULL DEFAULT '1,2,3,4,5',
  am_pickup_time TEXT, am_arrival_time TEXT, pm_finish_time TEXT, pm_dropoff_time TEXT,
  route_info TEXT, am_notes TEXT, pm_notes TEXT,
  income_per_day REAL NOT NULL DEFAULT 0,
  income_basis TEXT NOT NULL DEFAULT 'per_journey' CHECK (income_basis IN ('per_day','per_journey')),
  driver_pay_per_day REAL NOT NULL DEFAULT 0,
  pa_pay_per_day REAL NOT NULL DEFAULT 0,
  pay_basis TEXT NOT NULL DEFAULT 'per_journey' CHECK (pay_basis IN ('per_day','per_journey')),
  other_costs_per_day REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS children (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL, last_name TEXT NOT NULL,
  dob TEXT, photo TEXT,
  address TEXT, postcode TEXT,
  parent_name TEXT, parent_phone TEXT,
  emergency_contact_name TEXT, emergency_contact_phone TEXT,
  school_id INTEGER REFERENCES schools(id) ON DELETE SET NULL,
  contract_id INTEGER REFERENCES contracts(id) ON DELETE SET NULL,
  council_ref TEXT,
  pickup_time TEXT, arrival_time TEXT, finish_time TEXT, dropoff_time TEXT,
  medical_info TEXT, sen_needs TEXT, conditions TEXT, mobility TEXT,
  wheelchair INTEGER NOT NULL DEFAULT 0,
  behaviour TEXT, communication TEXT, allergies TEXT,
  safeguarding_info TEXT, risk_info TEXT, notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('child','staff','contract','vehicle','school')),
  entity_id INTEGER NOT NULL,
  doc_type TEXT NOT NULL,
  reference TEXT,
  file_name TEXT, stored_name TEXT, mime_type TEXT, size INTEGER,
  upload_date TEXT NOT NULL DEFAULT (date('now')),
  issue_date TEXT, expiry_date TEXT,
  status TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','invalid','superseded')),
  notes TEXT,
  uploaded_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_entity ON documents(entity_type, entity_id);
CREATE TABLE IF NOT EXISTS exceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('child_absence','staff_absence','school_closed','contract_cancelled','journey_cancelled','pay_override','note')),
  leg TEXT NOT NULL DEFAULT 'DAY' CHECK (leg IN ('AM','PM','DAY')),
  contract_id INTEGER REFERENCES contracts(id) ON DELETE CASCADE,
  school_id INTEGER REFERENCES schools(id) ON DELETE CASCADE,
  child_id INTEGER REFERENCES children(id) ON DELETE CASCADE,
  role TEXT CHECK (role IN ('driver','pa')),
  staff_id INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  cover_staff_id INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  cover_pay REAL,
  paid_immediately INTEGER NOT NULL DEFAULT 0,
  amount REAL,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_exceptions_date ON exceptions(date);
CREATE INDEX IF NOT EXISTS idx_exceptions_contract ON exceptions(contract_id, date);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  work_date TEXT NOT NULL,
  paid_date TEXT NOT NULL DEFAULT (date('now')),
  amount REAL NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('cover_immediate','manual','payroll')),
  exception_id INTEGER REFERENCES exceptions(id) ON DELETE SET NULL,
  payroll_run_id INTEGER,
  method TEXT, reference TEXT, note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_staff ON payments(staff_id, work_date);
CREATE TABLE IF NOT EXISTS payroll_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_date TEXT NOT NULL, to_date TEXT NOT NULL,
  description TEXT,
  total REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'paid',
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS payroll_run_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payroll_run_id INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  breakdown_json TEXT
);
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  contract_id INTEGER REFERENCES contracts(id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  description TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_name TEXT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  entity_label TEXT,
  action TEXT NOT NULL,
  field TEXT, old_value TEXT, new_value TEXT,
  summary TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
`;

db.exec(SCHEMA);

// ---------- helpers ----------
function all(sql, params = []) { return db.prepare(sql).all(...params); }
function get(sql, params = []) { return db.prepare(sql).get(...params); }
function run(sql, params = []) { return db.prepare(sql).run(...params); }
function transaction(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

function getSetting(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, String(value)]);
}

// Generic insert/update builders restricted to whitelisted columns.
function insert(table, data, columns) {
  // Columns that normalise to null are omitted so the table's own default applies.
  // Without this, leaving an optional numeric field blank would break a NOT NULL DEFAULT 0 column.
  const cols = columns.filter(c => data[c] !== undefined && norm(data[c]) !== null);
  const placeholders = cols.map(() => '?').join(',');
  const res = run(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`, cols.map(c => norm(data[c])));
  return Number(res.lastInsertRowid);
}
function update(table, id, data, columns) {
  const cols = columns.filter(c => data[c] !== undefined);
  if (!cols.length) return 0;
  const sets = cols.map(c => `${c} = ?`).join(', ');
  const res = run(`UPDATE ${table} SET ${sets} WHERE id = ?`, [...cols.map(c => norm(data[c])), id]);
  return res.changes;
}
function norm(v) {
  if (v === '' || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

module.exports = { db, all, get, run, transaction, getSetting, setSetting, insert, update, DB_PATH };
