/* views: dashboard, operations calendar, day view, exception quick-entry */
'use strict';
const Ops = window.Ops = {};

/* =========================================================
   DASHBOARD
   ========================================================= */
App.views.dashboard = async function () {
  const d = await api.get('/api/dashboard');
  App.state.alertCount = d.alerts.filter(a => a.level === 'red').length;
  App.refreshNavCounts(d);
  const wrap = h('div');

  wrap.appendChild(UI.pageHead(
    'Dashboard',
    fmt.dateLong(d.date) + ' · ' + (App.state.settings.company_name || 'Transport operations'),
    [h('a', { class: 'btn', href: '#/calendar' }, 'Open calendar'),
     h('a', { class: 'btn primary', href: '#/day/' + d.date }, "Today's journeys")]));

  // --- operational counts ---
  wrap.appendChild(h('div', { class: 'stats' },
    UI.stat({ label: 'Active contracts', value: d.counts.contracts, hint: `${d.today.operating} operating today`, href: '#/contracts?status=active' }),
    UI.stat({ label: 'Active children', value: d.counts.children, href: '#/children' }),
    UI.stat({ label: 'Drivers', value: d.counts.drivers, hint: `${d.counts.pool_drivers} in the pool`, href: '#/staff/list/driver' }),
    UI.stat({ label: 'Passenger assistants', value: d.counts.pas, hint: `${d.counts.pool_pas} in the pool`, href: '#/staff/list/pa' }),
    UI.stat({ label: 'Schools serviced', value: d.counts.schools, href: '#/schools' }),
    UI.stat({ label: 'Councils / customers', value: d.counts.councils, href: '#/councils' })));

  // --- today ---
  wrap.appendChild(h('div', { style: 'height:14px' }));
  wrap.appendChild(h('div', { class: 'stats' },
    UI.stat({ label: 'Contracts today', value: d.today.operating, hint: d.today.not_operating.length ? `${d.today.not_operating.length} not running` : 'All running', href: '#/day/' + d.date, tone: d.today.not_operating.length ? 'amber' : '' }),
    UI.stat({ label: 'Staff absences today', value: d.today.staff_absences.length, hint: d.today.covers.length ? `${d.today.covers.length} covered` : (d.today.staff_absences.length ? 'Cover needed' : 'None'), href: '#/day/' + d.date, tone: d.today.staff_absences.length > d.today.covers.length ? 'red' : (d.today.staff_absences.length ? 'amber' : '') }),
    UI.stat({ label: 'Cover staff in use', value: d.today.covers.length, hint: 'Today', href: '#/day/' + d.date, tone: d.today.covers.length ? 'amber' : '' }),
    UI.stat({ label: 'Child absences today', value: d.today.child_absences, href: '#/day/' + d.date }),
    UI.stat({ label: 'Contracts missing staff', value: d.gaps.no_driver.length + d.gaps.no_pa.length, hint: `${d.gaps.no_driver.length} no driver · ${d.gaps.no_pa.length} no PA`, href: '#/contracts?gap=1', tone: (d.gaps.no_driver.length + d.gaps.no_pa.length) ? 'red' : 'green' }),
    UI.stat({ label: 'Compliance problems', value: d.compliance.red, hint: `${d.compliance.amber} expiring soon · ${d.compliance.green} compliant`, href: '#/compliance', tone: d.compliance.red ? 'red' : (d.compliance.amber ? 'amber' : 'green') })));

  // --- finance ---
  if (d.finance) {
    wrap.appendChild(h('div', { style: 'height:14px' }));
    const f = d.finance;
    wrap.appendChild(h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', 'Expected financial position'),
        h('a', { class: 'btn sm', href: '#/finance' }, 'Full profitability')),
      h('div', { class: 'card-body' },
        h('div', { class: 'stats' },
          UI.stat({ label: 'Income today', value: fmt.money0(f.today.income), hint: `${f.today.contracts_operating} contracts operating`, href: '#/finance?from=' + d.date + '&to=' + d.date }),
          UI.stat({ label: 'Staff cost today', value: fmt.money0(f.today.driver_cost + f.today.pa_cost), hint: `Drivers ${fmt.money0(f.today.driver_cost)} · PAs ${fmt.money0(f.today.pa_cost)}`, href: '#/finance?from=' + d.date + '&to=' + d.date }),
          UI.stat({ label: 'Gross profit today', value: fmt.money0(f.today.gross_profit), hint: fmt.pct(f.today.margin) + ' margin', tone: f.today.gross_profit >= 0 ? 'green' : 'red', href: '#/finance?from=' + d.date + '&to=' + d.date }),
          UI.stat({ label: 'This week income', value: fmt.money0(f.week.income), hint: `Profit ${fmt.money0(f.week.gross_profit)} · ${fmt.pct(f.week.margin)}`, href: `#/finance?from=${f.week.from}&to=${f.week.to}` }),
          UI.stat({ label: 'This month income', value: fmt.money0(f.month.income), hint: `Profit ${fmt.money0(f.month.gross_profit)} · ${fmt.pct(f.month.margin)}`, href: `#/finance?from=${f.month.from}&to=${f.month.to}` }),
          UI.stat({ label: 'Month staff cost', value: fmt.money0(f.month.driver_cost + f.month.pa_cost), hint: 'Calculated from journeys actually operated', href: '#/wages' })))));
  }

  // --- alerts + today's operations side by side ---
  wrap.appendChild(h('div', { style: 'height:14px' }));
  const alertsCard = UI.cardTight(`Operational alerts (${d.alerts.length})`,
    d.alerts.length
      ? h('div', null, ...d.alerts.slice(0, 14).map(a => h('a', { class: 'alert-row', href: a.href },
          h('span', { class: 'dot ' + a.level, style: 'margin-top:5px' }),
          h('span', { class: 'cat' }, a.category),
          h('span', { style: 'flex:1' }, a.text))))
      : UI.empty('No alerts. Everything is in order.', '✅'));

  const todayCard = UI.cardTight(`Today's operations`,
    d.today.items.length ? h('div', { class: 'oplist' }, ...d.today.items.map(i => {
      const bad = !i.operated;
      const warn = i.summary.length > 0;
      return h('div', { class: 'oprow ' + (bad ? 'bad' : warn ? 'warn' : '') },
        h('div', { class: 'oc' }, h('a', { class: 'code', href: '#/contracts/' + i.contract_id }, i.code),
          h('div', { class: 'sch' }, plural(i.children, 'child', 'children'))),
        h('div', { class: 'ostaff' }, i.summary.length ? i.summary.join(' · ') : 'Running as normal'),
        h('div', { class: 'oacts' },
          App.can('calendar') ? h('button', { class: 'btn xs', onclick: () => Ops.dayDialog(i.contract_id, d.date, () => Router.handle()) }, 'Record exception') : null));
    })) : UI.empty('No contracts scheduled today', '📅'),
    h('a', { class: 'btn sm', href: '#/day/' + d.date }, 'Open day view'));

  wrap.appendChild(h('div', { class: 'grid cols-2' }, alertsCard, todayCard));

  // --- documents expiring ---
  if (d.compliance.expiring.length) {
    wrap.appendChild(h('div', { style: 'height:14px' }));
    wrap.appendChild(UI.cardTight(`Documents needing attention (${d.compliance.expiring.length})`,
      UI.table([
        { label: '', width: '26px', sortable: false, value: r => h('span', { class: 'dot ' + r.status }) },
        { key: 'entity_label', label: 'Record', value: r => h('a', { href: linkForDoc(r) }, r.entity_label || '—') },
        { key: 'entity_type', label: 'Type', value: r => fmt.titleCase(r.entity_type) },
        { key: 'doc_type', label: 'Document' },
        { key: 'expiry_date', label: 'Expiry', value: r => fmt.date(r.expiry_date), nowrap: true },
        { key: 'days_left', label: 'Days', num: true, value: r => r.days_left < 0 ? h('span', { style: 'color:var(--red);font-weight:700' }, `${-r.days_left} overdue`) : r.days_left },
      ], d.compliance.expiring, { sortKey: 'expiry_date' }),
      h('a', { class: 'btn sm', href: '#/compliance' }, 'Compliance centre')));
  }

  return wrap;
};
function linkForDoc(r) {
  const map = { staff: '#/staff/', child: '#/children/', contract: '#/contracts/', school: '#/schools/' };
  if (r.entity_type === 'vehicle') return r.vehicle_driver_id ? '#/staff/' + r.vehicle_driver_id : '#/vehicles';
  return (map[r.entity_type] || '#/') + r.entity_id;
}

