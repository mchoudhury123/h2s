'use strict';
// API routing.
//
// Every request after sign-in belongs to exactly one operating firm. ctx.org is
// that firm's id, taken from the session and never from the request, and every
// query below filters on it. Everyone who can sign in is an administrator of
// their own firm, so there are no roles or permission levels.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { all, get, run, transaction, getSetting, setSetting, insert, update } = require('./db');
const H = require('./http');
const auth = require('./services/auth');
const audit = require('./services/audit');
const cal = require('./services/calendar');
const compliance = require('./services/compliance');
const wages = require('./services/wages');
const finance = require('./services/finance');
const search = require('./services/search');
const dash = require('./services/dashboard');
const reports = require('./reports');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- column whitelists ----------
const COLS = {
  councils: ['name', 'contact_name', 'phone', 'email', 'address', 'notes', 'active'],
  schools: ['name', 'address', 'postcode', 'phone', 'contact_name', 'email', 'open_time', 'close_time', 'notes', 'active'],
  staff: ['type', 'first_name', 'last_name', 'address', 'postcode', 'phone', 'email', 'emergency_contact_name', 'emergency_contact_phone', 'status', 'licensing_authority', 'badge_number', 'dbs_number', 'default_day_rate', 'availability', 'preferred_areas', 'start_date', 'notes'],
  vehicles: ['driver_id', 'registration', 'make', 'model', 'seats', 'wheelchair_accessible', 'colour', 'notes', 'active'],
  contracts: ['code', 'name', 'council_id', 'council_ref', 'school_id', 'driver_id', 'pa_id', 'vehicle_id', 'requires_pa', 'status', 'start_date', 'end_date', 'days_of_week', 'am_pickup_time', 'am_arrival_time', 'pm_finish_time', 'pm_dropoff_time', 'route_info', 'am_notes', 'pm_notes', 'income_per_day', 'income_basis', 'driver_pay_per_day', 'pa_pay_per_day', 'pay_basis', 'other_costs_per_day', 'notes'],
  children: ['first_name', 'last_name', 'dob', 'address', 'postcode', 'parent_name', 'parent_phone', 'emergency_contact_name', 'emergency_contact_phone', 'school_id', 'contract_id', 'council_ref', 'pickup_time', 'arrival_time', 'finish_time', 'dropoff_time', 'medical_info', 'sen_needs', 'conditions', 'mobility', 'wheelchair', 'behaviour', 'communication', 'allergies', 'safeguarding_info', 'risk_info', 'notes', 'status'],
  expenses: ['date', 'contract_id', 'category', 'amount', 'description'],
};
// Numeric columns declared NOT NULL DEFAULT 0. A blank box means zero, never null.
const ZERO_IF_BLANK = {
  contracts: ['income_per_day', 'driver_pay_per_day', 'pa_pay_per_day', 'other_costs_per_day', 'requires_pa'],
  staff: ['default_day_rate'],
  children: ['wheelchair'],
  vehicles: ['wheelchair_accessible', 'active'],
  expenses: ['amount'],
};
function zeroBlanks(table, data) {
  for (const f of ZERO_IF_BLANK[table] || []) if (data[f] === null || data[f] === '') data[f] = 0;
}

// ---------- routing ----------
const routes = [];
function route(method, pattern, handler, { open = false } = {}) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, regex, keys, handler, open });
}
const openRoute = (method, pattern, handler) => route(method, pattern, handler, { open: true });

async function handle(ctx) {
  const { req, res } = ctx;
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.regex.exec(ctx.path);
    if (!m) continue;
    ctx.params = {};
    r.keys.forEach((k, i) => { ctx.params[k] = decodeURIComponent(m[i + 1]); });
    if (!r.open) {
      if (!ctx.user) return H.error(res, 'Not signed in', 401);
      // The firm comes from the session, never from anything the caller sends.
      ctx.org = ctx.user.organisation_id;
      if (!ctx.org) return H.error(res, 'Your account is not linked to a business', 403);
    }
    return await r.handler(ctx);
  }
  return H.error(res, 'Unknown endpoint: ' + ctx.path, 404);
}

function friendly(e) {
  const m = String(e.message || e);
  if (/unique|duplicate/i.test(m) && /code/i.test(m)) return 'That contract code is already in use';
  if (/unique|duplicate/i.test(m) && /email/i.test(m)) return 'That email address already has an account';
  if (/FOREIGN KEY|violates foreign key/i.test(m)) return 'This record is still linked to other records';
  if (/NOT NULL|null value in column/i.test(m)) return 'A required field is missing';
  if (/CHECK constraint|violates check/i.test(m)) return 'One of the fields has an invalid value';
  return m.split('\n')[0];
}

// =====================================================================
// Registration and sign-in
// =====================================================================
openRoute('POST', '/api/register', async ctx => {
  const { email, business_name, password, name } = ctx.body;
  let result;
  try { result = await auth.register({ email, business_name, password, name }); }
  catch (e) { return H.error(ctx.res, friendly(e), 400); }
  if (result.error) return H.error(ctx.res, result.error, 400);

  const signedIn = await auth.login(email, password);
  await audit.logAction(signedIn.user, 'organisation', result.organisation.id, result.organisation.name,
    'create', `Registered ${result.organisation.name}`);
  ctx.res.setHeader('Set-Cookie', sessionCookie(signedIn.token));
  H.json(ctx.res, { user: signedIn.user, token: signedIn.token }, 201);
});

openRoute('POST', '/api/login', async ctx => {
  const { email, password } = ctx.body;
  const r = await auth.login(email, password);
  if (!r) return H.error(ctx.res, 'Incorrect email address or password', 401);
  await audit.logAction(r.user, 'user', r.user.id, r.user.name, 'login', 'Signed in');
  ctx.res.setHeader('Set-Cookie', sessionCookie(r.token));
  H.json(ctx.res, { user: r.user, token: r.token });
});

