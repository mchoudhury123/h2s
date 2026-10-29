/* Contracts overview: every contract of every business the account belongs to,
   on one spreadsheet-style page. Reads live from the CRM; edits write back
   through the CRM's own rules. Staff costs and profit stay hidden until a
   management account chooses to reveal them, and never reach other accounts. */
'use strict';
const Ov = window.Ov = {};

const OV_STORE = 'h2s.overview.state';
function ovLoadState() { try { return JSON.parse(localStorage.getItem(OV_STORE) || '{}'); } catch (_) { return {}; } }
function ovSaveState(st) {
  try { localStorage.setItem(OV_STORE, JSON.stringify({ company: st.company, from: st.from, to: st.to, columns: st.columns, sort: st.sort, dir: st.dir, widths: st.widths, view: st.view })); } catch (_) { /* a private window */ }
}

/** Opens a record that may belong to another of the account's businesses, switching to it first. */
Ov.open = async function (companyId, hash) {
  if (!App.state.organisation || Number(companyId) === Number(App.state.organisation.id)) return Router.go(hash);
  const target = (App.state.organisations || []).find(o => Number(o.id) === Number(companyId));
  if (!target) return toast('That record belongs to a business you are not part of', 'err');
  UI.confirm(`This record belongs to ${target.name}. Switch to ${target.name} and open it?`, async () => {
    await api.post('/api/switch-business', { organisation_id: target.id });
    UI.closeAll(); UI.invalidateLookups(); await App.loadMe(); App.renderShell(); Router.go(hash);
  }, { title: 'Switch business', yes: 'Switch and open', danger: false });
};

/** One cell's content for a column. */
function ovCell(col, row) {
  const v = row[col.key];
  const missing = v === null || v === undefined || v === '';
  if (missing) return h('span', { class: 'ov-none' }, 'Not provided');
  if (col.type === 'money') return h('span', { class: 'ov-num' }, fmt.money(v));
  if (col.type === 'pct') return h('span', { class: 'badge ' + (v >= 20 ? 'green' : v >= 10 ? 'amber' : 'red') }, fmt.pct(v));
  if (col.type === 'int') return h('span', { class: 'ov-num' }, String(v));
  if (col.type === 'date') return fmt.date(v);
  if (col.key === 'code') return h('a', { href: '#', class: 'ov-link', onclick: e => { e.preventDefault(); Ov.open(row.company_id, '/contracts/' + row.contract_id); } }, h('strong', v));
  if (col.key === 'school_name' && row.school_id) return h('a', { href: '#', class: 'ov-link', onclick: e => { e.preventDefault(); Ov.open(row.company_id, '/schools/' + row.school_id); } }, v);
  if (col.key === 'driver_name' && row.driver_id) return h('a', { href: '#', class: 'ov-link', onclick: e => { e.preventDefault(); Ov.open(row.company_id, '/staff/' + row.driver_id); } }, v);
  if (col.key === 'pa_name' && row.pa_id) return h('a', { href: '#', class: 'ov-link', onclick: e => { e.preventDefault(); Ov.open(row.company_id, '/staff/' + row.pa_id); } }, v);
  if (col.key === 'children_names') return h('div', null, ...row.children.map(k => h('div', null, h('a', { href: '#', class: 'ov-link', onclick: e => { e.preventDefault(); Ov.open(row.company_id, '/children/' + k.id); } }, k.name))));
  if (col.key === 'status_label') return h('span', { class: 'badge ' + (row.status === 'active' ? 'green' : row.status === 'pending' ? 'blue' : row.status === 'suspended' ? 'amber' : '') }, v);
  if (col.key === 'company_name') return h('span', { class: 'ov-company' }, v);
  const lines = String(v).split('\n');
  return lines.length > 1 ? h('div', null, ...lines.map(l => h('div', null, l))) : v;
}

