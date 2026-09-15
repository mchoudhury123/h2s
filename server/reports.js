'use strict';
// Report builders. Each returns { title, columns, rows, totals? } and can render as JSON or CSV.
const { all } = require('./db');
const H = require('./http');
const cal = require('./services/calendar');
const wages = require('./services/wages');
const finance = require('./services/finance');
const compliance = require('./services/compliance');

const money = n => (n === null || n === undefined) ? '' : Number(n).toFixed(2);

// Every builder receives (query, user, organisationId) and must scope its own SQL.
const BUILDERS = {
  'driver-wages': (q, user, org) => wageReport(org, q, 'driver', 'Driver Wage Report'),
  'pa-wages': (q, user, org) => wageReport(org, q, 'pa', 'PA Wage Report'),
  'payroll': (q, user, org) => wageReport(org, q, null, 'Full Payroll Report'),

  'wage-breakdown': async (q, user, org) => {
    const from = q.from, to = q.to;
    const calc = await wages.calculateWages(org, { from, to, staff_ids: q.staff_ids ? String(q.staff_ids).split(',').map(Number) : undefined });
    const rows = [];
    for (const r of calc.results) {
      for (const l of r.lines) rows.push({ staff: r.staff.name, type: r.staff.type, date: l.date, leg: l.leg || '', contract: l.contract_code || '', kind: l.kind, description: l.description, rate: l.rate, amount: l.amount });
      rows.push({ staff: r.staff.name, type: r.staff.type, date: '', leg: '', contract: '', kind: 'TOTAL', description: 'AMOUNT DUE', rate: '', amount: r.totals.amount_due });
    }
    return {
      title: `Wage Breakdown ${from} to ${to}`,
      columns: [c('staff', 'Staff'), c('type', 'Type'), c('date', 'Date'), c('leg', 'Leg'), c('contract', 'Contract'), c('kind', 'Line type'), c('description', 'Description'), c('rate', 'Rate', money), c('amount', 'Amount', money)],
      rows,
    };
  },

  'contract-profitability': async (q, user, org) => {
    const p = await finance.profitability(org, { from: q.from, to: q.to });
    return {
      title: `Contract Profitability ${q.from} to ${q.to}`,
      columns: [c('code', 'Contract'), c('name', 'Name'), c('school_name', 'School'), c('council_name', 'Council'), c('children', 'Children'),
        c('days_operated', 'Days operated'), c('journeys_operated', 'Journeys operated'), c('journeys_scheduled', 'Journeys scheduled'),
        c('income', 'Income', money), c('driver_cost', 'Driver cost', money), c('pa_cost', 'PA cost', money),
        c('other_costs', 'Other costs', money), c('adhoc_expenses', 'Expenses', money), c('total_cost', 'Total cost', money),
        c('gross_profit', 'Gross profit', money), c('margin', 'Margin %', n => Number(n).toFixed(1))],
      rows: p.rows,
      totals: p.totals,
    };
  },

  'contract-income': async (q, user, org) => {
    const p = await finance.profitability(org, { from: q.from, to: q.to });
    return {
      title: `Contract Income ${q.from} to ${q.to}`,
      columns: [c('code', 'Contract'), c('council_name', 'Council'), c('school_name', 'School'), c('journeys_operated', 'Journeys'), c('income', 'Income', money)],
      rows: p.rows, totals: { income: p.totals.income },
    };
  },

  'school-contracts': async (q, user, org) => ({
    title: 'School Contracts',
    columns: [c('school', 'School'), c('postcode', 'Postcode'), c('code', 'Contract'), c('status', 'Status'), c('children', 'Children'), c('driver', 'Driver'), c('pa', 'PA'), c('days', 'Operating days')],
    rows: await all(`SELECT s.name AS school, s.postcode, c.code, c.status, c.days_of_week AS days,
        (SELECT COUNT(*) FROM children WHERE contract_id = c.id AND organisation_id = c.organisation_id AND status = 'active') AS children,
        COALESCE(d.first_name || ' ' || d.last_name, 'NONE') AS driver,
        COALESCE(p.first_name || ' ' || p.last_name, 'NONE') AS pa
      FROM contracts c
      LEFT JOIN schools s ON s.id = c.school_id
      LEFT JOIN staff d ON d.id = c.driver_id
      LEFT JOIN staff p ON p.id = c.pa_id
      WHERE c.organisation_id = ? ORDER BY s.name, c.code`, [org]),
  }),

  'children': async (q, user, org) => ({
    title: 'Child List',
    columns: [c('name', 'Child'), c('dob', 'DOB'), c('address', 'Address'), c('postcode', 'Postcode'), c('school', 'School'),
      c('contract', 'Contract'), c('driver', 'Driver'), c('pa', 'PA'), c('pickup_time', 'Pick-up'), c('dropoff_time', 'Drop-off'),
      c('wheelchair', 'Wheelchair', v => v ? 'Yes' : 'No'), c('sen_needs', 'SEN/Additional needs'), c('allergies', 'Allergies'), c('parent_name', 'Parent/Carer'), c('parent_phone', 'Phone'), c('status', 'Status')],
    rows: await all(`SELECT ch.first_name || ' ' || ch.last_name AS name, ch.dob, ch.address, ch.postcode, ch.pickup_time, ch.dropoff_time,
        ch.wheelchair, ch.sen_needs, ch.allergies, ch.parent_name, ch.parent_phone, ch.status,
        s.name AS school, c.code AS contract,
        d.first_name || ' ' || d.last_name AS driver, p.first_name || ' ' || p.last_name AS pa
      FROM children ch
      LEFT JOIN schools s ON s.id = ch.school_id
      LEFT JOIN contracts c ON c.id = ch.contract_id
      LEFT JOIN staff d ON d.id = c.driver_id
      LEFT JOIN staff p ON p.id = c.pa_id
      WHERE ch.organisation_id = ? ORDER BY ch.last_name, ch.first_name`, [org]),
  }),

  'drivers': (q, user, org) => staffList(org, 'driver', 'Driver List'),
  'pas': (q, user, org) => staffList(org, 'pa', 'PA List'),

  'compliance': async (q, user, org) => {
    const staff = await all("SELECT id, type, first_name, last_name, status, phone FROM staff WHERE organisation_id = ? AND status IN ('active','pool') ORDER BY type, last_name", [org]);
    const complianceMap = await compliance.complianceForMany(org, staff);
    const rows = [];
    for (const s of staff) {
      const cmp = complianceMap.get(s.id);
      rows.push({
        name: `${s.first_name} ${s.last_name}`, type: s.type.toUpperCase(), staff_status: s.status, phone: s.phone,
        status: cmp.status.toUpperCase(),
        problems: cmp.items.filter(i => i.status !== 'green').map(i => `${i.doc_type}: ${i.reason}`).join('; ') || 'None',
        detail: cmp.items.map(i => `${i.doc_type}=${i.status}`).join('; '),
      });
    }
    return { title: 'Compliance Report', columns: [c('name', 'Staff'), c('type', 'Type'), c('staff_status', 'Staff status'), c('phone', 'Phone'), c('status', 'Compliance'), c('problems', 'Problems'), c('detail', 'All documents')], rows };
  },

  'expiring-documents': async (q, user, org) => ({
    title: `Expiring Documents (next ${q.days || 30} days)`,
    columns: [c('entity_label', 'Record'), c('entity_type', 'Type'), c('doc_type', 'Document'), c('expiry_date', 'Expiry'), c('days_left', 'Days left'), c('status', 'Status'), c('reference', 'Reference')],
    rows: await compliance.expiringDocuments(org, Number(q.days) || undefined, true),
  }),

  'journeys': async (q, user, org) => {
    const data = await cal.buildCalendar(org, q.from, q.to, q.contract_id ? { contract_id: Number(q.contract_id) } : {});
    const rows = [];
    for (const r of data.rows) {
      for (const d of data.dates) {
        const day = r.days[d];
        if (!day) continue;
        for (const leg of cal.LEGS) {
          const L = day.legs[leg];
          rows.push({
            date: d, contract: r.contract.code, school: r.contract.school_name, leg,
            status: L.status === 'operated' ? 'Operated' : 'Not operated',
            reason: L.reason || '',
            driver: L.driver.status === 'covered' ? `${L.driver.cover_name} (cover)` : (L.driver.normal_name || 'NONE'),
            pa: L.pa.status === 'not_required' ? 'n/a' : (L.pa.status === 'covered' ? `${L.pa.cover_name} (cover)` : (L.pa.normal_name || 'NONE')),
            children_travelling: L.children_travelling, children_absent: L.children_absent,
          });
        }
      }
    }
    return { title: `Journey & Attendance Report ${q.from} to ${q.to}`, columns: [c('date', 'Date'), c('contract', 'Contract'), c('school', 'School'), c('leg', 'Leg'), c('status', 'Status'), c('reason', 'Reason'), c('driver', 'Driver'), c('pa', 'PA'), c('children_travelling', 'Children travelling'), c('children_absent', 'Children absent')], rows };
  },

  'attendance': async (q, user, org) => {
    const data = await cal.buildCalendar(org, q.from, q.to, q.contract_id ? { contract_id: Number(q.contract_id) } : {});
    const rows = [];
    for (const r of data.rows) for (const d of data.dates) {
      const day = r.days[d];
      if (!day) continue;
      for (const ch of day.children) {
        if (ch.AM === 'travelling' && ch.PM === 'travelling') continue;
        rows.push({ date: d, contract: r.contract.code, child: ch.name, am: ch.AM, pm: ch.PM });
      }
    }
    return { title: `Child Absence Report ${q.from} to ${q.to}`, columns: [c('date', 'Date'), c('contract', 'Contract'), c('child', 'Child'), c('am', 'AM'), c('pm', 'PM')], rows };
  },

  'cover-staff': async (q, user, org) => {
    const rows = await all(`SELECT e.date, e.leg, e.role, c.code AS contract, s.name AS school,
        st.first_name || ' ' || st.last_name AS normal_staff,
        cs.first_name || ' ' || cs.last_name AS cover_staff,
        e.cover_pay, e.paid_immediately,
        (SELECT COUNT(*) FROM payments p WHERE p.exception_id = e.id AND p.organisation_id = e.organisation_id) AS paid_count
      FROM exceptions e
      LEFT JOIN contracts c ON c.id = e.contract_id
      LEFT JOIN schools s ON s.id = c.school_id
      LEFT JOIN staff st ON st.id = e.staff_id
      LEFT JOIN staff cs ON cs.id = e.cover_staff_id
      WHERE e.organisation_id = ? AND e.type = 'staff_absence' AND e.date >= ? AND e.date <= ?
      ORDER BY e.date DESC`, [org, q.from, q.to]);
    return {
      title: `Cover Staff Report ${q.from} to ${q.to}`,
      columns: [c('date', 'Date'), c('contract', 'Contract'), c('school', 'School'), c('leg', 'Leg'), c('role', 'Role'),
        c('normal_staff', 'Normal staff'), c('cover_staff', 'Cover staff'), c('cover_pay', 'Cover pay', money),
        c('paid_immediately', 'Paid immediately', v => v ? 'YES' : 'No'), c('paid_count', 'Payment recorded', v => v ? 'YES' : 'No')],
      rows,
    };
  },

  'audit': async (q, user, org) => ({
    title: 'Audit Log',
    columns: [c('created_at', 'When'), c('user_name', 'User'), c('entity_type', 'Record type'), c('entity_label', 'Record'), c('action', 'Action'), c('field', 'Field'), c('old_value', 'Previous value'), c('new_value', 'New value'), c('summary', 'Summary')],
    rows: await require('./services/audit').recent(org, q, 2000),
  }),
};

