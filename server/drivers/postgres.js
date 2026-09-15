'use strict';
// Postgres driver, used for Supabase. Queries are written once with "?" placeholders
// and translated to $1, $2 … here, so application code stays dialect-neutral.
const { Pool, types } = require('pg');
const schema = require('../schema');

// COUNT(*) and other bigint results arrive as strings by default. The application
// treats them as numbers, so parse them here rather than at every call site.
types.setTypeParser(20, v => (v === null ? null : Number(v)));   // int8
types.setTypeParser(1700, v => (v === null ? null : Number(v))); // numeric

/** Replace ? placeholders with $n, leaving ? inside string literals alone. */
function toPositional(sql) {
  let out = '';
  let n = 0;
  let quote = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (quote) {
      out += c;
      if (c === quote) {
        if (sql[i + 1] === quote) { out += sql[++i]; }  // escaped quote inside the literal
        else quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"') { quote = c; out += c; continue; }
    if (c === '?') { out += '$' + (++n); continue; }
    out += c;
  }
  return out;
}

function create({ connectionString, schema: schemaName } = {}) {
  const url = connectionString || process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set. Add it to your .env file.');

  // An alternative schema keeps a test run away from the live tables.
  const targetSchema = schemaName || process.env.H2S_PG_SCHEMA || null;
  if (targetSchema && !/^[a-z_][a-z0-9_]*$/.test(targetSchema)) {
    throw new Error(`Invalid schema name: ${targetSchema}`);
  }

  const pool = new Pool({
    connectionString: url,
    // Supabase requires TLS. Its certificate chain is not in Node's default store,
    // so verification is relaxed here; the connection is still encrypted.
    ssl: /supabase|amazonaws|render|neon/i.test(url) ? { rejectUnauthorized: false } : undefined,
    max: Number(process.env.PGPOOL_MAX || 8),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
    options: targetSchema ? `-c search_path=${targetSchema}` : undefined,
  });
  pool.on('error', err => console.error('Postgres pool error:', err.message));

  const safeUrl = url.replace(/:\/\/([^:]+):[^@]*@/, '://$1:****@')
    + (targetSchema ? ` [schema ${targetSchema}]` : '');

  const exec_ = async (client, sql, params = []) => {
    try { return await (client || pool).query(toPositional(sql), params); }
    catch (e) {
      e.message = `${e.message}\n  in: ${sql.trim().slice(0, 300)}`;
      throw e;
    }
  };

  const api = client => ({
    async all(sql, params = []) { return (await exec_(client, sql, params)).rows; },
    async get(sql, params = []) { return (await exec_(client, sql, params)).rows[0]; },
    async run(sql, params = []) {
      const r = await exec_(client, sql, params);
      return { changes: r.rowCount, lastInsertRowid: r.rows[0] ? r.rows[0].id : null };
    },
    async exec(sql) { await exec_(client, sql, []); },
    async insertReturningId(sql, params) {
      const r = await exec_(client, sql + ' RETURNING id', params);
      return r.rows[0].id;
    },
  });

  const base = api(null);

  async function transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(api(client));
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      client.release();
    }
  }

  async function migrate() {
    if (targetSchema) {
      await base.exec(`CREATE SCHEMA IF NOT EXISTS ${targetSchema}`);
      await base.exec(`SET search_path TO ${targetSchema}`);
    }
    for (const stmt of schema.statements('postgres')) await base.exec(stmt);
  }

  /** Removes an alternative schema entirely. Refuses to touch the default one. */
  async function dropSchema() {
    if (!targetSchema || targetSchema === 'public') throw new Error('Refusing to drop the public schema');
    await base.exec(`DROP SCHEMA IF EXISTS ${targetSchema} CASCADE`);
  }

  /** After copying rows with explicit ids, move each identity sequence past the highest id. */
  async function resetSequences() {
    for (const table of schema.SEQUENCE_TABLES) {
      await base.exec(`SELECT setval(
        pg_get_serial_sequence('${table}', 'id'),
        COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1,
        false)`);
    }
  }

  async function close() { await pool.end(); }

  return {
    dialect: 'postgres', describe: `Postgres (${safeUrl})`, schema: targetSchema,
    ...base, transaction, migrate, resetSequences, dropSchema, close, pool,
  };
}

module.exports = { create, toPositional };
