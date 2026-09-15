'use strict';
// Sessions, password hashing and role-based permissions.
const crypto = require('crypto');
const { all, get, run } = require('../db');

const ROLES = {
  admin: { label: 'Administrator', perms: ['*'] },
  manager: { label: 'Manager', perms: ['view', 'edit', 'calendar', 'finance', 'wages', 'reports', 'documents', 'audit'] },
  operations: { label: 'Operations Staff', perms: ['view', 'edit', 'calendar', 'reports', 'documents'] },
  finance: { label: 'Finance', perms: ['view', 'finance', 'wages', 'reports'] },
  readonly: { label: 'Read Only', perms: ['view'] },
};

function hash(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(password, s, 64).toString('hex');
  return `${s}:${h}`;
}
function verify(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt] = stored.split(':');
  const candidate = hash(password, salt);
  const a = Buffer.from(candidate), b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const sessions = new Map(); // token -> { user, expires }
const SESSION_MS = 12 * 60 * 60 * 1000;

async function login(username, password) {
  const u = await get('SELECT * FROM users WHERE lower(username) = lower(?) AND active = 1', [String(username || '').trim()]);
  if (!u || !verify(password, u.password_hash)) return null;
  const token = crypto.randomBytes(24).toString('hex');
  const user = { id: u.id, username: u.username, name: u.name, role: u.role };
  sessions.set(token, { user, expires: Date.now() + SESSION_MS });
  return { token, user };
}
function logout(token) { sessions.delete(token); }
function userFor(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(token); return null; }
  s.expires = Date.now() + SESSION_MS;
  return s.user;
}
function can(user, perm) {
  if (!user) return false;
  const r = ROLES[user.role];
  if (!r) return false;
  return r.perms.includes('*') || r.perms.includes(perm);
}
/** Strip money fields from payloads for roles without finance access. */
function redact(user, obj, fields) {
  if (can(user, 'finance')) return obj;
  const copy = Array.isArray(obj) ? obj.map(o => ({ ...o })) : { ...obj };
  const apply = o => { for (const f of fields) if (f in o) o[f] = null; return o; };
  return Array.isArray(copy) ? copy.map(apply) : apply(copy);
}

async function ensureSeedAdmin() {
  const row = await get('SELECT COUNT(*) AS n FROM users');
  if (Number(row.n) === 0) {
    await run('INSERT INTO users (username, password_hash, name, role) VALUES (?,?,?,?)',
      ['admin', hash('admin123'), 'System Administrator', 'admin']);
    return true;
  }
  return false;
}

module.exports = { ROLES, hash, verify, login, logout, userFor, can, redact, ensureSeedAdmin, sessions };