/* =========================================================
   OPERATIONS CALENDAR
   ========================================================= */
App.views.calendar = async function ({ query }) {
  const today = D.today();
  let from = query.from || D.weekStart(today);
  let to = query.to || D.add(from, 6);
  const filter = { contract_id: query.contract || '', school_id: query.school || '', staff_id: query.staff || '' };
  const [data, lookups] = await Promise.all([
    api.get('/api/calendar', { from, to, contract_id: filter.contract_id, school_id: filter.school_id, staff_id: filter.staff_id }),
    UI.lookups(),
  ]);

  const setRange = (a, b) => Router.go(`/calendar?from=${a}&to=${b}` + qsFilters(filter));
  const qsFilters = f => Object.entries(f).filter(([, v]) => v).map(([k, v]) => `&${k === 'contract_id' ? 'contract' : k === 'school_id' ? 'school' : 'staff'}=${v}`).join('');

  const nav = h('div', { class: 'pill-row' },
    h('button', { class: 'btn sm', onclick: () => setRange(D.add(from, -7), D.add(to, -7)) }, '‹ Previous'),
    h('button', { class: 'btn sm', onclick: () => setRange(D.weekStart(today), D.add(D.weekStart(today), 6)) }, 'This week'),
    h('button', { class: 'btn sm', onclick: () => setRange(D.add(from, 7), D.add(to, 7)) }, 'Next ›'),
    h('span', { style: 'width:8px' }),
    h('div', { class: 'btn-group' },
      h('button', { class: 'btn sm' + (data.dates.length <= 7 ? ' on' : ''), onclick: () => setRange(D.weekStart(from), D.add(D.weekStart(from), 6)) }, 'Week'),
      h('button', { class: 'btn sm' + (data.dates.length > 7 && data.dates.length <= 16 ? ' on' : ''), onclick: () => setRange(D.weekStart(from), D.add(D.weekStart(from), 13)) }, 'Fortnight'),
      h('button', { class: 'btn sm' + (data.dates.length > 16 ? ' on' : ''), onclick: () => setRange(D.monthStart(from), D.monthEnd(from)) }, 'Month')));

  const filterBar = h('div', { class: 'filters' },
    h('div', { class: 'field' }, h('label', 'Contract'),
      h('select', { onchange: e => Router.go(`/calendar?from=${from}&to=${to}` + (e.target.value ? '&contract=' + e.target.value : '')) },
        h('option', { value: '' }, 'All contracts'),
        ...lookups.contracts.map(c => h('option', { value: c.id, selected: String(c.id) === String(filter.contract_id) }, c.code)))),
    h('div', { class: 'field' }, h('label', 'School'),
      h('select', { onchange: e => Router.go(`/calendar?from=${from}&to=${to}` + (e.target.value ? '&school=' + e.target.value : '')) },
        h('option', { value: '' }, 'All schools'),
        ...lookups.schools.map(s => h('option', { value: s.id, selected: String(s.id) === String(filter.school_id) }, s.name)))),
    h('div', { class: 'field' }, h('label', 'Staff member'),
      h('select', { onchange: e => Router.go(`/calendar?from=${from}&to=${to}` + (e.target.value ? '&staff=' + e.target.value : '')) },
        h('option', { value: '' }, 'All staff'),
        h('optgroup', { label: 'Drivers' }, ...lookups.drivers.map(s => h('option', { value: s.id, selected: String(s.id) === String(filter.staff_id) }, s.name))),
        h('optgroup', { label: 'PAs' }, ...lookups.pas.map(s => h('option', { value: s.id, selected: String(s.id) === String(filter.staff_id) }, s.name))))),
    h('div', { class: 'field' }, h('label', 'From'), h('input', { type: 'date', value: from, onchange: e => setRange(e.target.value, to) })),
    h('div', { class: 'field' }, h('label', 'To'), h('input', { type: 'date', value: to, onchange: e => setRange(from, e.target.value) })));

  const grid = Ops.calendarGrid(data, () => Router.handle());

  return h('div', null,
    UI.pageHead('Operations calendar',
      'Journeys are generated automatically from each contract. Record only what is different.',
      [nav]),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, filterBar),
      h('div', { class: 'card-body tight' }, h('div', { class: 'cal-wrap' }, grid)),
      h('div', { class: 'card-head', style: 'border-top:1px solid var(--border);border-bottom:0' },
        h('div', { class: 'legend' },
          h('span', null, h('span', { class: 'leg', style: 'display:inline-flex' }, 'Operated'), ' as scheduled'),
          h('span', null, h('span', { class: 'leg partial', style: 'display:inline-flex' }, 'Partial'), ' child absent'),
          h('span', null, h('span', { class: 'leg cover', style: 'display:inline-flex' }, 'Cover'), ' cover staff used'),
          h('span', null, h('span', { class: 'leg bad', style: 'display:inline-flex' }, 'Not run'), ' cancelled or uncovered'),
          h('span', { style: 'color:var(--text-faint)' }, '· Click any day to record an exception')))));
};