openRoute('POST', '/api/logout', async ctx => {
  if (ctx.token) auth.logout(ctx.token);
  ctx.res.setHeader('Set-Cookie', 'h2s=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  H.json(ctx.res, { ok: true });
});

function sessionCookie(token) {
  const secure = process.env.H2S_SECURE_COOKIE === '1' ? '; Secure' : '';
  return `h2s=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=43200${secure}`;
}

route('GET', '/api/me', async ctx => {
  H.json(ctx.res, {
    user: ctx.user,
    organisation: await get('SELECT id, name FROM organisations WHERE id = ?', [ctx.org]),
    settings: {
      amber_days: await compliance.amberDays(ctx.org),
      company_name: await getSetting(ctx.org, 'company_name', ctx.user.organisation_name),
    },
    doc_types: compliance.DOC_TYPES,
  });
});

// =====================================================================
// Generic CRUD, always scoped to the signed-in firm
// =====================================================================
function crud(name, table, opts = {}) {
  const cols = COLS[table];
  const label = opts.label || (r => r.name || r.code || `${r.first_name} ${r.last_name}`);
  const type = opts.auditType || name;

  route('GET', `/api/${name}`, async ctx => {
    H.json(ctx.res, await opts.list(ctx));
  });

  route('GET', `/api/${name}/:id`, async ctx => {
    const row = await opts.detail(ctx.org, Number(ctx.params.id), ctx);
    if (!row) return H.error(ctx.res, 'Record not found', 404);
    H.json(ctx.res, row);
  });

  route('POST', `/api/${name}`, async ctx => {
    const data = { ...ctx.body };
    delete data.organisation_id;
    if (opts.before) { const err = await opts.before(ctx.org, data, ctx); if (err) return H.error(ctx.res, err, 400); }
    zeroBlanks(table, data);
    let id;
    try { id = await insert(table, data, cols, null, ctx.org); }
    catch (e) { return H.error(ctx.res, friendly(e), 400); }
    const row = await owned(table, id, ctx.org);
    await audit.logAction(ctx.user, type, id, label(row), 'create', `Created ${opts.singular || name} ${label(row)}`);
    if (opts.after) await opts.after(ctx.org, row, ctx, null);
    H.json(ctx.res, row, 201);
  });

  route('PUT', `/api/${name}/:id`, async ctx => {
    const id = Number(ctx.params.id);
    const before = await owned(table, id, ctx.org);
    if (!before) return H.error(ctx.res, 'Record not found', 404);
    const data = { ...ctx.body };
    delete data.id;
    delete data.organisation_id;
    if (opts.before) { const err = await opts.before(ctx.org, data, ctx, before); if (err) return H.error(ctx.res, err, 400); }
    zeroBlanks(table, data);
    try { await update(table, id, data, cols, null, ctx.org); }
    catch (e) { return H.error(ctx.res, friendly(e), 400); }
    const after = await owned(table, id, ctx.org);
    await audit.logDiff(ctx.user, type, id, label(after), before, data, cols,
      opts.resolve ? (col, v) => opts.resolve(ctx.org, col, v) : null);
    if (opts.after) await opts.after(ctx.org, after, ctx, before);
    H.json(ctx.res, after);
  });

  route('DELETE', `/api/${name}/:id`, async ctx => {
    const id = Number(ctx.params.id);
    const row = await owned(table, id, ctx.org);
    if (!row) return H.error(ctx.res, 'Record not found', 404);
    if (opts.guard) { const msg = await opts.guard(ctx.org, row); if (msg) return H.error(ctx.res, msg, 409); }
    try {
      await transaction(async tx => {
        if (opts.docEntity) await deleteDocumentsFor(ctx.org, opts.docEntity, id, tx);
        if (opts.cascade) await opts.cascade(ctx.org, id, tx);
        await tx.run(`DELETE FROM ${table} WHERE id = ? AND organisation_id = ?`, [id, ctx.org]);
      });
    } catch (e) { return H.error(ctx.res, friendly(e), 409); }
    await audit.logAction(ctx.user, type, id, label(row), 'delete', `Deleted ${opts.singular || name} ${label(row)}`);
    H.json(ctx.res, { ok: true });
  });
}

/** Fetches one row only if it belongs to this firm. Returns undefined otherwise. */
function owned(table, id, orgId) {
  return get(`SELECT * FROM ${table} WHERE id = ? AND organisation_id = ?`, [id, orgId]);
}

// =====================================================================
// Councils
// =====================================================================
crud('councils', 'councils', {
  singular: 'council',
  list: ctx => all(`SELECT c.*,
      (SELECT COUNT(*) FROM contracts WHERE council_id = c.id AND organisation_id = c.organisation_id AND status = 'active') AS contract_count
    FROM councils c WHERE c.organisation_id = ? ORDER BY c.name`, [ctx.org]),
  detail: async (org, id) => {
    const row = await owned('councils', id, org);
    if (!row) return null;
    row.contracts = await all(`SELECT c.id, c.code, c.name, c.status, c.income_per_day, s.name AS school_name,
        (SELECT COUNT(*) FROM children WHERE contract_id = c.id AND organisation_id = c.organisation_id AND status = 'active') AS child_count
      FROM contracts c LEFT JOIN schools s ON s.id = c.school_id
      WHERE c.organisation_id = ? AND c.council_id = ? ORDER BY c.code`, [org, id]);
    row.history = await audit.history(org, 'councils', id, 30);
    return row;
  },
});

// =====================================================================
// Schools
// =====================================================================
crud('schools', 'schools', {
  singular: 'school',
  docEntity: 'school',
  list: ctx => all(`SELECT s.*,
      (SELECT COUNT(*) FROM children  WHERE school_id = s.id AND organisation_id = s.organisation_id AND status = 'active') AS child_count,
      (SELECT COUNT(*) FROM contracts WHERE school_id = s.id AND organisation_id = s.organisation_id AND status = 'active') AS contract_count
    FROM schools s WHERE s.organisation_id = ? ORDER BY s.name`, [ctx.org]),
  detail: async (org, id) => {
    const row = await owned('schools', id, org);
    if (!row) return null;
    row.children = await all(`SELECT ch.id, ch.first_name, ch.last_name, ch.postcode, ch.wheelchair, ch.status,
        c.code AS contract_code, c.id AS contract_id,
        d.first_name || ' ' || d.last_name AS driver_name, p.first_name || ' ' || p.last_name AS pa_name
      FROM children ch
      LEFT JOIN contracts c ON c.id = ch.contract_id
      LEFT JOIN staff d ON d.id = c.driver_id
      LEFT JOIN staff p ON p.id = c.pa_id
      WHERE ch.organisation_id = ? AND ch.school_id = ? ORDER BY ch.last_name, ch.first_name`, [org, id]);
    row.contracts = await all(`SELECT c.*, cl.name AS council_name,
        d.first_name || ' ' || d.last_name AS driver_name, p.first_name || ' ' || p.last_name AS pa_name,
        (SELECT COUNT(*) FROM children WHERE contract_id = c.id AND organisation_id = c.organisation_id AND status = 'active') AS child_count
      FROM contracts c
      LEFT JOIN councils cl ON cl.id = c.council_id
      LEFT JOIN staff d ON d.id = c.driver_id
      LEFT JOIN staff p ON p.id = c.pa_id
      WHERE c.organisation_id = ? AND c.school_id = ? ORDER BY c.code`, [org, id]);
    row.drivers = await all(`SELECT DISTINCT s.id, s.first_name, s.last_name, s.phone, s.type
      FROM staff s JOIN contracts c ON c.driver_id = s.id
      WHERE c.organisation_id = ? AND c.school_id = ? AND c.status = 'active'`, [org, id]);
    row.pas = await all(`SELECT DISTINCT s.id, s.first_name, s.last_name, s.phone, s.type
      FROM staff s JOIN contracts c ON c.pa_id = s.id
      WHERE c.organisation_id = ? AND c.school_id = ? AND c.status = 'active'`, [org, id]);
    row.documents = await documentsFor(org, 'school', id);
    row.history = await audit.history(org, 'schools', id, 30);
    return row;
  },
});

// =====================================================================
// Staff (drivers and passenger assistants)
// =====================================================================
crud('staff', 'staff', {
  singular: 'staff member',
  docEntity: 'staff',
  list: async ctx => {
    let sql = `SELECT s.*,
        (SELECT COUNT(*) FROM contracts WHERE (driver_id = s.id OR pa_id = s.id) AND organisation_id = s.organisation_id AND status = 'active') AS contract_count,
        (SELECT string_agg(registration, ', ') FROM vehicles WHERE driver_id = s.id AND organisation_id = s.organisation_id AND active = 1) AS vehicles
      FROM staff s WHERE s.organisation_id = ?`;
    const p = [ctx.org];
    if (ctx.query.type) { sql += ' AND s.type = ?'; p.push(ctx.query.type); }
    if (ctx.query.status) { sql += ' AND s.status = ?'; p.push(ctx.query.status); }
    sql += ' ORDER BY s.last_name, s.first_name';
    const rows = await all(sql, p);
    const map = await compliance.complianceForMany(ctx.org, rows);
    for (const r of rows) { r.name = `${r.first_name} ${r.last_name}`; r.compliance = map.get(r.id).status; }
    return rows;
  },
  detail: async (org, id) => {
    const row = await owned('staff', id, org);
    if (!row) return null;
    row.name = `${row.first_name} ${row.last_name}`;
    row.vehicles = await all('SELECT * FROM vehicles WHERE organisation_id = ? AND driver_id = ? ORDER BY active DESC, registration', [org, id]);
    row.contracts = await all(`SELECT c.id, c.code, c.name, c.status, c.days_of_week, c.am_pickup_time, c.pm_dropoff_time,
        c.driver_pay_per_day, c.pa_pay_per_day, c.pay_basis, c.driver_id, c.pa_id,
        s.name AS school_name, s.id AS school_id, cl.name AS council_name,
        (SELECT COUNT(*) FROM children WHERE contract_id = c.id AND organisation_id = c.organisation_id AND status = 'active') AS child_count
      FROM contracts c
      LEFT JOIN schools s ON s.id = c.school_id
      LEFT JOIN councils cl ON cl.id = c.council_id
      WHERE c.organisation_id = ? AND (c.driver_id = ? OR c.pa_id = ?) ORDER BY c.status, c.code`, [org, id, id]);
    for (const c of row.contracts) c.role = c.driver_id === id ? 'driver' : 'pa';
    row.children = await all(`SELECT ch.id, ch.first_name, ch.last_name, ch.wheelchair, ch.sen_needs, ch.pickup_time, ch.dropoff_time,
        c.code AS contract_code, c.id AS contract_id, s.name AS school_name
      FROM children ch
      JOIN contracts c ON c.id = ch.contract_id
      LEFT JOIN schools s ON s.id = ch.school_id
      WHERE ch.organisation_id = ? AND (c.driver_id = ? OR c.pa_id = ?) AND ch.status = 'active'
      ORDER BY c.code, ch.last_name`, [org, id, id]);
    row.compliance = await compliance.staffCompliance(org, id, row.type);
    row.documents = await documentsFor(org, 'staff', id);
    row.vehicle_documents = await all(`SELECT d.*, v.registration FROM documents d
      JOIN vehicles v ON v.id = d.entity_id
      WHERE d.organisation_id = ? AND d.entity_type = 'vehicle' AND v.driver_id = ? ORDER BY d.expiry_date`, [org, id]);
    row.recent_cover = await all(`SELECT e.*, c.code AS contract_code FROM exceptions e
      LEFT JOIN contracts c ON c.id = e.contract_id
      WHERE e.organisation_id = ? AND e.cover_staff_id = ? ORDER BY e.date DESC LIMIT 20`, [org, id]);
    row.absences = await all(`SELECT e.*, c.code AS contract_code, cs.first_name || ' ' || cs.last_name AS cover_name
      FROM exceptions e
      LEFT JOIN contracts c ON c.id = e.contract_id
      LEFT JOIN staff cs ON cs.id = e.cover_staff_id
      WHERE e.organisation_id = ? AND e.type = 'staff_absence' AND e.staff_id = ? ORDER BY e.date DESC LIMIT 20`, [org, id]);
    row.payments = await all('SELECT * FROM payments WHERE organisation_id = ? AND staff_id = ? ORDER BY work_date DESC LIMIT 25', [org, id]);
    row.history = await audit.history(org, 'staff', id, 40);
    return row;
  },
  guard: async (org, row) => {
    const n = Number((await get(
      "SELECT COUNT(*) AS n FROM contracts WHERE organisation_id = ? AND (driver_id = ? OR pa_id = ?) AND status = 'active'",
      [org, row.id, row.id])).n);
    return n ? `Cannot delete: still assigned to ${n} active ${n === 1 ? 'contract' : 'contracts'}. Unassign first, or set their status to inactive.` : null;
  },
  // Cover already worked stays on record; only the link to the deleted person is cleared.
  cascade: async (org, id, tx) => {
    await tx.run('UPDATE exceptions SET cover_staff_id = NULL WHERE cover_staff_id = ? AND organisation_id = ?', [id, org]);
  },
});

// =====================================================================
// Vehicles
// =====================================================================
crud('vehicles', 'vehicles', {
  singular: 'vehicle',
  docEntity: 'vehicle',
  label: r => r.registration,
  list: ctx => all(`SELECT v.*, s.first_name || ' ' || s.last_name AS driver_name
    FROM vehicles v LEFT JOIN staff s ON s.id = v.driver_id
    WHERE v.organisation_id = ? ORDER BY v.active DESC, v.registration`, [ctx.org]),
  detail: async (org, id) => {
    const row = await get(`SELECT v.*, s.first_name || ' ' || s.last_name AS driver_name
      FROM vehicles v LEFT JOIN staff s ON s.id = v.driver_id
      WHERE v.id = ? AND v.organisation_id = ?`, [id, org]);
    if (!row) return null;
    row.documents = await documentsFor(org, 'vehicle', id);
    row.contracts = await all('SELECT id, code, name, status FROM contracts WHERE organisation_id = ? AND vehicle_id = ?', [org, id]);
    row.history = await audit.history(org, 'vehicles', id, 30);
    return row;
  },
  before: async (org, data) => {
    if (data.driver_id && !(await owned('staff', Number(data.driver_id), org))) return 'That driver is not in your records';
    return null;
  },
});

// =====================================================================
// Contracts
// =====================================================================
crud('contracts', 'contracts', {
  singular: 'contract',
  docEntity: 'contract',
  label: r => r.code,
  list: async ctx => {
    let sql = `SELECT c.*, s.name AS school_name, s.postcode AS school_postcode, cl.name AS council_name,
        d.first_name || ' ' || d.last_name AS driver_name, p.first_name || ' ' || p.last_name AS pa_name,
        v.registration AS vehicle_reg, v.seats AS vehicle_seats,
        (SELECT COUNT(*) FROM children WHERE contract_id = c.id AND organisation_id = c.organisation_id AND status = 'active') AS child_count
      FROM contracts c
      LEFT JOIN schools s ON s.id = c.school_id
      LEFT JOIN councils cl ON cl.id = c.council_id
      LEFT JOIN staff d ON d.id = c.driver_id
      LEFT JOIN staff p ON p.id = c.pa_id
      LEFT JOIN vehicles v ON v.id = c.vehicle_id
      WHERE c.organisation_id = ?`;
    const p = [ctx.org];
    if (ctx.query.status) { sql += ' AND c.status = ?'; p.push(ctx.query.status); }
    if (ctx.query.school_id) { sql += ' AND c.school_id = ?'; p.push(Number(ctx.query.school_id)); }
    if (ctx.query.council_id) { sql += ' AND c.council_id = ?'; p.push(Number(ctx.query.council_id)); }
    sql += ' ORDER BY c.code';
    const rows = await all(sql, p);
    for (const r of rows) {
      r.expected_profit_per_day = cal.round2(r.income_per_day - r.driver_pay_per_day - r.pa_pay_per_day - r.other_costs_per_day);
      r.margin = r.income_per_day > 0 ? cal.round2(r.expected_profit_per_day / r.income_per_day * 100) : 0;
    }
    return rows;
  },
  detail: async (org, id) => {
    const row = await get(`SELECT c.*, s.name AS school_name, s.address AS school_address, s.postcode AS school_postcode,
        s.phone AS school_phone, s.open_time AS school_open, s.close_time AS school_close,
        cl.name AS council_name,
        d.first_name || ' ' || d.last_name AS driver_name, d.phone AS driver_phone,
        p.first_name || ' ' || p.last_name AS pa_name, p.phone AS pa_phone,
        v.registration AS vehicle_reg, v.make AS vehicle_make, v.model AS vehicle_model,
        v.seats AS vehicle_seats, v.wheelchair_accessible
      FROM contracts c
      LEFT JOIN schools s ON s.id = c.school_id
      LEFT JOIN councils cl ON cl.id = c.council_id
      LEFT JOIN staff d ON d.id = c.driver_id
      LEFT JOIN staff p ON p.id = c.pa_id
      LEFT JOIN vehicles v ON v.id = c.vehicle_id
      WHERE c.id = ? AND c.organisation_id = ?`, [id, org]);
    if (!row) return null;
    row.children = await all(`SELECT id, first_name, last_name, dob, postcode, address, pickup_time, dropoff_time,
        wheelchair, mobility, sen_needs, medical_info, allergies, behaviour, status, parent_name, parent_phone
      FROM children WHERE organisation_id = ? AND contract_id = ? ORDER BY status, pickup_time, last_name`, [org, id]);
    row.child_count = row.children.filter(c => c.status === 'active').length;
    row.documents = await documentsFor(org, 'contract', id);
    row.driver_compliance = row.driver_id ? (await compliance.staffCompliance(org, row.driver_id, 'driver')).status : null;
    row.pa_compliance = row.pa_id ? (await compliance.staffCompliance(org, row.pa_id, 'pa')).status : null;

    const from = cal.today().slice(0, 8) + '01';
    const to = cal.addDays(nextMonthStart(from), -1);
    const prof = await finance.profitability(org, { from, to, contract_id: id });
    row.financials = prof.rows[0] || null;
    row.financials_period = { from, to };
    const profit = cal.round2(row.income_per_day - row.driver_pay_per_day - row.pa_pay_per_day - row.other_costs_per_day);
    row.per_day = {
      income: row.income_per_day, driver: row.driver_pay_per_day, pa: row.pa_pay_per_day, other: row.other_costs_per_day,
      profit, margin: row.income_per_day > 0 ? cal.round2(profit / row.income_per_day * 100) : 0,
    };

    const recentFrom = cal.addDays(cal.today(), -14);
    row.exceptions = await all(`SELECT e.*, ch.first_name || ' ' || ch.last_name AS child_name,
        cs.first_name || ' ' || cs.last_name AS cover_name, st.first_name || ' ' || st.last_name AS staff_name
      FROM exceptions e
      LEFT JOIN children ch ON ch.id = e.child_id
      LEFT JOIN staff cs ON cs.id = e.cover_staff_id
      LEFT JOIN staff st ON st.id = e.staff_id
      WHERE e.organisation_id = ? AND e.contract_id = ? AND e.date >= ? ORDER BY e.date DESC LIMIT 60`, [org, id, recentFrom]);
    row.history = await audit.history(org, 'contracts', id, 50);
    return row;
  },
  before: async (org, data) => {
    if (data.code) data.code = String(data.code).trim().toUpperCase();
    // Every link must point at a record belonging to the same firm.
    for (const [field, table, msg] of [
      ['school_id', 'schools', 'That school is not in your records'],
      ['council_id', 'councils', 'That council is not in your records'],
      ['driver_id', 'staff', 'That driver is not in your records'],
      ['pa_id', 'staff', 'That PA is not in your records'],
      ['vehicle_id', 'vehicles', 'That vehicle is not in your records'],
    ]) {
      if (data[field] && !(await owned(table, Number(data[field]), org))) return msg;
    }
    return null;
  },
  after: async (org, row, ctx, before) => {
    // Changing a contract's school re-points its children so the hierarchy stays consistent.
    if (before && row.school_id !== before.school_id && row.school_id) {
      await run('UPDATE children SET school_id = ? WHERE contract_id = ? AND organisation_id = ?', [row.school_id, row.id, org]);
    }
  },
  resolve: async (org, col, v) => {
    if (v === null || v === undefined || v === '') return null;
    const lookup = {
      driver_id: ['staff', "first_name || ' ' || last_name"], pa_id: ['staff', "first_name || ' ' || last_name"],
      school_id: ['schools', 'name'], council_id: ['councils', 'name'], vehicle_id: ['vehicles', 'registration'],
    };
    if (!lookup[col]) return v;
    const [table, expr] = lookup[col];
    const r = await get(`SELECT ${expr} AS label FROM ${table} WHERE id = ? AND organisation_id = ?`, [Number(v), org]);
    return r ? r.label : v;
  },
  guard: async (org, row) => {
    const n = Number((await get('SELECT COUNT(*) AS n FROM children WHERE organisation_id = ? AND contract_id = ?', [org, row.id])).n);
    return n ? `Cannot delete: ${n} ${n === 1 ? 'child is' : 'children are'} assigned to this contract. Move them first.` : null;
  },
  // Exceptions cascade with the contract, so payments recorded against them must go
  // too. Left behind they would keep reducing someone's wages with nothing to explain it.
  cascade: async (org, id, tx) => {
    await tx.run(`DELETE FROM payments WHERE organisation_id = ?
      AND exception_id IN (SELECT id FROM exceptions WHERE contract_id = ? AND organisation_id = ?)`, [org, id, org]);
  },
});

// =====================================================================
// Children
// =====================================================================
crud('children', 'children', {
  singular: 'child',
  docEntity: 'child',
  list: async ctx => {
    let sql = `SELECT ch.*, s.name AS school_name, c.code AS contract_code,
        d.first_name || ' ' || d.last_name AS driver_name, p.first_name || ' ' || p.last_name AS pa_name
      FROM children ch
      LEFT JOIN schools s ON s.id = ch.school_id
      LEFT JOIN contracts c ON c.id = ch.contract_id
      LEFT JOIN staff d ON d.id = c.driver_id
      LEFT JOIN staff p ON p.id = c.pa_id
      WHERE ch.organisation_id = ?`;
    const p = [ctx.org];
    if (ctx.query.status) { sql += ' AND ch.status = ?'; p.push(ctx.query.status); }
    if (ctx.query.school_id) { sql += ' AND ch.school_id = ?'; p.push(Number(ctx.query.school_id)); }
    if (ctx.query.contract_id) { sql += ' AND ch.contract_id = ?'; p.push(Number(ctx.query.contract_id)); }
    sql += ' ORDER BY ch.last_name, ch.first_name';
    const rows = await all(sql, p);
    for (const r of rows) r.name = `${r.first_name} ${r.last_name}`;
    return rows;
  },
  detail: async (org, id) => {
    const row = await get(`SELECT ch.*, s.name AS school_name, s.address AS school_address, s.postcode AS school_postcode,
        s.phone AS school_phone,
        c.code AS contract_code, c.route_info, c.am_pickup_time AS contract_am, c.pm_dropoff_time AS contract_pm,
        c.days_of_week, cl.name AS council_name,
        d.id AS driver_id, d.first_name || ' ' || d.last_name AS driver_name, d.phone AS driver_phone,
        p.id AS pa_id, p.first_name || ' ' || p.last_name AS pa_name, p.phone AS pa_phone,
        v.registration AS vehicle_reg
      FROM children ch
      LEFT JOIN schools s ON s.id = ch.school_id
      LEFT JOIN contracts c ON c.id = ch.contract_id
      LEFT JOIN councils cl ON cl.id = c.council_id
      LEFT JOIN staff d ON d.id = c.driver_id
      LEFT JOIN staff p ON p.id = c.pa_id
      LEFT JOIN vehicles v ON v.id = c.vehicle_id
      WHERE ch.id = ? AND ch.organisation_id = ?`, [id, org]);
    if (!row) return null;
    row.name = `${row.first_name} ${row.last_name}`;
    row.travels_with = row.contract_id
      ? await all(`SELECT id, first_name, last_name, pickup_time FROM children
          WHERE organisation_id = ? AND contract_id = ? AND id != ? AND status = 'active' ORDER BY pickup_time`,
        [org, row.contract_id, id])
      : [];
    row.documents = await documentsFor(org, 'child', id);
    row.absences = await all(`SELECT e.*, c.code AS contract_code FROM exceptions e
      LEFT JOIN contracts c ON c.id = e.contract_id
      WHERE e.organisation_id = ? AND e.child_id = ? ORDER BY e.date DESC LIMIT 40`, [org, id]);
    row.history = await audit.history(org, 'children', id, 40);
    return row;
  },
  before: async (org, data) => {
    if (data.contract_id) {
      const c = await owned('contracts', Number(data.contract_id), org);
      if (!c) return 'That contract is not in your records';
      // A child inherits the school from their contract unless one is given explicitly.
      if (!data.school_id && c.school_id) data.school_id = c.school_id;
    }
    if (data.school_id && !(await owned('schools', Number(data.school_id), org))) return 'That school is not in your records';
    return null;
  },
  resolve: async (org, col, v) => {
    if (!v) return v;
    if (col === 'school_id') { const s = await get('SELECT name FROM schools WHERE id = ? AND organisation_id = ?', [Number(v), org]); return s ? s.name : v; }
    if (col === 'contract_id') { const s = await get('SELECT code FROM contracts WHERE id = ? AND organisation_id = ?', [Number(v), org]); return s ? s.code : v; }
    return v;
  },
});

// =====================================================================
// Expenses
// =====================================================================
crud('expenses', 'expenses', {
  singular: 'expense',
  label: r => `${r.category} ${r.amount}`,
  list: async ctx => {
    let sql = `SELECT e.*, c.code AS contract_code FROM expenses e
      LEFT JOIN contracts c ON c.id = e.contract_id WHERE e.organisation_id = ?`;
    const p = [ctx.org];
    if (ctx.query.from) { sql += ' AND e.date >= ?'; p.push(ctx.query.from); }
    if (ctx.query.to) { sql += ' AND e.date <= ?'; p.push(ctx.query.to); }
    if (ctx.query.contract_id) { sql += ' AND e.contract_id = ?'; p.push(Number(ctx.query.contract_id)); }
    sql += ' ORDER BY e.date DESC LIMIT 500';
    return all(sql, p);
  },
  detail: (org, id) => owned('expenses', id, org),
  before: async (org, data) => {
    if (data.contract_id && !(await owned('contracts', Number(data.contract_id), org))) return 'That contract is not in your records';
    return null;
  },
});

function nextMonthStart(d) {
  const [y, m] = d.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

// =====================================================================
// Documents
// =====================================================================
async function documentsFor(org, type, id) {
  const rows = await all(
    'SELECT * FROM documents WHERE organisation_id = ? AND entity_type = ? AND entity_id = ? ORDER BY doc_type, expiry_date DESC',
    [org, type, id]);
  const amber = await compliance.amberDays(org);
  const ref = cal.today();
  for (const r of rows) {
    r.calculated_status = compliance.docStatus(r, amber, ref);
    r.days_left = r.expiry_date ? compliance.daysBetween(ref, r.expiry_date) : null;
  }
  return rows;
}

async function deleteDocumentsFor(org, entityType, entityId, tx) {
  const q = tx || { all, run };
  const docs = await q.all('SELECT id, stored_name FROM documents WHERE organisation_id = ? AND entity_type = ? AND entity_id = ?',
    [org, entityType, entityId]);
  for (const d of docs) {
    if (d.stored_name) { try { fs.unlinkSync(path.join(UPLOAD_DIR, d.stored_name)); } catch (_) {} }
  }
  await q.run('DELETE FROM documents WHERE organisation_id = ? AND entity_type = ? AND entity_id = ?', [org, entityType, entityId]);
}

const DOC_PARENT = { child: 'children', staff: 'staff', contract: 'contracts', vehicle: 'vehicles', school: 'schools' };

route('GET', '/api/documents', async ctx => {
  if (ctx.query.entity_type && ctx.query.entity_id) {
    return H.json(ctx.res, await documentsFor(ctx.org, ctx.query.entity_type, Number(ctx.query.entity_id)));
  }
  H.json(ctx.res, await compliance.expiringDocuments(ctx.org, Number(ctx.query.days) || 3650, true));
});

route('POST', '/api/documents', async ctx => {
  const f = ctx.body;
  const entityType = f.entity_type;
  const entityId = Number(f.entity_id);
  if (!DOC_PARENT[entityType] || !entityId) return H.error(ctx.res, 'A valid record must be given for the document');
  // The record the document is attached to must belong to this firm.
  if (!(await owned(DOC_PARENT[entityType], entityId, ctx.org))) return H.error(ctx.res, 'Record not found', 404);

  let stored = null, fileName = null, mime = null, size = null;
  const file = (ctx.files || [])[0];
  if (file && file.data && file.data.length) {
    const ext = path.extname(file.filename).slice(0, 10).replace(/[^\w.]/g, '');
    stored = crypto.randomBytes(12).toString('hex') + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, stored), file.data);
    fileName = file.filename; mime = file.mime; size = file.data.length;
  }
  const id = await insert('documents', {
    entity_type: entityType, entity_id: entityId, doc_type: f.doc_type || 'Other', reference: f.reference,
    file_name: fileName, stored_name: stored, mime_type: mime, size,
    issue_date: f.issue_date, expiry_date: f.expiry_date, status: f.status || 'valid', notes: f.notes,
    uploaded_by: ctx.user.name,
  }, ['entity_type', 'entity_id', 'doc_type', 'reference', 'file_name', 'stored_name', 'mime_type', 'size',
    'issue_date', 'expiry_date', 'status', 'notes', 'uploaded_by'], null, ctx.org);
  await audit.logAction(ctx.user, entityType === 'staff' ? 'staff' : entityType + 's', entityId, null, 'document',
    `Added document ${f.doc_type}${f.expiry_date ? ' expiring ' + f.expiry_date : ''}`);
  H.json(ctx.res, await owned('documents', id, ctx.org), 201);
});

