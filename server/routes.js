'use strict';
// API routing. Every handler receives (ctx) = { req, res, url, query, body, files, user, params }.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { all, get, run, transaction, getSetting, setSetting, insert, update, db } = require('./db');
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
const FINANCE_FIELDS = {
  contracts: ['income_per_day', 'driver_pay_per_day', 'pa_pay_per_day', 'other_costs_per_day'],
  staff: ['default_day_rate'],
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
  for (const f of ZERO_IF_BLANK[table] || []) {
    if (data[f] === null || data[f] === '') data[f] = 0;
  }
}

const routes = [];
function route(method, pattern, perm, handler) {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, regex, keys, perm, handler });
}

async function handle(ctx) {
  const { req, res } = ctx;
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.regex.exec(ctx.path);
    if (!m) continue;
    ctx.params = {};
    r.keys.forEach((k, i) => { ctx.params[k] = decodeURIComponent(m[i + 1]); });
    if (r.perm !== null) {
      if (!ctx.user) return H.error(res, 'Not signed in', 401);
      if (!auth.can(ctx.user, r.perm)) return H.error(res, 'Your role does not permit this action', 403);
    }
    return await r.handler(ctx);
  }
  return H.error(res, 'Unknown endpoint: ' + ctx.path, 404);
}

// ---------- auth ----------
route('POST', '/api/login', null, ctx => {
  const { username, password } = ctx.body;
  const r = auth.login(username, password);
  if (!r) return H.error(ctx.res, 'Incorrect username or password', 401);
  audit.logAction(r.user, 'user', r.user.id, r.user.name, 'login', 'Signed in');
  ctx.res.setHeader('Set-Cookie', `h2s=${r.token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=43200`);
  H.json(ctx.res, { user: r.user, token: r.token, roles: auth.ROLES });
});
route('POST', '/api/logout', null, ctx => {
  if (ctx.token) auth.logout(ctx.token);
  ctx.res.setHeader('Set-Cookie', 'h2s=; HttpOnly; Path=/; Max-Age=0');
  H.json(ctx.res, { ok: true });
});
route('GET', '/api/me', null, ctx => {
  if (!ctx.user) return H.error(ctx.res, 'Not signed in', 401);
  H.json(ctx.res, { user: ctx.user, permissions: auth.ROLES[ctx.user.role].perms, roles: auth.ROLES, settings: { amber_days: compliance.amberDays(), company_name: getSetting('company_name', 'Home-to-School Transport') }, doc_types: compliance.DOC_TYPES });
});

// ---------- generic CRUD factory ----------
function crud(name, table, opts = {}) {
  const cols = COLS[table];
  const label = opts.label || (r => r.name || r.code || `${r.first_name} ${r.last_name}`);

  route('GET', `/api/${name}`, 'view', ctx => {
    const rows = opts.list ? opts.list(ctx) : all(`SELECT * FROM ${table} ORDER BY id DESC`);
    H.json(ctx.res, redactRows(ctx.user, table, rows));
  });
  route('GET', `/api/${name}/:id`, 'view', ctx => {
    const id = Number(ctx.params.id);
    const row = opts.detail ? opts.detail(id, ctx) : get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
    if (!row) return H.error(ctx.res, 'Record not found', 404);
    H.json(ctx.res, redactRows(ctx.user, table, row));
  });
  route('POST', `/api/${name}`, 'edit', ctx => {
    const data = { ...ctx.body };
    if (opts.before) opts.before(data, ctx);
    zeroBlanks(table, data);
    stripFinance(ctx.user, table, data);
    let id;
    try { id = insert(table, data, cols); }
    catch (e) { return H.error(ctx.res, friendly(e), 400); }
    const row = get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
    audit.logAction(ctx.user, opts.auditType || name, id, label(row), 'create', `Created ${opts.singular || name} ${label(row)}`);
    if (opts.after) opts.after(row, ctx, null);
    H.json(ctx.res, row, 201);
  });
  route('PUT', `/api/${name}/:id`, 'edit', ctx => {
    const id = Number(ctx.params.id);
    const before = get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
    if (!before) return H.error(ctx.res, 'Record not found', 404);
    const data = { ...ctx.body };
    delete data.id;
    if (opts.before) opts.before(data, ctx, before);
    zeroBlanks(table, data);
    stripFinance(ctx.user, table, data);
    try { update(table, id, data, cols); }
    catch (e) { return H.error(ctx.res, friendly(e), 400); }
    const after = get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
    audit.logDiff(ctx.user, opts.auditType || name, id, label(after), before, data, cols, opts.resolve);
    if (opts.after) opts.after(after, ctx, before);
    H.json(ctx.res, after);
  });
  route('DELETE', `/api/${name}/:id`, 'edit', ctx => {
    const id = Number(ctx.params.id);
    const row = get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
    if (!row) return H.error(ctx.res, 'Record not found', 404);
    if (opts.guard) { const msg = opts.guard(row); if (msg) return H.error(ctx.res, msg, 409); }
    // Documents are attached polymorphically, so they must be cleaned up explicitly.
    const docEntity = opts.docEntity;
    try {
      transaction(() => {
        if (docEntity) deleteDocumentsFor(docEntity, id);
        run(`DELETE FROM ${table} WHERE id = ?`, [id]);
      });
    }
    catch (e) { return H.error(ctx.res, friendly(e), 409); }
    audit.logAction(ctx.user, opts.auditType || name, id, label(row), 'delete', `Deleted ${opts.singular || name} ${label(row)}`);
    H.json(ctx.res, { ok: true });
  });
}
/** Removes a record's documents and their stored files. */
function deleteDocumentsFor(entityType, entityId) {
  const docs = all('SELECT id, stored_name FROM documents WHERE entity_type = ? AND entity_id = ?', [entityType, entityId]);
  for (const d of docs) {
    if (d.stored_name) { try { fs.unlinkSync(path.join(UPLOAD_DIR, d.stored_name)); } catch (_) {} }
  }
  run('DELETE FROM documents WHERE entity_type = ? AND entity_id = ?', [entityType, entityId]);
}

function friendly(e) {
  const m = String(e.message || e);
  if (m.includes('UNIQUE constraint failed: contracts.code')) return 'That contract code is already in use';
  if (m.includes('UNIQUE constraint failed: users.username')) return 'That username already exists';
  if (m.includes('FOREIGN KEY')) return 'This record is still linked to other records';
  if (m.includes('NOT NULL constraint failed')) return 'Required field missing: ' + m.split(':').pop().trim();
  if (m.includes('CHECK constraint failed')) return 'Invalid value for one of the fields';
  return m;
}
function stripFinance(user, table, data) {
  if (auth.can(user, 'finance')) return;
  for (const f of FINANCE_FIELDS[table] || []) delete data[f];
}
function redactRows(user, table, rows) {
  const fields = FINANCE_FIELDS[table];
  if (!fields) return rows;
  return auth.redact(user, rows, fields);
}