Ops.calendarGrid = function (data, onChange) {
  const today = D.today();
  const table = h('table', { class: 'cal' });
  const head = h('tr', h('th', { class: 'contract-col' }, 'Contract'));
  for (const dt of data.dates) {
    head.appendChild(h('th', { class: (D.isWeekend(dt) ? 'wknd ' : '') + (dt === today ? 'today' : '') },
      h('div', { class: 'dn' }, new Date(dt + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })),
      h('div', { class: 'dd' }, fmt.dateShort(dt))));
  }
  table.appendChild(h('thead', head));
  const body = h('tbody');
  for (const row of data.rows) {
    const c = row.contract;
    const tr = h('tr');
    tr.appendChild(h('td', { class: 'contract-col' },
      h('a', { class: 'cc', href: '#/contracts/' + c.id }, c.code),
      h('div', { class: 'cs' }, c.school_name || 'No school'),
      h('div', { class: 'cm' }, `${plural(row.children.length, 'child', 'children')} · ${c.driver_name || 'NO DRIVER'}${c.requires_pa ? ' / ' + (c.pa_name || 'NO PA') : ''}`)));
    for (const dt of data.dates) {
      const day = row.days[dt];
      if (!day) { tr.appendChild(h('td', { class: 'off' })); continue; }
      tr.appendChild(h('td', Ops.cell(day, c, dt, onChange)));
    }
    body.appendChild(tr);
  }
  if (!data.rows.length) body.appendChild(h('tr', h('td', { colspan: data.dates.length + 1 }, UI.empty('No contracts match these filters'))));
  table.appendChild(body);
  return table;
};

