/**
 * Checks the things a serverless host needs, which a long-running server hides.
 *
 *   - the serverless entry point answers requests at all
 *   - a session survives the process that created it going away
 *   - an uploaded file is stored in the database, not on disk
 *   - nothing is written to the filesystem while handling a request
 *
 * Run with:  npm run test:serverless
 */
'use strict';
require('../server/env').load();

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.SERVERLESS_TEST_PORT || 4123);
const BASE = `http://127.0.0.1:${PORT}`;
const stamp = Date.now().toString().slice(-8);

let pass = 0;
const failures = [];
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { failures.push(label); console.log('  FAIL ' + label); }
};
const section = t => console.log('\n' + t);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Runs one instance of the serverless entry point, exactly as the host would:
 * a fresh process, no shared memory with the last one.
 */
function startInstance() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', path.join(__dirname, 'serverless-host.js')], {
      env: { ...process.env, PORT: String(PORT), VERCEL: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', d => {
      out += d.toString();
      if (out.includes('instance ready')) resolve(child);
    });
    child.stderr.on('data', d => process.stderr.write('    [instance] ' + d.toString()));
    child.on('exit', c => { if (!out.includes('instance ready')) reject(new Error('instance exited with ' + c)); });
    setTimeout(() => reject(new Error('instance did not start in time')), 30000);
  });
}
function stopInstance(child) {
  return new Promise(resolve => { child.on('exit', resolve); child.kill(); });
}

async function call(method, urlPath, { cookie, body, contentType } = {}) {
  const opts = { method, headers: {} };
  if (cookie) opts.headers.Cookie = cookie;
  if (body !== undefined) {
    opts.headers['Content-Type'] = contentType || 'application/json';
    opts.body = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  }
  const res = await fetch(BASE + urlPath, opts);
  const setCookie = res.headers.get('set-cookie');
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data, cookie: setCookie ? setCookie.split(';')[0] : cookie };
}

async function main() {
  const db = require('../server/db');

  section('1. The serverless entry point answers');
  let instance = await startInstance();
  const ping = await call('GET', '/api/me');
  ok(ping.status === 401, 'an unauthenticated request is refused, not a 404');

  section('2. A business registers through the function');
  const reg = await call('POST', '/api/register', {
    body: { business_name: 'Serverless Check ' + stamp, email: `sl${stamp}@example.test`, password: 'serverless1' },
  });
  ok(reg.status === 201, 'registration succeeds');
  const orgId = reg.data.user && reg.data.user.organisation_id;
  const cookie = reg.cookie;
  ok(!!cookie, 'a session cookie comes back');

  const me = await call('GET', '/api/me', { cookie });
  ok(me.status === 200 && me.data.user.organisation_id === orgId, 'the cookie identifies the business');

  section('3. A session survives the instance disappearing');
  await stopInstance(instance);
  instance = await startInstance();                 // a brand new process, no shared memory
  const afterRestart = await call('GET', '/api/me', { cookie });
  ok(afterRestart.status === 200 && afterRestart.data.user.organisation_id === orgId,
    'the same cookie still works on a fresh instance');

  const school = await call('POST', '/api/schools', { cookie, body: { name: 'Serverless School ' + stamp } });
  ok(school.status === 201, 'the restored session can still write');

  section('4. An uploaded file is kept in the database');
  const child = await call('POST', '/api/children', { cookie, body: { first_name: 'Serverless', last_name: 'Child' } });
  ok(child.status === 201, 'a child is created');

  const boundary = '----h2scheck' + stamp;
  const fileBody = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="entity_type"\r\n\r\nchild\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="entity_id"\r\n\r\n${child.data.id}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="doc_type"\r\n\r\nCare Plan\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="plan.txt"\r\nContent-Type: text/plain\r\n\r\n`),
    Buffer.from('Serverless upload check ' + stamp),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const upload = await call('POST', '/api/documents', {
    cookie, body: fileBody, contentType: `multipart/form-data; boundary=${boundary}`,
  });
  ok(upload.status === 201, 'the document uploads');
  ok(upload.data.has_file === 1 || upload.data.has_file === true, 'the response says a file is attached');
  ok(upload.data.file_data === undefined, 'the file bytes are not echoed back in the response');

  const stored = await db.get('SELECT file_data, stored_name FROM documents WHERE id = ?', [upload.data.id]);
  ok(!!stored.file_data, 'the file is held in the database');
  ok(!stored.stored_name, 'nothing was written to a local folder');

  // A different instance must be able to serve it back.
  await stopInstance(instance);
  instance = await startInstance();
  const download = await fetch(`${BASE}/api/documents/${upload.data.id}/file`, { headers: { Cookie: cookie } });
  const text = await download.text();
  ok(download.status === 200 && text.includes('Serverless upload check'), 'a fresh instance serves the file back');
  ok(download.headers.get('content-disposition').includes('plan.txt'), 'the original file name is kept');

  section('5. The dashboard works on a cold instance');
  await stopInstance(instance);
  instance = await startInstance();
  const started = Date.now();
  const dash = await call('GET', '/api/dashboard', { cookie });
  ok(dash.status === 200, `the dashboard renders from cold in ${Date.now() - started} ms`);

  section('6. Signing out is immediate everywhere');
  await call('POST', '/api/logout', { cookie });
  await stopInstance(instance);
  instance = await startInstance();
  const afterLogout = await call('GET', '/api/me', { cookie });
  ok(afterLogout.status === 401, 'the cookie is dead on every instance, not just the one that signed out');

  section('7. Nothing was written to the uploads folder');
  const uploadDir = path.join(__dirname, '..', 'uploads');
  const files = fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir).filter(f => f !== '.gitkeep') : [];
  ok(files.length === 0, 'the uploads folder is still empty, so a read-only disk is fine');

  await stopInstance(instance);

  section('Cleaning up');
  await db.run('DELETE FROM organisations WHERE id = ?', [orgId]);
  const left = await db.get('SELECT COUNT(*) AS n FROM organisations WHERE id = ?', [orgId]);
  ok(Number(left.n) === 0, 'the test business was removed');
  await db.close();

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
}

main().catch(async e => {
  console.error('\nServerless check failed to run:', e.stack || e.message);
  try { const db = require('../server/db'); await db.close(); } catch (_) {}
  process.exit(1);
});
