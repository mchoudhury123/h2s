/* views: contracts, children, staff, schools, councils, vehicles */
'use strict';
const Rec = window.Rec = {};

const STATUS_BADGE = { active: 'green', pending: 'blue', suspended: 'amber', ended: '', inactive: '', pool: 'blue' };
function statusBadge(s) { return h('span', { class: 'badge ' + (STATUS_BADGE[s] || '') }, fmt.titleCase(s)); }
// "None known", "N/A" and similar are not a real value, so they must not raise a warning flag.
const NO_VALUE = /^(none|none known|n\/?a|no|nil|not known|none recorded)\.?$/i;
function hasValue(v) { return !!v && !NO_VALUE.test(String(v).trim()); }
window.hasValue = hasValue;

/* =========================================================
   CONTRACTS
   ========================================================= */
App.views.contracts = async function ({ query }) {
  const rows = await api.get('/api/contracts', query.status ? { status: query.status } : {});
  let data = rows;
  if (query.gap) data = rows.filter(r => ['active', 'pending'].includes(r.status) && (!r.driver_id || (r.requires_pa && !r.pa_id)));
  const showMoney = App.can('finance');
  return UI.listPage({
    deleteRecord: { resource: 'contracts', label: r => r.code },
    title: 'Contracts & routes',
    subtitle: query.gap ? 'Showing only contracts missing a driver or PA' : `${rows.length} contracts`,
    actions: [
      App.can('edit') ? h('button', { class: 'btn primary', onclick: () => Rec.contractEditor(null) }, '+ New contract') : null,
      h('a', { class: 'btn', href: '#/reports' }, 'Reports'),
    ],
    columns: [
      { key: 'code', label: 'Code', value: r => h('a', { href: '#/contracts/' + r.id }, h('strong', r.code)), nowrap: true },
      { key: 'school_name', label: 'School', value: r => r.school_name ? h('a', { href: '#/schools/' + r.school_id }, r.school_name) : '—' },
      { key: 'council_name', label: 'Council' },
      { key: 'child_count', label: 'Children', num: true },
      { key: 'driver_name', label: 'Driver', value: r => r.driver_id ? h('a', { href: '#/staff/' + r.driver_id }, r.driver_name) : h('span', { class: 'badge red' }, 'None') },
      { key: 'pa_name', label: 'PA', value: r => r.pa_id ? h('a', { href: '#/staff/' + r.pa_id }, r.pa_name) : (r.requires_pa ? h('span', { class: 'badge red' }, 'None') : h('span', { class: 'badge' }, 'Not required')) },
      { key: 'days_of_week', label: 'Days', value: r => fmt.days(r.days_of_week), nowrap: true },
      ...(showMoney ? [
        { key: 'income_per_day', label: 'Income/day', num: true, value: r => fmt.money(r.income_per_day) },
        { key: 'expected_profit_per_day', label: 'Profit/day', num: true, value: r => h('span', { style: r.expected_profit_per_day < 0 ? 'color:var(--red);font-weight:650' : '' }, fmt.money(r.expected_profit_per_day)) },
        { key: 'margin', label: 'Margin', num: true, value: r => fmt.pct(r.margin) },
      ] : []),
      { key: 'status', label: 'Status', value: r => statusBadge(r.status) },
    ],
    rows: data,
    searchFields: ['code', 'name', 'school_name', 'council_name', 'driver_name', 'pa_name', 'council_ref', 'route_info'],
    filters: [{ key: 'status', label: 'Status', options: ['active', 'pending', 'suspended', 'ended'], value: query.status }],
    onRow: r => Router.go('/contracts/' + r.id),
    empty: 'No contracts yet. Create one to start generating journeys.',
  });
};