Ops.cell = function (day, contract, date, onChange) {
  const cell = h('div', { class: 'cell', title: 'Click to record an exception' });
  for (const leg of ['AM', 'PM']) {
    const L = day.legs[leg];
    let cls = 'leg', text = 'Operated';
    if (L.status !== 'operated') { cls += ' bad'; text = L.reason || 'Not operated'; }
    else if (L.driver.status === 'covered' || L.pa.status === 'covered') {
      cls += ' cover';
      const who = L.driver.status === 'covered' ? L.driver.cover_name : L.pa.cover_name;
      text = 'Cover: ' + (who || '').split(' ')[0];
    } else if (L.children_absent > 0) { cls += ' partial'; text = `${L.children_absent} absent`; }
    cell.appendChild(h('div', { class: cls }, h('span', { class: 'lt' }, leg), h('span', { class: 'lx' }, text)));
  }
  const notes = day.exceptions.filter(e => e.type === 'note');
  if (notes.length) cell.appendChild(h('div', { class: 'cellnote', title: notes.map(n => n.note).join('\n') }, '📝 ' + notes[0].note));
  cell.onclick = () => Ops.dayDialog(contract.id, date, onChange);
  return cell;
};

/* =========================================================
   DAY VIEW
   ========================================================= */
App.views.day = async function ({ params }) {
  const date = params.date;
  const data = await api.get('/api/day/' + date);
  const rows = data.items;
  const nav = h('div', { class: 'pill-row' },
    h('button', { class: 'btn sm', onclick: () => Router.go('/day/' + D.add(date, -1)) }, '‹ Previous day'),
    h('button', { class: 'btn sm', onclick: () => Router.go('/day/' + D.today()) }, 'Today'),
    h('button', { class: 'btn sm', onclick: () => Router.go('/day/' + D.add(date, 1)) }, 'Next day ›'),
    h('input', { type: 'date', value: date, style: 'padding:5px 8px;border:1px solid var(--border-strong);border-radius:6px', onchange: e => Router.go('/day/' + e.target.value) }));

  const list = h('div', { class: 'oplist' });
  for (const item of rows) {
    const bad = !item.operated;
    const warn = item.summary.length > 0;
    const c = data.contracts.find(x => x.id === item.contract_id);
    const driverInfo = legStaffText(item, 'driver');
    const paInfo = legStaffText(item, 'pa');
    list.appendChild(h('div', { class: 'oprow ' + (bad ? 'bad' : warn ? 'warn' : '') },
      h('div', { class: 'oc' },
        h('a', { class: 'code', href: '#/contracts/' + item.contract_id }, item.code),
        h('div', { class: 'sch' }, c ? c.school_name : '')),
      h('div', { class: 'ostaff' },
        h('div', null, h('strong', 'Driver: '), driverInfo),
        h('div', null, h('strong', 'PA: '), paInfo)),
      h('div', { style: 'min-width:150px' },
        h('div', { class: 'pill-row' },
          legBadge('AM', item.legs.AM), legBadge('PM', item.legs.PM)),
        item.summary.length ? h('div', { style: 'font-size:11.5px;color:var(--text-dim);margin-top:4px' }, item.summary.join(' · ')) : null),
      h('div', { style: 'min-width:140px;font-size:12.5px' },
        ...item.children.map(ch => h('div', null,
          h('span', { class: 'dot ' + (ch.AM === 'travelling' && ch.PM === 'travelling' ? 'green' : (ch.AM === 'absent' && ch.PM === 'absent' ? 'red' : 'amber')), style: 'margin-right:5px' }),
          h('a', { href: '#/children/' + ch.id }, ch.name)))),
      h('div', { class: 'oacts' },
        App.can('calendar') ? h('button', { class: 'btn sm primary', onclick: () => Ops.dayDialog(item.contract_id, date, () => Router.handle()) }, 'Record exception') : null)));
  }

  return h('div', null,
    UI.pageHead('Day view — ' + fmt.dateLong(date), `${rows.length} contracts scheduled`, [nav, h('a', { class: 'btn', href: '#/calendar' }, 'Calendar view')]),
    h('div', { class: 'card' }, h('div', { class: 'card-body tight' }, rows.length ? list : UI.empty('No contracts operate on this date', '📅'))));
};
function legBadge(leg, L) {
  let cls = 'green', text = 'Operated';
  if (L.status !== 'operated') { cls = 'red'; text = L.reason || 'Not run'; }
  else if (L.driver.status === 'covered' || L.pa.status === 'covered') { cls = 'purple'; text = 'Cover'; }
  else if (L.children_absent) { cls = 'amber'; text = `${L.children_absent} absent`; }
  return h('span', { class: 'badge ' + cls }, h('strong', leg), ' ', text);
}
function legStaffText(item, role) {
  const am = item.legs.AM[role], pm = item.legs.PM[role];
  const t = L => L.status === 'not_required' ? 'Not required' :
    L.status === 'covered' ? `${L.cover_name} (cover for ${L.normal_name || 'unassigned'})` :
    L.status === 'absent_no_cover' ? `${L.normal_name || 'unassigned'} — ABSENT, no cover` :
    (L.normal_name || 'NOT ASSIGNED');
  const a = t(am), b = t(pm);
  return a === b ? a : `AM ${a} / PM ${b}`;
}

/* =========================================================
   EXCEPTION QUICK-ENTRY DIALOG  (the core daily workflow)
   ========================================================= */
