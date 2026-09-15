'use strict';
// The request handler, with no server attached.
//
// server.js wraps this in a long-running HTTP server for local use.
// api/index.js wraps the same function for a serverless host such as Vercel.
const path = require('path');
const H = require('./http');
const auth = require('./services/auth');
const routes = require('./routes');
const db = require('./db');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/**
 * Prepares the database once per process. On a serverless host a cold start
 * runs this before the first request; later requests reuse the same promise.
 */
let ready = null;
function prepare() {
  if (!ready) {
    ready = db.migrate().catch(e => {
      ready = null;           // let the next request try again
      throw e;
    });
  }
  return ready;
}

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  try {
    if (!pathname.startsWith('/api/')) {
      // Static files. A serverless host usually serves these itself, so this
      // only runs locally or as a fallback.
      if (H.serveStatic(res, PUBLIC_DIR, pathname)) return;
      if (!path.extname(pathname)) { H.serveStatic(res, PUBLIC_DIR, '/index.html'); return; }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    await prepare();

    const cookies = parseCookies(req.headers.cookie);
    const token = cookies.h2s || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const user = await auth.userFor(token);

    let body = {}, files = [];
    if (req.method !== 'GET' && req.method !== 'DELETE') {
      try { const parsed = await H.parseBody(req); body = parsed.fields || {}; files = parsed.files || []; }
      catch (e) { return H.error(res, e.message, 400); }
    }
    const ctx = { req, res, url, path: pathname, query: Object.fromEntries(url.searchParams), body, files, user, token };
    return await routes.handle(ctx);
  } catch (e) {
    console.error('Request failed:', req.method, pathname, e);
    if (!res.headersSent) H.error(res, 'Server error: ' + e.message, 500);
    else res.end();
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

module.exports = { handleRequest, prepare, PUBLIC_DIR };