// ---------- councils ----------
crud('councils', 'councils', {
  singular: 'council',
  list: () => all(`SELECT c.*, (SELECT COUNT(*) FROM contracts WHERE council_id=c.id AND status='active') AS contract_count FROM councils c ORDER BY c.name`),
  detail: id => {
    const row = get('SELECT * FROM councils WHERE id = ?', [id]);
    if (!row) return null;
    row.contracts = all(`SELECT c.id, c.code, c.name, c.status, c.income_per_day, s.name AS school_name, (SELECT COUNT(*) FROM children WHERE contract_id=c.id AND status='active') AS child_count FROM contracts c LEFT JOIN schools s ON s.id=c.school_id WHERE c.council_id = ? ORDER BY c.code`, [id]);
    row.history = audit.history('councils', id, 30);
    return row;
  },
  guard: row => get('SELECT COUNT(*) n FROM contracts WHERE council_id = ?', [row.id]).n ? null : null,
});

// ---------- schools ----------
crud('schools', 'schools', {
  singular: 'school',
  docEntity: 'school',
  list: () => all(`SELECT s.*,
      (SELECT COUNT(*) FROM children WHERE school_id=s.id AND status='active') AS child_count,
      (SELECT COUNT(*) FROM contracts WHERE school_id=s.id AND status='active') AS contract_count
    FROM schools s ORDER BY s.name`),
  detail: id => {
    const row = get('SELECT * FROM schools WHERE id = ?', [id]);
    if (!row) return null;
    row.children = all(`SELECT ch.id, ch.first_name, ch.last_name, ch.postcode, ch.wheelchair, ch.status, c.code AS contract_code, c.id AS contract_id,
        d.first_name || ' ' || d.last_name AS driver_name, p.first_name || ' ' || p.last_name AS pa_name
      FROM children ch LEFT JOIN contracts c ON c.id=ch.contract_id
      LEFT JOIN staff d ON d.id=c.driver_id LEFT JOIN staff p ON p.id=c.pa_id
      WHERE ch.school_id = ? ORDER BY ch.last_name, ch.first_name`, [id]);
    row.contracts = all(`SELECT c.*, cl.name AS council_name, d.first_name || ' ' || d.last_name AS driver_name, p.first_name || ' ' || p.last_name AS pa_name,
        (SELECT COUNT(*) FROM children WHERE contract_id=c.id AND status='active') AS child_count
      FROM contracts c LEFT JOIN councils cl ON cl.id=c.council_id LEFT JOIN staff d ON d.id=c.driver_id LEFT JOIN staff p ON p.id=c.pa_id
      WHERE c.school_id = ? ORDER BY c.code`, [id]);
    row.drivers = all(`SELECT DISTINCT s.id, s.first_name, s.last_name, s.phone, s.type FROM staff s JOIN contracts c ON c.driver_id = s.id WHERE c.school_id = ? AND c.status='active'`, [id]);
    row.pas = all(`SELECT DISTINCT s.id, s.first_name, s.last_name, s.phone, s.type FROM staff s JOIN contracts c ON c.pa_id = s.id WHERE c.school_id = ? AND c.status='active'`, [id]);
    row.documents = documentsFor('school', id);
    row.history = audit.history('schools', id, 30);
    return row;
  },
});

// ---------- staff (drivers + PAs) ----------
crud('staff', 'staff', {
  singular: 'staff member',
  docEntity: 'staff',
  list: ctx => {
    let sql = `SELECT s.*, (SELECT COUNT(*) FROM contracts WHERE (driver_id=s.id OR pa_id=s.id) AND status='active') AS contract_count,
      (SELECT group_concat(registration, ', ') FROM vehicles WHERE driver_id=s.id AND active=1) AS vehicles
      FROM staff s WHERE 1=1`;
    const p = [];
    if (ctx.query.type) { sql += ' AND s.type = ?'; p.push(ctx.query.type); }
    if (ctx.query.status) { sql += ' AND s.status = ?'; p.push(ctx.query.status); }
    sql += ' ORDER BY s.last_name, s.first_name';
    const rows = all(sql, p);
    for (const r of rows) { r.name = `${r.first_name} ${r.last_name}`; r.compliance = compliance.staffCompliance(r.id, r.type).status; }
    return rows;
  },
  detail: id => {
    const row = get('SELECT * FROM staff WHERE id = ?', [id]);
    if (!row) return null;
    row.name = `${row.first_name} ${row.last_name}`;
    row.vehicles = all('SELECT * FROM vehicles WHERE driver_id = ? ORDER BY active DESC, registration', [id]);
    row.contracts = all(`SELECT c.id, c.code, c.name, c.status, c.days_of_week, c.am_pickup_time, c.pm_dropoff_time,
        c.driver_pay_per_day, c.pa_pay_per_day, c.pay_basis, c.driver_id, c.pa_id,
        s.name AS school_name, s.id AS school_id, cl.name AS council_name,
        (SELECT COUNT(*) FROM children WHERE contract_id=c.id AND status='active') AS child_count
      FROM contracts c LEFT JOIN schools s ON s.id=c.school_id LEFT JOIN councils cl ON cl.id=c.council_id
      WHERE c.driver_id = ? OR c.pa_id = ? ORDER BY c.status, c.code`, [id, id]);
    for (const c of row.contracts) c.role = c.driver_id === id ? 'driver' : 'pa';
    row.children = all(`SELECT ch.id, ch.first_name, ch.last_name, ch.wheelchair, ch.sen_needs, ch.pickup_time, ch.dropoff_time,
        c.code AS contract_code, c.id AS contract_id, s.name AS school_name
      FROM children ch JOIN contracts c ON c.id = ch.contract_id LEFT JOIN schools s ON s.id = ch.school_id
      WHERE (c.driver_id = ? OR c.pa_id = ?) AND ch.status='active' ORDER BY c.code, ch.last_name`, [id, id]);
    row.compliance = compliance.staffCompliance(id, row.type);
    row.documents = documentsFor('staff', id);
    row.vehicle_documents = all(`SELECT d.*, v.registration FROM documents d JOIN vehicles v ON v.id = d.entity_id WHERE d.entity_type='vehicle' AND v.driver_id = ? ORDER BY d.expiry_date`, [id]);
    row.recent_cover = all(`SELECT e.*, c.code AS contract_code FROM exceptions e LEFT JOIN contracts c ON c.id=e.contract_id WHERE e.cover_staff_id = ? ORDER BY e.date DESC LIMIT 20`, [id]);
    row.absences = all(`SELECT e.*, c.code AS contract_code, cs.first_name || ' ' || cs.last_name AS cover_name FROM exceptions e LEFT JOIN contracts c ON c.id=e.contract_id LEFT JOIN staff cs ON cs.id=e.cover_staff_id WHERE e.type='staff_absence' AND e.staff_id = ? ORDER BY e.date DESC LIMIT 20`, [id]);
    row.payments = all('SELECT * FROM payments WHERE staff_id = ? ORDER BY work_date DESC LIMIT 25', [id]);
    row.history = audit.history('staff', id, 40);
    return row;
  },
  guard: row => {
    const n = get('SELECT COUNT(*) n FROM contracts WHERE (driver_id = ? OR pa_id = ?) AND status = \'active\'', [row.id, row.id]).n;
    return n ? `Cannot delete: still assigned to ${n} active contract(s). Unassign first or set status to inactive.` : null;
  },
  resolve: (col, v) => v,
});