function c(key, label, value) { return value ? { key, label, value: r => value(r[key]) } : { key, label }; }

async function wageReport(org, q, type, title) {
  const calc = await wages.calculateWages(org, { from: q.from, to: q.to, type: type || undefined, staff_ids: q.staff_ids ? String(q.staff_ids).split(',').map(Number) : undefined });
  const rows = calc.results.map(r => ({
    name: r.staff.name, type: r.staff.type.toUpperCase(),
    normal_days: r.totals.normal_days, journeys: r.totals.journeys, normal_earnings: r.totals.normal_earnings,
    cover_days: r.totals.cover_days, cover_earnings: r.totals.cover_earnings,
    gross: r.totals.gross, already_paid: r.totals.already_paid, amount_due: r.totals.amount_due,
  }));
  return {
    title: `${title} ${q.from} to ${q.to}`,
    columns: [c('name', 'Staff'), c('type', 'Type'), c('normal_days', 'Days worked'), c('journeys', 'Journeys'),
      c('normal_earnings', 'Normal earnings', money), c('cover_days', 'Cover days'), c('cover_earnings', 'Cover earnings', money),
      c('gross', 'Gross', money), c('already_paid', 'Already paid', money), c('amount_due', 'Amount due', money)],
    rows, totals: calc.totals,
  };
}