Ops.dayDialog = async function (contractId, date, onChange) {
  const loading = UI.modal({ title: 'Loading…', body: h('div', { class: 'loading' }, h('span', { class: 'spinner' })) });
  let data, lookups;
  try {
    [data, lookups] = await Promise.all([api.get('/api/calendar', { from: date, to: date, contract_id: contractId }), UI.lookups()]);
  } catch (e) { loading.close(); return toast(e.message, 'err'); }
  loading.close();
  const row = data.rows[0];
  if (!row) return toast('This contract does not operate on that date', 'err');
  const day = row.days[date];
  const c = row.contract;
  if (!day) return toast(`${c.code} does not operate on ${fmt.date(date)}`, 'err');

  let dirty = false;
  const body = h('div');
  const refresh = async () => {
    const fresh = await api.get('/api/calendar', { from: date, to: date, contract_id: contractId });
    const nd = fresh.rows[0].days[date];
    body.innerHTML = '';
    body.appendChild(render(nd));
  };
  const post = async payload => {
    try {
      await api.post('/api/exceptions', { contract_id: contractId, date, ...payload });
      dirty = true; toast('Recorded', 'ok'); await refresh();
    } catch (e) { toast(e.message, 'err'); }
  };
  const remove = async id => {
    try { const r = await api.del('/api/exceptions/' + id); dirty = true; toast('Exception removed' + (r.payment_reversed ? ' and immediate payment reversed' : ''), 'ok'); await refresh(); }
    catch (e) { toast(e.message, 'err'); }
  };

  function render(day) {
    const wrap = h('div');

    // current status
    wrap.appendChild(h('div', { class: 'pill-row', style: 'margin-bottom:12px' },
      legBadge('AM', day.legs.AM), legBadge('PM', day.legs.PM),
      h('span', { style: 'color:var(--text-dim);font-size:12.5px' }, `${c.school_name || 'No school'} · ${plural(day.children.length, 'child', 'children')}`)));

    // ---- children ----
    const childBox = h('fieldset', h('legend', 'Children — mark an absence'));
    if (!day.children.length) childBox.appendChild(h('div', { style: 'color:var(--text-faint)' }, 'No children assigned to this contract.'));
    for (const ch of day.children) {
      const exs = day.exceptions.filter(e => e.type === 'child_absence' && e.child_id === ch.id);
      childBox.appendChild(h('div', { class: 'oprow', style: 'padding:7px 0;border-bottom:1px solid var(--border)' },
        h('div', { style: 'flex:1;min-width:130px' },
          h('a', { href: '#/children/' + ch.id, target: '_blank' }, ch.name),
          exs.length ? h('div', { class: 'pill-row', style: 'margin-top:3px' }, ...exs.map(e =>
            h('span', { class: 'badge red' }, `Absent ${e.leg === 'DAY' ? 'all day' : e.leg}`,
              h('button', { class: 'x', style: 'font-size:14px;padding:0 3px', title: 'Undo', onclick: () => remove(e.id) }, '×')))) : null),
        h('div', { class: 'pill-row' },
          ...(exs.length ? [] : [
            h('button', { class: 'btn xs', onclick: () => post({ type: 'child_absence', leg: 'AM', child_id: ch.id }) }, 'Absent AM'),
            h('button', { class: 'btn xs', onclick: () => post({ type: 'child_absence', leg: 'PM', child_id: ch.id }) }, 'Absent PM'),
            h('button', { class: 'btn xs danger', onclick: () => post({ type: 'child_absence', leg: 'DAY', child_id: ch.id }) }, 'Absent all day')]))));
    }
    wrap.appendChild(childBox);

    // ---- staff ----
    for (const role of ['driver', 'pa']) {
      const L = day.legs.AM[role];
      if (L.status === 'not_required') continue;
      const normalName = L.normal_name || 'Not assigned';
      const exs = day.exceptions.filter(e => e.type === 'staff_absence' && e.role === role);
      const box = h('fieldset', h('legend', role === 'driver' ? 'Driver' : 'Passenger assistant'));
      box.appendChild(h('div', { style: 'margin-bottom:8px' },
        h('strong', normalName),
        h('span', { style: 'color:var(--text-faint);font-size:12px;margin-left:8px' },
          role === 'driver' ? fmt.money(c.driver_pay_per_day) + '/day' : fmt.money(c.pa_pay_per_day) + '/day')));
      if (exs.length) {
        for (const e of exs) {
          box.appendChild(h('div', { class: 'note-box ' + (e.cover_staff_id ? 'warn' : 'danger'), style: 'margin-bottom:8px' },
            h('div', null,
              h('strong', e.leg === 'DAY' ? 'Absent all day' : `Absent ${e.leg}`), ' — ',
              e.cover_staff_id ? h('span', null, 'covered by ', h('strong', e.cover_name), ' at ', h('strong', fmt.money(e.cover_pay)),
                e.paid_immediately ? h('span', { class: 'badge green', style: 'margin-left:6px' }, 'Paid immediately') : h('span', { class: 'badge', style: 'margin-left:6px' }, 'Pay via payroll'))
                : h('strong', { style: 'color:var(--red)' }, 'NO COVER ASSIGNED')),
            e.note ? h('div', { style: 'font-size:12px;margin-top:3px' }, e.note) : null,
            h('div', { class: 'pill-row', style: 'margin-top:6px' },
              !e.cover_staff_id ? h('button', { class: 'btn xs primary', onclick: () => Ops.coverDialog(c, date, role, e, refresh, () => dirty = true) }, 'Assign cover') : null,
              h('button', { class: 'btn xs', onclick: () => remove(e.id) }, 'Undo absence'))));
        }
      } else {
        box.appendChild(h('div', { class: 'pill-row' },
          h('button', { class: 'btn xs', onclick: () => Ops.absenceDialog(c, date, role, 'AM', refresh, () => dirty = true) }, 'Absent AM'),
          h('button', { class: 'btn xs', onclick: () => Ops.absenceDialog(c, date, role, 'PM', refresh, () => dirty = true) }, 'Absent PM'),
          h('button', { class: 'btn xs danger', onclick: () => Ops.absenceDialog(c, date, role, 'DAY', refresh, () => dirty = true) }, 'Absent all day')));
      }
      wrap.appendChild(box);
    }

    // ---- journey level ----
    const jbox = h('fieldset', h('legend', 'Journey and contract'));
    const cancels = day.exceptions.filter(e => ['school_closed', 'contract_cancelled', 'journey_cancelled'].includes(e.type));
    if (cancels.length) {
      jbox.appendChild(h('div', { class: 'pill-row' }, ...cancels.map(e =>
        h('span', { class: 'badge red' }, `${fmt.titleCase(e.type)} ${e.leg === 'DAY' ? '(all day)' : '(' + e.leg + ')'}`,
          e.contract_id ? h('button', { class: 'x', style: 'font-size:14px;padding:0 3px', onclick: () => remove(e.id) }, '×')
            : h('span', { style: 'font-size:10px;margin-left:5px' }, '(school-wide)')))));
    }
    jbox.appendChild(h('div', { class: 'pill-row', style: 'margin-top:8px' },
      h('button', { class: 'btn xs', onclick: () => post({ type: 'journey_cancelled', leg: 'AM' }) }, 'AM journey cancelled'),
      h('button', { class: 'btn xs', onclick: () => post({ type: 'journey_cancelled', leg: 'PM' }) }, 'PM journey cancelled'),
      h('button', { class: 'btn xs', onclick: () => post({ type: 'contract_cancelled', leg: 'DAY' }) }, 'Contract not operating'),
      h('button', { class: 'btn xs', onclick: () => Ops.schoolClosureDialog(c, date, refresh, () => dirty = true) }, 'School closed'),
      h('button', { class: 'btn xs', onclick: () => Ops.noteDialog(c, date, refresh, () => dirty = true) }, 'Add note'),
      App.can('finance') ? h('button', { class: 'btn xs', onclick: () => Ops.payOverrideDialog(c, date, refresh, () => dirty = true) }, 'Pay override') : null));
    wrap.appendChild(jbox);

    // ---- everything recorded on this day ----
    if (day.exceptions.length) {
      wrap.appendChild(h('fieldset', h('legend', 'All exceptions recorded for this day'),
        UI.table([
          { key: 'type', label: 'Type', value: e => fmt.titleCase(e.type) },
          { key: 'leg', label: 'Leg' },
          { label: 'Detail', sortable: false, value: e => [e.child_name, e.staff_name, e.cover_name ? '→ ' + e.cover_name : null, e.cover_pay != null ? fmt.money(e.cover_pay) : null, e.note].filter(Boolean).join(' · ') || '—' },
          { key: 'created_by', label: 'Recorded by' },
          { label: '', sortable: false, value: e => h('button', { class: 'btn xs danger', onclick: () => remove(e.id) }, 'Remove') },
        ], day.exceptions)));
    }
    return wrap;
  }

  body.appendChild(render(day));
  const m = UI.modal({
    title: `${c.code} — ${fmt.dateLong(date)}`,
    body, width: 'wide',
    footer: [h('a', { class: 'btn left', href: '#/contracts/' + c.id, onclick: () => m.close() }, 'Open contract'),
      h('button', { class: 'btn primary', onclick: () => m.close() }, 'Done')],
    onClose: () => { if (dirty && onChange) onChange(); },
  });
};