route('PUT', '/api/documents/:id', async ctx => {
  const id = Number(ctx.params.id);
  const before = await owned('documents', id, ctx.org);
  if (!before) return H.error(ctx.res, 'Document not found', 404);
  await update('documents', id, ctx.body, ['doc_type', 'reference', 'issue_date', 'expiry_date', 'status', 'notes'], null, ctx.org);
  await audit.logAction(ctx.user, before.entity_type === 'staff' ? 'staff' : before.entity_type + 's', before.entity_id, null,
    'document', `Updated document ${before.doc_type}`);
  H.json(ctx.res, await owned('documents', id, ctx.org));
});

route('DELETE', '/api/documents/:id', async ctx => {
  const id = Number(ctx.params.id);
  const doc = await owned('documents', id, ctx.org);
  if (!doc) return H.error(ctx.res, 'Document not found', 404);
  if (doc.stored_name) { try { fs.unlinkSync(path.join(UPLOAD_DIR, doc.stored_name)); } catch (_) {} }
  await run('DELETE FROM documents WHERE id = ? AND organisation_id = ?', [id, ctx.org]);
  await audit.logAction(ctx.user, doc.entity_type === 'staff' ? 'staff' : doc.entity_type + 's', doc.entity_id, null,
    'document', `Deleted document ${doc.doc_type}`);
  H.json(ctx.res, { ok: true });
});

