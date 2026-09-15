/**
 * Copies the local SQLite database into the Postgres database named by DATABASE_URL
 * (your Supabase project). Creates the tables first if they are not there.
 *
 *   npm run db:push              copy, refusing to touch a Postgres database that already has rows
 *   npm run db:push -- --replace clear the Postgres tables first, then copy
 *   npm run db:push -- --schema-only   create the tables and stop
 *
 * The local SQLite file is only read, never changed.
 */
'use strict';
require('../server/env').load();

const path = require('path');
const fs = require('fs');
const schema = require('../server/schema');
const sqliteDriver = require('../server/drivers/sqlite');
const postgresDriver = require('../server/drivers/postgres');

const REPLACE = process.argv.includes('--replace');
const SCHEMA_ONLY = process.argv.includes('--schema-only');
const BATCH = 200;

async function main() {
  if (!process.env.DATABASE_URL) {
    fail('DATABASE_URL is not set.',
      'Create a file called .env in the project root containing:',
      '',
      '  DATABASE_URL=postgresql://postgres:YOUR-PASSWORD@db.YOUR-PROJECT.supabase.co:5432/postgres',
      '',
      'Supabase shows this under Project Settings > Database > Connection string.');
  }

  const sqlitePath = process.env.H2S_DB || path.join(__dirname, '..', 'data', 'h2s.db');
  const target = postgresDriver.create();
  console.log(`Target: ${target.describe}`);

  console.log('Creating tables if they do not exist…');
  await target.migrate();
  if (SCHEMA_ONLY) {
    console.log('Schema is in place. Stopping because --schema-only was given.');
    await target.close();
    return;
  }

  if (!fs.existsSync(sqlitePath)) {
    console.log(`\nNo local SQLite database at ${sqlitePath}, so there is nothing to copy.`);
    console.log('The Supabase tables are ready. Run "npm run seed" to load demo data into them.');
    await target.close();
    return;
  }
  const source = sqliteDriver.create({ file: sqlitePath });
  console.log(`Source: ${source.describe}`);

  // Refuse to overwrite a database that already holds records, unless asked to.
  const existing = [];
  for (const table of schema.TABLE_ORDER) {
    const row = await target.get(`SELECT COUNT(*) AS n FROM ${table}`);
    if (Number(row.n) > 0) existing.push(`${table} (${row.n})`);
  }
  if (existing.length && !REPLACE) {
    await source.close(); await target.close();
    fail('The Supabase database already contains records:',
      '  ' + existing.join(', '),
      '',
      'Re-run with --replace to clear those tables and copy the local data over them:',
      '  npm run db:push -- --replace');
  }

  if (REPLACE && existing.length) {
    console.log('\nClearing existing rows…');
    for (const table of [...schema.TABLE_ORDER].reverse()) {
      await target.exec(`DELETE FROM ${table}`);
    }
  }

  console.log('\nCopying rows…');
  let grandTotal = 0;
  for (const table of schema.TABLE_ORDER) {
    const rows = await source.all(`SELECT * FROM ${table}`);
    if (!rows.length) { console.log(`  ${table.padEnd(18)} 0`); continue; }
    const columns = Object.keys(rows[0]);
    const colList = columns.join(', ');

    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH);
      const values = [];
      const placeholders = slice.map(row => {
        const marks = columns.map(c => { values.push(row[c] === undefined ? null : row[c]); return '?'; });
        return `(${marks.join(',')})`;
      });
      await target.run(`INSERT INTO ${table} (${colList}) VALUES ${placeholders.join(',')}`, values);
    }
    grandTotal += rows.length;
    console.log(`  ${table.padEnd(18)} ${rows.length}`);
  }

  // Identity columns were given explicit ids, so their sequences must catch up.
  console.log('\nResynchronising id sequences…');
  await target.resetSequences();

  // Verify both sides agree before declaring success.
  console.log('\nVerifying…');
  let mismatch = false;
  for (const table of schema.TABLE_ORDER) {
    const a = Number((await source.get(`SELECT COUNT(*) AS n FROM ${table}`)).n);
    const b = Number((await target.get(`SELECT COUNT(*) AS n FROM ${table}`)).n);
    if (a !== b) { console.log(`  MISMATCH ${table}: local ${a}, Supabase ${b}`); mismatch = true; }
  }

  await source.close();
  await target.close();

  if (mismatch) { console.error('\nCopy finished with mismatches. Nothing was removed locally.'); process.exit(1); }
  console.log(`\nDone. ${grandTotal} rows copied and verified.`);
  console.log('The application will now use Supabase because DATABASE_URL is set in .env.');
}

function fail(...lines) {
  console.error('\n' + lines.join('\n') + '\n');
  process.exit(1);
}

function connectionHint(message, url) {
  const lines = [];
  const direct = /db\.[a-z0-9]+\.supabase\.co/i.test(url || '');
  const pooler = /pooler\.supabase\.com/i.test(url || '');
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ENETUNREACH/.test(message)) {
    if (/tenant or user not found|tenant\/user/i.test(message)) {
      lines.push('The pooler did not recognise that project. Two things to check:',
        '  - the region in the host name (aws-0-REGION.pooler.supabase.com) must match your project',
        '  - the user must be postgres.PROJECT-REF, not plain postgres',
        'Copy the Session pooler string straight from Supabase rather than editing it by hand.');
    } else if (direct) {
      lines.push('The direct Supabase host resolves over IPv6 only, and it could not be reached from here.',
        'Use the Session pooler string instead: Supabase lists it under',
        'Project Settings > Database > Connection string > Session pooler.');
    } else {
      lines.push('The database host could not be reached. Check the host name in DATABASE_URL.');
    }
  }
  if (/password authentication failed/i.test(message)) {
    lines.push('The password in DATABASE_URL was rejected. Reset it under Project Settings > Database.');
  }
  if (/self.signed|certificate/i.test(message)) {
    lines.push('TLS negotiation failed. Leave sslmode out of the URL; the driver handles TLS itself.');
  }
  return lines;
}

main().catch(e => {
  console.error('\nCopy failed:', e.message.split('\n')[0]);
  const hints = connectionHint(e.message, process.env.DATABASE_URL);
  if (hints.length) console.error('\n' + hints.join('\n'));
  process.exit(1);
});