/** The expanded panel under a contract row. */
function ovDetail(row, data) {
  const conf = data.confidential;
  const childCols = [
    { key: 'name', label: 'Child', value: k => h('a', { href: '#', onclick: e => { e.preventDefault(); Ov.open(row.company_id, '/children/' + k.id); } }, h('strong', k.name)) },
    { key: 'school_name', label: 'School', value: k => k.school_name || h('span', { class: 'ov-none' }, 'Not provided') },
    { key: 'pickup_address', label: 'Home / pickup address', value: k => k.pickup_address || h('span', { class: 'ov-none' }, 'Not provided') },
    { key: 'dropoff_address', label: 'Drop-off (if different)', value: k => k.dropoff_address || h('span', { class: 'ov-none' }, 'Same as pickup / not provided') },
    { key: 'pickup_time', label: 'AM pickup', value: k => k.pickup_time || '—', nowrap: true },
    { key: 'school_start', label: 'School start', value: k => k.school_start || '—', nowrap: true },
    { key: 'school_finish', label: 'School finish', value: k => k.school_finish || '—', nowrap: true },
    { key: 'dropoff_time', label: 'PM drop-off', value: k => k.dropoff_time || '—', nowrap: true },
  ];
  if (row.children.some(k => 'requirements' in k)) childCols.push({ key: 'requirements', label: 'Transport requirements', value: k => k.requirements || h('span', { class: 'ov-none' }, 'None recorded') });
  const staffBox = UI.kv([
    ['Driver', row.driver_name ? h('span', null, h('a', { href: '#', onclick: e => { e.preventDefault(); Ov.open(row.company_id, '/staff/' + row.driver_id); } }, row.driver_name), row.driver_phone ? ' · ' + row.driver_phone : '', row.driver_since ? h('span', { class: 'ov-none' }, ` · since ${fmt.date(row.driver_since)}`) : '') : null],
    ['Passenger assistant', row.pa_name ? h('span', null, row.pa_id ? h('a', { href: '#', onclick: e => { e.preventDefault(); Ov.open(row.company_id, '/staff/' + row.pa_id); } }, row.pa_name) : row.pa_name, row.pa_phone ? ' · ' + row.pa_phone : '', row.pa_since ? h('span', { class: 'ov-none' }, ` · since ${fmt.date(row.pa_since)}`) : '') : null],
    ['Additional assigned staff', row.other_staff ? h('div', null, ...row.other_staff.split('\n').map(l => h('div', null, l))) : null],
    ['Regular or cover', row.staffing_status],
    ['Operating days', `${row.operating_days} · ${plural(row.daily_trips, 'trip')} a day`],
    ['In this period', `${plural(row.run_days, 'operating day')} · ${row.planned_trips} planned runs · ${row.operated_trips} operated · ${row.closed_trips} school closed`],
  ]);
  const money = (label, v, hint) => h('div', { class: 'ov-fin' }, h('span', null, label, hint ? h('span', { class: 'ov-none' }, ' ' + hint) : null), h('strong', fmt.money(v)));
  const finBox = h('div', null,
    h('div', { class: 'ov-fin-title' }, 'Contract value'),
    money('Per day', row.value_per_day), money('Per week', row.value_per_week, `(${row.operating_days_count} days)`), money('Per month (estimated)', row.value_per_month),
    money('For this period', row.income_range, `(recorded ${fmt.money(row.income_actual)} · projected ${fmt.money(row.income_projected)})`),
    money('Invoiced in period (actual)', row.invoiced_range, row.invoices_in_range ? `(${plural(row.invoices_in_range, 'invoice')})` : '(no invoice covers this period)'),
    conf ? h('div', null,
      h('div', { class: 'ov-fin-title', style: 'margin-top:10px' }, 'Staff costs and gross profit (confidential)'),
      money('Driver cost per day', row.driver_cost_per_day), money('PA cost per day', row.pa_cost_per_day), money('Additional / other costs per day', row.other_cost_per_day),
      money('Total staff cost per day', row.staff_cost_per_day),
      money('Staff cost for this period', row.staff_cost_range, `(recorded ${fmt.money(row.staff_cost_actual)} · projected ${fmt.money(row.staff_cost_projected)}; cover rates and absences included)`),
      money('Gross profit per day', row.gross_per_day, `(${fmt.pct(row.margin_per_day)})`),
      money('Gross profit for this period', row.gross_range, `(${fmt.pct(row.margin_range)} margin)`),
      h('div', { class: 'ov-none', style: 'margin-top:6px' }, 'Gross profit is contract value less direct staff costs. Other operating expenses are not included.')) : null);
  return h('div', { class: 'ov-detail' },
    h('div', { class: 'ov-detail-grid' },
      h('div', null, h('div', { class: 'ov-fin-title' }, `Children (${row.child_count})`),
        row.children.length ? UI.table(childCols, row.children, { empty: 'No children assigned' }) : h('div', { class: 'ov-none' }, 'No children assigned'),
        h('div', { class: 'ov-none', style: 'margin-top:6px' }, 'School: ', row.school_address || 'address not provided', row.school_start || row.school_finish ? ` · school day ${row.school_start || '—'} to ${row.school_finish || '—'}` : '')),
      h('div', null, h('div', { class: 'ov-fin-title' }, 'Staff'), staffBox),
      finBox),
    h('div', { class: 'pill-row', style: 'margin-top:10px' },
      h('button', { class: 'btn xs', onclick: () => Ov.open(row.company_id, '/contracts/' + row.contract_id) }, 'Open contract profile'),
      h('button', { class: 'btn xs', onclick: () => Ov.open(row.company_id, `/calendar?contract=${row.contract_id}`) }, 'Calendar'),
      App.can('edit') ? h('button', { class: 'btn xs primary', onclick: () => Ov.editRow(row, data) }, 'Edit') : null));
}