route('GET', '/api/documents/:id/file', async ctx => {
  const doc = await owned('documents', Number(ctx.params.id), ctx.org);
  if (!doc || !doc.stored_name) return H.error(ctx.res, 'No file attached', 404);
  const full = path.join(UPLOAD_DIR, doc.stored_name);
  if (!fs.existsSync(full)) return H.error(ctx.res, 'File missing from store', 404);
  ctx.res.writeHead(200, {
    'Content-Type': doc.mime_type || 'application/octet-stream',
    'Content-Disposition': `inline; filename="${(doc.file_name || 'document').replace(/"/g, '')}"`,
  });
  fs.createReadStream(full).pipe(ctx.res);
});

// =====================================================================
// Compliance
// =====================================================================
route('GET', '/api/compliance', async ctx => {
  const rows = await all(
    `SELECT id, type, first_name, last_name, status, postcode, phone FROM staff
     WHERE organisation_id = ? AND status IN ('active','pool') ORDER BY type, last_name`, [ctx.org]);
  const map = await compliance.complianceForMany(ctx.org, rows);
  const out = rows.map(s => {
    const c = map.get(s.id);
    return {
      id: s.id, name: `${s.first_name} ${s.last_name}`, type: s.type, staff_status: s.status,
      postcode: s.postcode, phone: s.phone, status: c.status, items: c.items,
    };
  });
  const filtered = ctx.query.status ? out.filter(o => o.status === ctx.query.status) : out;
  H.json(ctx.res, {
    amber_days: await compliance.amberDays(ctx.org),
    required: { driver: await compliance.requiredDocs(ctx.org, 'driver'), pa: await compliance.requiredDocs(ctx.org, 'pa') },
    staff: filtered,
    summary: {
      green: out.filter(o => o.status === 'green').length,
      amber: out.filter(o => o.status === 'amber').length,
      red: out.filter(o => o.status === 'red').length,
    },
  });
});