/* absence + cover in a single step */
Ops.absenceDialog = function (contract, date, role, leg, refresh, markDirty) {
  const lookups = App.state.lookups;
  const pool = role === 'driver' ? lookups.drivers : lookups.pas;
  const normalId = role === 'driver' ? contract.driver_id : contract.pa_id;
  const baseRate = role === 'driver' ? contract.driver_pay_per_day : contract.pa_pay_per_day;
  const suggested = Math.round((leg === 'DAY' ? baseRate : baseRate / 2) * 100) / 100;

  const form = UI.form([
    { name: 'cover_staff_id', label: 'Cover staff member', type: 'select', placeholder: '— no cover, journey will not run —', options: pool.filter(p => p.id !== normalId).map(p => ({ value: p.id, label: `${p.name}${p.status === 'pool' ? ' (pool)' : ''}` })) },
    { name: 'cover_pay', label: 'Cover pay (£)', type: 'number', step: '0.01', value: suggested, help: 'Override the normal rate if the cover staff member is paid differently.' },
    { name: 'paid_immediately', label: 'Paid immediately (cash/bank today) — exclude from the next payroll', type: 'checkbox', span: 'full' },
    { name: 'note', label: 'Reason / note', span: 'full', placeholder: 'e.g. Sickness, annual leave, hospital appointment' },
  ], {});

  const finder = h('button', { class: 'btn sm', onclick: () => Ops.findCover(contract, date, role, leg, id => { form.controls.cover_staff_id.value = id; }) }, '🔍 Find available staff near this route');

  const saveBtn = h('button', { class: 'btn primary' }, 'Record absence');
  const dlg = UI.modal({
    title: `${role === 'driver' ? 'Driver' : 'PA'} absent — ${contract.code}`,
    body: h('div', null,
      h('div', { class: 'note-box', style: 'margin-bottom:12px' },
        h('strong', leg === 'DAY' ? 'Absent all day' : `Absent ${leg} only`), ' on ', h('strong', fmt.dateLong(date)), '. ',
        `The normal ${role === 'driver' ? 'driver' : 'PA'} will not be paid for this journey.`),
      h('div', { style: 'margin-bottom:10px' }, finder),
      form),
    footer: [h('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'), saveBtn],
  });
  saveBtn.onclick = async () => {
    const v = form.read();
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    try {
      await api.post('/api/exceptions', {
        contract_id: contract.id, date, type: 'staff_absence', leg, role,
        cover_staff_id: v.cover_staff_id || null,
        cover_pay: v.cover_staff_id ? v.cover_pay : null,
        paid_immediately: v.cover_staff_id ? v.paid_immediately : 0,
        note: v.note,
      });
      markDirty(); toast('Absence recorded', 'ok'); dlg.close(); refresh();
    } catch (e) { toast(e.message, 'err'); saveBtn.disabled = false; saveBtn.textContent = 'Record absence'; }
  };
};