/** Edits the fields the account may change, writing back through the CRM. */
Ov.editRow = async function (row, data) {
  const same = App.state.organisation && Number(row.company_id) === Number(App.state.organisation.id);
  const L = same ? await UI.lookups() : null;
  const fields = [
    { type: 'section', label: `${row.company_name} · ${row.code}` },
    { name: 'code', label: 'Contract / route reference', required: true },
    { name: 'po_number', label: 'PO number', help: 'Several contracts may share one PO number.' },
    { name: 'status', label: 'Status', type: 'select', placeholder: false, options: [{ value: 'active', label: 'Active' }, { value: 'pending', label: 'Pending' }, { value: 'suspended', label: 'Suspended' }, { value: 'ended', label: 'Completed' }] },
  ];
  if (L) fields.push(
    { name: 'school_id', label: 'School', type: 'select', options: L.schools.map(x => ({ value: x.id, label: x.name })) },
    { name: 'council_id', label: 'Local authority / council', type: 'select', options: L.councils.map(x => ({ value: x.id, label: x.name })) },
    { name: 'driver_id', label: 'Assigned driver', type: 'select', options: L.drivers.map(x => ({ value: x.id, label: x.name })), help: 'Changing the driver here corrects who is recorded on every date. For a handover from a date, use the contract page.' },
    { name: 'pa_id', label: 'Assigned PA', type: 'select', options: L.pas.map(x => ({ value: x.id, label: x.name })) });
  else fields.push({ type: 'section', label: 'School, council, driver and PA can be changed after switching to this business (top left), or from its contract page.' });
  if (data.can_see_finance) fields.push(
    { type: 'section', label: 'Contract values (management only, audited)' },
    { name: 'income_per_day', label: 'Contract value per day (£)', type: 'number', step: '0.01' },
    { name: 'driver_pay_per_day', label: 'Driver pay per day (£)', type: 'number', step: '0.01' },
    { name: 'pa_pay_per_day', label: 'PA pay per day (£)', type: 'number', step: '0.01' },
    { name: 'other_costs_per_day', label: 'Additional staff / other costs per day (£)', type: 'number', step: '0.01' });
  const values = { code: row.code, po_number: row.po_number || '', status: row.status, school_id: row.school_id, council_id: row.council_id, driver_id: row.driver_id, pa_id: row.pa_id };
  if (data.can_see_finance) Object.assign(values, { income_per_day: row.value_per_day, driver_pay_per_day: row.driver_cost_per_day, pa_pay_per_day: row.pa_cost_per_day, other_costs_per_day: row.other_cost_per_day });
  UI.editor({
    title: 'Edit ' + row.code, fields, values, width: 'wide',
    onSave: async v => {
      const body = {};
      for (const k of Object.keys(v)) if (String(v[k] ?? '') !== String(values[k] ?? '')) body[k] = v[k];
      if (!Object.keys(body).length) return toast('Nothing changed', 'ok');
      await api.put(`/api/contracts-overview/${row.company_id}/contracts/${row.contract_id}`, body);
      toast(`${row.code} updated`, 'ok');
      await Ov.reload();
    },
  });
};