route('GET', '/api/compliance/expiring', async ctx => {
  const days = Number(ctx.query.days) || await compliance.amberDays(ctx.org);
  H.json(ctx.res, await compliance.expiringDocuments(ctx.org, days, ctx.query.expired !== '0'));
});

// =====================================================================
// Calendar and exceptions
// =====================================================================
route('GET', '/api/calendar', async ctx => {
  const from = ctx.query.from || cal.today();
  const to = ctx.query.to || cal.addDays(from, 6);
  if (cal.dateRange(from, to).length > 120) return H.error(ctx.res, 'Date range too large (max 120 days)');
  const filter = {};
  if (ctx.query.contract_id) filter.contract_id = Number(ctx.query.contract_id);
  if (ctx.query.school_id) filter.school_id = Number(ctx.query.school_id);
  if (ctx.query.staff_id) filter.staff_id = Number(ctx.query.staff_id);
  H.json(ctx.res, await cal.buildCalendar(ctx.org, from, to, filter));
});

route('GET', '/api/day/:date', async ctx => H.json(ctx.res, await cal.dayOverview(ctx.org, ctx.params.date)));

route('GET', '/api/exceptions', async ctx => {
  const from = ctx.query.from || cal.addDays(cal.today(), -30);
  const to = ctx.query.to || cal.addDays(cal.today(), 30);
  let rows = await cal.loadExceptions(ctx.org, from, to);
  if (ctx.query.contract_id) rows = rows.filter(r => r.contract_id === Number(ctx.query.contract_id));
  if (ctx.query.type) rows = rows.filter(r => r.type === ctx.query.type);
  const codes = Object.fromEntries(
    (await all('SELECT id, code FROM contracts WHERE organisation_id = ?', [ctx.org])).map(c => [c.id, c.code]));
  H.json(ctx.res, rows.map(r => ({ ...r, contract_code: codes[r.contract_id] || null })));
});