// ---------- vehicles ----------
crud('vehicles', 'vehicles', {
  singular: 'vehicle',
  docEntity: 'vehicle',
  label: r => r.registration,
  list: () => all(`SELECT v.*, s.first_name || ' ' || s.last_name AS driver_name FROM vehicles v LEFT JOIN staff s ON s.id=v.driver_id ORDER BY v.active DESC, v.registration`),
  detail: id => {
    const row = get('SELECT v.*, s.first_name || \' \' || s.last_name AS driver_name FROM vehicles v LEFT JOIN staff s ON s.id=v.driver_id WHERE v.id = ?', [id]);
    if (!row) return null;
    row.documents = documentsFor('vehicle', id);
    row.contracts = all('SELECT id, code, name, status FROM contracts WHERE vehicle_id = ?', [id]);
    row.history = audit.history('vehicles', id, 30);
    return row;
  },
});

// ---------- contracts ----------
crud('contracts', 'contracts', {
  singular: 'contract',
  docEntity: 'contract',
  label: r => r.code,
  auditType: 'contracts',
  list: ctx => {
    let sql = `SELECT c.*, s.name AS school_name, s.postcode AS school_postcode, cl.name AS council_name,
        d.first_name || ' ' || d.last_name AS driver_name, p.first_name || ' ' || p.last_name AS pa_name,
        v.registration AS vehicle_reg, v.seats AS vehicle_seats,
        (SELECT COUNT(*) FROM children WHERE contract_id=c.id AND status='active') AS child_count
      FROM contracts c
      LEFT JOIN schools s ON s.id=c.school_id LEFT JOIN councils cl ON cl.id=c.council_id
      LEFT JOIN staff d ON d.id=c.driver_id LEFT JOIN staff p ON p.id=c.pa_id
      LEFT JOIN vehicles v ON v.id=c.vehicle_id WHERE 1=1`;
    const p = [];
    if (ctx.query.status) { sql += ' AND c.status = ?'; p.push(ctx.query.status); }
    if (ctx.query.school_id) { sql += ' AND c.school_id = ?'; p.push(Number(ctx.query.school_id)); }
    if (ctx.query.council_id) { sql += ' AND c.council_id = ?'; p.push(Number(ctx.query.council_id)); }
    sql += ' ORDER BY c.code';
    const rows = all(sql, p);
    for (const r of rows) {
      r.margin = r.income_per_day > 0 ? cal.round2((r.income_per_day - r.driver_pay_per_day - r.pa_pay_per_day - r.other_costs_per_day) / r.income_per_day * 100) : 0;
      r.expected_profit_per_day = cal.round2(r.income_per_day - r.driver_pay_per_day - r.pa_pay_per_day - r.other_costs_per_day);
    }
    return rows;
  },
  detail: (id, ctx) => {
    const row = get(`SELECT c.*, s.name AS school_name, s.address AS school_address, s.postcode AS school_postcode, s.phone AS school_phone,
        s.open_time AS school_open, s.close_time AS school_close,
        cl.name AS council_name, d.first_name || ' ' || d.last_name AS driver_name, d.phone AS driver_phone,
        p.first_name || ' ' || p.last_name AS pa_name, p.phone AS pa_phone,
        v.registration AS vehicle_reg, v.make AS vehicle_make, v.model AS vehicle_model, v.seats AS vehicle_seats, v.wheelchair_accessible
      FROM contracts c
      LEFT JOIN schools s ON s.id=c.school_id LEFT JOIN councils cl ON cl.id=c.council_id
      LEFT JOIN staff d ON d.id=c.driver_id LEFT JOIN staff p ON p.id=c.pa_id LEFT JOIN vehicles v ON v.id=c.vehicle_id
      WHERE c.id = ?`, [id]);
    if (!row) return null;
    row.children = all(`SELECT id, first_name, last_name, dob, postcode, address, pickup_time, dropoff_time, wheelchair, mobility, sen_needs, medical_info, allergies, behaviour, status, parent_name, parent_phone
      FROM children WHERE contract_id = ? ORDER BY status, pickup_time, last_name`, [id]);
    row.child_count = row.children.filter(c => c.status === 'active').length;
    row.documents = documentsFor('contract', id);
    row.driver_compliance = row.driver_id ? compliance.staffCompliance(row.driver_id, 'driver').status : null;
    row.pa_compliance = row.pa_id ? compliance.staffCompliance(row.pa_id, 'pa').status : null;
    // financial snapshot for the current month
    const from = cal.today().slice(0, 8) + '01';
    const to = cal.addDays(nextMonthStart(from), -1);
    if (auth.can(ctx.user, 'finance')) {
      const prof = finance.profitability({ from, to, contract_id: id });
      row.financials = prof.rows[0] || null;
      row.financials_period = { from, to };
      row.per_day = {
        income: row.income_per_day, driver: row.driver_pay_per_day, pa: row.pa_pay_per_day, other: row.other_costs_per_day,
        profit: cal.round2(row.income_per_day - row.driver_pay_per_day - row.pa_pay_per_day - row.other_costs_per_day),
        margin: row.income_per_day > 0 ? cal.round2((row.income_per_day - row.driver_pay_per_day - row.pa_pay_per_day - row.other_costs_per_day) / row.income_per_day * 100) : 0,
      };
    }
    const recentFrom = cal.addDays(cal.today(), -14);
    const recentTo = cal.addDays(cal.today(), 14);
    row.exceptions = all(`SELECT e.*, ch.first_name || ' ' || ch.last_name AS child_name, cs.first_name || ' ' || cs.last_name AS cover_name, st.first_name || ' ' || st.last_name AS staff_name
      FROM exceptions e LEFT JOIN children ch ON ch.id=e.child_id LEFT JOIN staff cs ON cs.id=e.cover_staff_id LEFT JOIN staff st ON st.id=e.staff_id
      WHERE e.contract_id = ? AND e.date >= ? ORDER BY e.date DESC LIMIT 60`, [id, recentFrom]);
    row.history = audit.history('contracts', id, 50);
    return row;
  },
  before: (data) => { if (data.code) data.code = String(data.code).trim().toUpperCase(); },
  after: (row, ctx, before) => {
    // Changing a contract's school re-points its children so the hierarchy stays consistent.
    if (before && row.school_id !== before.school_id && row.school_id) {
      run('UPDATE children SET school_id = ? WHERE contract_id = ?', [row.school_id, row.id]);
    }
  },
  resolve: (col, v) => {
    if (v === null || v === undefined || v === '') return null;
    if (col === 'driver_id' || col === 'pa_id') { const s = get('SELECT first_name, last_name FROM staff WHERE id=?', [Number(v)]); return s ? `${s.first_name} ${s.last_name}` : v; }
    if (col === 'school_id') { const s = get('SELECT name FROM schools WHERE id=?', [Number(v)]); return s ? s.name : v; }
    if (col === 'council_id') { const s = get('SELECT name FROM councils WHERE id=?', [Number(v)]); return s ? s.name : v; }
    if (col === 'vehicle_id') { const s = get('SELECT registration FROM vehicles WHERE id=?', [Number(v)]); return s ? s.registration : v; }
    return v;
  },
  guard: row => {
    const n = get('SELECT COUNT(*) n FROM children WHERE contract_id = ?', [row.id]).n;
    return n ? `Cannot delete: ${n} child(ren) are assigned to this contract. Move them first.` : null;
  },
});

