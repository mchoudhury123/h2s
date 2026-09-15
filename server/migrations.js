'use strict';
// Schema upgrades for databases created by an earlier version.
//
// A fresh database is built by schema.statements() and needs none of this.
// An existing one is brought up to date here, in place, keeping its data.
// Every step checks what is actually there first, so running twice is harmless.

const schema = require('./schema');

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

/** Runs any pending upgrades, then makes sure every table and index exists. */
async function run(driver, log = () => {}) {
  await upgradeToMultiTenant(driver, log);
  // Uploaded files moved from a local folder into the database, so they survive
  // on a host with no writable disk.
  await addColumn(driver, 'documents', 'file_data', 'TEXT', log);
  for (const stmt of schema.statements(driver.dialect)) await driver.exec(stmt);
}

module.exports = { run, upgradeToMultiTenant };
