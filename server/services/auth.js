'use strict';
// Accounts, sessions and organisations.
//
// Each operating firm is an organisation. Everyone who can sign in is an
// administrator of the firm they are looking at and sees everything belonging
// to it, and nothing belonging to any other firm. There are no roles.
//
// One person has one account and one password. That account was created in
// one business, its own, and can be added to others by their colleagues. The
// session remembers which business it is looking at, and the sidebar switches.
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
// Sessions live in the database rather than in memory, so the CRM works on a
// serverless host where consecutive requests hit different instances, and so
// signing someone out takes effect everywhere at once.
function sessionExpiry() {
  return new Date(Date.now() + SESSION_MS).toISOString().slice(0, 19).replace('T', ' ');
}
function nowStamp() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

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
  await run('/* cross-org: a new session for the account just authenticated */ INSERT INTO sessions (token, user_id, organisation_id, expires_at) VALUES (?,?,?,?)',
    [token, u.id, u.organisation_id, sessionExpiry()]);
  await run('/* cross-org: the account was just authenticated by id */ UPDATE users SET last_login = ? WHERE id = ?',
    [nowStamp(), u.id]);
  // Tidy up anything long expired. Cheap, and keeps the table from growing.
  await run('/* cross-org: housekeeping across all sessions */ DELETE FROM sessions WHERE expires_at < ?', [nowStamp()]);
  return { token, user };
}

async function logout(token) {
  if (token) await run('/* cross-org: a session is identified by its own token */ DELETE FROM sessions WHERE token = ?', [token]);
}

/**
 * Resolves a session token to the signed-in person, or null.
 * `organisation_id` is the business the session is looking at, which every
 * request is then scoped to. If that business is no longer one the account
 * belongs to, the session falls back to the account's own business.
 */
async function userFor(token) {
  if (!token || typeof token !== 'string' || token.length < 20) return null;
  const row = await get(
    `/* cross-org: the token identifies the account, which then fixes the firm */
     SELECT s.token, s.expires_at, s.organisation_id AS session_org,
            u.id, u.email, u.name, u.organisation_id AS home_org
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND u.active = 1`, [token]);
  if (!row) return null;
  if (row.expires_at < nowStamp()) {
    await run('/* cross-org: removing one expired session by its token */ DELETE FROM sessions WHERE token = ?', [token]);
    return null;
  }
  let org = row.session_org ? await membership(row.id, row.home_org, row.session_org) : null;
  if (!org) {
    org = await membership(row.id, row.home_org, row.home_org);
    if (!org) return null;                       // their own business has been closed
    if (row.session_org) {
      await run('/* cross-org: a session is identified by its own token */ UPDATE sessions SET organisation_id = ? WHERE token = ?',
        [org.id, token]);
    }
  }
  return {
    id: row.id, email: row.email, name: row.name,
    organisation_id: org.id, organisation_name: org.name, home_organisation_id: row.home_org,
  };
}

/** The business if the account belongs to it and it is open, otherwise null. */
async function membership(userId, homeOrg, orgId) {
  return get(
    `/* cross-org: checking one account against one business it may belong to */
     SELECT o.id, o.name FROM organisations o
     WHERE o.id = ? AND o.active = 1
       AND (o.id = ? OR EXISTS (SELECT 1 FROM user_organisations m WHERE m.user_id = ? AND m.organisation_id = o.id))`,
    [orgId, homeOrg, userId]);
}

/** Every open business an account belongs to, its own first. */
async function memberships(userId, homeOrg) {
  return all(
    `/* cross-org: the businesses of one account, whichever firm it is looking at */
     SELECT o.id, o.name, CASE WHEN o.id = ? THEN 1 ELSE 0 END AS home
     FROM organisations o
     WHERE o.active = 1
       AND (o.id = ? OR EXISTS (SELECT 1 FROM user_organisations m WHERE m.user_id = ? AND m.organisation_id = o.id))
     ORDER BY home DESC, o.name`, [homeOrg, homeOrg, userId]);
}

/** Points a session at another of the account's businesses. Returns it, or null. */
async function switchOrganisation(token, user, orgId) {
  const org = await membership(user.id, user.home_organisation_id, Number(orgId));
  if (!org) return null;
  await run('/* cross-org: a session is identified by its own token */ UPDATE sessions SET organisation_id = ? WHERE token = ?',
    [org.id, token]);
  return org;
}

/**
 * Ends every session belonging to a user, when an account is disabled, deleted
 * or given a new password. `keepToken` spares the session doing the asking, so
 * changing your own password does not sign you out mid-task.
 */