App.views.overview = async function ({ query }) {
  const today = D.today();
  const saved = ovLoadState();
  const st = {
    company: query.company || saved.company || 'all',
    from: query.from || saved.from || D.monthStart(today),
    to: query.to || saved.to || D.monthEnd(today),
    confidential: false,
    q: '', school_id: '', council_id: '', driver_id: '', pa_id: '', status: '', po: '', starts_from: '', starts_to: '',
    sort: saved.sort || 'code', dir: saved.dir || 1,
    columns: Array.isArray(saved.columns) && saved.columns.length ? saved.columns : null,
    widths: saved.widths || {}, view: saved.view || null,
    expanded: new Set(),
  };
  let data = null, views = { presets: [], views: [] };
  const root = h('div');
  const load = async () => {
    data = await api.get('/api/contracts-overview', clean({ from: st.from, to: st.to, company: st.company, confidential: st.confidential ? 1 : 0, include_ended: 1 }));
    if (!st.columns) st.columns = data.columns.filter(c => c.main && !c.restricted).map(c => c.key);
    // Anything the account may not see, or chose to hide, leaves the column list.
    st.columns = st.columns.filter(k => data.columns.some(c => c.key === k));
  };
  Ov.reload = async () => { await load(); draw(); };
  try { [views] = await Promise.all([api.get('/api/contracts-overview/views'), load()]); }
  catch (e) { return h('div', { class: 'card' }, h('div', { class: 'card-body' }, h('h2', { style: 'color:var(--red)' }, 'Could not load the overview'), h('p', e.message))); }

  const visibleRows = () => {
    const rows = data.rows.filter(r => {
      if (st.status ? r.status !== st.status : r.status === 'ended') return false;
      if (st.school_id && String(r.school_id) !== st.school_id && !r.children.some(k => String(k.school_id) === st.school_id)) return false;
      if (st.council_id && String(r.council_id) !== st.council_id) return false;
      if (st.driver_id && String(r.driver_id) !== st.driver_id) return false;
      if (st.pa_id && String(r.pa_id) !== st.pa_id) return false;
      if (st.po && String(r.po_number || '').toLowerCase() !== st.po.toLowerCase()) return false;
      if (st.starts_from && (!r.start_date || r.start_date < st.starts_from)) return false;
      if (st.starts_to && (!r.start_date || r.start_date > st.starts_to)) return false;
      if (st.q) {
        const t = st.q.toLowerCase();
        const hay = [r.code, r.name, r.po_number, r.school_name, r.council_name, r.company_name, r.driver_name, r.pa_name, ...r.children.map(k => k.name), ...r.children.map(k => k.postcode)].filter(Boolean).join(' | ').toLowerCase();
        if (!hay.includes(t)) return false;
      }
      return true;
    });
    const col = data.columns.find(c => c.key === st.sort);
    const numeric = col && ['money', 'pct', 'int'].includes(col.type);
    return rows.sort((a, b) => {
      const x = a[st.sort], y = b[st.sort];
      if (x === y) return 0;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return (numeric ? Number(x) - Number(y) : String(x).localeCompare(String(y))) * st.dir;
    });
  };
  const summaryOf = rows => {
    const sum = k => Math.round(rows.reduce((a, r) => a + (Number(r[k]) || 0), 0) * 100) / 100;
    const distinct = k => new Set(rows.map(r => r[k]).filter(Boolean)).size;
    const out = { contracts: rows.length, active: rows.filter(r => r.status === 'active').length, schools: distinct('school_id'), children: rows.reduce((a, r) => a + r.child_count, 0), drivers: distinct('driver_id'), pas: distinct('pa_id'), revenue: sum('income_range'), revenue_actual: sum('income_actual'), revenue_projected: sum('income_projected'), invoiced: sum('invoiced_range') };
    if (data.confidential) { out.staff_cost = sum('staff_cost_range'); out.gross = Math.round((out.revenue - out.staff_cost) * 100) / 100; out.margin = out.revenue > 0 ? Math.round(out.gross / out.revenue * 1000) / 10 : 0; }
    return out;
  };
  const exportUrl = format => '/api/contracts-overview/export?' + new URLSearchParams(clean({
    format, from: st.from, to: st.to, company: st.company, confidential: st.confidential ? 1 : 0, include_ended: 1,
    q: st.q, school_id: st.school_id, council_id: st.council_id, driver_id: st.driver_id, pa_id: st.pa_id, status: st.status || '', po: st.po,
    starts_from: st.starts_from, starts_to: st.starts_to, sort: st.sort, dir: st.dir === -1 ? 'desc' : 'asc', columns: st.columns.join(','), inline: format === 'pdf' ? 1 : 0,
  }));
  const applyView = v => {
    st.view = v.id;
    st.columns = v.columns.filter(k => data.columns.some(c => c.key === k) || data.can_see_finance);
    const f = v.filters || {};
    Object.assign(st, { q: f.q || '', school_id: f.school_id || '', council_id: f.council_id || '', driver_id: f.driver_id || '', pa_id: f.pa_id || '', status: f.status || '', po: f.po || '' });
    if (f.company) st.company = f.company;
    if (v.confidential && data.can_see_finance && !st.confidential) { st.confidential = true; Ov.reload(); return; }
    if (!v.confidential && st.confidential) { st.confidential = false; Ov.reload(); return; }
    if (f.company && f.company !== (data.companies.length === 1 ? String(data.companies[0].id) : 'all')) { Ov.reload(); return; }
    st.columns = st.columns.filter(k => data.columns.some(c => c.key === k));
    draw();
  };

  function draw() {
    ovSaveState(st);
    root.innerHTML = '';
    const rows = visibleRows();
    const columns = st.columns.map(k => data.columns.find(c => c.key === k)).filter(Boolean);
    const conf = data.confidential;
    const sum = summaryOf(rows);

    // ---- actions ----
    const actions = h('div', { class: 'pill-row' },
      data.can_see_finance ? h('button', { class: 'btn ' + (conf ? 'danger' : ''), title: conf ? 'Hide wages, staff costs and profit' : 'Reveal wages, staff costs and profit', onclick: async () => {
        st.confidential = !conf;
        if (!st.confidential) st.columns = st.columns.filter(k => !data.columns.find(c => c.key === k && c.restricted));
        await load();
        if (st.confidential) for (const c of data.columns) if (c.restricted && c.main && !st.columns.includes(c.key)) st.columns.push(c.key);
        draw();
      } }, conf ? 'Hide staff costs & profit' : 'Show staff costs & profit') : null,
      h('button', { class: 'btn', onclick: () => Ov.columnChooser(data, st, draw) }, 'Columns'),
      h('button', { class: 'btn', onclick: () => Ov.viewsMenu(data, st, views, applyView, v => { views = v; draw(); }) }, st.view ? `View: ${(views.presets.concat(views.views).find(v => v.id === st.view) || {}).name || 'custom'}` : 'Saved views'),
      h('a', { class: 'btn', href: exportUrl('xlsx') }, 'Export to Excel'),
      h('a', { class: 'btn', href: exportUrl('pdf'), target: '_blank' }, 'Export to PDF'));

    // ---- filters ----
    const opt = (list, labelKey) => list.map(x => h('option', { value: x.id }, x[labelKey]));
    const distinctFrom = (idKey, nameKey) => { const m = new Map(); for (const r of data.rows) if (r[idKey]) m.set(`${r.company_id}:${r[idKey]}`, { id: r[idKey], name: r[nameKey] + (data.companies.length > 1 ? ` (${r.company_name})` : '') }); return [...m.values()].sort((a, b) => a.name.localeCompare(b.name)); };
    const schools = (() => { const m = new Map(); for (const r of data.rows) { if (r.school_id) m.set(`${r.company_id}:${r.school_id}`, { id: r.school_id, name: r.school_name }); for (const k of r.children) if (k.school_id) m.set(`${r.company_id}:${k.school_id}`, { id: k.school_id, name: k.school_name }); } return [...m.values()].filter(s => s.name).sort((a, b) => a.name.localeCompare(b.name)); })();
    const pos = [...new Set(data.rows.map(r => r.po_number).filter(Boolean))].sort();
    const sel = (key, label, options, placeholder) => h('div', { class: 'field' }, h('label', label),
      h('select', { onchange: e => { st[key] = e.target.value; st.view = null; draw(); } }, h('option', { value: '' }, placeholder), ...options.map(o => h('option', { value: o.id, selected: String(o.id) === String(st[key]) }, o.name))));
    const period = (label, a, b) => h('button', { class: 'btn sm', onclick: () => { st.from = a; st.to = b; Ov.reload(); } }, label);
    const nextMonth = D.monthStart(D.add(D.monthEnd(today), 1));
    const filters = h('div', null,
      h('div', { class: 'filters' },
        h('div', { class: 'field', style: 'min-width:200px' }, h('label', 'Company'),
          h('select', { onchange: e => { st.company = e.target.value; st.view = null; Ov.reload(); } },
            h('option', { value: 'all', selected: st.company === 'all' }, 'All companies'),
            ...(App.state.organisations || []).map(o => h('option', { value: o.id, selected: String(o.id) === String(st.company) }, o.name)))),
        h('div', { class: 'field', style: 'flex:1;min-width:240px' }, h('label', 'Search'),
          h('input', { type: 'search', value: st.q, placeholder: 'Contract, PO, school, child, postcode, driver, PA, company', oninput: e => { st.q = e.target.value; clearTimeout(st._t); st._t = setTimeout(draw, 200); } })),
        sel('school_id', 'School', schools, 'All schools'),
        sel('council_id', 'Local authority', distinctFrom('council_id', 'council_name'), 'All councils'),
        h('div', { class: 'field' }, h('label', 'Status'), h('select', { onchange: e => { st.status = e.target.value; draw(); } },
          h('option', { value: '' }, 'Active, pending, suspended'), ...['active', 'pending', 'suspended', 'ended'].map(s => h('option', { value: s, selected: st.status === s }, s === 'ended' ? 'Completed' : fmt.titleCase(s))))),
        sel('driver_id', 'Driver', distinctFrom('driver_id', 'driver_name'), 'All drivers'),
        sel('pa_id', 'PA', distinctFrom('pa_id', 'pa_name'), 'All PAs'),
        sel('po', 'PO number', pos.map(p => ({ id: p, name: p })), 'All PO numbers')),
      h('div', { class: 'filters', style: 'margin-top:8px' },
        h('div', { class: 'field' }, h('label', 'Financial period from'), h('input', { type: 'date', value: st.from, onchange: e => { st.from = e.target.value; Ov.reload(); } })),
        h('div', { class: 'field' }, h('label', 'To'), h('input', { type: 'date', value: st.to, onchange: e => { st.to = e.target.value; Ov.reload(); } })),
        h('div', { class: 'pill-row', style: 'padding-bottom:1px' },
          period('This month', D.monthStart(today), D.monthEnd(today)),
          period('Last month', D.monthStart(D.add(D.monthStart(today), -1)), D.monthEnd(D.add(D.monthStart(today), -1))),
          period('Next month', nextMonth, D.monthEnd(nextMonth)),
          period('This week', D.weekStart(today), D.add(D.weekStart(today), 6)),
          period('Year to date', today.slice(0, 4) + '-01-01', today)),
        h('div', { class: 'field' }, h('label', 'Contract start from'), h('input', { type: 'date', value: st.starts_from, onchange: e => { st.starts_from = e.target.value; draw(); } })),
        h('div', { class: 'field' }, h('label', 'Contract start to'), h('input', { type: 'date', value: st.starts_to, onchange: e => { st.starts_to = e.target.value; draw(); } })),
        (st.q || st.school_id || st.council_id || st.driver_id || st.pa_id || st.po || st.status || st.starts_from || st.starts_to)
          ? h('button', { class: 'btn sm', onclick: () => { Object.assign(st, { q: '', school_id: '', council_id: '', driver_id: '', pa_id: '', po: '', status: '', starts_from: '', starts_to: '' }); draw(); } }, 'Clear filters') : null));

    // ---- summary ----
    const projected = sum.revenue_projected > 0;
    const stats = h('div', { class: 'stats' },
      UI.stat({ label: 'Active contracts', value: String(sum.active), hint: rows.length !== sum.active ? `${rows.length} shown` : (data.companies.length > 1 ? `${data.companies.length} companies` : data.companies[0] ? data.companies[0].name : '') }),
      UI.stat({ label: 'Schools', value: String(sum.schools) }),
      UI.stat({ label: 'Children', value: String(sum.children) }),
      UI.stat({ label: 'Assigned drivers', value: String(sum.drivers) }),
      UI.stat({ label: 'Assigned PAs', value: String(sum.pas) }),
      UI.stat({ label: 'Contract revenue', value: fmt.money0(sum.revenue), hint: `${fmt.date(st.from)} to ${fmt.date(st.to)} · recorded ${fmt.money0(sum.revenue_actual)}${projected ? ` · projected ${fmt.money0(sum.revenue_projected)}` : ''} · invoiced ${fmt.money0(sum.invoiced)}` }),
      ...(conf ? [
        UI.stat({ label: 'Staff costs', value: fmt.money0(sum.staff_cost), hint: 'Recorded and projected wages, cover included', tone: 'amber' }),
        UI.stat({ label: 'Gross profit', value: fmt.money0(sum.gross), hint: 'Revenue less direct staff costs', tone: sum.gross >= 0 ? 'green' : 'red' }),
        UI.stat({ label: 'Average gross margin', value: fmt.pct(sum.margin), tone: sum.margin >= 20 ? 'green' : sum.margin >= 10 ? 'amber' : 'red' }),
      ] : []));
    const companySummary = data.companies.length > 1 ? UI.table([
      { key: 'name', label: 'Company', value: c => h('strong', c.name) },
      { key: 'active', label: 'Active contracts', num: true },
      { key: 'schools', label: 'Schools', num: true }, { key: 'children', label: 'Children', num: true },
      { key: 'drivers', label: 'Drivers', num: true }, { key: 'pas', label: 'PAs', num: true },
      { key: 'revenue', label: 'Revenue', num: true, value: c => fmt.money(c.revenue) },
      { key: 'invoiced', label: 'Invoiced', num: true, value: c => fmt.money(c.invoiced) },
      ...(conf ? [
        { key: 'staff_cost', label: 'Staff costs', num: true, value: c => fmt.money(c.staff_cost) },
        { key: 'gross', label: 'Gross profit', num: true, value: c => h('strong', fmt.money(c.gross)) },
        { key: 'margin', label: 'Margin', num: true, value: c => fmt.pct(c.margin) }] : []),
    ], data.companies.map(c => ({ name: c.name, ...summaryOf(rows.filter(r => r.company_id === c.id)) })), {}) : null;

    // ---- the spreadsheet ----
    const table = h('table', { class: 'ov' });
    const headRow = h('tr', h('th', { class: 'ov-fixed ov-tog' }));
    let left = 36;
    for (const col of columns) {
      const key = col.key;
      const width = st.widths[key] || (col.type === 'money' || col.type === 'pct' || col.type === 'int' ? 120 : key.startsWith('children_') || key === 'other_staff' ? 220 : key === 'school_name' || key === 'code' ? 170 : 140);
      const th = h('th', { class: (col.frozen ? 'ov-fixed ' : '') + (col.restricted ? 'ov-conf ' : '') + (['money', 'pct', 'int'].includes(col.type) ? 'num' : ''), style: `width:${width}px;min-width:${width}px;max-width:${width}px;${col.frozen ? `left:${left}px` : ''}`, title: col.section },
        h('span', { class: 'ov-th', onclick: () => { if (st.sort === key) st.dir = -st.dir; else { st.sort = key; st.dir = 1; } draw(); } }, col.label, st.sort === key ? (st.dir === 1 ? ' ▲' : ' ▼') : ''),
        h('span', { class: 'ov-grip', title: 'Drag to resize', onmousedown: e => {
          e.preventDefault();
          const startX = e.clientX, startW = width;
          const move = ev => { st.widths[key] = Math.max(70, startW + ev.clientX - startX); th.style.width = th.style.minWidth = th.style.maxWidth = st.widths[key] + 'px'; };
          const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); ovSaveState(st); draw(); };
          document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
        } }));
      if (col.frozen) left += width;
      headRow.appendChild(th);
    }
    headRow.appendChild(h('th', { class: 'ov-act' }, ''));
    table.appendChild(h('thead', headRow));
    const body = h('tbody');
    if (!rows.length) body.appendChild(h('tr', h('td', { colspan: columns.length + 2 }, UI.empty('No contracts match these filters', 'contracts'))));
    for (const row of rows) {
      const id = `${row.company_id}:${row.contract_id}`;
      const open = st.expanded.has(id);
      const tr = h('tr', { class: 'ov-row' + (open ? ' open' : '') });
      tr.appendChild(h('td', { class: 'ov-fixed ov-tog' }, h('button', { class: 'ov-expand', title: open ? 'Collapse' : 'Expand', 'aria-label': (open ? 'Collapse ' : 'Expand ') + row.code, onclick: () => { if (open) st.expanded.delete(id); else st.expanded.add(id); draw(); } }, open ? '−' : '+')));
      let l = 36;
      for (const col of columns) {
        const width = st.widths[col.key] || (col.type === 'money' || col.type === 'pct' || col.type === 'int' ? 120 : col.key.startsWith('children_') || col.key === 'other_staff' ? 220 : col.key === 'school_name' || col.key === 'code' ? 170 : 140);
        tr.appendChild(h('td', { class: (col.frozen ? 'ov-fixed ' : '') + (col.restricted ? 'ov-conf ' : '') + (['money', 'pct', 'int'].includes(col.type) ? 'num' : ''), style: col.frozen ? `left:${l}px` : null }, ovCell(col, row)));
        if (col.frozen) l += width;
      }
      tr.appendChild(h('td', { class: 'ov-act' }, App.can('edit') ? h('button', { class: 'btn xs', onclick: () => Ov.editRow(row, data) }, 'Edit') : null));
      body.appendChild(tr);
      if (open) body.appendChild(h('tr', { class: 'ov-detail-row' }, h('td', { colspan: columns.length + 2 }, ovDetail(row, data))));
    }
    table.appendChild(body);
    const totals = h('tr', { class: 'ov-totals' }, h('td', { class: 'ov-fixed ov-tog' }));
    let tl = 36;
    columns.forEach((col, i) => {
      const width = st.widths[col.key] || (col.type === 'money' || col.type === 'pct' || col.type === 'int' ? 120 : col.key.startsWith('children_') || col.key === 'other_staff' ? 220 : col.key === 'school_name' || col.key === 'code' ? 170 : 140);
      let v = '';
      if (i === 0) v = `${plural(rows.length, 'contract')}`;
      else if (col.type === 'money') v = fmt.money(rows.reduce((a, r) => a + (Number(r[col.key]) || 0), 0));
      else if (col.key === 'child_count') v = String(sum.children);
      else if (col.key === 'margin_range' && conf) v = fmt.pct(sum.margin);
      totals.appendChild(h('td', { class: (col.frozen ? 'ov-fixed ' : '') + (['money', 'pct', 'int'].includes(col.type) ? 'num' : ''), style: col.frozen ? `left:${tl}px` : null }, v));
      if (col.frozen) tl += width;
    });
    totals.appendChild(h('td', { class: 'ov-act' }));
    table.appendChild(h('tfoot', totals));

    root.appendChild(UI.pageHead('Contracts overview',
      `Every contract across ${data.companies.length === 1 ? data.companies[0].name : plural(data.companies.length, 'company', 'companies')}, read live from the CRM. ${conf ? 'Staff costs and profit are showing.' : 'Staff costs and profit are hidden.'}`,
      actions));
    root.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-head' }, filters)));
    root.appendChild(h('div', { style: 'height:14px' }));
    root.appendChild(stats);
    if (companySummary) root.appendChild(h('div', { class: 'card', style: 'margin-top:14px' }, h('div', { class: 'card-head' }, h('h2', 'By company'), h('span', { class: 'ov-none' }, projected ? 'Figures to today are recorded; later dates are projected from the schedule.' : 'All figures are from recorded days.')), h('div', { class: 'card-body tight' }, companySummary)));
    root.appendChild(h('div', { class: 'card', style: 'margin-top:14px' },
      h('div', { class: 'card-head' }, h('h2', `${plural(rows.length, 'contract')}`), h('span', { class: 'ov-none' }, `Period ${fmt.date(st.from)} to ${fmt.date(st.to)} · click a heading to sort · drag a heading edge to resize · + expands a contract`)),
      h('div', { class: 'card-body tight' }, h('div', { class: 'ov-wrap' }, table))));
  }
  draw();
  return root;
};

