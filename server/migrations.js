'use strict';
// Schema upgrades for databases created by an earlier version.
//
// A fresh database is built by schema.statements() and needs none of this.
// An existing one is brought up to date here, in place, keeping its data.
// Every step checks what is actually there first, so running twice is harmless.

const schema = require('./schema');
const crypto = require('crypto');

/** Adds organisation_id to a table that predates multi-tenancy, and fills it in. */
async function addOrgColumn(driver, table, orgId) {
  const cols = await driver.columns(table);
  if (cols.includes('organisation_id')) return false;
  await driver.exec(`ALTER TABLE ${table} ADD COLUMN organisation_id INTEGER`);
  await driver.run(`UPDATE ${table} SET organisation_id = ? WHERE organisation_id IS NULL`, [orgId]);
  // SQLite cannot add NOT NULL to an existing column; the application always
  // supplies the value, and Postgres gets the real constraint.
  if (driver.dialect === 'postgres') {
    await driver.exec(`ALTER TABLE ${table} ALTER COLUMN organisation_id SET NOT NULL`);
    await driver.exec(`ALTER TABLE ${table} ADD CONSTRAINT ${table}_org_fk
      FOREIGN KEY (organisation_id) REFERENCES organisations(id) ON DELETE CASCADE`);
  }
  return true;
}

/**
 * Brings a pre-multi-tenancy database up to date.
 * Everything already in it becomes the first organisation's data.
 */
