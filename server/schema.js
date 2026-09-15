'use strict';
// One schema definition, rendered for whichever database is in use.
// Tokens are substituted per dialect so SQLite and Postgres never drift apart.
//
//   {{PK}}    auto-incrementing primary key
//   {{NOW}}   default: current timestamp as text
//   {{TODAY}} default: current date as text (YYYY-MM-DD)
//   {{REAL}}  floating point number
//   {{INT}}   integer
//
// Dates and timestamps are stored as TEXT in both dialects. That keeps
// 'YYYY-MM-DD' comparisons, sorting and JSON output identical everywhere and
// avoids any timezone conversion between the database and the application.

const TABLES = [
  `CREATE TABLE IF NOT EXISTS users (
    id {{PK}},
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'readonly',
    active {{INT}} NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT {{NOW}}
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS councils (
    id {{PK}},
    name TEXT NOT NULL,
    contact_name TEXT, phone TEXT, email TEXT, address TEXT, notes TEXT,
    active {{INT}} NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS schools (
    id {{PK}},
    name TEXT NOT NULL,
    address TEXT, postcode TEXT, phone TEXT, contact_name TEXT, email TEXT,
    open_time TEXT, close_time TEXT, notes TEXT,
    active {{INT}} NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS staff (
    id {{PK}},
    type TEXT NOT NULL CHECK (type IN ('driver','pa')),
    first_name TEXT NOT NULL, last_name TEXT NOT NULL,
    address TEXT, postcode TEXT, phone TEXT, email TEXT,
    emergency_contact_name TEXT, emergency_contact_phone TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pool','inactive')),
    licensing_authority TEXT, badge_number TEXT, dbs_number TEXT,
    default_day_rate {{REAL}} NOT NULL DEFAULT 0,
    availability TEXT, preferred_areas TEXT,
    start_date TEXT, photo TEXT, notes TEXT,
    created_at TEXT NOT NULL DEFAULT {{NOW}}
  )`,
  `CREATE TABLE IF NOT EXISTS vehicles (
    id {{PK}},
    driver_id {{INT}} REFERENCES staff(id) ON DELETE SET NULL,
    registration TEXT NOT NULL, make TEXT, model TEXT,
    seats {{INT}}, wheelchair_accessible {{INT}} NOT NULL DEFAULT 0,
    colour TEXT, notes TEXT, active {{INT}} NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS contracts (
    id {{PK}},
    code TEXT UNIQUE NOT NULL,
    name TEXT,
    council_id {{INT}} REFERENCES councils(id) ON DELETE SET NULL,
    council_ref TEXT,
    school_id {{INT}} REFERENCES schools(id) ON DELETE SET NULL,
    driver_id {{INT}} REFERENCES staff(id) ON DELETE SET NULL,
    pa_id {{INT}} REFERENCES staff(id) ON DELETE SET NULL,
    vehicle_id {{INT}} REFERENCES vehicles(id) ON DELETE SET NULL,
    requires_pa {{INT}} NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','suspended','ended')),
    start_date TEXT, end_date TEXT,
    days_of_week TEXT NOT NULL DEFAULT '1,2,3,4,5',
    am_pickup_time TEXT, am_arrival_time TEXT, pm_finish_time TEXT, pm_dropoff_time TEXT,
    route_info TEXT, am_notes TEXT, pm_notes TEXT,
    income_per_day {{REAL}} NOT NULL DEFAULT 0,
    income_basis TEXT NOT NULL DEFAULT 'per_journey' CHECK (income_basis IN ('per_day','per_journey')),
    driver_pay_per_day {{REAL}} NOT NULL DEFAULT 0,
    pa_pay_per_day {{REAL}} NOT NULL DEFAULT 0,
    pay_basis TEXT NOT NULL DEFAULT 'per_journey' CHECK (pay_basis IN ('per_day','per_journey')),
    other_costs_per_day {{REAL}} NOT NULL DEFAULT 0,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT {{NOW}}
  )`,
  `CREATE TABLE IF NOT EXISTS children (
    id {{PK}},
    first_name TEXT NOT NULL, last_name TEXT NOT NULL,
    dob TEXT, photo TEXT,
    address TEXT, postcode TEXT,
    parent_name TEXT, parent_phone TEXT,
    emergency_contact_name TEXT, emergency_contact_phone TEXT,
    school_id {{INT}} REFERENCES schools(id) ON DELETE SET NULL,
    contract_id {{INT}} REFERENCES contracts(id) ON DELETE SET NULL,
    council_ref TEXT,
    pickup_time TEXT, arrival_time TEXT, finish_time TEXT, dropoff_time TEXT,
    medical_info TEXT, sen_needs TEXT, conditions TEXT, mobility TEXT,
    wheelchair {{INT}} NOT NULL DEFAULT 0,
    behaviour TEXT, communication TEXT, allergies TEXT,
    safeguarding_info TEXT, risk_info TEXT, notes TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
    created_at TEXT NOT NULL DEFAULT {{NOW}}
  )`,
  `CREATE TABLE IF NOT EXISTS documents (
    id {{PK}},
    entity_type TEXT NOT NULL CHECK (entity_type IN ('child','staff','contract','vehicle','school')),
    entity_id {{INT}} NOT NULL,
    doc_type TEXT NOT NULL,
    reference TEXT,
    file_name TEXT, stored_name TEXT, mime_type TEXT, size {{INT}},
    upload_date TEXT NOT NULL DEFAULT {{TODAY}},
    issue_date TEXT, expiry_date TEXT,
    status TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','invalid','superseded')),
    notes TEXT,
    uploaded_by TEXT,
    created_at TEXT NOT NULL DEFAULT {{NOW}}
  )`,
  `CREATE TABLE IF NOT EXISTS exceptions (
    id {{PK}},
    date TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('child_absence','staff_absence','school_closed','contract_cancelled','journey_cancelled','pay_override','note')),
    leg TEXT NOT NULL DEFAULT 'DAY' CHECK (leg IN ('AM','PM','DAY')),
    contract_id {{INT}} REFERENCES contracts(id) ON DELETE CASCADE,
    school_id {{INT}} REFERENCES schools(id) ON DELETE CASCADE,
    child_id {{INT}} REFERENCES children(id) ON DELETE CASCADE,
    role TEXT CHECK (role IN ('driver','pa')),
    staff_id {{INT}} REFERENCES staff(id) ON DELETE SET NULL,
    cover_staff_id {{INT}} REFERENCES staff(id) ON DELETE SET NULL,
    cover_pay {{REAL}},
    paid_immediately {{INT}} NOT NULL DEFAULT 0,
    amount {{REAL}},
    note TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT {{NOW}}
  )`,
  `CREATE TABLE IF NOT EXISTS payments (
    id {{PK}},
    staff_id {{INT}} NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    work_date TEXT NOT NULL,
    paid_date TEXT NOT NULL DEFAULT {{TODAY}},
    amount {{REAL}} NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('cover_immediate','manual','payroll')),
    exception_id {{INT}} REFERENCES exceptions(id) ON DELETE SET NULL,
    payroll_run_id {{INT}},
    method TEXT, reference TEXT, note TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT {{NOW}}
  )`,
  `CREATE TABLE IF NOT EXISTS payroll_runs (
    id {{PK}},
    from_date TEXT NOT NULL, to_date TEXT NOT NULL,
    description TEXT,
    total {{REAL}} NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'paid',
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT {{NOW}}
  )`,
  `CREATE TABLE IF NOT EXISTS payroll_run_lines (
    id {{PK}},
    payroll_run_id {{INT}} NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
    staff_id {{INT}} NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    amount {{REAL}} NOT NULL,
    breakdown_json TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS expenses (
    id {{PK}},
    date TEXT NOT NULL,
    contract_id {{INT}} REFERENCES contracts(id) ON DELETE SET NULL,
    category TEXT NOT NULL,
    amount {{REAL}} NOT NULL,
    description TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT {{NOW}}
  )`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id {{PK}},
    user_name TEXT,
    entity_type TEXT NOT NULL,
    entity_id {{INT}},
    entity_label TEXT,
    action TEXT NOT NULL,
    field TEXT, old_value TEXT, new_value TEXT,
    summary TEXT,
    created_at TEXT NOT NULL DEFAULT {{NOW}}
  )`,
];

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_documents_entity ON documents(entity_type, entity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_exceptions_date ON exceptions(date)`,
  `CREATE INDEX IF NOT EXISTS idx_exceptions_contract ON exceptions(contract_id, date)`,
  `CREATE INDEX IF NOT EXISTS idx_payments_staff ON payments(staff_id, work_date)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_children_contract ON children(contract_id)`,
  `CREATE INDEX IF NOT EXISTS idx_children_school ON children(school_id)`,
  `CREATE INDEX IF NOT EXISTS idx_contracts_school ON contracts(school_id)`,
  `CREATE INDEX IF NOT EXISTS idx_contracts_driver ON contracts(driver_id)`,
  `CREATE INDEX IF NOT EXISTS idx_contracts_pa ON contracts(pa_id)`,
];