App.views.contractDetail = async function ({ params }) {
  const c = await api.get('/api/contracts/' + params.id);
  const reload = () => Router.handle();
  const showMoney = App.can('finance');

  const head = UI.pageHead(c.code, [c.name, c.school_name, c.council_name].filter(Boolean).join(' · '),
    [
      App.can('calendar') ? h('button', { class: 'btn primary', onclick: () => Ops.dayDialog(c.id, D.today(), reload) }, 'Record exception today') : null,
      h('a', { class: 'btn', href: `#/calendar?contract=${c.id}` }, 'Calendar'),
      App.can('edit') ? h('button', { class: 'btn', onclick: () => Rec.contractEditor(c) }, 'Edit') : null,
    ],
    [statusBadge(c.status)]);

  // headline figures
  const stats = h('div', { class: 'stats' },
    UI.stat({ label: 'Children', value: c.child_count, hint: 'Travelling on this route', href: '#/children?contract=' + c.id }),
    UI.stat({ label: 'Driver', value: c.driver_name || 'None', hint: c.driver_id ? 'Compliance: ' + fmt.titleCase(c.driver_compliance || '—') : 'Assign a driver', tone: c.driver_id ? (c.driver_compliance === 'red' ? 'red' : '') : 'red', href: c.driver_id ? '#/staff/' + c.driver_id : '#/pool?type=driver' }),
    UI.stat({ label: 'Passenger assistant', value: c.requires_pa ? (c.pa_name || 'None') : 'Not required', hint: c.pa_id ? 'Compliance: ' + fmt.titleCase(c.pa_compliance || '—') : (c.requires_pa ? 'Assign a PA' : ''), tone: c.requires_pa && !c.pa_id ? 'red' : '', href: c.pa_id ? '#/staff/' + c.pa_id : '#/pool?type=pa' }),
    UI.stat({
      label: 'Journeys per week',
      value: c.week.days.reduce((a, d) => a + d.trip_count, 0),
      hint: c.week.configured
        ? c.week.days.filter(d => d.trip_count).map(d => `${Sched.DAY_SHORT[d.weekday]} ${d.trip_count}`).join(' · ')
        : `${fmt.days(c.days_of_week)} · standard week`,
      onclick: App.can('edit') ? () => Sched.weekEditor(c, reload) : null,
    }));

  const tabs = [];
  tabs.push({
    id: 'schedule', label: 'Weekly schedule',
    render: () => Sched.weekPanel(c, c.week, reload),
  });
  tabs.push({
    id: 'overview', label: 'Overview',
    render: () => h('div', { class: 'grid cols-2' },
      UI.card('Contract details', UI.kv([
        ['Contract code', c.code], ['Contract name', c.name],
        ['Council / customer', c.council_id ? h('a', { href: '#/councils/' + c.council_id }, c.council_name) : null],
        ['Council reference', c.council_ref],
        ['School', c.school_id ? h('a', { href: '#/schools/' + c.school_id }, c.school_name) : null],
        ['School address', [c.school_address, c.school_postcode].filter(Boolean).join(', ')],
        ['School phone', c.school_phone],
        ['Start date', fmt.date(c.start_date)], ['End date', fmt.date(c.end_date)],
        ['Status', statusBadge(c.status)],
        ['Operating days', fmt.days(c.days_of_week)],
      ])),
      UI.card('Journeys, route and vehicle', h('div', null,
        UI.kv([
          ['AM pick-up', fmt.time(c.am_pickup_time)], ['AM arrival at school', fmt.time(c.am_arrival_time)],
          ['PM school finish', fmt.time(c.pm_finish_time)], ['PM drop-off', fmt.time(c.pm_dropoff_time)],
          ['Route', c.route_info],
          ['Vehicle', c.vehicle_id ? `${c.vehicle_reg} — ${[c.vehicle_make, c.vehicle_model].filter(Boolean).join(' ')}` : null],
          ['Seats', c.vehicle_seats], ['Wheelchair accessible', c.vehicle_id ? (c.wheelchair_accessible ? 'Yes' : 'No') : null],
          ['AM notes', c.am_notes], ['PM notes', c.pm_notes],
        ]),
        c.notes ? h('div', { class: 'note-box', style: 'margin-top:12px' }, c.notes) : null))),
  });

  tabs.push({
    id: 'children', label: 'Children', count: c.children.length,
    render: () => UI.cardTight(null, UI.table([
      { key: 'last_name', label: 'Child', value: ch => h('a', { href: '#/children/' + ch.id }, h('strong', `${ch.first_name} ${ch.last_name}`)) },
      { key: 'dob', label: 'Age', num: true, value: ch => fmt.age(ch.dob) ?? '—' },
      { key: 'address', label: 'Pick-up address', value: ch => [ch.address, ch.postcode].filter(Boolean).join(', ') || '—' },
      { key: 'pickup_time', label: 'Pick-up', value: ch => fmt.time(ch.pickup_time), nowrap: true },
      { key: 'dropoff_time', label: 'Drop-off', value: ch => fmt.time(ch.dropoff_time), nowrap: true },
      { label: 'Needs', sortable: false, value: ch => h('div', { class: 'pill-row' },
        ch.wheelchair ? h('span', { class: 'badge blue' }, 'Wheelchair') : null,
        ch.mobility ? h('span', { class: 'badge' }, 'Mobility') : null,
        ch.medical_info ? h('span', { class: 'badge amber' }, 'Medical') : null,
        hasValue(ch.allergies) ? h('span', { class: 'badge red' }, 'Allergy') : null,
        ch.behaviour ? h('span', { class: 'badge amber' }, 'Behaviour') : null) },
      { key: 'parent_phone', label: 'Parent / carer', value: ch => ch.parent_name ? h('div', null, ch.parent_name, h('div', { style: 'font-size:11.5px;color:var(--text-dim)' }, ch.parent_phone || '')) : '—' },
      { key: 'status', label: 'Status', value: ch => statusBadge(ch.status) },
    ], c.children, { empty: 'No children assigned to this contract yet', onRow: ch => Router.go('/children/' + ch.id) }),
      App.can('edit') ? h('button', { class: 'btn sm primary', onclick: () => Rec.childEditor(null, { contract_id: c.id, school_id: c.school_id }) }, '+ Add child to this contract') : null),
  });

  if (showMoney && c.financials) {
    tabs.push({
      id: 'finance', label: 'Financials',
      render: () => {
        const f = c.financials, p = c.per_day;
        return h('div', null,
          h('div', { class: 'stats' },
            UI.stat({ label: 'Income per day', value: fmt.money(p.income), hint: fmt.titleCase(c.income_basis) }),
            UI.stat({ label: 'Driver pay per day', value: fmt.money(p.driver) }),
            UI.stat({ label: 'PA pay per day', value: fmt.money(p.pa) }),
            UI.stat({ label: 'Other direct costs', value: fmt.money(p.other) }),
            UI.stat({ label: 'Expected profit per day', value: fmt.money(p.profit), tone: p.profit >= 0 ? 'green' : 'red' }),
            UI.stat({ label: 'Expected margin', value: fmt.pct(p.margin), tone: p.margin >= 20 ? 'green' : p.margin >= 10 ? 'amber' : 'red' })),
          h('div', { style: 'height:14px' }),
          UI.card(`Actual performance ${fmt.date(c.financials_period.from)} – ${fmt.date(c.financials_period.to)}`,
            h('div', null,
              h('div', { class: 'breakdown' },
                bl('Income from journeys operated', f.income),
                bl('Driver cost', -f.driver_cost), bl('PA cost', -f.pa_cost),
                bl('Other direct costs', -f.other_costs), bl('Ad-hoc expenses', -f.adhoc_expenses),
                h('div', { class: 'bl total' }, h('span', { class: 'btx' }, 'Gross profit'), h('span', { class: 'bam' }, fmt.money(f.gross_profit)))),
              h('div', { style: 'margin-top:10px;color:var(--text-dim);font-size:13px' },
                `${f.journeys_operated} of ${f.journeys_scheduled} scheduled journeys operated · ${f.days_operated} days · margin ${fmt.pct(f.margin)}`)),
            h('a', { class: 'btn sm', href: `#/finance?contract=${c.id}&from=${c.financials_period.from}&to=${c.financials_period.to}` }, 'Full analysis')));
      },
    });
  }

  tabs.push({
    id: 'exceptions', label: 'Recent exceptions', count: c.exceptions.length,
    render: () => UI.cardTight(null, UI.table([
      { key: 'date', label: 'Date', value: e => h('a', { href: '#/day/' + e.date }, fmt.date(e.date)), nowrap: true },
      { key: 'type', label: 'Type', value: e => fmt.titleCase(e.type) },
      { key: 'leg', label: 'Journeys', value: e => journeyText(e) },
      { label: 'Detail', sortable: false, value: e => [e.child_name, e.staff_name, e.cover_name ? '→ cover: ' + e.cover_name : null, e.cover_pay != null ? fmt.money(e.cover_pay) : null, e.paid_immediately ? 'PAID IMMEDIATELY' : null, e.note].filter(Boolean).join(' · ') || '—' },
      { key: 'created_by', label: 'Recorded by' },
      { label: '', sortable: false, value: e => App.can('calendar') ? h('button', { class: 'btn xs', onclick: () => Ops.dayDialog(c.id, e.date, reload) }, 'Open day') : null },
    ], c.exceptions, { sortKey: 'date', sortDir: -1, empty: 'No exceptions recorded recently — everything ran as scheduled' })),
  });

  tabs.push({ id: 'documents', label: 'Documents', count: c.documents.length, render: () => UI.cardTight(null, UI.documentsPanel('contract', c.id, c.documents, reload)) });
  if (App.can('audit') || App.can('*')) tabs.push({ id: 'history', label: 'History', render: () => UI.cardTight(null, UI.historyPanel(c.history)) });

  const order = ['overview', 'schedule', 'children', 'finance', 'exceptions', 'documents', 'history'];
  tabs.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return h('div', null, head, stats, h('div', { style: 'height:14px' }), UI.tabs(tabs));
};
function bl(label, amount, cls) {
  return h('div', { class: 'bl ' + (amount < 0 ? 'neg ' : '') + (cls || '') },
    h('span', { class: 'btx' }, label), h('span', { class: 'bam' }, fmt.money(amount)));
}