/** Choose which columns are shown, by section. Restricted columns only appear when revealed. */
Ov.columnChooser = function (data, st, redraw) {
  const sections = [...new Set(data.columns.map(c => c.section))];
  const boxes = data.columns.map(c => ({ key: c.key, input: h('input', { type: 'checkbox', checked: st.columns.includes(c.key) }), label: c.label + (c.restricted ? ' (confidential)' : '') }));
  const body = h('div', null,
    h('p', { class: 'ov-none' }, data.can_see_finance && !data.confidential ? 'Staff cost and profit columns appear here once you choose "Show staff costs & profit".' : ''),
    ...sections.map(s => h('fieldset', h('legend', s), h('div', { class: 'form-grid' }, ...boxes.filter(b => data.columns.find(c => c.key === b.key).section === s).map(b => h('label', { class: 'field check' }, b.input, b.label))))));
  const dlg = UI.modal({ title: 'Columns', width: 'wide', body,
    footer: [h('button', { class: 'btn', onclick: () => { boxes.forEach(b => { b.input.checked = data.columns.find(c => c.key === b.key).main; }); } }, 'Main columns'),
      h('button', { class: 'btn', onclick: () => boxes.forEach(b => { b.input.checked = true; }) }, 'All'),
      h('button', { class: 'btn primary', onclick: () => { const keys = boxes.filter(b => b.input.checked).map(b => b.key); if (!keys.length) return toast('Choose at least one column', 'err'); st.columns = data.columns.map(c => c.key).filter(k => keys.includes(k)); st.view = null; dlg.close(); redraw(); } }, 'Apply')] });
};

