'use strict';
require('../server/env').load();
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const stamp = Date.now();
process.env.H2S_DB = path.join(os.tmpdir(), `h2s-performance-${stamp}.db`);
process.env.H2S_PG_SCHEMA = `h2s_performance_${stamp}`;
process.env.H2S_STRICT_TENANCY = '1';
const db = require('../server/db');
const { lookups } = require('../server/services/lookups');

(async () => {
  try {
    assert(db.dialect !== 'postgres' || db.driver.schema === process.env.H2S_PG_SCHEMA);
    await db.migrate();
    let calls = 0;
    const originals = {};
    for (const key of ['all','get','run','exec','tableExists','columns']) {
      originals[key] = db.driver[key];
      db.driver[key] = (...args) => { calls++; return originals[key](...args); };
    }
    await db.migrate();
    assert.equal(calls, 2, 'Current schema uses only two read calls');
    const fingerprint = (await db.get('SELECT fingerprint FROM h2s_schema_version WHERE id = 1')).fingerprint;
    await db.run('UPDATE h2s_schema_version SET fingerprint = ? WHERE id = 1', ['outdated']);
    db.driver.exec = async () => { throw new Error('Simulated migration failure'); };
    await assert.rejects(db.migrate(), /Simulated migration failure/);
    assert.equal((await db.get('SELECT fingerprint FROM h2s_schema_version WHERE id = 1')).fingerprint, 'outdated', 'Failed migration cannot mark schema current');
    db.driver.exec = originals.exec;
    await db.migrate();
    assert.equal((await db.get('SELECT fingerprint FROM h2s_schema_version WHERE id = 1')).fingerprint, fingerprint, 'Retry records successful upgrade');
    const org = await db.insert('organisations', {name:'Performance test'}, ['name']);
    const other = await db.insert('organisations', {name:'Other test'}, ['name']);
    const add = (table,row,owner=org) => db.insert(table,row,Object.keys(row),null,owner);
    await add('schools',{name:'School',postcode:'TEST'});
    await add('schools',{name:'Closed school',active:0});
    await add('schools',{name:'Other firm school'},other);
    await add('councils',{name:'Council'});
    await add('contracts',{code:'ROUTE',name:'Test route'});
    await add('staff',{type:'driver',first_name:'Zed',last_name:'Alpha',status:'inactive'});
    await add('staff',{type:'driver',first_name:'Amy',last_name:'Zulu'});
    await add('staff',{type:'pa',first_name:'Test',last_name:'Assistant'});
    await add('vehicles',{registration:'TEST123',seats:4});
    await add('children',{first_name:'Test',last_name:'Child'});
    await add('children',{first_name:'Inactive',last_name:'Child',status:'inactive'});
    calls = 0;
    const result = await lookups(org);
    assert.equal(calls, 1, 'Seven dropdowns loaded with one database query');
    const queries = {
      schools: 'SELECT id, name, postcode FROM schools WHERE organisation_id = ? AND active = 1 ORDER BY name',
      councils: 'SELECT id, name FROM councils WHERE organisation_id = ? AND active = 1 ORDER BY name',
      contracts: 'SELECT id, code, name, school_id, status FROM contracts WHERE organisation_id = ? ORDER BY code',
      drivers: "SELECT id, first_name || ' ' || last_name AS name, status, postcode FROM staff WHERE organisation_id = ? AND type = 'driver' ORDER BY last_name",
      pas: "SELECT id, first_name || ' ' || last_name AS name, status, postcode FROM staff WHERE organisation_id = ? AND type = 'pa' ORDER BY last_name",
      vehicles: 'SELECT id, registration, seats, wheelchair_accessible, driver_id FROM vehicles WHERE organisation_id = ? AND active = 1 ORDER BY registration',
      children: "SELECT id, first_name || ' ' || last_name AS name, contract_id, school_id FROM children WHERE organisation_id = ? AND status = 'active' ORDER BY last_name",
    };
    for (const [kind,sql] of Object.entries(queries)) assert.deepEqual(result[kind], await db.all(sql,[org]), kind + ': same fields, filtering, values and ordering');
    assert.equal((await lookups(other)).schools.length,1);
    assert.equal((await lookups(other)).children.length,0);
    console.log(`${db.dialect}: schema fast path, failed migration retry, single-query dropdown equivalence and tenant isolation passed.`);
  } finally {
    if (db.dialect === 'postgres') await db.dropSchema();
    await db.close();
    if (db.dialect === 'sqlite') for (const suffix of ['', '-wal', '-shm']) fs.rmSync(process.env.H2S_DB + suffix,{force:true});
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