Rec.contractEditor = async function (c) {
  const L = await UI.lookups();
  const fields = [
    { type: 'section', label: 'Identification' },
    { name: 'code', label: 'Contract / job code', required: true, placeholder: 'e.g. THORNHILL PARK 1' },
    { name: 'name', label: 'Description' },
    { name: 'council_id', label: 'Council / customer', type: 'select', options: L.councils.map(x => ({ value: x.id, label: x.name })) },
    { name: 'council_ref', label: 'Council reference' },
    { name: 'school_id', label: 'School', type: 'select', options: L.schools.map(x => ({ value: x.id, label: x.name })) },
    { name: 'status', label: 'Status', type: 'select', placeholder: false, options: [{ value: 'active', label: 'Active' }, { value: 'pending', label: 'Pending' }, { value: 'suspended', label: 'Suspended' }, { value: 'ended', label: 'Ended' }] },
    { type: 'section', label: 'Staffing' },
    { name: 'driver_id', label: 'Assigned driver', type: 'select', options: L.drivers.map(x => ({ value: x.id, label: `${x.name}${x.status === 'pool' ? ' (pool)' : ''}` })) },
    { name: 'pa_id', label: 'Assigned PA', type: 'select', options: L.pas.map(x => ({ value: x.id, label: `${x.name}${x.status === 'pool' ? ' (pool)' : ''}` })) },
    { name: 'vehicle_id', label: 'Vehicle', type: 'select', options: L.vehicles.map(x => ({ value: x.id, label: `${x.registration} (${x.seats || '?'} seats${x.wheelchair_accessible ? ', WAV' : ''})` })) },
    { name: 'requires_pa', label: 'This contract requires a PA', type: 'checkbox', span: 'full' },
    { type: 'section', label: 'Schedule' },
    { name: 'days_of_week', label: 'Operating days', type: 'days', help: 'Journeys are generated automatically for these days between the start and end dates. Use the Weekly schedule tab when a day needs more or fewer journeys than one out and one back.' },
    { name: 'start_date', label: 'Start date', type: 'date' },
    { name: 'end_date', label: 'End date', type: 'date' },
    { type: 'section', label: 'Standard times — used unless the weekly schedule says otherwise' },
    { name: 'am_pickup_time', label: 'AM pick-up time', type: 'time' },
    { name: 'am_arrival_time', label: 'AM school arrival', type: 'time' },
    { name: 'pm_finish_time', label: 'PM school finish', type: 'time' },
    { name: 'pm_dropoff_time', label: 'PM home drop-off', type: 'time' },
    { name: 'route_info', label: 'Route information', type: 'textarea', span: 'full' },
  ];
  if (App.can('finance')) fields.push(
    { type: 'section', label: 'Finance' },
    { name: 'income_per_day', label: 'Contract income per day (£)', type: 'number', step: '0.01' },
    { name: 'income_basis', label: 'Income basis', type: 'select', placeholder: false, options: [{ value: 'per_journey', label: 'Pro-rata per journey operated' }, { value: 'per_day', label: 'Fixed per operating day' }], help: 'Per journey: a cancelled AM run loses half the day rate.' },
    { name: 'driver_pay_per_day', label: 'Driver pay per day (£)', type: 'number', step: '0.01' },
    { name: 'pa_pay_per_day', label: 'PA pay per day (£)', type: 'number', step: '0.01' },
    { name: 'pay_basis', label: 'Pay basis', type: 'select', placeholder: false, options: [{ value: 'per_journey', label: 'Pro-rata per journey operated' }, { value: 'per_day', label: 'Fixed per operating day' }] },
    { name: 'other_costs_per_day', label: 'Other direct costs per day (£)', type: 'number', step: '0.01' });
  fields.push({ name: 'notes', label: 'Notes', type: 'textarea', span: 'full', rows: 3 });

  UI.editor({
    title: c ? 'Edit ' + c.code : 'New contract',
    fields, values: c || { status: 'active', requires_pa: 1, days_of_week: '1,2,3,4,5', income_basis: 'per_journey', pay_basis: 'per_journey' },
    onSave: async v => {
      const saved = c ? await api.put('/api/contracts/' + c.id, v) : await api.post('/api/contracts', v);
      await UI.lookups(true);
      toast(c ? 'Contract updated — changes flow through to children, calendar and wages' : 'Contract created', 'ok');
      if (c) Router.handle(); else Router.go('/contracts/' + saved.id);
    },
    extraFooter: c && App.can('edit') ? h('button', { class: 'btn danger left', onclick: () => UI.confirmDelete(`Delete ${c.code}? This cannot be undone.`, async () => { await api.del('/api/contracts/' + c.id); App.state.lookups = null; toast('Contract deleted', 'ok'); Router.go('/contracts'); }) }, 'Delete') : null,
  });
};

/* =========================================================
   CHILDREN
   ========================================================= */
App.views.children = async function ({ query }) {
  const rows = await api.get('/api/children', clean({ school_id: query.school, contract_id: query.contract, status: query.status }));
  return UI.listPage({
    deleteRecord: { resource: 'children', label: r => r.name },
    title: 'Children',
    subtitle: `${rows.filter(r => r.status === 'active').length} active`,
    actions: App.can('edit') ? [h('button', { class: 'btn primary', onclick: () => Rec.childEditor(null) }, '+ New child')] : null,
    columns: [
      { key: 'last_name', label: 'Name', value: r => h('a', { href: '#/children/' + r.id }, h('strong', r.name)) },
      { key: 'dob', label: 'Age', num: true, value: r => fmt.age(r.dob) ?? '—' },
      { key: 'school_name', label: 'School', value: r => r.school_id ? h('a', { href: '#/schools/' + r.school_id }, r.school_name) : '—' },
      { key: 'contract_code', label: 'Contract', value: r => r.contract_id ? h('a', { href: '#/contracts/' + r.contract_id }, r.contract_code) : h('span', { class: 'badge amber' }, 'Unassigned') },
      { key: 'driver_name', label: 'Driver', value: r => r.driver_name || '—' },
      { key: 'pa_name', label: 'PA', value: r => r.pa_name || '—' },
      { key: 'postcode', label: 'Postcode' },
      { key: 'pickup_time', label: 'Pick-up', value: r => fmt.time(r.pickup_time), nowrap: true },
      { label: 'Needs', sortable: false, value: r => h('div', { class: 'pill-row' },
        r.wheelchair ? h('span', { class: 'badge blue' }, 'WAV') : null,
        r.medical_info ? h('span', { class: 'badge amber' }, 'Medical') : null,
        hasValue(r.allergies) ? h('span', { class: 'badge red' }, 'Allergy') : null) },
      { key: 'status', label: 'Status', value: r => statusBadge(r.status) },
    ],
    rows,
    searchFields: ['name', 'first_name', 'last_name', 'postcode', 'address', 'school_name', 'contract_code', 'council_ref', 'parent_name', 'parent_phone'],
    filters: [{ key: 'status', label: 'Status', options: ['active', 'inactive'], value: query.status }],
    onRow: r => Router.go('/children/' + r.id),
  });
};

