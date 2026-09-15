'use strict';
// Long-running server, for running the CRM on your own machine or a VPS.
// A serverless host uses api/index.js instead, which shares the same handler.
const http = require('http');
const { handleRequest } = require('./app');
const db = require('./db');

const PORT = Number(process.env.PORT || 4000);
const server = http.createServer(handleRequest);

async function start() {
  try {
    await db.migrate(msg => console.log('  ' + msg));
  } catch (e) {
    console.error('\n  Could not prepare the database.');
    console.error(`  ${db.describe}`);
    console.error(`  ${e.message}\n`);
    if (db.dialect === 'postgres') {
      console.error('  Check DATABASE_URL in your .env file. Supabase shows it under');
      console.error('  Project Settings > Database > Connection string.\n');
    }
    process.exit(1);
  }
  const orgs = Number((await db.get('SELECT COUNT(*) AS n FROM organisations')).n);
  server.listen(PORT, () => {
    console.log('\n  Home-to-School Transport CRM');
    console.log(`  Database: ${db.describe}`);
    console.log(`  ${orgs} ${orgs === 1 ? 'business' : 'businesses'} registered`);
    console.log(`  Running at http://localhost:${PORT}\n`);
    if (!orgs) console.log('  No businesses yet. Open that address and choose "Create an account".\n');
  });
}

start();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    server.close();
    try { await db.close(); } catch (_) {}
    process.exit(0);
  });
}