const EX_COLS = ['date', 'type', 'leg', 'contract_id', 'school_id', 'child_id', 'role', 'staff_id',
  'cover_staff_id', 'cover_pay', 'paid_immediately', 'amount', 'note', 'created_by'];

route('POST', '/api/exceptions', async ctx => {
  const b = ctx.body;
  const dates = Array.isArray(b.dates) && b.dates.length ? b.dates : [b.date];
  if (!dates[0]) return H.error(ctx.res, 'A date is required');
  if (!b.type) return H.error(ctx.res, 'An exception type is required');

  // Everything the exception points at must belong to this firm.
  for (const [field, table, msg] of [
    ['contract_id', 'contracts', 'That contract is not in your records'],
    ['school_id', 'schools', 'That school is not in your records'],
    ['child_id', 'children', 'That child is not in your records'],
    ['cover_staff_id', 'staff', 'That cover staff member is not in your records'],
  ]) {
    if (b[field] && !(await owned(table, Number(b[field]), ctx.org))) return H.error(ctx.res, msg, 404);
  }

  const created = [];
  try {
    await transaction(async tx => {
      for (const date of dates) {
        const data = { ...b, date, created_by: ctx.user.name };
        delete data.dates;
        delete data.organisation_id;
        if (data.type === 'staff_absence') {
          if (!data.role) throw new Error('Select whether the driver or the PA is absent');
          const c = await tx.get(
            'SELECT driver_id, pa_id, code, driver_pay_per_day, pa_pay_per_day FROM contracts WHERE id = ? AND organisation_id = ?',
            [Number(data.contract_id), ctx.org]);
          if (!c) throw new Error('Contract not found');
          data.staff_id = data.role === 'driver' ? c.driver_id : c.pa_id;
          if (data.cover_staff_id && data.cover_pay === undefined) {
            const base = data.role === 'driver' ? c.driver_pay_per_day : c.pa_pay_per_day;
            data.cover_pay = cal.round2(base * (data.leg === 'DAY' || !data.leg ? 1 : 0.5));
          }
        }
        if (data.type === 'child_absence' && !data.child_id) throw new Error('Select the child who was absent');
        if (data.type === 'school_closed' && data.school_id) data.contract_id = null;

        const id = await insert('exceptions', data, EX_COLS, tx, ctx.org);
        // "Paid immediately" writes a payment straight away so payroll never pays it twice.
        if (data.type === 'staff_absence' && data.cover_staff_id && Number(data.paid_immediately) === 1) {
          await insert('payments', {
            staff_id: Number(data.cover_staff_id), work_date: date, paid_date: cal.today(),
            amount: data.cover_pay != null ? Number(data.cover_pay) : 0,
            source: 'cover_immediate', exception_id: id, note: 'Cover paid immediately', created_by: ctx.user.name,
          }, ['staff_id', 'work_date', 'paid_date', 'amount', 'source', 'exception_id', 'note', 'created_by'], tx, ctx.org);
        }
        const row = await tx.get('SELECT * FROM exceptions WHERE id = ? AND organisation_id = ?', [id, ctx.org]);
        created.push(row);
        const what = describeException(row);
        await tx.run(`INSERT INTO audit_log (organisation_id, user_name, entity_type, entity_id, entity_label, action, summary)
          VALUES (?,?,?,?,?,?,?)`, [ctx.org, ctx.user.name, 'exceptions', id, what, 'create', `${date}: ${what}`]);
        if (row.contract_id) {
          await tx.run(`INSERT INTO audit_log (organisation_id, user_name, entity_type, entity_id, entity_label, action, summary)
            VALUES (?,?,?,?,?,?,?)`,
            [ctx.org, ctx.user.name, 'contracts', row.contract_id, null, 'exception', `${date} ${row.leg}: ${what}`]);
        }
      }
    });
  } catch (e) { return H.error(ctx.res, friendly(e), 400); }
  H.json(ctx.res, created, 201);
});

route('DELETE', '/api/exceptions/:id', async ctx => {
  const id = Number(ctx.params.id);
  const row = await owned('exceptions', id, ctx.org);
  if (!row) return H.error(ctx.res, 'Exception not found', 404);
  const pay = await get('SELECT * FROM payments WHERE exception_id = ? AND organisation_id = ?', [id, ctx.org]);
  await transaction(async tx => {
    if (pay) await tx.run('DELETE FROM payments WHERE exception_id = ? AND organisation_id = ?', [id, ctx.org]);
    await tx.run('DELETE FROM exceptions WHERE id = ? AND organisation_id = ?', [id, ctx.org]);
  });
  const what = describeException(row);
  await audit.logAction(ctx.user, 'exceptions', id, what, 'delete',
    `Removed ${row.date}: ${what}${pay ? ' (immediate payment reversed)' : ''}`);
  if (row.contract_id) {
    await audit.logAction(ctx.user, 'contracts', row.contract_id, null, 'exception', `Removed ${row.date} ${row.leg}: ${what}`);
  }
  H.json(ctx.res, { ok: true, payment_reversed: !!pay });
});

function describeException(r) {
  const leg = r.leg === 'DAY' ? 'full day' : r.leg;
  switch (r.type) {
    case 'child_absence': return `Child absent (${leg})`;
    case 'staff_absence': return `${r.role === 'driver' ? 'Driver' : 'PA'} absent (${leg})${r.cover_staff_id ? ' - cover assigned' : ' - no cover'}`;
    case 'school_closed': return `School closed (${leg})`;
    case 'contract_cancelled': return `Contract cancelled (${leg})`;
    case 'journey_cancelled': return `Journey cancelled (${leg})`;
    case 'pay_override': return `Pay override ${r.amount} (${leg})`;
    default: return r.note || 'Note';
  }
}

// =====================================================================
// Dashboard and search
// =====================================================================
route('GET', '/api/dashboard', async ctx => H.json(ctx.res, await dash.dashboard(ctx.org, ctx.query.date)));
route('GET', '/api/search', async ctx => H.json(ctx.res,
  await search.universalSearch(ctx.org, ctx.query.q, Number(ctx.query.limit) || 8)));

// =====================================================================
// Staff pool and suitability
// =====================================================================
route('GET', '/api/pool', async ctx => {
  const type = ctx.query.type === 'pa' ? 'pa' : 'driver';
  const target = (ctx.query.postcode || '').toUpperCase().trim();
  const date = ctx.query.date;
  const leg = ctx.query.leg || 'DAY';
  const needWheelchair = ctx.query.wheelchair === '1';
  const minSeats = Number(ctx.query.seats || 0);
  const includeAssigned = ctx.query.include_assigned === '1';

  const rows = await all(`SELECT s.*,
      (SELECT COUNT(*) FROM contracts WHERE (driver_id = s.id OR pa_id = s.id) AND organisation_id = s.organisation_id AND status = 'active') AS contract_count,
      (SELECT string_agg(registration || ' (' || COALESCE(CAST(seats AS TEXT), '?') || ' seats' ||
        CASE WHEN wheelchair_accessible = 1 THEN ', WAV' ELSE '' END || ')', '; ')
        FROM vehicles WHERE driver_id = s.id AND organisation_id = s.organisation_id AND active = 1) AS vehicle_summary,
      (SELECT MAX(seats) FROM vehicles WHERE driver_id = s.id AND organisation_id = s.organisation_id AND active = 1) AS max_seats,
      (SELECT MAX(wheelchair_accessible) FROM vehicles WHERE driver_id = s.id AND organisation_id = s.organisation_id AND active = 1) AS has_wav
    FROM staff s WHERE s.organisation_id = ? AND s.type = ? AND s.status IN ('pool','active')`, [ctx.org, type]);

  const complianceMap = await compliance.complianceForMany(ctx.org, rows);
  const availability = date ? await availabilityOn(ctx.org, rows.map(r => r.id), date, leg) : new Map();
  const out = [];
  for (const s of rows) {
    if (!includeAssigned && s.status === 'active' && s.contract_count > 0 && !date) continue;
    if (type === 'driver') {
      if (needWheelchair && !s.has_wav) continue;
      if (minSeats && (s.max_seats || 0) < minSeats) continue;
    }
    const comp = complianceMap.get(s.id);
    const prox = postcodeScore(target, s.postcode);
    out.push({
      id: s.id, name: `${s.first_name} ${s.last_name}`, type: s.type, status: s.status, postcode: s.postcode,
      phone: s.phone, email: s.email, availability: s.availability, preferred_areas: s.preferred_areas,
      default_day_rate: s.default_day_rate,
      contract_count: s.contract_count, vehicle_summary: s.vehicle_summary, max_seats: s.max_seats, has_wav: !!s.has_wav,
      compliance: comp.status,
      compliance_problems: comp.items.filter(i => i.status !== 'green').map(i => `${i.doc_type}: ${i.reason}`),
      proximity: prox.label, proximity_score: prox.score,
      busy: date ? (availability.get(s.id) || null) : null,
    });
  }
  out.sort((a, b) => {
    const rank = { green: 0, amber: 1, red: 2 };
    if (!!a.busy !== !!b.busy) return a.busy ? 1 : -1;
    if (b.proximity_score !== a.proximity_score) return b.proximity_score - a.proximity_score;
    if (rank[a.compliance] !== rank[b.compliance]) return rank[a.compliance] - rank[b.compliance];
    return a.contract_count - b.contract_count;
  });
  H.json(ctx.res, { type, target_postcode: target, staff: out });
});