App.views.childDetail = async function ({ params }) {
  const c = await api.get('/api/children/' + params.id);
  const reload = () => Router.handle();
  const age = fmt.age(c.dob);

  const head = UI.pageHead(c.name,
    [c.school_name, c.contract_code, age ? age + ' years old' : null].filter(Boolean).join(' · '),
    [App.can('edit') ? h('button', { class: 'btn', onclick: () => Rec.childEditor(c) }, 'Edit') : null,
     c.contract_id && App.can('calendar') ? h('button', { class: 'btn primary', onclick: () => Ops.dayDialog(c.contract_id, D.today(), reload) }, 'Record absence today') : null],
    [statusBadge(c.status)]);

  const transport = h('div', { class: 'stats' },
    UI.stat({ label: 'School', value: c.school_name || 'Not set', hint: c.school_postcode || '', href: c.school_id ? '#/schools/' + c.school_id : '#/schools' }),
    UI.stat({ label: 'Contract / route', value: c.contract_code || 'Unassigned', hint: c.route_info || '', href: c.contract_id ? '#/contracts/' + c.contract_id : '#/contracts', tone: c.contract_id ? '' : 'amber' }),
    UI.stat({ label: 'Driver', value: c.driver_name || 'None', hint: c.driver_phone || '', href: c.driver_id ? '#/staff/' + c.driver_id : '#/contracts', tone: c.driver_id ? '' : 'red' }),
    UI.stat({ label: 'Passenger assistant', value: c.pa_name || 'None', hint: c.pa_phone || '', href: c.pa_id ? '#/staff/' + c.pa_id : '#/contracts' }),
    UI.stat({
      label: 'Travels', value: plural(c.timetable.attending_days, 'day') + ' a week',
      hint: c.timetable.days.filter(d => !d.attends).length
        ? 'Off ' + c.timetable.days.filter(d => !d.attends).map(d => Sched.DAY_SHORT[d.weekday]).join(', ')
        : (c.timetable.configured ? `${fmt.time(c.timetable.start_time)} – ${fmt.time(c.timetable.finish_time)}` : 'Whenever the contract runs'),
      onclick: App.can('edit') ? () => Sched.timetableEditor(c, reload) : null,
    }));

  const flags = h('div', { class: 'pill-row', style: 'margin:12px 0' },
    c.wheelchair ? h('span', { class: 'badge blue' }, '♿ Wheelchair user') : null,
    hasValue(c.allergies) ? h('span', { class: 'badge red' }, '⚠ Allergy: ' + c.allergies) : null,
    c.medical_info ? h('span', { class: 'badge amber' }, '⚕ Medical information recorded') : null,
    c.safeguarding_info ? h('span', { class: 'badge purple' }, '🛡 Safeguarding information') : null,
    c.behaviour ? h('span', { class: 'badge amber' }, 'Behaviour plan') : null);

  const tabs = [
    {
      id: 'timetable', label: 'Weekly timetable',
      render: () => Sched.timetablePanel(c, c.timetable, reload),
    },
    {
      id: 'profile', label: 'Profile',
      render: () => h('div', { class: 'grid cols-2' },
        UI.card('Personal and contact', UI.kv([
          ['Full name', c.name], ['Date of birth', c.dob ? `${fmt.date(c.dob)} (${age})` : null],
          ['Home address', c.address], ['Postcode', c.postcode],
          ['Parent / carer', c.parent_name], ['Parent telephone', c.parent_phone ? h('a', { href: 'tel:' + c.parent_phone }, c.parent_phone) : null],
          ['Emergency contact', c.emergency_contact_name], ['Emergency telephone', c.emergency_contact_phone ? h('a', { href: 'tel:' + c.emergency_contact_phone }, c.emergency_contact_phone) : null],
          ['Council reference', c.council_ref],
        ])),
        UI.card('Transport timings', h('div', null,
          UI.kv([
            ['Pick-up from home', fmt.time(c.pickup_time)], ['Arrival at school', fmt.time(c.arrival_time)],
            ['School finish', fmt.time(c.finish_time)], ['Drop-off at home', fmt.time(c.dropoff_time)],
            ['Operating days', fmt.days(c.days_of_week)],
            ['Vehicle', c.vehicle_reg],
            ['School address', [c.school_address, c.school_postcode].filter(Boolean).join(', ')],
            ['School telephone', c.school_phone],
          ]),
          c.travels_with.length ? h('div', { style: 'margin-top:12px' },
            h('div', { style: 'font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-faint);font-weight:650;margin-bottom:5px' }, 'Travels with'),
            h('div', { class: 'pill-row' }, ...c.travels_with.map(t => h('a', { class: 'badge', href: '#/children/' + t.id }, `${t.first_name} ${t.last_name}`, t.pickup_time ? ' · ' + fmt.time(t.pickup_time) : '')))) : null))),
    },
    {
      id: 'needs', label: 'Needs & safeguarding',
      render: () => h('div', { class: 'grid cols-2' },
        UI.card('Medical and additional needs', UI.kv([
          ['SEN / additional needs', c.sen_needs], ['Conditions', c.conditions],
          ['Medical information', c.medical_info], ['Allergies', c.allergies],
          ['Mobility requirements', c.mobility], ['Wheelchair', c.wheelchair ? 'Yes — wheelchair accessible vehicle required' : 'No'],
        ])),
        UI.card('Transport risk and communication', h('div', null,
          UI.kv([
            ['Behavioural information', c.behaviour],
            ['Communication requirements', c.communication],
          ]),
          c.safeguarding_info ? h('div', { class: 'note-box danger', style: 'margin-top:12px' }, h('strong', 'Safeguarding: '), c.safeguarding_info) : null,
          c.risk_info ? h('div', { class: 'note-box warn', style: 'margin-top:10px' }, h('strong', 'Risk information: '), c.risk_info) : null,
          c.notes ? h('div', { class: 'note-box', style: 'margin-top:10px' }, c.notes) : null))),
    },
    {
      id: 'absences', label: 'Absence history', count: c.absences.length,
      render: () => UI.cardTight(null, UI.table([
        { key: 'date', label: 'Date', value: a => h('a', { href: '#/day/' + a.date }, fmt.dateLong(a.date)), nowrap: true },
        { key: 'leg', label: 'Journeys missed', value: a => a.trip_seq ? (a.trip_label || `Journey ${a.trip_seq}`) : (a.leg === 'DAY' ? 'All day' : a.leg + ' only') },
        { key: 'contract_code', label: 'Contract' },
        { key: 'note', label: 'Reason', value: a => a.note || '—' },
        { key: 'created_by', label: 'Recorded by' },
      ], c.absences.filter(a => a.type === 'child_absence'), { sortKey: 'date', sortDir: -1, empty: 'No absences recorded' })),
    },
    { id: 'documents', label: 'Documents', count: c.documents.length, render: () => UI.cardTight(null, UI.documentsPanel('child', c.id, c.documents, reload)) },
  ];
  if (App.can('audit') || App.can('*')) tabs.push({ id: 'history', label: 'History', render: () => UI.cardTight(null, UI.historyPanel(c.history)) });

  const order = ['profile', 'timetable', 'needs', 'absences', 'documents', 'history'];
  tabs.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return h('div', null, head, transport, flags, UI.tabs(tabs));
};

Rec.childEditor = async function (c, defaults) {
  const L = await UI.lookups();
  const fields = [
    { type: 'section', label: 'Child' },
    { name: 'first_name', label: 'First name', required: true },
    { name: 'last_name', label: 'Last name', required: true },
    { name: 'dob', label: 'Date of birth', type: 'date' },
    { name: 'council_ref', label: 'Council reference' },
    { name: 'status', label: 'Status', type: 'select', placeholder: false, options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }] },
    { type: 'section', label: 'Home and contacts' },
    { name: 'address', label: 'Home address', span: 'full' },
    { name: 'postcode', label: 'Postcode' },
    { name: 'parent_name', label: 'Parent / carer name' },
    { name: 'parent_phone', label: 'Parent / carer telephone' },
    { name: 'emergency_contact_name', label: 'Additional / emergency contact' },
    { name: 'emergency_contact_phone', label: 'Emergency telephone' },
    { type: 'section', label: 'Transport' },
    { name: 'contract_id', label: 'Contract / route', type: 'select', options: L.contracts.map(x => ({ value: x.id, label: x.code })), help: 'The school, driver and PA follow from the contract automatically.' },
    { name: 'school_id', label: 'School (override)', type: 'select', options: L.schools.map(x => ({ value: x.id, label: x.name })), help: 'Leave blank to inherit from the contract.' },
    { name: 'pickup_time', label: 'Pick-up time', type: 'time' },
    { name: 'arrival_time', label: 'School arrival time', type: 'time' },
    { name: 'finish_time', label: 'School finish time', type: 'time' },
    { name: 'dropoff_time', label: 'Home drop-off time', type: 'time' },
    { type: 'section', label: 'Needs, medical and safeguarding' },
    { name: 'sen_needs', label: 'SEN / additional needs', type: 'textarea', span: 'full', rows: 2 },
    { name: 'conditions', label: 'Autism / ADHD / learning difficulties', type: 'textarea', span: 'full', rows: 2 },
    { name: 'medical_info', label: 'Medical information', type: 'textarea', span: 'full', rows: 2 },
    { name: 'allergies', label: 'Allergies', span: 'full' },
    { name: 'mobility', label: 'Mobility requirements', type: 'textarea', span: 'full', rows: 2 },
    { name: 'wheelchair', label: 'Wheelchair user — requires an accessible vehicle', type: 'checkbox', span: 'full' },
    { name: 'behaviour', label: 'Behavioural information', type: 'textarea', span: 'full', rows: 2 },
    { name: 'communication', label: 'Communication requirements', type: 'textarea', span: 'full', rows: 2 },
    { name: 'safeguarding_info', label: 'Important safeguarding / transport information', type: 'textarea', span: 'full', rows: 2 },
    { name: 'risk_info', label: 'Risk information', type: 'textarea', span: 'full', rows: 2 },
    { name: 'notes', label: 'Notes', type: 'textarea', span: 'full', rows: 2 },
  ];
  UI.editor({
    title: c ? 'Edit ' + c.name : 'New child',
    fields, values: c || { status: 'active', ...(defaults || {}) },
    onSave: async v => {
      const saved = c ? await api.put('/api/children/' + c.id, v) : await api.post('/api/children', v);
      await UI.lookups(true);
      toast(c ? 'Child updated' : 'Child added', 'ok');
      if (c) Router.handle(); else Router.go('/children/' + saved.id);
    },
    extraFooter: c && App.can('edit') ? h('button', { class: 'btn danger left', onclick: () => UI.confirmDelete(`Delete ${c.name}? This removes their profile and absence history.`, async () => { await api.del('/api/children/' + c.id); App.state.lookups = null; toast('Child deleted', 'ok'); Router.go('/children'); }) }, 'Delete') : null,
  });
};