async function endSessionsFor(userId, keepToken) {
  if (keepToken) {
    await run('/* cross-org: sessions are ended by the account they belong to */ DELETE FROM sessions WHERE user_id = ? AND token != ?',
      [userId, keepToken]);
  } else {
    await run('/* cross-org: sessions are ended by the account they belong to */ DELETE FROM sessions WHERE user_id = ?', [userId]);
  }
}

// ---------- colleagues within one firm ----------
/**
 * Adds someone to a business. An address that already has an account joins
 * this business with the account it has, password untouched. A new address
 * gets a new account, which needs a password.
 */
async function addUser(orgId, { email, name, password }, addedBy) {
  const badEmail = checkEmail(email);
  if (badEmail) return { error: badEmail };
  const cleanEmail = String(email).trim();
  const existing = await get(
    '/* cross-org: an email address identifies one person across the whole system */ SELECT id, organisation_id, name, active FROM users WHERE LOWER(email) = LOWER(?)',
    [cleanEmail]);

  if (existing) {
    const already = existing.organisation_id === orgId
      || await get('SELECT id FROM user_organisations WHERE organisation_id = ? AND user_id = ?', [orgId, existing.id]);
    if (already) return { error: `${cleanEmail} is already part of this business.` };
    if (!existing.active) return { error: 'That account has been disabled by its own business.' };
    await insert('user_organisations', { user_id: existing.id, added_by: addedBy || null },
      ['user_id', 'added_by'], null, orgId);
    const user = (await listUsers(orgId)).find(u => u.id === existing.id);
    return { user, existing: true };
  }

  if (!password) return { error: 'Choose a password for the new account.' };
  const badPassword = checkPassword(password);
  if (badPassword) return { error: badPassword };
  const id = await insert('users', {
    organisation_id: orgId, email: cleanEmail, password_hash: hash(password),
    name: String(name || '').trim() || cleanEmail.split('@')[0],
  }, ['organisation_id', 'email', 'password_hash', 'name']);
  const user = (await listUsers(orgId)).find(u => u.id === id);
  return { user, existing: false };
}

/** Everyone who can sign in to a business, whether it is their own or one they were added to. */
async function listUsers(orgId) {
  return all(
    `SELECT u.id, u.email, u.name, u.active, u.last_login,
            CASE WHEN u.organisation_id = ? THEN 1 ELSE 0 END AS home,
            COALESCE(m.created_at, u.created_at) AS created_at,
            (SELECT COUNT(*) FROM user_organisations x WHERE x.user_id = u.id) + 1 AS business_count
     FROM users u
     LEFT JOIN user_organisations m ON m.user_id = u.id AND m.organisation_id = ?
     WHERE u.organisation_id = ? OR m.id IS NOT NULL
     ORDER BY u.name`, [orgId, orgId, orgId]);
}

/**
 * Takes someone out of a business. An account added from elsewhere just loses
 * this business. An account whose own business this is moves to another of
 * its businesses if it has one, and is deleted if it has none.
 */
async function removeUser(orgId, userId) {
  const u = await get(
    '/* cross-org: the account is checked against this business below */ SELECT id, email, name, organisation_id FROM users WHERE id = ?',
    [userId]);
  if (!u) return { error: 'User not found' };
  const extra = await all(
    '/* cross-org: the other businesses of one account, to decide what removal means */ SELECT organisation_id FROM user_organisations WHERE user_id = ? ORDER BY created_at',
    [userId]);
  const member = u.organisation_id === orgId || extra.some(m => m.organisation_id === orgId);
  if (!member) return { error: 'User not found' };

  await transaction(async tx => {
    if (u.organisation_id !== orgId) {
      await tx.run('DELETE FROM user_organisations WHERE organisation_id = ? AND user_id = ?', [orgId, userId]);
    } else if (extra.length) {
      const next = extra[0].organisation_id;
      await tx.run('/* cross-org: the account moves its home to another of its businesses */ UPDATE users SET organisation_id = ? WHERE id = ?',
        [next, userId]);
      await tx.run('DELETE FROM user_organisations WHERE organisation_id = ? AND user_id = ?', [next, userId]);
    } else {
      await tx.run('DELETE FROM users WHERE id = ? AND organisation_id = ?', [userId, orgId]);
    }
  });
  await endSessionsFor(userId);
  return { user: u, deleted: u.organisation_id === orgId && !extra.length };
}

module.exports = {
  hash, verify, register, login, logout, userFor, endSessionsFor,
  memberships, switchOrganisation,
  addUser, listUsers, removeUser, checkEmail, checkPassword, checkBusinessName, MIN_PASSWORD,
};