/** Rough UK postcode proximity by outward code. An honest heuristic, no geocoding data required. */
function postcodeScore(target, candidate) {
  if (!target || !candidate) return { score: 0, label: '' };
  const t = normPostcode(target), c = normPostcode(candidate);
  if (!t.out || !c.out) return { score: 0, label: '' };
  if (t.out === c.out) return { score: 100, label: 'Same postcode district' };
  if (t.area === c.area && t.district === c.district) return { score: 80, label: 'Same district' };
  if (t.area === c.area) return { score: 55, label: `Same postcode area (${t.area})` };
  return { score: 5, label: 'Different area' };
}
function normPostcode(pc) {
  const s = String(pc || '').toUpperCase().replace(/\s+/g, '');
  const m = /^([A-Z]{1,2})(\d[A-Z\d]?)(\d[A-Z]{2})?$/.exec(s);
  if (!m) return { out: null, area: null, district: null };
  return { out: m[1] + m[2], area: m[1], district: m[2] };
}

/**
 * Who is already working on a given date, for every candidate at once.
 * Returns a Map of staff id to a short description, or nothing when free.
 */
async function availabilityOn(org, staffIds, date, leg) {
  const out = new Map();
  if (!staffIds.length) return out;
  const contracts = await cal.loadContracts(org, " AND c.status = 'active'");
  const exceptions = await cal.loadExceptions(org, date, date);
  const operating = contracts.filter(c => cal.contractOperatesOn(c, date));

  for (const id of staffIds) {
    const parts = [];
    const onDuty = operating.filter(c => {
      if (c.driver_id !== id && c.pa_id !== id) return false;
      const role = c.driver_id === id ? 'driver' : 'pa';
      // Someone whose absence is already recorded for this leg is free to cover elsewhere.
      return !exceptions.some(e => e.contract_id === c.id && e.type === 'staff_absence' && e.role === role
        && (e.leg === 'DAY' || leg === 'DAY' || e.leg === leg));
    });
    const covering = exceptions.filter(e => e.cover_staff_id === id);
    if (onDuty.length) parts.push('On ' + onDuty.map(c => c.code).join(', '));
    if (covering.length) parts.push(`Covering ${covering.length} ${covering.length === 1 ? 'journey' : 'journeys'}`);
    if (parts.length) out.set(id, parts.join('; '));
  }
  return out;
}

// =====================================================================
// Wages and payroll
// =====================================================================
route('GET', '/api/wages', async ctx => {
  const { from, to } = ctx.query;
  if (!from || !to) return H.error(ctx.res, 'from and to dates are required');
  if (cal.dateRange(from, to).length > 400) return H.error(ctx.res, 'Date range too large (max 400 days)');
  const opts = { from, to, include_zero: ctx.query.include_zero === '1' };
  if (ctx.query.type) opts.type = ctx.query.type;
  if (ctx.query.contract_id) opts.contract_id = Number(ctx.query.contract_id);
  if (ctx.query.staff_ids) opts.staff_ids = String(ctx.query.staff_ids).split(',').map(Number).filter(Boolean);
  H.json(ctx.res, await wages.calculateWages(ctx.org, opts));
});

route('GET', '/api/payments', async ctx => {
  let sql = `SELECT p.*, s.first_name || ' ' || s.last_name AS staff_name, s.type AS staff_type
    FROM payments p JOIN staff s ON s.id = p.staff_id WHERE p.organisation_id = ?`;
  const q = [ctx.org];
  if (ctx.query.staff_id) { sql += ' AND p.staff_id = ?'; q.push(Number(ctx.query.staff_id)); }
  if (ctx.query.from) { sql += ' AND p.work_date >= ?'; q.push(ctx.query.from); }
  if (ctx.query.to) { sql += ' AND p.work_date <= ?'; q.push(ctx.query.to); }
  sql += ' ORDER BY p.work_date DESC, p.id DESC LIMIT 500';
  H.json(ctx.res, await all(sql, q));
});

route('POST', '/api/payments', async ctx => {
  const b = ctx.body;
  if (!b.staff_id || !b.amount) return H.error(ctx.res, 'Staff member and amount are required');
  if (!(await owned('staff', Number(b.staff_id), ctx.org))) return H.error(ctx.res, 'Staff member not found', 404);
  const id = await insert('payments', {
    ...b, source: b.source || 'manual', work_date: b.work_date || cal.today(),
    paid_date: b.paid_date || cal.today(), created_by: ctx.user.name,
  }, ['staff_id', 'work_date', 'paid_date', 'amount', 'source', 'exception_id', 'method', 'reference', 'note', 'created_by'],
  null, ctx.org);
  await audit.logAction(ctx.user, 'staff', Number(b.staff_id), null, 'payment',
    `Recorded payment of ${Number(b.amount).toFixed(2)} for ${b.work_date || cal.today()}`);
  H.json(ctx.res, await owned('payments', id, ctx.org), 201);
});

route('DELETE', '/api/payments/:id', async ctx => {
  const id = Number(ctx.params.id);
  const p = await owned('payments', id, ctx.org);
  if (!p) return H.error(ctx.res, 'Payment not found', 404);
  await run('DELETE FROM payments WHERE id = ? AND organisation_id = ?', [id, ctx.org]);
  await audit.logAction(ctx.user, 'staff', p.staff_id, null, 'payment', `Deleted payment of ${p.amount} for ${p.work_date}`);
  H.json(ctx.res, { ok: true });
});

// Mark a calculated payroll as paid: records one payment per staff member so it is never paid twice.
route('POST', '/api/payroll-runs', async ctx => {
  const { from, to, staff_ids, description } = ctx.body;
  if (!from || !to) return H.error(ctx.res, 'from and to dates are required');
  const calc = await wages.calculateWages(ctx.org, { from, to, staff_ids: staff_ids && staff_ids.length ? staff_ids : undefined });
  const payable = calc.results.filter(r => r.totals.amount_due > 0);
  if (!payable.length) return H.error(ctx.res, 'Nothing outstanding to pay for that period');
  let runId;
  await transaction(async tx => {
    runId = await insert('payroll_runs', {
      from_date: from, to_date: to, description: description || `Payroll ${from} to ${to}`,
      total: calc.totals.total_due, created_by: ctx.user.name,
    }, ['from_date', 'to_date', 'description', 'total', 'created_by'], tx, ctx.org);
    for (const r of payable) {
      await insert('payroll_run_lines', {
        payroll_run_id: runId, staff_id: r.staff.id, amount: r.totals.amount_due, breakdown_json: JSON.stringify(r),
      }, ['payroll_run_id', 'staff_id', 'amount', 'breakdown_json'], tx, ctx.org);
      await insert('payments', {
        staff_id: r.staff.id, work_date: to, paid_date: cal.today(), amount: r.totals.amount_due,
        source: 'payroll', payroll_run_id: runId, note: `Payroll ${from} to ${to}`, created_by: ctx.user.name,
      }, ['staff_id', 'work_date', 'paid_date', 'amount', 'source', 'payroll_run_id', 'note', 'created_by'], tx, ctx.org);
      await tx.run(`INSERT INTO audit_log (organisation_id, user_name, entity_type, entity_id, entity_label, action, summary)
        VALUES (?,?,?,?,?,?,?)`,
      [ctx.org, ctx.user.name, 'staff', r.staff.id, r.staff.name, 'payroll',
        `Paid ${r.totals.amount_due.toFixed(2)} for ${from} to ${to}`]);
    }
  });
  H.json(ctx.res, { id: runId, paid: payable.length, total: calc.totals.total_due }, 201);
});

