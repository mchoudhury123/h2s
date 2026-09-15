'use strict';
const { all } = require('../db');

// One round trip for form dropdowns, including on a single-connection pool.
const definitions = {
  schools: { table: 'schools', fields: ['id','name','postcode'], where: 'active = 1', order: 'name' },
  councils: { table: 'councils', fields: ['id','name'], where: 'active = 1', order: 'name' },
  contracts: { table: 'contracts', fields: ['id','code','name','school_id','status'], order: 'code' },
  drivers: { table: 'staff', fields: ['id','name','status','postcode'], where: "type = 'driver'", order: 'last_name' },
  pas: { table: 'staff', fields: ['id','name','status','postcode'], where: "type = 'pa'", order: 'last_name' },
  vehicles: { table: 'vehicles', fields: ['id','registration','seats','wheelchair_accessible','driver_id'], where: 'active = 1', order: 'registration' },
  children: { table: 'children', fields: ['id','name','contract_id','school_id'], where: "status = 'active'", order: 'last_name' },
};
const fields = [...new Set(Object.values(definitions).flatMap(d => d.fields))];
const integerFields = new Set(['id','school_id','seats','wheelchair_accessible','driver_id','contract_id']);
const sql = Object.entries(definitions).map(([kind, d]) => {
  const columns = fields.map(field => {
    let expression = d.fields.includes(field) ? field : `CAST(NULL AS ${integerFields.has(field) ? 'INTEGER' : 'TEXT'})`;
    if (field === 'name' && ['staff','children'].includes(d.table)) expression = "first_name || ' ' || last_name";
    return `${expression} AS ${field}`;
  });
  return `SELECT '${kind}' AS kind, ${d.order} AS sort_name, ${columns.join(', ')}
    FROM ${d.table} WHERE organisation_id = ?${d.where ? ' AND ' + d.where : ''}`;
}).join(' UNION ALL ') + ' ORDER BY kind, sort_name, id';

async function lookups(orgId) {
  if (!orgId) throw new Error('An organisation id is required');
  const result = Object.fromEntries(Object.keys(definitions).map(kind => [kind, []]));
  for (const row of await all(sql, Object.keys(definitions).map(() => orgId))) {
    result[row.kind].push(Object.fromEntries(definitions[row.kind].fields.map(field => [field, row[field]])));
  }
  return result;
}
module.exports = { lookups };