// ---------- children ----------
crud('children', 'children', {
  singular: 'child',
  docEntity: 'child',
  list: ctx => {
    let sql = `SELECT ch.*, s.name AS school_name, c.code AS contract_code,
        d.first_name || ' ' || d.last_name AS driver_name, p.first_name || ' ' || p.last_name AS pa_name
      FROM children ch LEFT JOIN schools s ON s.id=ch.school_id LEFT JOIN contracts c ON c.id=ch.contract_id
      LEFT JOIN staff d ON d.id=c.driver_id LEFT JOIN staff p ON p.id=c.pa_id WHERE 1=1`;
    const p = [];
    if (ctx.query.status) { sql += ' AND ch.status = ?'; p.push(ctx.query.status); }
    if (ctx.query.school_id) { sql += ' AND ch.school_id = ?'; p.push(Number(ctx.query.school_id)); }
    if (ctx.query.contract_id) { sql += ' AND ch.contract_id = ?'; p.push(Number(ctx.query.contract_id)); }
    sql += ' ORDER BY ch.last_name, ch.first_name';
    const rows = all(sql, p);
    for (const r of rows) r.name = `${r.first_name} ${r.last_name}`;
    return rows;
  },
  detail: id => {
    const row = get(`SELECT ch.*, s.name AS school_name, s.address AS school_address, s.postcode AS school_postcode, s.phone AS school_phone,
        c.code AS contract_code, c.id AS contract_id2, c.route_info, c.am_pickup_time AS contract_am, c.pm_dropoff_time AS contract_pm,
        c.days_of_week, cl.name AS council_name,
        d.id AS driver_id, d.first_name || ' ' || d.last_name AS driver_name, d.phone AS driver_phone,
        p.id AS pa_id, p.first_name || ' ' || p.last_name AS pa_name, p.phone AS pa_phone,
        v.registration AS vehicle_reg
      FROM children ch LEFT JOIN schools s ON s.id=ch.school_id LEFT JOIN contracts c ON c.id=ch.contract_id
      LEFT JOIN councils cl ON cl.id=c.council_id LEFT JOIN staff d ON d.id=c.driver_id LEFT JOIN staff p ON p.id=c.pa_id
      LEFT JOIN vehicles v ON v.id=c.vehicle_id WHERE ch.id = ?`, [id]);
    if (!row) return null;
    row.name = `${row.first_name} ${row.last_name}`;
    row.travels_with = row.contract_id ? all('SELECT id, first_name, last_name, pickup_time FROM children WHERE contract_id = ? AND id != ? AND status=\'active\' ORDER BY pickup_time', [row.contract_id, id]) : [];
    row.documents = documentsFor('child', id);
    row.absences = all(`SELECT e.*, c.code AS contract_code FROM exceptions e LEFT JOIN contracts c ON c.id=e.contract_id WHERE e.child_id = ? ORDER BY e.date DESC LIMIT 40`, [id]);
    row.history = audit.history('children', id, 40);
    return row;
  },
  before: (data, ctx) => {
    // A child inherits the school from their contract unless one is given explicitly.
    if (data.contract_id && !data.school_id) {
      const c = get('SELECT school_id FROM contracts WHERE id = ?', [Number(data.contract_id)]);
      if (c && c.school_id) data.school_id = c.school_id;
    }
  },
  resolve: (col, v) => {
    if (!v) return v;
    if (col === 'school_id') { const s = get('SELECT name FROM schools WHERE id=?', [Number(v)]); return s ? s.name : v; }
    if (col === 'contract_id') { const s = get('SELECT code FROM contracts WHERE id=?', [Number(v)]); return s ? s.code : v; }
    return v;
  },
});

// ---------- expenses ----------
crud('expenses', 'expenses', {
  singular: 'expense',
  label: r => `${r.category} ${r.amount}`,
  list: ctx => {
    let sql = 'SELECT e.*, c.code AS contract_code FROM expenses e LEFT JOIN contracts c ON c.id=e.contract_id WHERE 1=1';
    const p = [];
    if (ctx.query.from) { sql += ' AND e.date >= ?'; p.push(ctx.query.from); }
    if (ctx.query.to) { sql += ' AND e.date <= ?'; p.push(ctx.query.to); }
    if (ctx.query.contract_id) { sql += ' AND e.contract_id = ?'; p.push(Number(ctx.query.contract_id)); }
    sql += ' ORDER BY e.date DESC LIMIT 500';
    return all(sql, p);
  },
});