async function upgradeToMultiTenant(driver, log) {
  const hasUsers = await driver.tableExists('users');
  if (!hasUsers) return false;                       // brand new database
  const userCols = await driver.columns('users');
  if (userCols.includes('organisation_id')) return false;  // already upgraded

  log('Upgrading an existing database to support multiple operating firms.');

  // 1. The organisations table, and one organisation for everything already here.
  for (const stmt of schema.statements(driver.dialect)) {
    if (/CREATE TABLE IF NOT EXISTS organisations/.test(stmt)) { await driver.exec(stmt); break; }
  }
  let name = 'My transport company';
  try {
    const row = await driver.get("SELECT value FROM settings WHERE key = 'company_name'");
    if (row && row.value) name = row.value;
  } catch (_) { /* settings may not exist yet */ }

  let org = await driver.get('SELECT id FROM organisations ORDER BY id LIMIT 1');
  if (!org) {
    const id = await driver.insertReturningId('INSERT INTO organisations (name) VALUES (?)', [name]);
    org = { id };
    log(`  Created organisation "${name}" and assigned all existing records to it.`);
  }
  const orgId = org.id;

  // 2. Every data table gains organisation_id.
  for (const table of schema.TENANT_TABLES) {
    if (!(await driver.tableExists(table))) continue;
    if (table === 'settings' || table === 'users') continue;   // rebuilt below
    if (await addOrgColumn(driver, table, orgId)) log(`  ${table}: added organisation_id`);
  }

  // 3. settings moves from one global row per key to one row per firm per key.
  if (await driver.tableExists('settings')) {
    const existing = await driver.all('SELECT key, value FROM settings');
    await driver.exec('DROP TABLE settings');
    for (const stmt of schema.statements(driver.dialect)) {
      if (/CREATE TABLE IF NOT EXISTS settings/.test(stmt)) { await driver.exec(stmt); break; }
    }
    for (const row of existing) {
      await driver.run('INSERT INTO settings (organisation_id, key, value) VALUES (?,?,?)', [orgId, row.key, row.value]);
    }
    log(`  settings: moved ${existing.length} to the new organisation`);
  }

  // 4. users: sign-in moves from a username to an email address, and roles go away.
  //    Everyone with a login is an administrator of their own firm.
  const users = await driver.all('SELECT * FROM users');
  await driver.exec('DROP TABLE users');
  for (const stmt of schema.statements(driver.dialect)) {
    if (/CREATE TABLE IF NOT EXISTS users/.test(stmt) || /idx_users_email/.test(stmt)) await driver.exec(stmt);
  }
  let kept = 0;
  const seen = new Set();
  for (const u of users) {
    // An old account had a username, not an email. Keep the address if it looks
    // like one, otherwise park it under the organisation's placeholder domain so
    // the account still exists and the owner can correct it.
    let email = (u.email && String(u.email).includes('@')) ? u.email
      : `${String(u.username || 'user').toLowerCase()}@example.invalid`;
    if (seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    await driver.run(
      'INSERT INTO users (organisation_id, email, password_hash, name, active, created_at) VALUES (?,?,?,?,?,?)',
      [orgId, email, u.password_hash, u.name, u.active === undefined ? 1 : u.active, u.created_at || null]);
    kept++;
  }
  log(`  users: migrated ${kept} account(s) to email sign-in, roles removed`);

  // 5. A contract code only needs to be unique inside one firm.
  if (driver.dialect === 'postgres') {
    await driver.exec('ALTER TABLE contracts DROP CONSTRAINT IF EXISTS contracts_code_key');
  }
  log('Upgrade complete.');
  return true;
}

/** Adds a column to a table that predates it. Safe to run repeatedly. */
async function addColumn(driver, table, column, definition, log) {
  if (!(await driver.tableExists(table))) return;
  const cols = await driver.columns(table);
  if (cols.includes(column)) return;
  await driver.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  log(`  ${table}: added ${column}`);
}

/**
 * Allows the new 'extra_journey' exception type on a database created before it.
 * SQLite cannot alter a CHECK constraint, so its table is rebuilt; Postgres
 * replaces the constraint in place.
 */
async function widenExceptionTypes(driver, log) {
  if (!(await driver.tableExists('exceptions'))) return;
  try {
    if (driver.dialect === 'postgres') {
      const row = await driver.get(
        `SELECT conname FROM pg_constraint
         WHERE conrelid = 'exceptions'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%child_absence%'`);
      if (!row) return;
      const def = await driver.get(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ?`, [row.conname]);
      if (def && def.def.includes('extra_journey')) return;
      await driver.exec(`ALTER TABLE exceptions DROP CONSTRAINT ${row.conname}`);
      await driver.exec(`ALTER TABLE exceptions ADD CONSTRAINT ${row.conname} CHECK (type IN
        ('child_absence','staff_absence','school_closed','contract_cancelled','journey_cancelled','pay_override','note','extra_journey'))`);
      log('  exceptions: one-off extra journeys are now allowed');
      return;
    }
    // SQLite: only rebuild if the old constraint is actually in the way.
    const info = await driver.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'exceptions'");
    if (!info || info.sql.includes('extra_journey')) return;
    const rows = await driver.all('SELECT * FROM exceptions');
    const cols = await driver.columns('exceptions');
    await driver.exec('ALTER TABLE exceptions RENAME TO exceptions_old');
    for (const stmt of schema.statements('sqlite')) {
      if (/CREATE TABLE IF NOT EXISTS exceptions /.test(stmt)) { await driver.exec(stmt); break; }
    }
    const shared = (await driver.columns('exceptions')).filter(c => cols.includes(c));
    for (const r of rows) {
      await driver.run(
        `INSERT INTO exceptions (${shared.join(',')}) VALUES (${shared.map(() => '?').join(',')})`,
        shared.map(c => (r[c] === undefined ? null : r[c])));
    }
    await driver.exec('DROP TABLE exceptions_old');
    log(`  exceptions: rebuilt to allow one-off extra journeys (${rows.length} kept)`);
  } catch (e) {
    log(`  exceptions: could not widen the type list (${e.message})`);
    throw e;
  }
}

async function widenDocumentStatuses(driver, log) {
  if (!(await driver.tableExists('documents'))) return;
  if (driver.dialect === 'postgres') {
    const rows = await driver.all(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'documents'::regclass AND contype = 'c'`);
    const constraint = rows.find(row => row.def.includes('superseded'));
    if (!constraint || constraint.def.includes('needs_review')) return;
    const name = '"' + constraint.conname.replace(/"/g, '""') + '"';
    await driver.exec(`ALTER TABLE documents DROP CONSTRAINT ${name}, ADD CONSTRAINT ${name}
      CHECK (status IN ('valid','invalid','superseded','needs_review'))`);
  } else {
    const info = await driver.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'documents'");
    if (!info || info.sql.includes('needs_review')) return;
    const columns = await driver.columns('documents');
    const statement = schema.statements('sqlite').find(stmt => /CREATE TABLE IF NOT EXISTS documents /.test(stmt));
    await driver.exec('BEGIN IMMEDIATE');
    try {
      await driver.exec(statement.replace('CREATE TABLE IF NOT EXISTS documents', 'CREATE TABLE documents_review_upgrade'));
      const shared = (await driver.columns('documents_review_upgrade')).filter(column => columns.includes(column));
      await driver.exec(`INSERT INTO documents_review_upgrade (${shared.join(',')}) SELECT ${shared.join(',')} FROM documents`);
      await driver.exec('DROP TABLE documents');
      await driver.exec('ALTER TABLE documents_review_upgrade RENAME TO documents');
      await driver.exec('COMMIT');
    } catch (error) { await driver.exec('ROLLBACK'); throw error; }
  }
  log('  documents: auto input review status is now allowed');
}

/** Runs any pending upgrades, then makes sure every table and index exists. */
async function applyMigrations(driver, log) {
  await upgradeToMultiTenant(driver, log);
  // Uploaded files moved from a local folder into the database, so they survive
  // on a host with no writable disk.
  await addColumn(driver, 'documents', 'file_data', 'TEXT', log);
  await addColumn(driver, 'documents', 'vehicle_registration', 'TEXT', log);
  for (const [column, definition] of [['second_file_name', 'TEXT'], ['second_mime_type', 'TEXT'], ['second_size', driver.dialect === 'postgres' ? 'BIGINT' : 'INTEGER'], ['second_file_data', 'TEXT']]) {
    await addColumn(driver, 'documents', column, definition, log);
  }
  await widenDocumentStatuses(driver, log);
  // An exception can now name the individual journey it applies to, for days
  // that run more than an outward and a return trip.
  await addColumn(driver, 'exceptions', 'trip_seq', 'INTEGER', log);
  await addColumn(driver, 'exceptions', 'trip_label', 'TEXT', log);
  await addColumn(driver, 'exceptions', 'trip_kind', 'TEXT', log);
  await widenExceptionTypes(driver, log);
  for (const stmt of schema.statements(driver.dialect)) await driver.exec(stmt);
}

// Persist the exact schema/migration fingerprint so new serverless instances
// need only two reads, rather than repeating every inspection and CREATE.
// Changes to either the schema or an upgrade automatically invalidate it.
async function run(driver, log = () => {}) {
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify([
    schema.statements(driver.dialect),
    ...[addOrgColumn, upgradeToMultiTenant, addColumn, widenExceptionTypes, widenDocumentStatuses, applyMigrations].map(String),
  ])).digest('hex');
  if (await driver.tableExists('h2s_schema_version')) {
    const current = await driver.get('SELECT fingerprint FROM h2s_schema_version WHERE id = 1');
    if (current?.fingerprint === fingerprint) return;
  }
  await applyMigrations(driver, log);
  await driver.exec('CREATE TABLE IF NOT EXISTS h2s_schema_version (id INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL)');
  await driver.run(`INSERT INTO h2s_schema_version (id, fingerprint) VALUES (1, ?)
    ON CONFLICT (id) DO UPDATE SET fingerprint = excluded.fingerprint`, [fingerprint]);
}

module.exports = { run, upgradeToMultiTenant };