/* =========================================================
   STAFF (drivers + PAs)
   ========================================================= */
App.views.staffList = async function ({ params, query }) {
  const type = params.type || 'driver';
  const rows = await api.get('/api/staff', clean({ type, status: query.status }));
  const label = type === 'driver' ? 'Drivers' : 'Passenger assistants';
  return UI.listPage({
    deleteRecord: { resource: 'staff', label: r => r.name },
    title: label,
    subtitle: `${rows.filter(r => r.status === 'active').length} active · ${rows.filter(r => r.status === 'pool').length} in the staff pool`,
    actions: [
      App.can('edit') ? h('button', { class: 'btn primary', onclick: () => Rec.staffEditor(null, type) }, '+ New ' + (type === 'driver' ? 'driver' : 'PA')) : null,
      h('a', { class: 'btn', href: '#/pool?type=' + type }, 'Staff pool & availability'),
    ],
    columns: [
      { label: '', width: '26px', sortable: false, value: r => h('span', { class: 'dot ' + r.compliance, title: 'Compliance: ' + r.compliance }) },
      { key: 'last_name', label: 'Name', value: r => h('a', { href: '#/staff/' + r.id }, h('strong', r.name)) },
      { key: 'phone', label: 'Telephone', value: r => r.phone ? h('a', { href: 'tel:' + r.phone }, r.phone) : '—' },
      { key: 'postcode', label: 'Postcode' },
      { key: 'contract_count', label: 'Contracts', num: true },
      ...(type === 'driver' ? [{ key: 'vehicles', label: 'Vehicle', value: r => r.vehicles || h('span', { class: 'badge amber' }, 'None') },
        { key: 'badge_number', label: 'Badge no.' }] : []),
      ...(App.can('finance') ? [{ key: 'default_day_rate', label: 'Default rate', num: true, value: r => fmt.money(r.default_day_rate) }] : []),
      { key: 'compliance', label: 'Compliance', value: r => rag(r.compliance) },
      { key: 'status', label: 'Status', value: r => statusBadge(r.status) },
    ],
    rows,
    searchFields: ['name', 'first_name', 'last_name', 'postcode', 'phone', 'email', 'badge_number', 'address'],
    filters: [
      { key: 'status', label: 'Status', options: ['active', 'pool', 'inactive'], value: query.status },
      { key: 'compliance', label: 'Compliance', options: [{ value: 'green', label: 'Green' }, { value: 'amber', label: 'Amber' }, { value: 'red', label: 'Red' }] },
    ],
    onRow: r => Router.go('/staff/' + r.id),
  });
};

