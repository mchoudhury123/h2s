'use strict';
// Accounts, sessions and organisations.
//
// Each operating firm is an organisation. Everyone who can sign in is an
// administrator of their own firm and sees everything belonging to it, and
// nothing belonging to any other firm. There are no roles.
const crypto = require('crypto');
const { all, get, run, insert, transaction } = require('../db');

const SESSION_MS = 12 * 60 * 60 * 1000;
const MIN_PASSWORD = 8;

// ---------- passwords ----------
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

// ---------- validation ----------
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function checkEmail(email) {
  const e = String(email || '').trim();
  if (!e) return 'Enter an email address';
  if (!EMAIL_RX.test(e)) return 'That does not look like an email address';
  if (e.length > 254) return 'That email address is too long';
  return null;
}
function checkPassword(pw) {
  const p = String(pw || '');
  if (p.length < MIN_PASSWORD) return `Choose a password of at least ${MIN_PASSWORD} characters`;
  if (p.length > 200) return 'That password is too long';
  if (!/[a-zA-Z]/.test(p) || !/[0-9]/.test(p)) return 'Include at least one letter and one number';
  return null;
}
function checkBusinessName(name) {
  const n = String(name || '').trim();
  if (n.length < 2) return 'Enter the name of your business';
  if (n.length > 120) return 'That business name is too long';
  return null;
}

// ---------- registration ----------
/**
 * Creates a new operating firm and its first account.
 * Returns { organisation, user } or { error }.
 */
async function register({ email, business_name, password, name }) {
  const problem = checkEmail(email) || checkBusinessName(business_name) || checkPassword(password);
  if (problem) return { error: problem };

  const cleanEmail = String(email).trim();
  const existing = await get(
    '/* cross-org: an email address identifies one person across the whole system */ SELECT id FROM users WHERE LOWER(email) = LOWER(?)',
    [cleanEmail]);
  if (existing) return { error: 'An account already exists for that email address. Sign in instead.' };

  const result = await transaction(async tx => {
    const orgId = await tx.insertReturningId('INSERT INTO organisations (name) VALUES (?)', [String(business_name).trim()]);
    const userId = await insert('users', {
      organisation_id: orgId,
      email: cleanEmail,
      password_hash: hash(password),
      name: String(name || '').trim() || cleanEmail.split('@')[0],
    }, ['organisation_id', 'email', 'password_hash', 'name'], tx);
    await tx.run('INSERT INTO settings (organisation_id, key, value) VALUES (?,?,?)',
      [orgId, 'company_name', String(business_name).trim()]);
    await tx.run('INSERT INTO settings (organisation_id, key, value) VALUES (?,?,?)',
      [orgId, 'amber_days', '30']);
    return { orgId, userId };
  });

  const user = await get('SELECT id, organisation_id, email, name FROM users WHERE id = ?', [result.userId]);
  const organisation = await get('SELECT id, name FROM organisations WHERE id = ?', [result.orgId]);
  return { organisation, user };
}

// ---------- sessions ----------
const sessions = new Map(); // token -> { user, expires }

async function login(email, password) {
  const u = await get(
    `/* cross-org: sign-in finds the account first, which then fixes the firm */
     SELECT u.*, o.name AS organisation_name FROM users u
     JOIN organisations o ON o.id = u.organisation_id
     WHERE LOWER(u.email) = LOWER(?) AND u.active = 1 AND o.active = 1`,
    [String(email || '').trim()]);
  if (!u || !verify(password, u.password_hash)) return null;
  const token = crypto.randomBytes(24).toString('hex');
  const user = {
    id: u.id, email: u.email, name: u.name,
    organisation_id: u.organisation_id, organisation_name: u.organisation_name,
  };
  sessions.set(token, { user, expires: Date.now() + SESSION_MS });
  await run('/* cross-org: the account was just authenticated by id */ UPDATE users SET last_login = ? WHERE id = ?',
    [new Date().toISOString().slice(0, 19).replace('T', ' '), u.id]);
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
/** Ends every session belonging to a user, used when an account is disabled or deleted. */
function endSessionsFor(userId) {
  for (const [token, s] of sessions) if (s.user.id === userId) sessions.delete(token);
}

// ---------- colleagues within one firm ----------
async function addUser(orgId, { email, name, password }) {
  const problem = checkEmail(email) || checkPassword(password);
  if (problem) return { error: problem };
  const cleanEmail = String(email).trim();
  const existing = await get(
    '/* cross-org: an email address identifies one person across the whole system */ SELECT id FROM users WHERE LOWER(email) = LOWER(?)',
    [cleanEmail]);
  if (existing) return { error: 'That email address already has an account.' };
  const id = await insert('users', {
    organisation_id: orgId, email: cleanEmail, password_hash: hash(password),
    name: String(name || '').trim() || cleanEmail.split('@')[0],
  }, ['organisation_id', 'email', 'password_hash', 'name']);
  return { user: await get('SELECT id, email, name, active, created_at FROM users WHERE id = ? AND organisation_id = ?', [id, orgId]) };
}

async function listUsers(orgId) {
  return all('SELECT id, email, name, active, last_login, created_at FROM users WHERE organisation_id = ? ORDER BY name', [orgId]);
}

module.exports = {
  hash, verify, register, login, logout, userFor, endSessionsFor,
  addUser, listUsers, checkEmail, checkPassword, checkBusinessName, MIN_PASSWORD, sessions,
};
