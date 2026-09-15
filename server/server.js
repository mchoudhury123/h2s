'use strict';
const http = require('http');
const path = require('path');
const H = require('./http');
const auth = require('./services/auth');
const routes = require('./routes');
const { getSetting } = require('./db');

const PORT = Number(process.env.PORT || 4000);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

if (auth.ensureSeedAdmin()) {
  console.log('Created default administrator account: admin / admin123  (change this on first sign-in)');
}

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

server.listen(PORT, () => {
  const name = getSetting('company_name', 'Home-to-School Transport');
  console.log(`\n  ${name} CRM`);
  console.log(`  Running at http://localhost:${PORT}\n`);
});