route('GET', '/api/payroll-runs', async ctx => H.json(ctx.res, await all(
  `SELECT r.*, (SELECT COUNT(*) FROM payroll_run_lines WHERE payroll_run_id = r.id AND organisation_id = r.organisation_id) AS staff_count
   FROM payroll_runs r WHERE r.organisation_id = ? ORDER BY r.id DESC LIMIT 100`, [ctx.org])));

route('GET', '/api/payroll-runs/:id', async ctx => {
  const r = await owned('payroll_runs', Number(ctx.params.id), ctx.org);
  if (!r) return H.error(ctx.res, 'Payroll run not found', 404);
  r.lines = (await all(`SELECT l.*, s.first_name || ' ' || s.last_name AS staff_name, s.type
    FROM payroll_run_lines l JOIN staff s ON s.id = l.staff_id
    WHERE l.organisation_id = ? AND l.payroll_run_id = ?`, [ctx.org, r.id]))
    .map(l => ({ ...l, breakdown: l.breakdown_json ? JSON.parse(l.breakdown_json) : null, breakdown_json: undefined }));
  H.json(ctx.res, r);
});

// =====================================================================
// Profitability
// =====================================================================
route('GET', '/api/profitability', async ctx => {
  const { from, to } = ctx.query;
  if (!from || !to) return H.error(ctx.res, 'from and to dates are required');
  if (cal.dateRange(from, to).length > 400) return H.error(ctx.res, 'Date range too large (max 400 days)');
  const opts = { from, to };
  if (ctx.query.contract_id) opts.contract_id = Number(ctx.query.contract_id);
  if (ctx.query.school_id) opts.school_id = Number(ctx.query.school_id);
  if (ctx.query.council_id) opts.council_id = Number(ctx.query.council_id);
  H.json(ctx.res, await finance.profitability(ctx.org, opts));
});

// =====================================================================
// Settings, colleagues and the audit log
// =====================================================================
route('GET', '/api/settings', async ctx => {
  H.json(ctx.res, {
    amber_days: await compliance.amberDays(ctx.org),
    company_name: await getSetting(ctx.org, 'company_name', ctx.user.organisation_name),
    required_docs_driver: await compliance.requiredDocs(ctx.org, 'driver'),
    required_docs_pa: await compliance.requiredDocs(ctx.org, 'pa'),
    all_doc_types: compliance.DOC_TYPES,
  });
});

route('POST', '/api/settings', async ctx => {
  const b = ctx.body;
  if (b.amber_days !== undefined) await setSetting(ctx.org, 'amber_days', Math.max(0, Math.min(365, Number(b.amber_days) || 0)));
  if (b.company_name !== undefined) {
    const name = String(b.company_name).trim();
    if (!name) return H.error(ctx.res, 'Enter a business name');
    await setSetting(ctx.org, 'company_name', name);
    await run('UPDATE organisations SET name = ? WHERE id = ?', [name, ctx.org]);
  }
  if (b.required_docs_driver) await setSetting(ctx.org, 'required_docs_driver', JSON.stringify(b.required_docs_driver));
  if (b.required_docs_pa) await setSetting(ctx.org, 'required_docs_pa', JSON.stringify(b.required_docs_pa));
  await audit.logAction(ctx.user, 'settings', 0, 'System settings', 'update', 'Updated settings');
  H.json(ctx.res, { ok: true });
});

route('GET', '/api/users', async ctx => H.json(ctx.res, await auth.listUsers(ctx.org)));

route('POST', '/api/users', async ctx => {
  const { email, name, password } = ctx.body;
  const r = await auth.addUser(ctx.org, { email, name, password });
  if (r.error) return H.error(ctx.res, r.error, 400);
  await audit.logAction(ctx.user, 'user', r.user.id, r.user.name, 'create', `Added ${r.user.email} to the team`);
  H.json(ctx.res, r.user, 201);
});

route('PUT', '/api/users/:id', async ctx => {
  const id = Number(ctx.params.id);
  const u = await get('SELECT * FROM users WHERE id = ? AND organisation_id = ?', [id, ctx.org]);
  if (!u) return H.error(ctx.res, 'User not found', 404);
  const b = ctx.body;
  if (b.password) {
    const bad = auth.checkPassword(b.password);
    if (bad) return H.error(ctx.res, bad, 400);
    await run('UPDATE users SET password_hash = ? WHERE id = ? AND organisation_id = ?', [auth.hash(b.password), id, ctx.org]);
  }
  if (b.name !== undefined) await run('UPDATE users SET name = ? WHERE id = ? AND organisation_id = ?', [String(b.name).trim(), id, ctx.org]);
  if (b.active !== undefined) {
    if (!Number(b.active) && id === ctx.user.id) return H.error(ctx.res, 'You cannot disable your own account', 400);
    await run('UPDATE users SET active = ? WHERE id = ? AND organisation_id = ?', [b.active ? 1 : 0, id, ctx.org]);
    if (!Number(b.active)) auth.endSessionsFor(id);
  }
  await audit.logAction(ctx.user, 'user', id, u.name, 'update', `Updated ${u.email}`);
  H.json(ctx.res, await get('SELECT id, email, name, active FROM users WHERE id = ? AND organisation_id = ?', [id, ctx.org]));
});

route('DELETE', '/api/users/:id', async ctx => {
  const id = Number(ctx.params.id);
  if (ctx.user.id === id) return H.error(ctx.res, 'You cannot delete your own account', 400);
  const u = await get('SELECT * FROM users WHERE id = ? AND organisation_id = ?', [id, ctx.org]);
  if (!u) return H.error(ctx.res, 'User not found', 404);
  const remaining = Number((await get('SELECT COUNT(*) AS n FROM users WHERE organisation_id = ? AND active = 1', [ctx.org])).n);
  if (remaining <= 1) return H.error(ctx.res, 'A business must keep at least one active account', 400);
  await run('DELETE FROM users WHERE id = ? AND organisation_id = ?', [id, ctx.org]);
  auth.endSessionsFor(id);
  await audit.logAction(ctx.user, 'user', id, u.name, 'delete', `Removed ${u.email} from the team`);
  H.json(ctx.res, { ok: true });
});

route('GET', '/api/audit', async ctx => H.json(ctx.res,
  await audit.recent(ctx.org, ctx.query, Number(ctx.query.limit) || 200)));

// =====================================================================
// Lookups for dropdowns, one call so forms stay fast
// =====================================================================
route('GET', '/api/lookups', async ctx => {
  const org = ctx.org;
  H.json(ctx.res, {
    schools: await all('SELECT id, name, postcode FROM schools WHERE organisation_id = ? AND active = 1 ORDER BY name', [org]),
    councils: await all('SELECT id, name FROM councils WHERE organisation_id = ? AND active = 1 ORDER BY name', [org]),
    contracts: await all('SELECT id, code, name, school_id, status FROM contracts WHERE organisation_id = ? ORDER BY code', [org]),
    drivers: await all("SELECT id, first_name || ' ' || last_name AS name, status, postcode FROM staff WHERE organisation_id = ? AND type = 'driver' ORDER BY last_name", [org]),
    pas: await all("SELECT id, first_name || ' ' || last_name AS name, status, postcode FROM staff WHERE organisation_id = ? AND type = 'pa' ORDER BY last_name", [org]),
    vehicles: await all('SELECT id, registration, seats, wheelchair_accessible, driver_id FROM vehicles WHERE organisation_id = ? AND active = 1 ORDER BY registration', [org]),
    children: await all("SELECT id, first_name || ' ' || last_name AS name, contract_id, school_id FROM children WHERE organisation_id = ? AND status = 'active' ORDER BY last_name", [org]),
  });
});

// =====================================================================
// Reports
// =====================================================================
route('GET', '/api/reports/:name', ctx => reports.handle(ctx));

module.exports = { handle, routes, UPLOAD_DIR, documentsFor, owned };