function nextMonthStart(d) {
  const [y, m] = d.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

// ---------- documents ----------
function documentsFor(type, id) {
  const rows = all('SELECT * FROM documents WHERE entity_type = ? AND entity_id = ? ORDER BY doc_type, expiry_date DESC', [type, id]);
  const amber = compliance.amberDays();
  for (const r of rows) {
    r.calculated_status = compliance.docStatus(r, amber);
    r.days_left = r.expiry_date ? compliance.daysBetween(cal.today(), r.expiry_date) : null;
  }
  return rows;
}
route('GET', '/api/documents', 'view', ctx => {
  if (ctx.query.entity_type && ctx.query.entity_id) return H.json(ctx.res, documentsFor(ctx.query.entity_type, Number(ctx.query.entity_id)));
  const rows = compliance.expiringDocuments(Number(ctx.query.days || 3650), true);
  H.json(ctx.res, rows);
});
route('POST', '/api/documents', 'documents', ctx => {
  const f = ctx.body;
  const entityType = f.entity_type, entityId = Number(f.entity_id);
  if (!entityType || !entityId) return H.error(ctx.res, 'entity_type and entity_id are required');
  let stored = null, fileName = null, mime = null, size = null;
  const file = (ctx.files || [])[0];
  if (file && file.data && file.data.length) {
    const ext = path.extname(file.filename).slice(0, 10);
    stored = crypto.randomBytes(12).toString('hex') + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, stored), file.data);
    fileName = file.filename; mime = file.mime; size = file.data.length;
  }
  const id = insert('documents', {
    entity_type: entityType, entity_id: entityId, doc_type: f.doc_type || 'Other', reference: f.reference,
    file_name: fileName, stored_name: stored, mime_type: mime, size,
    issue_date: f.issue_date, expiry_date: f.expiry_date, status: f.status || 'valid', notes: f.notes,
    uploaded_by: ctx.user.name,
  }, ['entity_type', 'entity_id', 'doc_type', 'reference', 'file_name', 'stored_name', 'mime_type', 'size', 'issue_date', 'expiry_date', 'status', 'notes', 'uploaded_by']);
  audit.logAction(ctx.user, entityType === 'staff' ? 'staff' : entityType + 's', entityId, null, 'document', `Added document ${f.doc_type}${f.expiry_date ? ' expiring ' + f.expiry_date : ''}`);
  H.json(ctx.res, get('SELECT * FROM documents WHERE id = ?', [id]), 201);
});
route('PUT', '/api/documents/:id', 'documents', ctx => {
  const id = Number(ctx.params.id);
  const before = get('SELECT * FROM documents WHERE id = ?', [id]);
  if (!before) return H.error(ctx.res, 'Document not found', 404);
  update('documents', id, ctx.body, ['doc_type', 'reference', 'issue_date', 'expiry_date', 'status', 'notes']);
  audit.logAction(ctx.user, before.entity_type === 'staff' ? 'staff' : before.entity_type + 's', before.entity_id, null, 'document', `Updated document ${before.doc_type}`);
  H.json(ctx.res, get('SELECT * FROM documents WHERE id = ?', [id]));
});
route('DELETE', '/api/documents/:id', 'documents', ctx => {
  const id = Number(ctx.params.id);
  const doc = get('SELECT * FROM documents WHERE id = ?', [id]);
  if (!doc) return H.error(ctx.res, 'Document not found', 404);
  if (doc.stored_name) { try { fs.unlinkSync(path.join(UPLOAD_DIR, doc.stored_name)); } catch (_) {} }
  run('DELETE FROM documents WHERE id = ?', [id]);
  audit.logAction(ctx.user, doc.entity_type === 'staff' ? 'staff' : doc.entity_type + 's', doc.entity_id, null, 'document', `Deleted document ${doc.doc_type}`);
  H.json(ctx.res, { ok: true });
});
route('GET', '/api/documents/:id/file', 'view', ctx => {
  const doc = get('SELECT * FROM documents WHERE id = ?', [Number(ctx.params.id)]);
  if (!doc || !doc.stored_name) return H.error(ctx.res, 'No file attached', 404);
  const full = path.join(UPLOAD_DIR, doc.stored_name);
  if (!fs.existsSync(full)) return H.error(ctx.res, 'File missing from store', 404);
  ctx.res.writeHead(200, { 'Content-Type': doc.mime_type || 'application/octet-stream', 'Content-Disposition': `inline; filename="${(doc.file_name || 'document').replace(/"/g, '')}"` });
  fs.createReadStream(full).pipe(ctx.res);
});

// ---------- compliance ----------
route('GET', '/api/compliance', 'view', ctx => {
  const rows = all("SELECT id, type, first_name, last_name, status, postcode, phone FROM staff WHERE status IN ('active','pool') ORDER BY type, last_name");
  const out = rows.map(s => {
    const c = compliance.staffCompliance(s.id, s.type);
    return { id: s.id, name: `${s.first_name} ${s.last_name}`, type: s.type, staff_status: s.status, postcode: s.postcode, phone: s.phone, status: c.status, items: c.items };
  });
  const filtered = ctx.query.status ? out.filter(o => o.status === ctx.query.status) : out;
  H.json(ctx.res, { amber_days: compliance.amberDays(), required: { driver: compliance.requiredDocs('driver'), pa: compliance.requiredDocs('pa') }, staff: filtered, summary: { green: out.filter(o => o.status === 'green').length, amber: out.filter(o => o.status === 'amber').length, red: out.filter(o => o.status === 'red').length } });
});
route('GET', '/api/compliance/expiring', 'view', ctx => {
  H.json(ctx.res, compliance.expiringDocuments(Number(ctx.query.days || compliance.amberDays()), ctx.query.expired !== '0'));
});

// ---------- calendar & exceptions ----------
route('GET', '/api/calendar', 'view', ctx => {
  const from = ctx.query.from || cal.today();
  const to = ctx.query.to || cal.addDays(from, 6);
  if (cal.dateRange(from, to).length > 120) return H.error(ctx.res, 'Date range too large (max 120 days)');
  const filter = {};
  if (ctx.query.contract_id) filter.contract_id = Number(ctx.query.contract_id);
  if (ctx.query.school_id) filter.school_id = Number(ctx.query.school_id);
  if (ctx.query.staff_id) filter.staff_id = Number(ctx.query.staff_id);
  const data = cal.buildCalendar(from, to, filter);
  H.json(ctx.res, data);
});
route('GET', '/api/day/:date', 'view', ctx => H.json(ctx.res, cal.dayOverview(ctx.params.date)));