App.views.staffDetail = async function ({ params }) {
  const s = await api.get('/api/staff/' + params.id);
  const reload = () => Router.handle();
  const isDriver = s.type === 'driver';

  const head = UI.pageHead(s.name,
    `${isDriver ? 'Driver' : 'Passenger assistant'}${s.phone ? ' · ' + s.phone : ''}${s.postcode ? ' · ' + s.postcode : ''}`,
    [App.can('edit') ? h('button', { class: 'btn', onclick: () => Rec.staffEditor(s) }, 'Edit') : null,
     App.can('wages') ? h('a', { class: 'btn primary', href: `#/wages?staff=${s.id}` }, 'Calculate wages') : null,
     h('a', { class: 'btn', href: `#/calendar?staff=${s.id}` }, 'Calendar')],
    [rag(s.compliance.status), statusBadge(s.status)]);

  const activeContracts = s.contracts.filter(c => c.status === 'active');
  const stats = h('div', { class: 'stats' },
    UI.stat({ label: 'Active contracts', value: activeContracts.length, hint: activeContracts.map(c => c.code).join(', ') || 'None assigned' }),
    UI.stat({ label: 'Children transported', value: s.children.length }),
    UI.stat({ label: 'Schools serviced', value: new Set(activeContracts.map(c => c.school_name).filter(Boolean)).size, hint: [...new Set(activeContracts.map(c => c.school_name).filter(Boolean))].join(', ') }),
    ...(App.can('finance') ? [UI.stat({ label: 'Expected pay per full day', value: fmt.money(activeContracts.reduce((a, c) => a + (c.role === 'driver' ? c.driver_pay_per_day : c.pa_pay_per_day), 0)), hint: 'Across all assigned contracts' })] : []),
    UI.stat({ label: 'Compliance', value: fmt.titleCase(s.compliance.status), hint: (() => { const n = s.compliance.items.filter(i => i.status !== 'green').length; return n ? plural(n, 'document') + ' needs attention' : 'All required documents valid'; })(), tone: s.compliance.status }));

  const complianceCard = UI.cardTight('Compliance — traffic light',
    UI.table([
      { label: '', width: '26px', sortable: false, value: i => h('span', { class: 'dot ' + i.status }) },
      { key: 'doc_type', label: 'Required document' },
      { key: 'status', label: 'Status', value: i => h('span', { class: 'badge ' + i.status }, i.status === 'green' ? 'Valid' : i.status === 'amber' ? 'Expiring' : 'Action required') },
      { key: 'reason', label: 'Detail' },
      { label: '', sortable: false, value: i => i.document ? (hasFile(i.document) ? h('a', { class: 'btn xs', href: `/api/documents/${i.document.id}/file`, target: '_blank' }, 'View file') : null)
        : (App.can('documents') ? h('button', { class: 'btn xs primary', onclick: () => UI.documentEditor('staff', s.id, null, reload) }, 'Add') : null) },
    ], s.compliance.items, { empty: 'No required documents configured' }),
    h('span', { style: 'font-size:12px;color:var(--text-faint)' }, `Amber warning ${s.compliance.amber_days} days before expiry`));

  const tabs = [
    {
      id: 'work', label: 'Work & assignments',
      render: () => h('div', null,
        UI.cardTight('Assigned contracts', UI.table([
          { key: 'code', label: 'Contract', value: c => h('a', { href: '#/contracts/' + c.id }, h('strong', c.code)) },
          { key: 'role', label: 'Role', value: c => h('span', { class: 'badge blue' }, c.role === 'driver' ? 'Driver' : 'PA') },
          { key: 'school_name', label: 'School', value: c => c.school_id ? h('a', { href: '#/schools/' + c.school_id }, c.school_name) : '—' },
          { key: 'council_name', label: 'Council' },
          { key: 'child_count', label: 'Children', num: true },
          { key: 'days_of_week', label: 'Days', value: c => fmt.days(c.days_of_week), nowrap: true },
          { label: 'Times', sortable: false, value: c => `${fmt.time(c.am_pickup_time)} – ${fmt.time(c.pm_dropoff_time)}` },
          ...(App.can('finance') ? [{ label: 'Pay per day', num: true, sortable: false, value: c => fmt.money(c.role === 'driver' ? c.driver_pay_per_day : c.pa_pay_per_day) }] : []),
          { key: 'status', label: 'Status', value: c => statusBadge(c.status) },
        ], s.contracts, { empty: 'Not assigned to any contract yet' })),
        h('div', { style: 'height:14px' }),
        UI.cardTight(`Children transported (${s.children.length})`, UI.table([
          { key: 'last_name', label: 'Child', value: c => h('a', { href: '#/children/' + c.id }, `${c.first_name} ${c.last_name}`) },
          { key: 'school_name', label: 'School' },
          { key: 'contract_code', label: 'Contract', value: c => h('a', { href: '#/contracts/' + c.contract_id }, c.contract_code) },
          { key: 'pickup_time', label: 'Pick-up', value: c => fmt.time(c.pickup_time), nowrap: true },
          { key: 'dropoff_time', label: 'Drop-off', value: c => fmt.time(c.dropoff_time), nowrap: true },
          { label: 'Needs', sortable: false, value: c => h('div', { class: 'pill-row' }, c.wheelchair ? h('span', { class: 'badge blue' }, 'WAV') : null, c.sen_needs ? h('span', { class: 'badge' }, 'SEN') : null) },
        ], s.children, { empty: 'No children currently assigned' }))),
    },
    { id: 'compliance', label: 'Compliance', render: () => h('div', null, complianceCard) },
    {
      id: 'profile', label: 'Profile',
      render: () => h('div', { class: 'grid cols-2' },
        UI.card('Contact details', UI.kv([
          ['Full name', s.name], ['Address', s.address], ['Postcode', s.postcode],
          ['Telephone', s.phone ? h('a', { href: 'tel:' + s.phone }, s.phone) : null],
          ['Email', s.email ? h('a', { href: 'mailto:' + s.email }, s.email) : null],
          ['Emergency contact', s.emergency_contact_name], ['Emergency telephone', s.emergency_contact_phone],
          ['Start date', fmt.date(s.start_date)], ['Status', statusBadge(s.status)],
        ])),
        UI.card(isDriver ? 'Licensing and pay' : 'Training and pay', h('div', null,
          UI.kv([
            ...(isDriver ? [['Licensing authority', s.licensing_authority], ['Driver badge / licence number', s.badge_number]] : []),
            ['DBS number', s.dbs_number],
            ...(App.can('finance') ? [['Default day rate', fmt.money(s.default_day_rate)]] : []),
            ['Availability', s.availability], ['Preferred working areas', s.preferred_areas],
          ]),
          s.notes ? h('div', { class: 'note-box', style: 'margin-top:12px' }, s.notes) : null)),
        ...(isDriver ? [UI.cardTight('Vehicles', h('div', null,
          UI.table([
            { key: 'registration', label: 'Registration', value: v => h('strong', v.registration) },
            { label: 'Vehicle', sortable: false, value: v => [v.make, v.model, v.colour].filter(Boolean).join(' ') },
            { key: 'seats', label: 'Passenger seats', num: true },
            { key: 'wheelchair_accessible', label: 'Wheelchair accessible', value: v => v.wheelchair_accessible ? h('span', { class: 'badge green' }, 'Yes') : 'No' },
            { key: 'active', label: 'Active', value: v => v.active ? 'Yes' : 'No' },
            { label: '', sortable: false, value: v => App.can('edit') ? h('button', { class: 'btn xs', onclick: () => Rec.vehicleEditor(v, s.id) }, 'Edit') : null },
          ], s.vehicles, { empty: 'No vehicle recorded' }),
          App.can('edit') ? h('div', { style: 'padding:10px 14px' }, h('button', { class: 'btn sm primary', onclick: () => Rec.vehicleEditor(null, s.id) }, '+ Add vehicle')) : null))] : [])),
    },
    { id: 'documents', label: 'Documents', count: s.documents.length + s.vehicle_documents.length,
      render: () => h('div', null,
        UI.cardTight('Personal documents', UI.documentsPanel('staff', s.id, s.documents, reload)),
        isDriver ? h('div', null, h('div', { style: 'height:14px' }),
          UI.cardTight('Vehicle documents', s.vehicles.length
            ? h('div', null, ...s.vehicles.map(v => h('div', null,
                h('div', { style: 'padding:9px 14px;font-weight:650;background:var(--surface-2);border-bottom:1px solid var(--border)' }, v.registration),
                UI.documentsPanel('vehicle', v.id, s.vehicle_documents.filter(d => d.entity_id === v.id).map(d => ({ ...d, calculated_status: docStatusOf(d), days_left: daysLeft(d) })), reload))))
            : UI.empty('Add a vehicle first', '🚐'))) : null) },
    {
      id: 'cover', label: 'Absence & cover', count: s.absences.length + s.recent_cover.length,
      render: () => h('div', null,
        UI.cardTight('Own absences', UI.table([
          { key: 'date', label: 'Date', value: a => h('a', { href: '#/day/' + a.date }, fmt.dateLong(a.date)), nowrap: true },
          { key: 'contract_code', label: 'Contract' },
          { key: 'leg', label: 'Journeys', value: a => journeyText(a) },
          { key: 'cover_name', label: 'Covered by', value: a => a.cover_name || h('span', { class: 'badge red' }, 'No cover') },
          { key: 'note', label: 'Reason' },
        ], s.absences, { sortKey: 'date', sortDir: -1, empty: 'No absences recorded' })),
        h('div', { style: 'height:14px' }),
        UI.cardTight('Cover worked for others', UI.table([
          { key: 'date', label: 'Date', value: a => h('a', { href: '#/day/' + a.date }, fmt.dateLong(a.date)), nowrap: true },
          { key: 'contract_code', label: 'Contract' },
          { key: 'role', label: 'Role', value: a => fmt.titleCase(a.role) },
          { key: 'leg', label: 'Journeys', value: a => journeyText(a) },
          ...(App.can('finance') ? [{ key: 'cover_pay', label: 'Cover pay', num: true, value: a => fmt.money(a.cover_pay) }] : []),
          { key: 'paid_immediately', label: 'Paid immediately', value: a => a.paid_immediately ? h('span', { class: 'badge green' }, 'Yes — excluded from payroll') : h('span', { class: 'badge' }, 'Via payroll') },
        ], s.recent_cover, { sortKey: 'date', sortDir: -1, empty: 'Has not covered any journeys' })),
        App.can('wages') ? h('div', null, h('div', { style: 'height:14px' }),
          UI.cardTight('Payments recorded', UI.table([
            { key: 'work_date', label: 'Work date', value: p => fmt.date(p.work_date), nowrap: true },
            { key: 'paid_date', label: 'Paid on', value: p => fmt.date(p.paid_date), nowrap: true },
            { key: 'amount', label: 'Amount', num: true, value: p => fmt.money(p.amount) },
            { key: 'source', label: 'Source', value: p => h('span', { class: 'badge ' + (p.source === 'cover_immediate' ? 'amber' : '') }, fmt.titleCase(p.source)) },
            { key: 'note', label: 'Note' },
            { label: '', sortable: false, value: p => h('button', { class: 'btn xs danger', onclick: () => UI.confirm('Delete this payment record? It will then be included in the next wage calculation again.', async () => { await api.del('/api/payments/' + p.id); toast('Payment record deleted', 'ok'); reload(); }) }, 'Delete') },
          ], s.payments, { sortKey: 'work_date', sortDir: -1, empty: 'No payments recorded' }))) : null),
    },
  ];
  if (App.can('audit') || App.can('*')) tabs.push({ id: 'history', label: 'History', render: () => UI.cardTight(null, UI.historyPanel(s.history)) });

  return h('div', null, head, stats, h('div', { style: 'height:14px' }), UI.tabs(tabs));
};
function daysLeft(d) { return d.expiry_date ? Math.round((Date.parse(d.expiry_date) - Date.parse(D.today())) / 86400000) : null; }
function docStatusOf(d) {
  if (d.status === 'invalid') return 'red';
  if (!d.expiry_date) return 'green';
  const dl = daysLeft(d);
  return dl < 0 ? 'red' : dl <= (App.state.settings.amber_days || 30) ? 'amber' : 'green';
}

