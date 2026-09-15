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

main().catch(async e => {
  console.error('\nCould not connect:', e.message.split('\n')[0]);
  const hints = connectionHint(e.message, process.env.DATABASE_URL);
  if (hints.length) console.error('\n' + hints.join('\n'));
  try { await database.close(); } catch (_) {}
  process.exit(1);
});
