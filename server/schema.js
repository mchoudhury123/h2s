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
//
// MULTI-TENANCY. Every operating firm is an "organisation". Every table below
// except organisations itself carries organisation_id, and every query filters
// on it. One firm can never see another firm's children, staff or finances.

const ORG = '{{INT}} NOT NULL REFERENCES organisations(id) ON DELETE CASCADE';

const TABLES = [
  `CREATE TABLE IF NOT EXISTS organisations (
    id {{PK}},
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT {{NOW}},
    active {{INT}} NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id {{PK}},
    organisation_id ${ORG},
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    active {{INT}} NOT NULL DEFAULT 1,
    last_login TEXT,
    created_at TEXT NOT NULL DEFAULT {{NOW}}
  )`,
  // An email address identifies one person in one firm, so it is unique across
  // the whole system rather than within an organisation.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(LOWER(email))`,
  // Sign-in sessions live in the database, not in memory, so the CRM works on a
  // serverless host where each request may be served by a different instance.
  `CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id {{INT}} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT {{NOW}}
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    organisation_id ${ORG},
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (organisation_id, key)
  )`,
  `CREATE TABLE IF NOT EXISTS councils (
    id {{PK}},
    organisation_id ${ORG},
    name TEXT NOT NULL,
    contact_name TEXT, phone TEXT, email TEXT, address TEXT, notes TEXT,
    active {{INT}} NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS schools (
    id {{PK}},
    organisation_id ${ORG},
    name TEXT NOT NULL,
    address TEXT, postcode TEXT, phone TEXT, contact_name TEXT, email TEXT,
    open_time TEXT, close_time TEXT, notes TEXT,
    active {{INT}} NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS staff (
    id {{PK}},
    organisation_id ${ORG},
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
    organisation_id ${ORG},
    driver_id {{INT}} REFERENCES staff(id) ON DELETE SET NULL,
    registration TEXT NOT NULL, make TEXT, model TEXT,
    seats {{INT}}, wheelchair_accessible {{INT}} NOT NULL DEFAULT 0,
    colour TEXT, notes TEXT, active {{INT}} NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS contracts (
    id {{PK}},
    organisation_id ${ORG},
    code TEXT NOT NULL,
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
  // A contract code only has to be unique inside the firm that uses it.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_contracts_code ON contracts(organisation_id, code)`,
  // ---- weekly patterns -------------------------------------------------
  // A contract's normal week. Each row is a version taking effect on a date, so
  // changing next term's pattern never rewrites what already happened.
  // A contract with no version behaves as it always has: an outward and a return
  // trip on each of its operating days.
  `CREATE TABLE IF NOT EXISTS contract_schedules (
    id {{PK}},
    organisation_id ${ORG},
    contract_id {{INT}} NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    effective_from TEXT NOT NULL,
    note TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT {{NOW}}
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_schedules_from
     ON contract_schedules(contract_id, effective_from)`,
  // The journeys that normally run on one weekday of one version.
  // Leaving a pay or income figure blank shares the contract's day rate evenly
  // across that day's trips, which is what a plain two-trip day has always done.
  `CREATE TABLE IF NOT EXISTS contract_trips (
    id {{PK}},
    organisation_id ${ORG},
    schedule_id {{INT}} NOT NULL REFERENCES contract_schedules(id) ON DELETE CASCADE,
    weekday {{INT}} NOT NULL,
    seq {{INT}} NOT NULL,
    label TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'outbound' CHECK (kind IN ('outbound','return','other')),
    depart_time TEXT, arrive_time TEXT,
    driver_pay {{REAL}}, pa_pay {{REAL}}, income {{REAL}},
    notes TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_contract_trips_day ON contract_trips(schedule_id, weekday, seq)`,
  `CREATE TABLE IF NOT EXISTS children (
    id {{PK}},
    organisation_id ${ORG},
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
  // Which children a trip carries. No rows means everyone travelling that day,
  // which is the normal case; rows are only needed when a day splits into
  // separate collections at different times.
  `CREATE TABLE IF NOT EXISTS contract_trip_children (
    id {{PK}},
    organisation_id ${ORG},
    trip_id {{INT}} NOT NULL REFERENCES contract_trips(id) ON DELETE CASCADE,
    child_id {{INT}} NOT NULL REFERENCES children(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_trip_children ON contract_trip_children(trip_id)`,
  // A child's normal week. Versioned the same way. A child with no version
  // travels whenever their contract runs, using the contract's own times.
  `CREATE TABLE IF NOT EXISTS child_timetables (
    id {{PK}},
    organisation_id ${ORG},
    child_id {{INT}} NOT NULL REFERENCES children(id) ON DELETE CASCADE,
    effective_from TEXT NOT NULL,
    same_all_week {{INT}} NOT NULL DEFAULT 1,
    start_time TEXT, finish_time TEXT,
    note TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT {{NOW}}
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_child_timetables_from
     ON child_timetables(child_id, effective_from)`,
  // One row per weekday. "attends = 0" is a normal day off, which is not the
  // same thing as being absent from a day they were expected to travel.
  `CREATE TABLE IF NOT EXISTS child_timetable_days (
    id {{PK}},
    organisation_id ${ORG},
    timetable_id {{INT}} NOT NULL REFERENCES child_timetables(id) ON DELETE CASCADE,
    weekday {{INT}} NOT NULL,
    attends {{INT}} NOT NULL DEFAULT 1,
    start_time TEXT, finish_time TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_child_timetable_days ON child_timetable_days(timetable_id, weekday)`,
  `CREATE TABLE IF NOT EXISTS documents (
    id {{PK}},
    organisation_id ${ORG},
    entity_type TEXT NOT NULL CHECK (entity_type IN ('child','staff','contract','vehicle','school')),
    entity_id {{INT}} NOT NULL,
    doc_type TEXT NOT NULL,
    reference TEXT,
    vehicle_registration TEXT,
    file_name TEXT, stored_name TEXT, mime_type TEXT, size {{INT}},
    -- The file itself, base64 encoded. Kept in the database so uploads survive
    -- on a host with no writable disk, and so one backup covers everything.
    -- stored_name is only used by older self-hosted installations.
    file_data TEXT,
    second_file_name TEXT, second_mime_type TEXT, second_size {{INT}}, second_file_data TEXT,
    upload_date TEXT NOT NULL DEFAULT {{TODAY}},
    issue_date TEXT, expiry_date TEXT,
    status TEXT NOT NULL DEFAULT 'valid' CHECK (status IN ('valid','invalid','superseded','needs_review')),
    notes TEXT,
    uploaded_by TEXT,
    created_at TEXT NOT NULL DEFAULT {{NOW}}
  )`,
  `CREATE TABLE IF NOT EXISTS exceptions (
    id {{PK}},
    organisation_id ${ORG},
    date TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('child_absence','staff_absence','school_closed','contract_cancelled','journey_cancelled','pay_override','note','extra_journey')),
    -- Which journey this applies to. A trip number targets one journey; without
    -- one, AM means the outward trips, PM the return trips, DAY the whole day.
    leg TEXT NOT NULL DEFAULT 'DAY' CHECK (leg IN ('AM','PM','DAY')),
    trip_seq {{INT}},
    trip_label TEXT,
    trip_kind TEXT,
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
    organisation_id ${ORG},
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
    organisation_id ${ORG},
    from_date TEXT NOT NULL, to_date TEXT NOT NULL,
    description TEXT,
    total {{REAL}} NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'paid',
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT {{NOW}}
  )`,
  `CREATE TABLE IF NOT EXISTS payroll_run_lines (
    id {{PK}},
    organisation_id ${ORG},
    payroll_run_id {{INT}} NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
    staff_id {{INT}} NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    amount {{REAL}} NOT NULL,
    breakdown_json TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS expenses (
    id {{PK}},
    organisation_id ${ORG},
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
    organisation_id ${ORG},
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
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_documents_entity ON documents(organisation_id, entity_type, entity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_exceptions_date ON exceptions(organisation_id, date)`,
  `CREATE INDEX IF NOT EXISTS idx_exceptions_contract ON exceptions(contract_id, date)`,
  `CREATE INDEX IF NOT EXISTS idx_payments_staff ON payments(staff_id, work_date)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(organisation_id, entity_type, entity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_children_contract ON children(contract_id)`,
  `CREATE INDEX IF NOT EXISTS idx_children_org ON children(organisation_id)`,
  `CREATE INDEX IF NOT EXISTS idx_contracts_org ON contracts(organisation_id)`,
  `CREATE INDEX IF NOT EXISTS idx_staff_org ON staff(organisation_id)`,
  `CREATE INDEX IF NOT EXISTS idx_schools_org ON schools(organisation_id)`,
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
const TABLE_ORDER = ['organisations', 'settings', 'users', 'councils', 'schools', 'staff', 'vehicles',
  'contracts', 'contract_schedules', 'contract_trips', 'children', 'contract_trip_children',
  'child_timetables', 'child_timetable_days', 'documents', 'exceptions', 'payroll_runs', 'payments',
  'payroll_run_lines', 'expenses', 'audit_log'];

// Every table holding one firm's data. Each must be filtered by organisation_id.
// "sessions" is deliberately outside this: a session is looked up by its token
// before any organisation is known, and the user it names then fixes the firm.
const TENANT_TABLES = TABLE_ORDER.filter(t => t !== 'organisations');

// Tables whose id comes from a sequence that must be resynchronised after a bulk copy.
const SEQUENCE_TABLES = TABLE_ORDER.filter(t => t !== 'settings');

module.exports = { statements, TABLE_ORDER, TENANT_TABLES, SEQUENCE_TABLES, DIALECTS };