Rec.staffEditor = function (s, type) {
  const t = s ? s.type : type;
  const isDriver = t === 'driver';
  const fields = [
    { type: 'section', label: 'Personal' },
    { name: 'first_name', label: 'First name', required: true },
    { name: 'last_name', label: 'Last name', required: true },
    { name: 'address', label: 'Address', span: 'full' },
    { name: 'postcode', label: 'Postcode', help: 'Used to find the nearest available staff for cover.' },
    { name: 'phone', label: 'Telephone' },
    { name: 'email', label: 'Email', type: 'email' },
    { name: 'emergency_contact_name', label: 'Emergency contact' },
    { name: 'emergency_contact_phone', label: 'Emergency telephone' },
    { name: 'start_date', label: 'Start date', type: 'date' },
    { name: 'status', label: 'Status', type: 'select', placeholder: false, options: [{ value: 'active', label: 'Active — assigned to contracts' }, { value: 'pool', label: 'Staff pool — available, not assigned' }, { value: 'inactive', label: 'Inactive' }] },
    { type: 'section', label: isDriver ? 'Licensing' : 'Registration' },
    ...(isDriver ? [
      { name: 'licensing_authority', label: 'Licensing authority' },
      { name: 'badge_number', label: 'Driver badge / licence number' },
    ] : []),
    { name: 'dbs_number', label: 'DBS certificate number' },
    { type: 'section', label: 'Availability' },
    { name: 'availability', label: 'Availability', span: 'full', placeholder: 'e.g. Mon-Fri AM only, available at short notice' },
    { name: 'preferred_areas', label: 'Preferred working areas', span: 'full' },
  ];
  if (App.can('finance')) fields.push({ type: 'section', label: 'Pay' }, { name: 'default_day_rate', label: 'Default day rate (£)', type: 'number', step: '0.01', help: 'Used as a fallback. Contract rates take priority.' });
  fields.push({ name: 'notes', label: 'Notes', type: 'textarea', span: 'full', rows: 3 });

  UI.editor({
    title: s ? 'Edit ' + s.name : `New ${isDriver ? 'driver' : 'passenger assistant'}`,
    fields, values: s || { status: 'active' },
    onSave: async v => {
      v.type = t;
      const saved = s ? await api.put('/api/staff/' + s.id, v) : await api.post('/api/staff', v);
      await UI.lookups(true);
      toast(s ? 'Staff record updated' : 'Staff member added', 'ok');
      if (s) Router.handle(); else Router.go('/staff/' + saved.id);
    },
    extraFooter: s && App.can('edit') ? h('button', { class: 'btn danger left', onclick: () => UI.confirmDelete(`Delete ${s.name}?`, async () => { await api.del('/api/staff/' + s.id); App.state.lookups = null; toast('Deleted', 'ok'); Router.go('/staff/list/' + t); }) }, 'Delete') : null,
  });
};

Rec.vehicleEditor = function (v, driverId) {
  UI.editor({
    title: v ? 'Edit ' + v.registration : 'New vehicle',
    width: '',
    fields: [
      { name: 'registration', label: 'Registration', required: true },
      { name: 'make', label: 'Make' }, { name: 'model', label: 'Model' }, { name: 'colour', label: 'Colour' },
      { name: 'seats', label: 'Number of passenger seats', type: 'number', min: 1 },
      { name: 'wheelchair_accessible', label: 'Wheelchair accessible', type: 'checkbox', span: 'full' },
      { name: 'active', label: 'In service', type: 'checkbox', span: 'full' },
      { name: 'notes', label: 'Notes', type: 'textarea', span: 'full' },
    ],
    values: v || { active: 1, driver_id: driverId },
    onSave: async val => {
      val.driver_id = driverId;
      if (v) await api.put('/api/vehicles/' + v.id, val); else await api.post('/api/vehicles', val);
      await UI.lookups(true);
      toast('Vehicle saved', 'ok'); Router.handle();
    },
  });
};

/* =========================================================
   SCHOOLS
   ========================================================= */
App.views.schools = async function () {
  const rows = await api.get('/api/schools');
  return UI.listPage({
    deleteRecord: { resource: 'schools', label: r => r.name },
    title: 'Schools',
    subtitle: `${rows.length} schools`,
    actions: App.can('edit') ? [h('button', { class: 'btn primary', onclick: () => Rec.schoolEditor(null) }, '+ New school')] : null,
    columns: [
      { key: 'name', label: 'School', value: r => h('a', { href: '#/schools/' + r.id }, h('strong', r.name)) },
      { key: 'address', label: 'Address' },
      { key: 'postcode', label: 'Postcode' },
      { key: 'phone', label: 'Telephone' },
      { key: 'contact_name', label: 'Contact' },
      { key: 'open_time', label: 'Opens', value: r => fmt.time(r.open_time), nowrap: true },
      { key: 'close_time', label: 'Closes', value: r => fmt.time(r.close_time), nowrap: true },
      { key: 'child_count', label: 'Children', num: true },
      { key: 'contract_count', label: 'Contracts', num: true },
    ],
    rows, searchFields: ['name', 'address', 'postcode', 'contact_name', 'email'],
    onRow: r => Router.go('/schools/' + r.id),
  });
};

App.views.schoolDetail = async function ({ params }) {
  const s = await api.get('/api/schools/' + params.id);
  const reload = () => Router.handle();
  const head = UI.pageHead(s.name, [s.address, s.postcode].filter(Boolean).join(', '),
    [App.can('edit') ? h('button', { class: 'btn', onclick: () => Rec.schoolEditor(s) }, 'Edit') : null,
     h('a', { class: 'btn', href: `#/calendar?school=${s.id}` }, 'Calendar'),
     App.can('finance') ? h('a', { class: 'btn primary', href: `#/finance?school=${s.id}` }, 'Profitability') : null]);

  const activeChildren = s.children.filter(c => c.status === 'active');
  const stats = h('div', { class: 'stats' },
    UI.stat({ label: 'Children attending', value: activeChildren.length }),
    UI.stat({ label: 'Contracts / routes', value: s.contracts.filter(c => c.status === 'active').length }),
    UI.stat({ label: 'Drivers servicing', value: s.drivers.length }),
    UI.stat({ label: 'PAs servicing', value: s.pas.length }),
    UI.stat({ label: 'Opening times', value: `${fmt.time(s.open_time)}–${fmt.time(s.close_time)}` }));

  const tabs = [
    { id: 'contracts', label: 'Contracts', count: s.contracts.length,
      render: () => UI.cardTight(null, UI.table([
        { key: 'code', label: 'Contract', value: c => h('a', { href: '#/contracts/' + c.id }, h('strong', c.code)) },
        { key: 'council_name', label: 'Council' },
        { key: 'child_count', label: 'Children', num: true },
        { key: 'driver_name', label: 'Driver', value: c => c.driver_id ? h('a', { href: '#/staff/' + c.driver_id }, c.driver_name) : h('span', { class: 'badge red' }, 'None') },
        { key: 'pa_name', label: 'PA', value: c => c.pa_id ? h('a', { href: '#/staff/' + c.pa_id }, c.pa_name) : (c.requires_pa ? h('span', { class: 'badge red' }, 'None') : 'n/a') },
        { key: 'days_of_week', label: 'Days', value: c => fmt.days(c.days_of_week), nowrap: true },
        { label: 'Times', sortable: false, value: c => `${fmt.time(c.am_pickup_time)} – ${fmt.time(c.pm_dropoff_time)}` },
        { key: 'status', label: 'Status', value: c => statusBadge(c.status) },
      ], s.contracts, { empty: 'No contracts travel to this school' })) },
    { id: 'children', label: 'Children', count: s.children.length,
      render: () => UI.cardTight(null, UI.table([
        { key: 'last_name', label: 'Child', value: c => h('a', { href: '#/children/' + c.id }, `${c.first_name} ${c.last_name}`) },
        { key: 'contract_code', label: 'Contract', value: c => c.contract_id ? h('a', { href: '#/contracts/' + c.contract_id }, c.contract_code) : h('span', { class: 'badge amber' }, 'Unassigned') },
        { key: 'driver_name', label: 'Driver' }, { key: 'pa_name', label: 'PA' },
        { key: 'postcode', label: 'Postcode' },
        { key: 'wheelchair', label: 'Wheelchair', value: c => c.wheelchair ? h('span', { class: 'badge blue' }, 'Yes') : 'No' },
        { key: 'status', label: 'Status', value: c => statusBadge(c.status) },
      ], s.children, { empty: 'No children recorded at this school' })) },
    { id: 'staff', label: 'Staff', count: s.drivers.length + s.pas.length,
      render: () => h('div', { class: 'grid cols-2' },
        UI.cardTight('Drivers', h('div', { class: 'link-list' }, ...(s.drivers.length ? s.drivers.map(d => h('a', { href: '#/staff/' + d.id },
          h('div', { class: 'll-main' }, h('div', { class: 'll-t' }, `${d.first_name} ${d.last_name}`), h('div', { class: 'll-s' }, d.phone || '')))) : [UI.empty('None', '🚐')]))),
        UI.cardTight('Passenger assistants', h('div', { class: 'link-list' }, ...(s.pas.length ? s.pas.map(d => h('a', { href: '#/staff/' + d.id },
          h('div', { class: 'll-main' }, h('div', { class: 'll-t' }, `${d.first_name} ${d.last_name}`), h('div', { class: 'll-s' }, d.phone || '')))) : [UI.empty('None', '🧑‍🤝‍🧑')])))) },
    { id: 'details', label: 'Details',
      render: () => UI.card('School details', h('div', null, UI.kv([
        ['Name', s.name], ['Address', s.address], ['Postcode', s.postcode],
        ['Telephone', s.phone], ['Contact person', s.contact_name], ['Email', s.email],
        ['Opening time', fmt.time(s.open_time)], ['Closing time', fmt.time(s.close_time)],
      ]), s.notes ? h('div', { class: 'note-box', style: 'margin-top:12px' }, s.notes) : null)) },
    { id: 'documents', label: 'Documents', count: s.documents.length, render: () => UI.cardTight(null, UI.documentsPanel('school', s.id, s.documents, reload)) },
  ];
  return h('div', null, head, stats, h('div', { style: 'height:14px' }), UI.tabs(tabs));
};