const DIALECTS = {
  sqlite: {
    '{{PK}}': 'INTEGER PRIMARY KEY AUTOINCREMENT',
    '{{NOW}}': "(datetime('now'))",
    '{{TODAY}}': "(date('now'))",
    '{{REAL}}': 'REAL',
    '{{INT}}': 'INTEGER',
  },
  postgres: {
    '{{PK}}': 'INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY',
    '{{NOW}}': "(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))",
    '{{TODAY}}': "(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'))",
    '{{REAL}}': 'DOUBLE PRECISION',
    '{{INT}}': 'INTEGER',
  },
};

/** Every DDL statement for a dialect, in dependency order. */
function statements(dialect) {
  const map = DIALECTS[dialect];
  if (!map) throw new Error('Unknown dialect: ' + dialect);
  const render = sql => Object.entries(map).reduce((s, [token, value]) => s.split(token).join(value), sql);
  return [...TABLES.map(render), ...INDEXES.map(render)];
}

// Order matters for deletes and for copying rows between databases.
const TABLE_ORDER = ['settings', 'users', 'councils', 'schools', 'staff', 'vehicles', 'contracts',
  'children', 'documents', 'exceptions', 'payroll_runs', 'payments', 'payroll_run_lines', 'expenses', 'audit_log'];

// Tables whose id comes from a sequence that must be resynchronised after a bulk copy.
const SEQUENCE_TABLES = TABLE_ORDER.filter(t => t !== 'settings');

module.exports = { statements, TABLE_ORDER, SEQUENCE_TABLES, DIALECTS };
