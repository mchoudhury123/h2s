'use strict';
// Universal search: one query string, results grouped by record type, each with a deep link.
const { all } = require('../db');

// Both sides of the comparison are lowercased, because SQLite's LIKE ignores case
// for ASCII while Postgres's does not. Wildcards typed by the user are escaped so
// they match literally.
function like(q) {
  const escaped = String(q).toLowerCase().replace(/[%_\\]/g, m => '\\' + m);
  return '%' + escaped + '%';
}

async function universalSearch(q, limit = 8) {
  const term = (q || '').trim();
  if (term.length < 1) return { query: term, groups: [] };
  const p = like(term);
  const groups = [];

  const children = await all(`SELECT ch.id, ch.first_name, ch.last_name, ch.postcode, ch.address, ch.council_ref,
      s.name AS school_name, c.code AS contract_code,
      d.first_name || ' ' || d.last_name AS driver_name
    FROM children ch
    LEFT JOIN schools s ON s.id = ch.school_id
    LEFT JOIN contracts c ON c.id = ch.contract_id
    LEFT JOIN staff d ON d.id = c.driver_id
    WHERE LOWER(ch.first_name) LIKE ? ESCAPE '\\' OR LOWER(ch.last_name) LIKE ? ESCAPE '\\'
       OR LOWER(ch.first_name || ' ' || ch.last_name) LIKE ? ESCAPE '\\'
       OR LOWER(ch.postcode) LIKE ? ESCAPE '\\' OR LOWER(ch.address) LIKE ? ESCAPE '\\' OR LOWER(ch.council_ref) LIKE ? ESCAPE '\\'
    ORDER BY ch.last_name LIMIT ?`, [p, p, p, p, p, p, limit]);
  if (children.length) groups.push({ type: 'child', label: 'Children', items: children.map(r => ({ id: r.id, title: `${r.first_name} ${r.last_name}`, subtitle: [r.school_name, r.contract_code, r.postcode].filter(Boolean).join(' · '), meta: r.driver_name ? 'Driver: ' + r.driver_name : null, href: `#/children/${r.id}` })) });

  const schools = await all(`SELECT id, name, postcode, address,
      (SELECT COUNT(*) FROM children WHERE school_id = schools.id AND status='active') AS child_count,
      (SELECT COUNT(*) FROM contracts WHERE school_id = schools.id AND status='active') AS contract_count
    FROM schools WHERE LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(postcode) LIKE ? ESCAPE '\\' OR LOWER(address) LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?`, [p, p, p, limit]);
  if (schools.length) groups.push({ type: 'school', label: 'Schools', items: schools.map(r => ({ id: r.id, title: r.name, subtitle: [r.address, r.postcode].filter(Boolean).join(', '), meta: `${r.child_count} ${r.child_count === 1 ? 'child' : 'children'} · ${r.contract_count} ${r.contract_count === 1 ? 'contract' : 'contracts'}`, href: `#/schools/${r.id}` })) });

  const contracts = await all(`SELECT c.id, c.code, c.name, c.status, c.council_ref, s.name AS school_name, cl.name AS council_name,
      d.first_name || ' ' || d.last_name AS driver_name,
      (SELECT COUNT(*) FROM children WHERE contract_id = c.id AND status='active') AS child_count
    FROM contracts c
    LEFT JOIN schools s ON s.id = c.school_id
    LEFT JOIN councils cl ON cl.id = c.council_id
    LEFT JOIN staff d ON d.id = c.driver_id
    WHERE LOWER(c.code) LIKE ? ESCAPE '\\' OR LOWER(c.name) LIKE ? ESCAPE '\\' OR LOWER(c.council_ref) LIKE ? ESCAPE '\\' OR LOWER(c.route_info) LIKE ? ESCAPE '\\'
    ORDER BY c.code LIMIT ?`, [p, p, p, p, limit]);
  if (contracts.length) groups.push({ type: 'contract', label: 'Contracts / Routes', items: contracts.map(r => ({ id: r.id, title: r.code, subtitle: [r.name, r.school_name].filter(Boolean).join(' · '), meta: `${r.child_count} ${r.child_count === 1 ? 'child' : 'children'}${r.driver_name ? ' · ' + r.driver_name : ' · NO DRIVER'}`, badge: r.status, href: `#/contracts/${r.id}` })) });

  const staff = await all(`SELECT id, type, first_name, last_name, postcode, phone, status, badge_number,
      (SELECT COUNT(*) FROM contracts WHERE (driver_id = staff.id OR pa_id = staff.id) AND status='active') AS contract_count
    FROM staff
    WHERE LOWER(first_name) LIKE ? ESCAPE '\\' OR LOWER(last_name) LIKE ? ESCAPE '\\' OR LOWER(first_name || ' ' || last_name) LIKE ? ESCAPE '\\'
       OR LOWER(postcode) LIKE ? ESCAPE '\\' OR LOWER(phone) LIKE ? ESCAPE '\\' OR LOWER(badge_number) LIKE ? ESCAPE '\\' OR LOWER(address) LIKE ? ESCAPE '\\'
    ORDER BY type, last_name LIMIT ?`, [p, p, p, p, p, p, p, limit * 2]);
  const drivers = staff.filter(s => s.type === 'driver');
  const pas = staff.filter(s => s.type === 'pa');
  if (drivers.length) groups.push({ type: 'driver', label: 'Drivers', items: drivers.map(r => ({ id: r.id, title: `${r.first_name} ${r.last_name}`, subtitle: [r.postcode, r.phone].filter(Boolean).join(' · '), meta: `${r.contract_count} ${r.contract_count === 1 ? 'contract' : 'contracts'}`, badge: r.status, href: `#/staff/${r.id}` })) });
  if (pas.length) groups.push({ type: 'pa', label: 'Passenger Assistants', items: pas.map(r => ({ id: r.id, title: `${r.first_name} ${r.last_name}`, subtitle: [r.postcode, r.phone].filter(Boolean).join(' · '), meta: `${r.contract_count} ${r.contract_count === 1 ? 'contract' : 'contracts'}`, badge: r.status, href: `#/staff/${r.id}` })) });

  const councils = await all(`SELECT id, name, (SELECT COUNT(*) FROM contracts WHERE council_id = councils.id) AS contract_count FROM councils WHERE LOWER(name) LIKE ? ESCAPE '\\' ORDER BY name LIMIT ?`, [p, limit]);
  if (councils.length) groups.push({ type: 'council', label: 'Councils / Customers', items: councils.map(r => ({ id: r.id, title: r.name, subtitle: `${r.contract_count} ${r.contract_count === 1 ? 'contract' : 'contracts'}`, href: `#/councils/${r.id}` })) });

  const vehicles = await all(`SELECT v.id, v.registration, v.make, v.model, v.seats, v.driver_id, s.first_name || ' ' || s.last_name AS driver_name FROM vehicles v LEFT JOIN staff s ON s.id = v.driver_id WHERE LOWER(v.registration) LIKE ? ESCAPE '\\' OR LOWER(v.make) LIKE ? ESCAPE '\\' OR LOWER(v.model) LIKE ? ESCAPE '\\' LIMIT ?`, [p, p, p, limit]);
  if (vehicles.length) groups.push({ type: 'vehicle', label: 'Vehicles', items: vehicles.map(r => ({ id: r.id, title: r.registration, subtitle: [r.make, r.model].filter(Boolean).join(' '), meta: r.driver_name || 'Unassigned', href: r.driver_id ? `#/staff/${r.driver_id}` : `#/vehicles` })) });

  const count = groups.reduce((a, g) => a + g.items.length, 0);
  return { query: term, groups, count };
}

module.exports = { universalSearch };
