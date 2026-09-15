'use strict';
const http = require('http');
const path = require('path');
const H = require('./http');
const auth = require('./services/auth');
const routes = require('./routes');

const db = require('./db');

const PORT = Number(process.env.PORT || 4000);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  try {
    if (pathname.startsWith('/api/')) {
      const cookies = parseCookies(req.headers.cookie);
      const token = cookies.h2s || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const user = auth.userFor(token);
      let body = {}, files = [];
      if (req.method !== 'GET' && req.method !== 'DELETE') {
        try { const parsed = await H.parseBody(req); body = parsed.fields || {}; files = parsed.files || []; }
        catch (e) { return H.error(res, e.message, 400); }
      }
      const ctx = { req, res, url, path: pathname, query: Object.fromEntries(url.searchParams), body, files, user, token };
      return await routes.handle(ctx);
    }
    if (H.serveStatic(res, PUBLIC_DIR, pathname)) return;
    // SPA fallback
    if (!path.extname(pathname)) { H.serveStatic(res, PUBLIC_DIR, '/index.html'); return; }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (e) {
    console.error('Request failed:', req.method, pathname, e);
    if (!res.headersSent) H.error(res, 'Server error: ' + e.message, 500);
    else res.end();
  }
});

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function start() {
  try {
    await db.migrate(msg => console.log('  ' + msg));
  } catch (e) {
    console.error(`\n  Could not prepare the database.`);
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
    console.log(`\n  Home-to-School Transport CRM`);
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