/* attach cover to an existing uncovered absence */
Ops.coverDialog = function (contract, date, role, exception, refresh, markDirty) {
  const lookups = App.state.lookups;
  const pool = role === 'driver' ? lookups.drivers : lookups.pas;
  const baseRate = role === 'driver' ? contract.driver_pay_per_day : contract.pa_pay_per_day;
  const suggested = Math.round((exception.leg === 'DAY' ? baseRate : baseRate / 2) * 100) / 100;
  const form = UI.form([
    { name: 'cover_staff_id', label: 'Cover staff member', type: 'select', required: true, options: pool.map(p => ({ value: p.id, label: `${p.name}${p.status === 'pool' ? ' (pool)' : ''}` })) },
    { name: 'cover_pay', label: 'Cover pay (£)', type: 'number', step: '0.01', value: suggested },
    { name: 'paid_immediately', label: 'Paid immediately — exclude from the next payroll', type: 'checkbox', span: 'full' },
    { name: 'note', label: 'Note', span: 'full', value: exception.note || '' },
  ], {});
  const saveBtn = h('button', { class: 'btn primary' }, 'Assign cover');
  const dlg = UI.modal({
    title: 'Assign cover — ' + contract.code,
    body: h('div', null,
      h('div', { style: 'margin-bottom:10px' }, h('button', { class: 'btn sm', onclick: () => Ops.findCover(contract, date, role, exception.leg, id => { form.controls.cover_staff_id.value = id; }) }, '🔍 Find available staff near this route')),
      form),
    footer: [h('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'), saveBtn],
  });
  saveBtn.onclick = async () => {
    if (!form.validate()) return;
    const v = form.read();
    saveBtn.disabled = true;
    try {
      await api.del('/api/exceptions/' + exception.id);
      await api.post('/api/exceptions', { contract_id: contract.id, date, type: 'staff_absence', leg: exception.leg, role, cover_staff_id: v.cover_staff_id, cover_pay: v.cover_pay, paid_immediately: v.paid_immediately, note: v.note });
      markDirty(); toast('Cover assigned', 'ok'); dlg.close(); refresh();
    } catch (e) { toast(e.message, 'err'); saveBtn.disabled = false; }
  };
};

/* proximity + compliance aware cover finder */
Ops.findCover = async function (contract, date, role, leg, onPick) {
  const dlg = UI.modal({ title: 'Finding available staff…', body: h('div', { class: 'loading' }, h('span', { class: 'spinner' })), width: 'wide' });
  try {
    const q = { type: role, postcode: contract.school_postcode || '', date, leg, include_assigned: '1' };
    const data = await api.get('/api/pool', q);
    dlg.modal.querySelector('.modal-head h2').textContent = `Available ${role === 'driver' ? 'drivers' : 'PAs'} near ${contract.school_name || 'this route'}`;
    const bodyEl = dlg.modal.querySelector('.modal-body');
    bodyEl.innerHTML = '';
    bodyEl.appendChild(UI.table([
      { key: 'name', label: 'Name', value: s => h('div', null, h('strong', s.name), h('div', { style: 'font-size:11.5px;color:var(--text-dim)' }, s.phone || '')) },
      { key: 'status', label: 'Type', value: s => h('span', { class: 'badge ' + (s.status === 'pool' ? 'blue' : '') }, s.status === 'pool' ? 'Staff pool' : 'Assigned') },
      { key: 'postcode', label: 'Postcode' },
      { key: 'proximity_score', label: 'Proximity', value: s => s.proximity || '—' },
      { key: 'compliance', label: 'Compliance', value: s => rag(s.compliance) },
      { key: 'busy', label: 'Availability', value: s => s.busy ? h('span', { class: 'badge amber' }, s.busy) : h('span', { class: 'badge green' }, 'Free') },
      ...(role === 'driver' ? [{ key: 'vehicle_summary', label: 'Vehicle', value: s => s.vehicle_summary || 'None recorded' }] : []),
      { label: '', sortable: false, value: s => h('button', { class: 'btn xs primary', onclick: () => { onPick(s.id); dlg.close(); toast(`${s.name} selected`, 'ok'); } }, 'Select') },
    ], data.staff, { empty: 'No staff match', sortKey: 'proximity_score', sortDir: -1 }));
    bodyEl.appendChild(h('div', { style: 'margin-top:10px;font-size:12px;color:var(--text-faint)' },
      'Proximity compares home postcode with the school postcode. Availability checks other contracts and cover already booked for this date.'));
  } catch (e) { dlg.close(); toast(e.message, 'err'); }
};