Rec.schoolEditor = function (s) {
  UI.editor({
    title: s ? 'Edit ' + s.name : 'New school',
    fields: [
      { name: 'name', label: 'School name', required: true, span: 'full' },
      { name: 'address', label: 'Address', span: 'full' },
      { name: 'postcode', label: 'Postcode' },
      { name: 'phone', label: 'Telephone' },
      { name: 'contact_name', label: 'Contact person' },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'open_time', label: 'Opening time', type: 'time' },
      { name: 'close_time', label: 'Closing time', type: 'time' },
      { name: 'notes', label: 'Notes', type: 'textarea', span: 'full', rows: 3 },
    ],
    values: s || {},
    onSave: async v => {
      const saved = s ? await api.put('/api/schools/' + s.id, v) : await api.post('/api/schools', v);
      await UI.lookups(true); toast('School saved', 'ok');
      if (s) Router.handle(); else Router.go('/schools/' + saved.id);
    },
    extraFooter: s && App.can('edit') ? h('button', { class: 'btn danger left', onclick: () => UI.confirmDelete(`Delete ${s.name}?`, async () => { await api.del('/api/schools/' + s.id); App.state.lookups = null; toast('Deleted', 'ok'); Router.go('/schools'); }) }, 'Delete') : null,
  });
};

/* =========================================================
   COUNCILS
   ========================================================= */
App.views.councils = async function () {
  const rows = await api.get('/api/councils');
  return UI.listPage({
    deleteRecord: { resource: 'councils', label: r => r.name },
    title: 'Councils & customers', subtitle: `${rows.length} customers`,
    actions: App.can('edit') ? [h('button', { class: 'btn primary', onclick: () => Rec.councilEditor(null) }, '+ New council')] : null,
    columns: [
      { key: 'name', label: 'Name', value: r => h('a', { href: '#/councils/' + r.id }, h('strong', r.name)) },
      { key: 'contact_name', label: 'Contact' }, { key: 'phone', label: 'Telephone' }, { key: 'email', label: 'Email' },
      { key: 'contract_count', label: 'Active contracts', num: true },
    ],
    rows, searchFields: ['name', 'contact_name', 'email'], onRow: r => Router.go('/councils/' + r.id),
  });
};
App.views.councilDetail = async function ({ params }) {
  const c = await api.get('/api/councils/' + params.id);
  return h('div', null,
    UI.pageHead(c.name, c.contact_name ? 'Contact: ' + c.contact_name : '',
      [App.can('edit') ? h('button', { class: 'btn', onclick: () => Rec.councilEditor(c) }, 'Edit') : null,
       App.can('finance') ? h('a', { class: 'btn primary', href: `#/finance?council=${c.id}` }, 'Profitability') : null]),
    h('div', { class: 'grid cols-2' },
      UI.card('Details', h('div', null, UI.kv([
        ['Name', c.name], ['Contact', c.contact_name], ['Telephone', c.phone], ['Email', c.email], ['Address', c.address],
      ]), c.notes ? h('div', { class: 'note-box', style: 'margin-top:12px' }, c.notes) : null)),
      UI.cardTight('Contracts', UI.table([
        { key: 'code', label: 'Contract', value: r => h('a', { href: '#/contracts/' + r.id }, r.code) },
        { key: 'school_name', label: 'School' },
        { key: 'child_count', label: 'Children', num: true },
        ...(App.can('finance') ? [{ key: 'income_per_day', label: 'Income/day', num: true, value: r => fmt.money(r.income_per_day) }] : []),
        { key: 'status', label: 'Status', value: r => statusBadge(r.status) },
      ], c.contracts, { empty: 'No contracts' }))),
    App.can('audit') ? h('div', null, h('div', { style: 'height:14px' }), UI.cardTight('History', UI.historyPanel(c.history))) : null);
};
Rec.councilEditor = function (c) {
  UI.editor({
    title: c ? 'Edit ' + c.name : 'New council / customer', width: '',
    fields: [
      { name: 'name', label: 'Name', required: true, span: 'full' },
      { name: 'contact_name', label: 'Contact person' }, { name: 'phone', label: 'Telephone' },
      { name: 'email', label: 'Email', type: 'email' }, { name: 'address', label: 'Address', span: 'full' },
      { name: 'notes', label: 'Notes', type: 'textarea', span: 'full' },
    ],
    values: c || {},
    onSave: async v => {
      const saved = c ? await api.put('/api/councils/' + c.id, v) : await api.post('/api/councils', v);
      await UI.lookups(true); toast('Saved', 'ok');
      if (c) Router.handle(); else Router.go('/councils/' + saved.id);
    },
  });
};

/* =========================================================
   VEHICLES
   ========================================================= */
App.views.vehicles = async function () {
  const rows = await api.get('/api/vehicles');
  return UI.listPage({
    deleteRecord: { resource: 'vehicles', label: r => r.registration },
    title: 'Vehicles', subtitle: `${rows.filter(r => r.active).length} in service`,
    columns: [
      { key: 'registration', label: 'Registration', value: r => h('strong', r.registration) },
      { label: 'Vehicle', sortable: false, value: r => [r.make, r.model, r.colour].filter(Boolean).join(' ') || '—' },
      { key: 'driver_name', label: 'Driver', value: r => r.driver_id ? h('a', { href: '#/staff/' + r.driver_id }, r.driver_name) : h('span', { class: 'badge amber' }, 'Unassigned') },
      { key: 'seats', label: 'Seats', num: true },
      { key: 'wheelchair_accessible', label: 'Wheelchair accessible', value: r => r.wheelchair_accessible ? h('span', { class: 'badge green' }, 'Yes') : 'No' },
      { key: 'active', label: 'Status', value: r => r.active ? h('span', { class: 'badge green' }, 'In service') : h('span', { class: 'badge' }, 'Off road') },
      { label: '', sortable: false, value: r => App.can('edit') ? h('button', { class: 'btn xs', onclick: () => Rec.vehicleEditor(r, r.driver_id) }, 'Edit') : null },
    ],
    rows, searchFields: ['registration', 'make', 'model', 'driver_name'],
    onRow: r => r.driver_id ? Router.go('/staff/' + r.driver_id) : null,
  });
};