route('GET', '/api/exceptions', 'view', ctx => {
  const from = ctx.query.from || cal.addDays(cal.today(), -30);
  const to = ctx.query.to || cal.addDays(cal.today(), 30);
  let rows = cal.loadExceptions(from, to);
  if (ctx.query.contract_id) rows = rows.filter(r => r.contract_id === Number(ctx.query.contract_id));
  if (ctx.query.type) rows = rows.filter(r => r.type === ctx.query.type);
  const codes = Object.fromEntries(all('SELECT id, code FROM contracts').map(c => [c.id, c.code]));
  H.json(ctx.res, rows.map(r => ({ ...r, contract_code: codes[r.contract_id] || null })));
});

const EX_COLS = ['date', 'type', 'leg', 'contract_id', 'school_id', 'child_id', 'role', 'staff_id', 'cover_staff_id', 'cover_pay', 'paid_immediately', 'amount', 'note', 'created_by'];
route('POST', '/api/exceptions', 'calendar', ctx => {
  const b = ctx.body;
  const dates = Array.isArray(b.dates) && b.dates.length ? b.dates : [b.date];
  if (!dates[0]) return H.error(ctx.res, 'A date is required');
  if (!b.type) return H.error(ctx.res, 'An exception type is required');
  const created = [];
  try {
    transaction(() => {
      for (const date of dates) {
        const data = { ...b, date, created_by: ctx.user.name };
        delete data.dates;
        if (data.type === 'staff_absence') {
          if (!data.role) throw new Error('Select whether the driver or the PA is absent');
          const c = get('SELECT driver_id, pa_id, code, driver_pay_per_day, pa_pay_per_day FROM contracts WHERE id = ?', [Number(data.contract_id)]);
          if (!c) throw new Error('Contract not found');
          data.staff_id = data.role === 'driver' ? c.driver_id : c.pa_id;
          if (data.cover_staff_id && data.cover_pay === undefined) {
            const base = data.role === 'driver' ? c.driver_pay_per_day : c.pa_pay_per_day;
            data.cover_pay = cal.round2(base * (data.leg === 'DAY' || !data.leg ? 1 : 0.5));
          }
        }
        if (data.type === 'child_absence' && !data.child_id) throw new Error('Select the child who was absent');
        if (data.type === 'school_closed' && data.school_id) data.contract_id = null;
        const id = insert('exceptions', data, EX_COLS);
        // "Paid immediately" writes a payment straight away so payroll never pays it twice.
        if (data.type === 'staff_absence' && data.cover_staff_id && Number(data.paid_immediately) === 1) {
          const amount = data.cover_pay != null ? Number(data.cover_pay) : 0;
          insert('payments', {
            staff_id: Number(data.cover_staff_id), work_date: date, paid_date: cal.today(), amount,
            source: 'cover_immediate', exception_id: id, note: `Cover paid immediately`, created_by: ctx.user.name,
          }, ['staff_id', 'work_date', 'paid_date', 'amount', 'source', 'exception_id', 'note', 'created_by']);
        }
        const row = get('SELECT * FROM exceptions WHERE id = ?', [id]);
        created.push(row);
        audit.logAction(ctx.user, 'exceptions', id, describeException(row), 'create', `${date}: ${describeException(row)}`);
        if (row.contract_id) audit.logAction(ctx.user, 'contracts', row.contract_id, null, 'exception', `${date} ${row.leg}: ${describeException(row)}`);
      }
    });
  } catch (e) { return H.error(ctx.res, e.message, 400); }
  H.json(ctx.res, created, 201);
});
route('DELETE', '/api/exceptions/:id', 'calendar', ctx => {
  const id = Number(ctx.params.id);
  const row = get('SELECT * FROM exceptions WHERE id = ?', [id]);
  if (!row) return H.error(ctx.res, 'Exception not found', 404);
  const pay = get('SELECT * FROM payments WHERE exception_id = ?', [id]);
  transaction(() => {
    if (pay) run('DELETE FROM payments WHERE exception_id = ?', [id]);
    run('DELETE FROM exceptions WHERE id = ?', [id]);
  });
  audit.logAction(ctx.user, 'exceptions', id, describeException(row), 'delete', `Removed ${row.date}: ${describeException(row)}${pay ? ' (immediate payment reversed)' : ''}`);
  if (row.contract_id) audit.logAction(ctx.user, 'contracts', row.contract_id, null, 'exception', `Removed ${row.date} ${row.leg}: ${describeException(row)}`);
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

// ---------- dashboard & search ----------
route('GET', '/api/dashboard', 'view', ctx => {
  const d = dash.dashboard(ctx.query.date);
  if (!auth.can(ctx.user, 'finance')) d.finance = null;
  H.json(ctx.res, d);
});
route('GET', '/api/search', 'view', ctx => H.json(ctx.res, search.universalSearch(ctx.query.q, Number(ctx.query.limit || 8))));

// ---------- staff pool / suitability ----------
route('GET', '/api/pool', 'view', ctx => {
  const type = ctx.query.type || 'driver';
  const target = (ctx.query.postcode || '').toUpperCase().trim();
  const date = ctx.query.date;
  const leg = ctx.query.leg || 'DAY';
  const needWheelchair = ctx.query.wheelchair === '1';
  const minSeats = Number(ctx.query.seats || 0);
  const includeAssigned = ctx.query.include_assigned === '1';
  let sql = `SELECT s.*, (SELECT COUNT(*) FROM contracts WHERE (driver_id=s.id OR pa_id=s.id) AND status='active') AS contract_count,
      (SELECT group_concat(registration || ' (' || COALESCE(seats,'?') || ' seats' || CASE WHEN wheelchair_accessible=1 THEN ', WAV' ELSE '' END || ')', '; ') FROM vehicles WHERE driver_id=s.id AND active=1) AS vehicle_summary,
      (SELECT MAX(seats) FROM vehicles WHERE driver_id=s.id AND active=1) AS max_seats,
      (SELECT MAX(wheelchair_accessible) FROM vehicles WHERE driver_id=s.id AND active=1) AS has_wav
    FROM staff s WHERE s.type = ? AND s.status IN ('pool','active')`;
  const rows = all(sql, [type]);
  const out = [];
  for (const s of rows) {
    if (!includeAssigned && s.status === 'active' && s.contract_count > 0 && !date) continue;
    const comp = compliance.staffCompliance(s.id, s.type);
    const prox = postcodeScore(target, s.postcode);
    let busy = null;
    if (date) busy = staffBusyOn(s.id, date, leg);
    if (type === 'driver') {
      if (needWheelchair && !s.has_wav) continue;
      if (minSeats && (s.max_seats || 0) < minSeats) continue;
    }
    out.push({
      id: s.id, name: `${s.first_name} ${s.last_name}`, type: s.type, status: s.status, postcode: s.postcode,
      phone: s.phone, email: s.email, availability: s.availability, preferred_areas: s.preferred_areas,
      default_day_rate: auth.can(ctx.user, 'finance') ? s.default_day_rate : null,
      contract_count: s.contract_count, vehicle_summary: s.vehicle_summary, max_seats: s.max_seats, has_wav: !!s.has_wav,
      compliance: comp.status, compliance_problems: comp.items.filter(i => i.status !== 'green').map(i => `${i.doc_type}: ${i.reason}`),
      proximity: prox.label, proximity_score: prox.score, busy,
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

/** Rough UK postcode proximity by outward code. Honest heuristic, no geocoding data required. */
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
function staffBusyOn(staffId, date, leg) {
  const contracts = cal.loadContracts(' WHERE (c.driver_id = ? OR c.pa_id = ?) AND c.status = \'active\'', [staffId, staffId]);
  const operating = contracts.filter(c => cal.contractOperatesOn(c, date));
  const exceptions = cal.loadExceptions(date, date);
  const stillWorking = operating.filter(c => {
    const role = c.driver_id === staffId ? 'driver' : 'pa';
    return !exceptions.some(e => e.contract_id === c.id && e.type === 'staff_absence' && e.role === role && (e.leg === 'DAY' || leg === 'DAY' || e.leg === leg));
  });
  const covering = exceptions.filter(e => e.cover_staff_id === staffId);
  const parts = [];
  if (stillWorking.length) parts.push('On ' + stillWorking.map(c => c.code).join(', '));
  if (covering.length) parts.push(`Covering ${covering.length} ${covering.length === 1 ? 'journey' : 'journeys'}`);
  return parts.length ? parts.join('; ') : null;
}

// ---------- wages ----------
route('GET', '/api/wages', 'wages', ctx => {
  const from = ctx.query.from, to = ctx.query.to;
  if (!from || !to) return H.error(ctx.res, 'from and to dates are required');
  if (cal.dateRange(from, to).length > 400) return H.error(ctx.res, 'Date range too large (max 400 days)');
  const opts = { from, to, include_zero: ctx.query.include_zero === '1' };
  if (ctx.query.type) opts.type = ctx.query.type;
  if (ctx.query.contract_id) opts.contract_id = Number(ctx.query.contract_id);
  if (ctx.query.staff_ids) opts.staff_ids = String(ctx.query.staff_ids).split(',').map(Number).filter(Boolean);
  H.json(ctx.res, wages.calculateWages(opts));
});
route('GET', '/api/payments', 'wages', ctx => {
  let sql = `SELECT p.*, s.first_name || ' ' || s.last_name AS staff_name, s.type AS staff_type FROM payments p JOIN staff s ON s.id=p.staff_id WHERE 1=1`;
  const q = [];
  if (ctx.query.staff_id) { sql += ' AND p.staff_id = ?'; q.push(Number(ctx.query.staff_id)); }
  if (ctx.query.from) { sql += ' AND p.work_date >= ?'; q.push(ctx.query.from); }
  if (ctx.query.to) { sql += ' AND p.work_date <= ?'; q.push(ctx.query.to); }
  sql += ' ORDER BY p.work_date DESC, p.id DESC LIMIT 500';
  H.json(ctx.res, all(sql, q));
});
route('POST', '/api/payments', 'wages', ctx => {
  const b = ctx.body;
  if (!b.staff_id || !b.amount) return H.error(ctx.res, 'Staff member and amount are required');
  const id = insert('payments', { ...b, source: b.source || 'manual', work_date: b.work_date || cal.today(), paid_date: b.paid_date || cal.today(), created_by: ctx.user.name },
    ['staff_id', 'work_date', 'paid_date', 'amount', 'source', 'exception_id', 'method', 'reference', 'note', 'created_by']);
  audit.logAction(ctx.user, 'staff', Number(b.staff_id), null, 'payment', `Recorded payment of ${Number(b.amount).toFixed(2)} for ${b.work_date || cal.today()}`);
  H.json(ctx.res, get('SELECT * FROM payments WHERE id = ?', [id]), 201);
});
route('DELETE', '/api/payments/:id', 'wages', ctx => {
  const id = Number(ctx.params.id);
  const p = get('SELECT * FROM payments WHERE id = ?', [id]);
  if (!p) return H.error(ctx.res, 'Payment not found', 404);
  run('DELETE FROM payments WHERE id = ?', [id]);
  audit.logAction(ctx.user, 'staff', p.staff_id, null, 'payment', `Deleted payment of ${p.amount} for ${p.work_date}`);
  H.json(ctx.res, { ok: true });
});
// Mark a calculated payroll as paid: records one payment per staff member so it is never paid twice.
route('POST', '/api/payroll-runs', 'wages', ctx => {
  const { from, to, staff_ids, description } = ctx.body;
  if (!from || !to) return H.error(ctx.res, 'from and to dates are required');
  const calc = wages.calculateWages({ from, to, staff_ids: staff_ids && staff_ids.length ? staff_ids : undefined });
  const payable = calc.results.filter(r => r.totals.amount_due > 0);
  if (!payable.length) return H.error(ctx.res, 'Nothing outstanding to pay for that period');
  let runId;
  transaction(() => {
    runId = insert('payroll_runs', { from_date: from, to_date: to, description: description || `Payroll ${from} to ${to}`, total: calc.totals.total_due, created_by: ctx.user.name },
      ['from_date', 'to_date', 'description', 'total', 'created_by']);
    for (const r of payable) {
      insert('payroll_run_lines', { payroll_run_id: runId, staff_id: r.staff.id, amount: r.totals.amount_due, breakdown_json: JSON.stringify(r) }, ['payroll_run_id', 'staff_id', 'amount', 'breakdown_json']);
      run('INSERT INTO payments (staff_id, work_date, paid_date, amount, source, payroll_run_id, note, created_by) VALUES (?,?,?,?,?,?,?,?)',
        [r.staff.id, to, cal.today(), r.totals.amount_due, 'payroll', runId, `Payroll ${from} to ${to}`, ctx.user.name]);
      audit.logAction(ctx.user, 'staff', r.staff.id, r.staff.name, 'payroll', `Paid ${r.totals.amount_due.toFixed(2)} for ${from} to ${to}`);
    }
  });
  H.json(ctx.res, { id: runId, paid: payable.length, total: calc.totals.total_due }, 201);
});
route('GET', '/api/payroll-runs', 'wages', ctx => H.json(ctx.res, all(`SELECT r.*, (SELECT COUNT(*) FROM payroll_run_lines WHERE payroll_run_id=r.id) AS staff_count FROM payroll_runs r ORDER BY r.id DESC LIMIT 100`)));
route('GET', '/api/payroll-runs/:id', 'wages', ctx => {
  const r = get('SELECT * FROM payroll_runs WHERE id = ?', [Number(ctx.params.id)]);
  if (!r) return H.error(ctx.res, 'Payroll run not found', 404);
  r.lines = all(`SELECT l.*, s.first_name || ' ' || s.last_name AS staff_name, s.type FROM payroll_run_lines l JOIN staff s ON s.id=l.staff_id WHERE l.payroll_run_id = ?`, [r.id])
    .map(l => ({ ...l, breakdown: l.breakdown_json ? JSON.parse(l.breakdown_json) : null, breakdown_json: undefined }));
  H.json(ctx.res, r);
});

// ---------- profitability ----------
route('GET', '/api/profitability', 'finance', ctx => {
  const from = ctx.query.from, to = ctx.query.to;
  if (!from || !to) return H.error(ctx.res, 'from and to dates are required');
  if (cal.dateRange(from, to).length > 400) return H.error(ctx.res, 'Date range too large (max 400 days)');
  const opts = { from, to };
  if (ctx.query.contract_id) opts.contract_id = Number(ctx.query.contract_id);
  if (ctx.query.school_id) opts.school_id = Number(ctx.query.school_id);
  if (ctx.query.council_id) opts.council_id = Number(ctx.query.council_id);
  H.json(ctx.res, finance.profitability(opts));
});

// ---------- settings, users, audit ----------
route('GET', '/api/settings', 'view', ctx => {
  H.json(ctx.res, {
    amber_days: compliance.amberDays(),
    company_name: getSetting('company_name', 'Home-to-School Transport'),
    required_docs_driver: compliance.requiredDocs('driver'),
    required_docs_pa: compliance.requiredDocs('pa'),
    all_doc_types: compliance.DOC_TYPES,
  });
});
route('POST', '/api/settings', '*', ctx => {
  const b = ctx.body;
  if (b.amber_days !== undefined) setSetting('amber_days', Math.max(0, Number(b.amber_days) || 0));
  if (b.company_name !== undefined) setSetting('company_name', b.company_name);
  if (b.required_docs_driver) setSetting('required_docs_driver', JSON.stringify(b.required_docs_driver));
  if (b.required_docs_pa) setSetting('required_docs_pa', JSON.stringify(b.required_docs_pa));
  audit.logAction(ctx.user, 'settings', 0, 'System settings', 'update', 'Updated system settings');
  H.json(ctx.res, { ok: true });
});
route('GET', '/api/users', '*', ctx => H.json(ctx.res, all('SELECT id, username, name, role, active, created_at FROM users ORDER BY name')));
route('POST', '/api/users', '*', ctx => {
  const { username, name, password, role } = ctx.body;
  if (!username || !name || !password) return H.error(ctx.res, 'Username, name and password are required');
  if (!auth.ROLES[role]) return H.error(ctx.res, 'Unknown role');
  if (String(password).length < 6) return H.error(ctx.res, 'Password must be at least 6 characters');
  try {
    const res = run('INSERT INTO users (username, password_hash, name, role) VALUES (?,?,?,?)', [String(username).trim(), auth.hash(password), name, role]);
    audit.logAction(ctx.user, 'user', Number(res.lastInsertRowid), name, 'create', `Created user ${username} with role ${role}`);
    H.json(ctx.res, get('SELECT id, username, name, role, active FROM users WHERE id = ?', [Number(res.lastInsertRowid)]), 201);
  } catch (e) { H.error(ctx.res, friendly(e)); }
});
route('PUT', '/api/users/:id', '*', ctx => {
  const id = Number(ctx.params.id);
  const u = get('SELECT * FROM users WHERE id = ?', [id]);
  if (!u) return H.error(ctx.res, 'User not found', 404);
  const b = ctx.body;
  if (b.role && !auth.ROLES[b.role]) return H.error(ctx.res, 'Unknown role');
  if (b.password) { if (String(b.password).length < 6) return H.error(ctx.res, 'Password must be at least 6 characters'); run('UPDATE users SET password_hash = ? WHERE id = ?', [auth.hash(b.password), id]); }
  if (b.name !== undefined) run('UPDATE users SET name = ? WHERE id = ?', [b.name, id]);
  if (b.role !== undefined) run('UPDATE users SET role = ? WHERE id = ?', [b.role, id]);
  if (b.active !== undefined) run('UPDATE users SET active = ? WHERE id = ?', [b.active ? 1 : 0, id]);
  audit.logAction(ctx.user, 'user', id, u.name, 'update', `Updated user ${u.username}`);
  H.json(ctx.res, get('SELECT id, username, name, role, active FROM users WHERE id = ?', [id]));
});
route('DELETE', '/api/users/:id', '*', ctx => {
  const id = Number(ctx.params.id);
  if (ctx.user.id === id) return H.error(ctx.res, 'You cannot delete your own account');
  const u = get('SELECT * FROM users WHERE id = ?', [id]);
  if (!u) return H.error(ctx.res, 'User not found', 404);
  run('DELETE FROM users WHERE id = ?', [id]);
  audit.logAction(ctx.user, 'user', id, u.name, 'delete', `Deleted user ${u.username}`);
  H.json(ctx.res, { ok: true });
});
route('GET', '/api/audit', 'audit', ctx => H.json(ctx.res, audit.recent(ctx.query, Number(ctx.query.limit || 200))));

// ---------- lookups for dropdowns (one call, keeps forms fast) ----------
route('GET', '/api/lookups', 'view', ctx => {
  H.json(ctx.res, {
    schools: all('SELECT id, name, postcode FROM schools WHERE active=1 ORDER BY name'),
    councils: all('SELECT id, name FROM councils WHERE active=1 ORDER BY name'),
    contracts: all("SELECT id, code, name, school_id, status FROM contracts ORDER BY code"),
    drivers: all("SELECT id, first_name || ' ' || last_name AS name, status, postcode FROM staff WHERE type='driver' ORDER BY last_name"),
    pas: all("SELECT id, first_name || ' ' || last_name AS name, status, postcode FROM staff WHERE type='pa' ORDER BY last_name"),
    vehicles: all("SELECT id, registration, seats, wheelchair_accessible, driver_id FROM vehicles WHERE active=1 ORDER BY registration"),
    children: all("SELECT id, first_name || ' ' || last_name AS name, contract_id, school_id FROM children WHERE status='active' ORDER BY last_name"),
  });
});

// ---------- reports ----------
route('GET', '/api/reports/:name', 'reports', ctx => reports.handle(ctx));

module.exports = { handle, routes, UPLOAD_DIR, documentsFor };