/** Ready-made and saved views: switch, save the current layout, remove. */
Ov.viewsMenu = function (data, st, views, apply, onChange) {
  const render = () => {
    const list = h('div', null);
    const line = (v, own) => h('div', { class: 'oprow', style: 'padding:9px 0' },
      h('div', { style: 'flex:1;min-width:160px' }, h('strong', v.name), h('div', { class: 'ov-none' }, `${plural(v.columns.length, 'column')}${v.confidential ? ' · includes staff costs and profit' : ''}${own ? '' : ' · built in'}`)),
      h('div', { class: 'pill-row' },
        h('button', { class: 'btn xs primary', onclick: () => { dlg.close(); apply(v); } }, 'Use'),
        own ? h('button', { class: 'btn xs danger', onclick: async () => {
          try { const r = await api.put('/api/contracts-overview/views', { views: views.views.filter(x => x.id !== v.id) }); views = { ...views, views: r.views }; onChange(views); dlg.close(); Ov.viewsMenu(data, st, views, apply, onChange); } catch (e) { toast(e.message, 'err'); }
        } }, 'Remove') : null));
    for (const v of views.presets) list.appendChild(line(v, false));
    for (const v of views.views) list.appendChild(line(v, true));
    const name = h('input', { type: 'text', placeholder: 'Name this view, e.g. South Tyneside routes', maxlength: 60, style: 'flex:1' });
    const save = h('button', { class: 'btn primary', onclick: async () => {
      if (!name.value.trim()) return toast('Give the view a name', 'err');
      const view = { name: name.value.trim(), columns: st.columns, confidential: st.confidential,
        filters: clean({ q: st.q, company: st.company, school_id: st.school_id, council_id: st.council_id, driver_id: st.driver_id, pa_id: st.pa_id, status: st.status, po: st.po }) };
      try { const r = await api.put('/api/contracts-overview/views', { views: [...views.views.filter(v => v.name.toLowerCase() !== view.name.toLowerCase()), view] }); views = { ...views, views: r.views }; st.view = r.views.find(v => v.name === view.name).id; onChange(views); toast('View saved', 'ok'); dlg.close(); }
      catch (e) { toast(e.message, 'err'); }
    } }, 'Save current layout as a view');
    return h('div', null, list, h('div', { class: 'pill-row', style: 'margin-top:12px' }, name, save),
      h('p', { class: 'ov-none', style: 'margin-top:8px' }, 'A saved view remembers the columns, filters and whether staff costs are revealed. It only ever shows what your account is allowed to see.'));
  };
  const dlg = UI.modal({ title: 'Saved views', width: 'wide', body: render(), footer: [h('button', { class: 'btn', onclick: () => dlg.close() }, 'Close')] });
};
