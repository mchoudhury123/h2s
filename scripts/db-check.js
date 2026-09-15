/**
 * Checks the database connection and reports what is in it.
 *   npm run db:check
 * Uses Supabase when DATABASE_URL is set in .env, otherwise the local SQLite file.
 */
'use strict';
require('../server/env').load();
const database = require('../server/db');
const schema = require('../server/schema');

async function main() {
  console.log(`\nDatabase: ${database.describe}`);
  const started = Date.now();
  await database.get('SELECT 1 AS ok');
  console.log(`Connected in ${Date.now() - started} ms\n`);

  let missing = 0;
  for (const table of schema.TABLE_ORDER) {
    try {
      const row = await database.get(`SELECT COUNT(*) AS n FROM ${table}`);
      console.log(`  ${table.padEnd(18)} ${String(row.n).padStart(6)} rows`);
    } catch (e) {
      missing++;
      console.log(`  ${table.padEnd(18)}   missing`);
    }
  }
  if (missing) {
    console.log(`\n${missing} table(s) are missing. Create them with:  npm run db:push -- --schema-only`);
  } else {
    console.log('\nAll tables present.');
  }

  // A round trip per query matters on a remote database, so report the real latency.
  const t = Date.now();
  for (let i = 0; i < 5; i++) await database.get('SELECT 1 AS ok');
  console.log(`Round trip: ${Math.round((Date.now() - t) / 5)} ms per query`);

  await database.close();
}

main().catch(async e => {
  console.error('\nCould not connect:', e.message);
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ENETUNREACH/.test(e.message)) {
    console.error('\nSupabase direct connections (db.<project>.supabase.co) are IPv6 only.');
    console.error('On an IPv4 network use the Session pooler connection string instead.');
  }
  if (/password authentication failed/i.test(e.message)) {
    console.error('\nThe password in DATABASE_URL was rejected.');
  }
  try { await database.close(); } catch (_) {}
  process.exit(1);
});