Ops.schoolClosureDialog = function (contract, date, refresh, markDirty) {
  const form = UI.form([
    { name: 'scope', label: 'Applies to', type: 'select', placeholder: false, options: [{ value: 'school', label: `The whole school (${contract.school_name}) — every contract` }, { value: 'contract', label: `This contract only (${contract.code})` }] },
    { name: 'leg', label: 'Which journeys', type: 'select', placeholder: false, options: [{ value: 'DAY', label: 'All day' }, { value: 'AM', label: 'AM only' }, { value: 'PM', label: 'PM only' }] },
    { name: 'note', label: 'Reason', span: 'full', value: 'School closed' },
    { name: 'repeat_days', label: 'Repeat for this many consecutive days', type: 'number', min: 1, max: 30, value: 1, help: 'Use for half-terms and holidays.' },
  ], {});
  const saveBtn = h('button', { class: 'btn primary' }, 'Record closure');
  const dlg = UI.modal({ title: 'School closed — ' + fmt.date(date), body: form, footer: [h('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'), saveBtn] });
  saveBtn.onclick = async () => {
    const v = form.read();
    const dates = []; for (let i = 0; i < Math.max(1, v.repeat_days || 1); i++) dates.push(D.add(date, i));
    saveBtn.disabled = true;
    try {
      await api.post('/api/exceptions', {
        dates, type: 'school_closed', leg: v.leg, note: v.note,
        school_id: v.scope === 'school' ? contract.school_id : null,
        contract_id: v.scope === 'school' ? null : contract.id,
      });
      markDirty(); toast(`Closure recorded for ${dates.length} day(s)`, 'ok'); dlg.close(); refresh();
    } catch (e) { toast(e.message, 'err'); saveBtn.disabled = false; }
  };
};

Ops.noteDialog = function (contract, date, refresh, markDirty) {
  const form = UI.form([
    { name: 'leg', label: 'Applies to', type: 'select', placeholder: false, options: [{ value: 'DAY', label: 'Whole day' }, { value: 'AM', label: 'AM' }, { value: 'PM', label: 'PM' }] },
    { name: 'note', label: 'Note', type: 'textarea', span: 'full', required: true, rows: 3 },
  ], {});
  const saveBtn = h('button', { class: 'btn primary' }, 'Save note');
  const dlg = UI.modal({ title: 'Add note — ' + contract.code + ' ' + fmt.date(date), body: form, footer: [h('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'), saveBtn] });
  saveBtn.onclick = async () => {
    if (!form.validate()) return;
    const v = form.read();
    try { await api.post('/api/exceptions', { contract_id: contract.id, date, type: 'note', leg: v.leg, note: v.note }); markDirty(); toast('Note saved', 'ok'); dlg.close(); refresh(); }
    catch (e) { toast(e.message, 'err'); }
  };
};

Ops.payOverrideDialog = function (contract, date, refresh, markDirty) {
  const form = UI.form([
    { name: 'role', label: 'Who', type: 'select', placeholder: false, options: [{ value: 'driver', label: `Driver (${contract.driver_name || 'unassigned'})` }, { value: 'pa', label: `PA (${contract.pa_name || 'unassigned'})` }] },
    { name: 'leg', label: 'Applies to', type: 'select', placeholder: false, options: [{ value: 'DAY', label: 'Whole day' }, { value: 'AM', label: 'AM' }, { value: 'PM', label: 'PM' }] },
    { name: 'amount', label: 'Day rate for this date (£)', type: 'number', step: '0.01', required: true, help: 'Replaces the contract rate for this date only.' },
    { name: 'note', label: 'Reason', span: 'full', placeholder: 'e.g. Extra run, long diversion, bank holiday rate' },
  ], {});
  const saveBtn = h('button', { class: 'btn primary' }, 'Save override');
  const dlg = UI.modal({ title: 'Pay override — ' + contract.code + ' ' + fmt.date(date), body: form, footer: [h('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'), saveBtn] });
  saveBtn.onclick = async () => {
    if (!form.validate()) return;
    const v = form.read();
    try { await api.post('/api/exceptions', { contract_id: contract.id, date, type: 'pay_override', ...v }); markDirty(); toast('Override saved', 'ok'); dlg.close(); refresh(); }
    catch (e) { toast(e.message, 'err'); }
  };
};