async function staffList(org, type, title) {
  const rows = await all(`SELECT s.*,
      (SELECT COUNT(*) FROM contracts WHERE (driver_id = s.id OR pa_id = s.id) AND organisation_id = s.organisation_id AND status = 'active') AS contracts,
      (SELECT string_agg(registration, '; ') FROM vehicles WHERE driver_id = s.id AND organisation_id = s.organisation_id AND active = 1) AS vehicles,
      (SELECT string_agg(code, '; ') FROM contracts WHERE (driver_id = s.id OR pa_id = s.id) AND organisation_id = s.organisation_id AND status = 'active') AS contract_codes
    FROM staff s WHERE s.organisation_id = ? AND s.type = ? ORDER BY s.last_name`, [org, type]);
  const complianceMap = await compliance.complianceForMany(org, rows);

  const out = rows.map(r => ({
    name: `${r.first_name} ${r.last_name}`, status: r.status, phone: r.phone, email: r.email,
    address: r.address, postcode: r.postcode, badge_number: r.badge_number, licensing_authority: r.licensing_authority,
    vehicles: r.vehicles, contracts: r.contracts, contract_codes: r.contract_codes,
    day_rate: r.default_day_rate,
    compliance: (complianceMap.get(r.id) || { status: 'red' }).status.toUpperCase(),
    availability: r.availability, preferred_areas: r.preferred_areas,
  }));
  const cols = [c('name', 'Name'), c('status', 'Status'), c('phone', 'Phone'), c('email', 'Email'), c('address', 'Address'), c('postcode', 'Postcode')];
  if (type === 'driver') cols.push(c('badge_number', 'Badge no.'), c('licensing_authority', 'Licensing authority'), c('vehicles', 'Vehicles'));
  cols.push(c('contracts', 'Active contracts'), c('contract_codes', 'Contract codes'));
  cols.push(c('day_rate', 'Default day rate', money));
  cols.push(c('compliance', 'Compliance'), c('availability', 'Availability'), c('preferred_areas', 'Preferred areas'));
  return { title, columns: cols, rows: out };
}

async function handle(ctx) {
  const name = String(ctx.params.name).replace(/\.(csv|json)$/, '');
  const format = /\.csv$/.test(ctx.params.name) ? 'csv' : (ctx.query.format || 'json');
  const builder = BUILDERS[name];
  if (!builder) return H.error(ctx.res, `Unknown report "${name}". Available: ${Object.keys(BUILDERS).join(', ')}`, 404);
  const needsDates = ['driver-wages', 'pa-wages', 'payroll', 'wage-breakdown', 'contract-profitability', 'contract-income', 'journeys', 'attendance', 'cover-staff'];
  if (needsDates.includes(name) && (!ctx.query.from || !ctx.query.to)) return H.error(ctx.res, 'This report needs a from and to date');
  const data = await builder(ctx.query, ctx.user, ctx.org);
  if (format === 'csv') {
    const csv = H.toCSV(data.columns, data.rows);
    return H.sendCSV(ctx.res, `${name}-${ctx.query.from || cal.today()}.csv`, csv);
  }
  H.json(ctx.res, { name, ...data, generated_at: new Date().toISOString() });
}

module.exports = { handle, BUILDERS, list: () => Object.keys(BUILDERS) };
