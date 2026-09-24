/* views: dashboard, operations calendar, day view, exception quick-entry */
'use strict';
const Ops = window.Ops = {};

/* =========================================================
   DASHBOARD
   ========================================================= */
App.views.dashboard = async function () {
  const d = await api.get('/api/dashboard');
  const coverNeeded = d.today.staff_absences.filter(absence => absence.needs_cover && !absence.cover_name).length;
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
    UI.stat({ label: 'Journeys today', value: d.today.journeys, hint: d.today.journeys === d.today.journeys_operating ? 'All running' : `${d.today.journeys_operating} running`, href: '#/day/' + d.date, tone: d.today.journeys > d.today.journeys_operating ? 'amber' : '' }),
    UI.stat({ label: 'Runs cancelled today', value: d.today.cancellations.count, hint: 'Council income retained', href: '#/day/' + d.date, tone: d.today.cancellations.count ? 'amber' : '' }),
    UI.stat({ label: 'Staff absences today', value: d.today.staff_absences.length, hint: coverNeeded ? `${coverNeeded} need cover` : d.today.covers.length ? `${d.today.covers.length} covered` : (d.today.staff_absences.length ? 'Runs cancelled; no cover needed' : 'None'), href: '#/day/' + d.date, tone: coverNeeded ? 'red' : (d.today.staff_absences.length ? 'amber' : '') }),
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

  wrap.appendChild(h('div', { style: 'height:14px' }));
  wrap.appendChild(UI.cardTight(`Runs cancelled today (${d.today.cancellations.count})`,
    d.today.cancelled_runs.length ? h('div', null,
      d.finance ? h('div', { class: 'stats', style: 'padding:14px' },
        UI.stat({ label: 'Council income retained', value: fmt.money(d.today.cancellations.council_income) }),
        UI.stat({ label: 'Driver pay saved', value: fmt.money(d.today.cancellations.driver_pay_saved), tone: 'green' })) : null,
      UI.table([
        { key: 'code', label: 'Contract', value: run => h('a', { href: '#/contracts/' + run.contract_id }, run.code) },
        { key: 'label', label: 'Run' },
        { key: 'driver_name', label: 'Driver' },
        { key: 'reason', label: 'Reason' },
        ...(d.finance ? [{ key: 'council_income', label: 'Council income', value: run => fmt.money(run.council_income) },
          { key: 'driver_pay_saved', label: 'Driver pay saved', value: run => fmt.money(run.driver_pay_saved) }] : []),
        { label: '', sortable: false, value: run => h('button', { class: 'btn xs', onclick: () => Ops.dayDialog(run.contract_id, d.date, () => Router.handle()) }, 'Manage run') },
      ], d.today.cancelled_runs)) : UI.empty('No runs cancelled today.')));

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
          h('div', { class: 'sch' }, `${plural(i.children_scheduled, 'child', 'children')} · ${plural(i.planned_trips, 'journey')}`)),
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

/* ---------- journeys ----------
   A day is a list of journeys, not a fixed AM and PM pair. Days that run one
   out and one back still read as AM and PM, because that is what they are;
   a Friday with three journeys names them instead. */
function regularTrips(day) { return day.trips.filter(t => t.source !== 'extra'); }
function isSimpleDay(day) { return regularTrips(day).length <= 2; }

/** Short label for a tight space: AM, PM, T3, EXTRA. */
function tripShort(day, t) {
  if (t.source === 'extra') return 'EXTRA';
  if (isSimpleDay(day)) return t.kind === 'outbound' ? 'AM' : 'PM';
  return 'T' + t.seq;
}
/** Full label for a sentence: AM, PM, Trip 3, Extra journey. */
function tripFull(day, t) {
  if (t.source === 'extra') return 'Extra journey';
  if (isSimpleDay(day)) return t.kind === 'outbound' ? 'AM' : 'PM';
  return 'Trip ' + t.seq;
}
/** How an exception should name this journey. */
function tripScope(day, t) {
  if (t.source !== 'extra' && isSimpleDay(day)) {
    return { leg: t.kind === 'outbound' ? 'AM' : 'PM', label: `${tripFull(day, t)} only` };
  }
  return { leg: 'DAY', trip_seq: t.seq, trip_label: t.label, label: `${t.label} only` };
}
/** Which journeys a scope covers — the same rule the server uses. */
function scopeTrips(day, scope) {
  return day.trips.filter(t => {
    if (scope.trip_seq !== null && scope.trip_seq !== undefined) return t.seq === scope.trip_seq;
    if (scope.leg === 'DAY') return true;
    if (scope.leg === 'AM') return t.kind === 'outbound';
    if (scope.leg === 'PM') return t.kind === 'return';
    return false;
  });
}
const ALL_DAY = { leg: 'DAY', label: 'All day' };
window.tripShort = tripShort;

/**
 * Every way of naming part of a day, for the pickers.
 * `only` narrows it to a subset of journeys, so a child is never offered a
 * journey they do not travel on.
 */
function scopeChoices(day, { includeDay = true, only = null } = {}) {
  const out = includeDay ? [{ ...ALL_DAY }] : [];
  for (const t of (only || day.trips)) out.push(tripScope(day, t));
  return out;
}

/** A select of journeys plus a button, for days with more than two. */
function scopePicker(day, buttonLabel, onChoose, { includeDay = true, only = null, cls = 'btn xs' } = {}) {
  const choices = scopeChoices(day, { includeDay, only });
  const sel = h('select', { style: 'padding:3px 5px;font-size:11.5px;max-width:190px' },
    ...choices.map((c, i) => h('option', { value: i }, c.label)));
  const btn = h('button', { class: cls, onclick: () => onChoose(choices[Number(sel.value)]) }, buttonLabel);
  return h('span', { class: 'pill-row', style: 'gap:4px' }, sel, btn);
}

Ops.cell = function (day, contract, date, onChange) {
  const cell = h('div', { class: 'cell' + (day.trips.length > 2 ? ' many' : ''), title: 'Click to record an exception' });
  for (const t of day.trips) {
    let cls = 'leg', text = 'Operated';
    if (t.status !== 'operated') { cls += ' bad'; text = t.reason || 'Not operated'; }
    else if (t.driver.status === 'covered' || t.pa.status === 'covered') {
      cls += ' cover';
      const who = t.driver.status === 'covered' ? t.driver.cover_name : t.pa.cover_name;
      text = 'Cover: ' + (who || '').split(' ')[0];
    } else if (t.children_absent > 0) { cls += ' partial'; text = `${t.children_absent} absent`; }
    else if (t.source === 'extra') { cls += ' cover'; text = t.label; }
    cell.appendChild(h('div', { class: cls, title: `${t.label}${t.depart_time ? ' · departs ' + fmt.time(t.depart_time) : ''}` },
      h('span', { class: 'lt' }, tripShort(day, t)), h('span', { class: 'lx' }, text)));
  }
  const off = day.children.filter(c => !c.scheduled).length;
  if (off && day.trips.length) {
    cell.appendChild(h('div', { class: 'cellnote', title: day.children.filter(c => !c.scheduled).map(c => c.name + ' — normal day off').join('\n') },
      `🏠 ${off} off`));
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
  const journeys = rows.reduce((a, i) => a + i.trips.length, 0);
  for (const item of rows) {
    const bad = !item.operated;
    const warn = item.summary.length > 0;
    const c = data.contracts.find(x => x.id === item.contract_id);
    list.appendChild(h('div', { class: 'oprow ' + (bad ? 'bad' : warn ? 'warn' : '') },
      h('div', { class: 'oc' },
        h('a', { class: 'code', href: '#/contracts/' + item.contract_id }, item.code),
        h('div', { class: 'sch' }, c ? c.school_name : '')),
      h('div', { class: 'ostaff' },
        h('div', null, h('strong', 'Driver: '), staffText(item, 'driver')),
        h('div', null, h('strong', 'PA: '), staffText(item, 'pa'))),
      h('div', { style: 'min-width:170px' },
        h('div', { class: 'pill-row' }, ...item.trips.map(t => tripBadge(item, t))),
        item.summary.length ? h('div', { style: 'font-size:11.5px;color:var(--text-dim);margin-top:4px' }, item.summary.join(' · ')) : null),
      h('div', { style: 'min-width:150px;font-size:12.5px' },
        ...item.children.map(ch => h('div', { title: childDayText(item, ch) },
          h('span', { class: 'dot ' + childDot(item, ch), style: 'margin-right:5px' }),
          h('a', { href: '#/children/' + ch.id }, ch.name),
          ch.scheduled ? null : h('span', { style: 'color:var(--text-faint);font-size:11px' }, ' · day off')))),
      h('div', { class: 'oacts' },
        App.can('calendar') ? h('button', { class: 'btn sm primary', onclick: () => Ops.dayDialog(item.contract_id, date, () => Router.handle()) }, 'Record exception') : null)));
  }

  return h('div', null,
    UI.pageHead('Day view — ' + fmt.dateLong(date),
      `${plural(rows.length, 'contract')} · ${plural(journeys, 'journey')} scheduled`,
      [nav, h('a', { class: 'btn', href: '#/calendar' }, 'Calendar view')]),
    h('div', { class: 'card' }, h('div', { class: 'card-body tight' }, rows.length ? list : UI.empty('No contracts operate on this date', '📅'))));
};

function tripBadge(day, t) {
  let cls = 'green', text = 'Operated';
  if (t.status !== 'operated') { cls = 'red'; text = t.reason || 'Not run'; }
  else if (t.driver.status === 'covered' || t.pa.status === 'covered') { cls = 'purple'; text = 'Cover'; }
  else if (t.children_absent) { cls = 'amber'; text = `${t.children_absent} absent`; }
  else if (t.source === 'extra') { cls = 'blue'; text = 'Extra'; }
  return h('span', { class: 'badge ' + cls, title: `${t.label}${t.depart_time ? ' · departs ' + fmt.time(t.depart_time) : ''}` },
    h('strong', tripShort(day, t)), ' ', text);
}
/** One line for a role across the whole day, only naming journeys when they differ. */
function staffText(day, role) {
  const describe = L => L.status === 'not_required' ? 'Not required'
    : L.status === 'covered' ? `${L.cover_name} (cover for ${L.normal_name || 'unassigned'})`
      : L.status === 'absent_no_cover' ? `${L.normal_name || 'unassigned'} — ABSENT, no cover`
        : (L.normal_name || 'NOT ASSIGNED');
  if (!day.trips.length) return '—';
  const parts = day.trips.map(t => [tripShort(day, t), describe(t[role])]);
  const first = parts[0][1];
  if (parts.every(p => p[1] === first)) return first;
  return parts.map(([n, txt]) => `${n} ${txt}`).join(' / ');
}
function childDot(day, ch) {
  if (!ch.scheduled) return 'grey';
  const states = Object.values(ch.trips);
  if (!states.length) return 'grey';
  if (states.every(s => s === 'travelling')) return 'green';
  if (states.every(s => s === 'absent')) return 'red';
  return 'amber';
}
function childDayText(day, ch) {
  if (!ch.scheduled) return `${ch.name} — normal day off, not an absence`;
  return day.trips.map(t => `${t.label}: ${ch.trips[t.seq] || 'not on this journey'}`).join('\n');
}

/* =========================================================
   EXCEPTION QUICK-ENTRY DIALOG  (the core daily workflow)
   ========================================================= */
Ops.dayDialog = async function (contractId, date, onChange) {
  const loading = UI.modal({ title: 'Loading…', body: h('div', { class: 'loading' }, h('span', { class: 'spinner' })) });
  let day, c;
  try {
    const [res] = await Promise.all([api.get(`/api/contracts/${contractId}/day/${date}`), UI.lookups()]);
    day = res; c = res.contract;
  } catch (e) { loading.close(); return toast(e.message, 'err'); }
  loading.close();
  if (!day.trips.length) return toast(`${c.code} does not operate on ${fmt.date(date)}`, 'err');

  let dirty = false;
  const body = h('div');
  const refresh = async () => {
    const fresh = await api.get(`/api/contracts/${contractId}/day/${date}`);
    body.innerHTML = '';
    body.appendChild(render(fresh));
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
  const markDirty = () => { dirty = true; };

  function render(day) {
    const wrap = h('div');
    const simple = isSimpleDay(day);

    // ---- what is meant to run today ----
    const jbox = h('fieldset', h('legend', `Journeys on this date — ${plural(day.planned_trips, 'planned journey')}`));
    for (const t of day.trips) {
      const cancelled = day.exceptions.find(e =>
        ['journey_cancelled', 'journey_removed', 'contract_cancelled', 'school_closed'].includes(e.type) && scopeTrips(day, e).some(x => x.seq === t.seq));
      jbox.appendChild(h('div', { class: 'trip-head' },
        h('div', { class: 'th-num' }, t.seq),
        h('div', { class: 'th-name' }, t.label,
          t.source === 'extra' ? h('span', { class: 'badge blue', style: 'margin-left:6px' }, 'One-off extra') : null),
        h('div', { class: 'th-time' }, t.depart_time ? fmt.time(t.depart_time) : ''),
        tripBadge(day, t),
        h('span', { style: 'font-size:11.5px;color:var(--text-dim)' },
          `${plural(t.children_travelling, 'child', 'children')} travelling`,
          t.children_not_scheduled ? ` · ${t.children_not_scheduled} not on this journey` : ''),
        h('span', { class: 'th-space' }),
        h('div', { class: 'pill-row' },
          (cancelled && cancelled.contract_id
            ? h('button', { class: 'btn xs', onclick: () => remove(cancelled.id) }, 'Undo cancellation')
            : (cancelled ? null : h('button', { class: 'btn xs danger', onclick: () => Ops.cancelRunDialog(c, date, day, tripScope(day, t), refresh, markDirty) }, 'Run cancelled'))),
          (cancelled || t.source === 'extra') ? null : h('button', { class: 'btn xs', title: 'The run was not needed: not billed to the council and not paid', onclick: () => Ops.removeRunDialog(c, date, day, tripScope(day, t), refresh, markDirty) }, 'Taken off'),
          t.source === 'extra' ? h('button', { class: 'btn xs', onclick: () => remove(t.exception_id) }, 'Remove extra journey') : null)));
    }
    jbox.appendChild(h('div', { class: 'pill-row', style: 'margin-top:9px' },
      h('button', { class: 'btn xs', onclick: () => Ops.extraJourneyDialog(c, date, refresh, markDirty) }, '+ Extra journey this date only'),
      App.can('edit') ? h('button', { class: 'btn xs', onclick: () => { m.close(); Sched.weekEditor(c, () => Router.handle()); } }, 'Change the weekly schedule') : null));
    wrap.appendChild(jbox);

    // ---- children ----
    const childBox = h('fieldset', h('legend', 'Children — mark an absence'));
    if (!day.children.length) childBox.appendChild(h('div', { style: 'color:var(--text-faint)' }, 'No children assigned to this contract.'));
    for (const ch of day.children) {
      const exs = day.exceptions.filter(e => e.type === 'child_absence' && e.child_id === ch.id);
      const permanent = () => {
        m.close();
        Sched.timetableEditor({ id: ch.id, name: ch.name }, () => Router.handle(), { date, weekday: day.weekday });
      };
      if (!ch.scheduled) {
        childBox.appendChild(h('div', { class: 'oprow', style: 'padding:7px 0;border-bottom:1px solid var(--border);opacity:.75' },
          h('div', { style: 'flex:1;min-width:130px' },
            h('a', { href: '#/children/' + ch.id, target: '_blank' }, ch.name),
            h('div', { style: 'font-size:11.5px;color:var(--text-faint)' }, 'Normal day off — not travelling today, and not an absence')),
          h('div', { class: 'pill-row' },
            App.can('edit') ? h('button', { class: 'btn xs', onclick: permanent }, 'Edit timetable') : null)));
        continue;
      }
      const recorded = exs.length ? h('div', { class: 'pill-row', style: 'margin-top:3px' }, ...exs.map(e =>
        h('span', { class: 'badge red' }, `Absent ${absenceSpan(day, e)}`,
          h('button', { class: 'x', style: 'font-size:14px;padding:0 3px', title: 'Undo', onclick: () => remove(e.id) }, '×')))) : null;
      // The journeys this child is actually on today. A 1pm collection for two
      // of them should never offer the 3pm run the third one takes.
      const theirs = day.trips.filter(t => ch.trips[t.seq]);
      const actions = h('div', { class: 'pill-row' });
      if (!exs.length) {
        if (simple || theirs.length === 1) {
          for (const t of theirs) {
            const sc = tripScope(day, t);
            actions.appendChild(h('button', { class: 'btn xs', onclick: () => post({ type: 'child_absence', child_id: ch.id, ...payloadOf(sc) }) },
              simple ? 'Absent ' + tripShort(day, t) : 'Absent from ' + t.label));
          }
        } else {
          actions.appendChild(scopePicker(day, 'Absent', sc => post({ type: 'child_absence', child_id: ch.id, ...payloadOf(sc) }),
            { includeDay: false, only: theirs }));
        }
        if (theirs.length > 1) {
          actions.appendChild(h('button', { class: 'btn xs danger', onclick: () => post({ type: 'child_absence', child_id: ch.id, leg: 'DAY' }) }, 'Absent all day'));
        }
      }
      if (App.can('edit')) {
        actions.appendChild(h('button', {
          class: 'btn xs', title: 'This child never travels on this weekday',
          onclick: () => Sched.scopeDialog({
            title: `${ch.name} — is this a one-off?`,
            intro: `${ch.name} is not travelling on ${fmt.dateLong(date)}. Is that just today, or has their normal week changed?`,
            onceLabel: 'Just this date',
            onceHint: 'Records an absence for today only. Everything else stays as it is.',
            onceDo: () => post({ type: 'child_absence', child_id: ch.id, leg: 'DAY' }),
            alwaysLabel: `Every ${Sched.DAY_NAMES[day.weekday]} from now on`,
            alwaysHint: 'Changes their weekly timetable. Days before the date you choose are left exactly as they were.',
            alwaysDo: permanent,
          }),
        }, 'Not a one-off?'));
      }
      childBox.appendChild(h('div', { class: 'oprow', style: 'padding:7px 0;border-bottom:1px solid var(--border)' },
        h('div', { style: 'flex:1;min-width:130px' },
          h('a', { href: '#/children/' + ch.id, target: '_blank' }, ch.name),
          ch.start_time || ch.finish_time ? h('div', { style: 'font-size:11.5px;color:var(--text-faint)' }, `${fmt.time(ch.start_time)} – ${fmt.time(ch.finish_time)}`) : null,
          recorded),
        actions));
    }
    wrap.appendChild(childBox);

    // ---- staff ----
    for (const role of ['driver', 'pa']) {
      const L = day.trips[0][role];
      if (L.status === 'not_required') continue;
      const normalName = L.normal_name || 'Not assigned';
      const exs = day.exceptions.filter(e => e.type === 'staff_absence' && e.role === role);
      const box = h('fieldset', h('legend', role === 'driver' ? 'Driver' : 'Passenger assistant'));
      const perJourney = day.trips.filter(t => t.source !== 'extra').map(t => role === 'driver' ? t.driver_rate : t.pa_rate);
      box.appendChild(h('div', { style: 'margin-bottom:8px' },
        h('strong', normalName),
        h('span', { style: 'color:var(--text-faint);font-size:12px;margin-left:8px' },
          `${fmt.money(perJourney.reduce((a, b) => a + b, 0))} today across ${plural(perJourney.length, 'journey')}`)));
      if (exs.length) {
        for (const e of exs) {
          box.appendChild(h('div', { class: 'note-box ' + (e.cover_staff_id ? 'warn' : 'danger'), style: 'margin-bottom:8px' },
            h('div', null,
              h('strong', 'Absent ' + absenceSpan(day, e)), ' — ',
              e.cover_staff_id ? h('span', null, 'covered by ', h('strong', e.cover_name), ' at ', h('strong', fmt.money(e.cover_pay)),
                e.paid_immediately ? h('span', { class: 'badge green', style: 'margin-left:6px' }, 'Paid immediately') : h('span', { class: 'badge', style: 'margin-left:6px' }, 'Pay via payroll'))
                : h('strong', { style: 'color:var(--red)' }, 'NO COVER ASSIGNED')),
            e.note ? h('div', { style: 'font-size:12px;margin-top:3px' }, e.note) : null,
            h('div', { class: 'pill-row', style: 'margin-top:6px' },
              !e.cover_staff_id ? h('button', { class: 'btn xs primary', onclick: () => Ops.coverDialog(c, date, role, e, day, refresh, markDirty) }, 'Assign cover') : null,
              h('button', { class: 'btn xs', onclick: () => remove(e.id) }, 'Undo absence'))));
        }
      } else {
        const acts = h('div', { class: 'pill-row' });
        if (simple) {
          for (const t of day.trips) {
            const sc = tripScope(day, t);
            acts.appendChild(h('button', { class: 'btn xs', onclick: () => Ops.absenceDialog(c, date, role, sc, day, refresh, markDirty) }, 'Absent ' + tripShort(day, t)));
          }
        } else {
          acts.appendChild(scopePicker(day, 'Absent', sc => Ops.absenceDialog(c, date, role, sc, day, refresh, markDirty), { includeDay: false }));
        }
        acts.appendChild(h('button', { class: 'btn xs danger', onclick: () => Ops.absenceDialog(c, date, role, { ...ALL_DAY }, day, refresh, markDirty) }, 'Absent all day'));
        box.appendChild(acts);
      }
      wrap.appendChild(box);
    }

    // ---- contract level ----
    const cbox = h('fieldset', h('legend', 'Contract and school'));
    const cancels = day.exceptions.filter(e => ['school_closed', 'contract_cancelled'].includes(e.type));
    if (cancels.length) {
      cbox.appendChild(h('div', { class: 'pill-row' }, ...cancels.map(e =>
        h('span', { class: 'badge red' }, `${fmt.titleCase(e.type)} (${absenceSpan(day, e)})`,
          e.contract_id ? h('button', { class: 'x', style: 'font-size:14px;padding:0 3px', onclick: () => remove(e.id) }, '×')
            : h('span', { style: 'font-size:10px;margin-left:5px' }, '(school-wide)')))));
    }
    cbox.appendChild(h('div', { class: 'pill-row', style: 'margin-top:8px' },
      h('button', { class: 'btn xs danger', onclick: () => Ops.cancelRunDialog(c, date, day, ALL_DAY, refresh, markDirty) }, 'Cancel runs'),
      h('button', { class: 'btn xs', onclick: () => Ops.schoolClosureDialog(c, date, day, refresh, markDirty) }, 'School closed / holiday'),
      h('button', { class: 'btn xs', onclick: () => Ops.noteDialog(c, date, day, refresh, markDirty) }, 'Add note'),
      App.can('finance') ? h('button', { class: 'btn xs', onclick: () => Ops.payOverrideDialog(c, date, day, refresh, markDirty) }, 'Pay override') : null));
    cbox.appendChild(h('div', { style: 'margin-top:8px;font-size:12px;color:var(--text-faint)' },
      'Cancelled runs and school closures retain council income. Staff are not paid for the cancelled runs.'));
    wrap.appendChild(cbox);

    // ---- everything recorded on this day ----
    if (day.exceptions.length) {
      wrap.appendChild(h('fieldset', h('legend', 'All exceptions recorded for this day'),
        UI.table([
          { key: 'type', label: 'Type', value: e => fmt.titleCase(e.type) },
          { label: 'Applies to', sortable: false, value: e => absenceSpan(day, e) },
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

/** Turns a scope back into the fields an exception is stored with. */
function payloadOf(scope) {
  const out = { leg: scope.leg || 'DAY' };
  if (scope.trip_seq !== null && scope.trip_seq !== undefined) { out.trip_seq = scope.trip_seq; out.trip_label = scope.trip_label; }
  return out;
}
/** Plain words for the part of a day an exception covers. */
function absenceSpan(day, e) {
  if (e.trip_seq) return e.trip_label || `journey ${e.trip_seq}`;
  if (e.leg === 'DAY' || !e.leg) return 'all day';
  const t = day && day.trips ? day.trips.find(x => (e.leg === 'AM' ? x.kind === 'outbound' : x.kind === 'return')) : null;
  return t && !isSimpleDay(day) ? t.label : e.leg;
}

/* absence + cover in a single step */
Ops.absenceDialog = function (contract, date, role, scope, day, refresh, markDirty) {
  const lookups = App.state.lookups;
  const pool = role === 'driver' ? lookups.drivers : lookups.pas;
  const normalId = role === 'driver' ? contract.driver_id : contract.pa_id;
  const covered = scopeTrips(day, scope);
  // Cover is worth what the journeys it covers are worth.
  const suggested = Math.round(covered.reduce((a, t) => a + (role === 'driver' ? t.driver_rate : t.pa_rate), 0) * 100) / 100;
  const spanText = scope.leg === 'DAY' && scope.trip_seq === undefined ? 'all day' : scope.label;

  const form = UI.form([
    { name: 'cover_staff_id', label: 'Cover staff member', type: 'select', placeholder: '— no cover, journey will not run —', options: pool.filter(p => p.id !== normalId).map(p => ({ value: p.id, label: `${p.name}${p.status === 'pool' ? ' (pool)' : ''}` })) },
    { name: 'cover_pay', label: 'Cover pay (£)', type: 'number', step: '0.01', value: suggested, help: `Suggested from the ${plural(covered.length, 'journey')} being covered. Override if the cover staff member is paid differently.` },
    { name: 'paid_immediately', label: 'Paid immediately (cash/bank today) — exclude from the next payroll', type: 'checkbox', span: 'full' },
    { name: 'note', label: 'Reason / note', span: 'full', placeholder: 'e.g. Sickness, annual leave, hospital appointment' },
  ], {});

  const finder = h('button', { class: 'btn sm', onclick: () => Ops.findCover(contract, date, role, scope.leg || 'DAY', id => { form.controls.cover_staff_id.value = id; }) }, '🔍 Find available staff near this route');

  const saveBtn = h('button', { class: 'btn primary' }, 'Record absence');
  const dlg = UI.modal({
    title: `${role === 'driver' ? 'Driver' : 'PA'} absent — ${contract.code}`,
    body: h('div', null,
      h('div', { class: 'note-box', style: 'margin-bottom:12px' },
        h('strong', `Absent ${spanText}`), ' on ', h('strong', fmt.dateLong(date)), '. ',
        `The normal ${role === 'driver' ? 'driver' : 'PA'} will not be paid for ${covered.length === 1 ? 'that journey' : 'those journeys'}.`,
        h('div', { style: 'margin-top:4px;color:var(--text-dim);font-size:12px' },
          covered.map(t => `${t.label}${t.depart_time ? ' ' + fmt.time(t.depart_time) : ''}`).join(' · '))),
      h('div', { style: 'margin-bottom:10px' }, finder),
      form),
    footer: [h('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'), saveBtn],
  });
  saveBtn.onclick = async () => {
    const v = form.read();
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    try {
      await api.post('/api/exceptions', {
        contract_id: contract.id, date, type: 'staff_absence', role, ...payloadOf(scope),
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
Ops.coverDialog = function (contract, date, role, exception, day, refresh, markDirty) {
  const lookups = App.state.lookups;
  const pool = role === 'driver' ? lookups.drivers : lookups.pas;
  const covered = scopeTrips(day, exception);
  const suggested = Math.round(covered.reduce((a, t) => a + (role === 'driver' ? t.driver_rate : t.pa_rate), 0) * 100) / 100;
  const form = UI.form([
    { name: 'cover_staff_id', label: 'Cover staff member', type: 'select', required: true, options: pool.map(p => ({ value: p.id, label: `${p.name}${p.status === 'pool' ? ' (pool)' : ''}` })) },
    { name: 'cover_pay', label: 'Cover pay (£)', type: 'number', step: '0.01', value: suggested, help: `Suggested from the ${plural(covered.length, 'journey')} being covered.` },
    { name: 'paid_immediately', label: 'Paid immediately — exclude from the next payroll', type: 'checkbox', span: 'full' },
    { name: 'note', label: 'Note', span: 'full', value: exception.note || '' },
  ], {});
  const saveBtn = h('button', { class: 'btn primary' }, 'Assign cover');
  const dlg = UI.modal({
    title: 'Assign cover — ' + contract.code,
    body: h('div', null,
      h('div', { class: 'note-box', style: 'margin-bottom:10px' }, `Covering ${absenceSpan(day, exception)}: `,
        covered.map(t => t.label).join(' · ')),
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
      await api.post('/api/exceptions', {
        contract_id: contract.id, date, type: 'staff_absence', role,
        leg: exception.leg, trip_seq: exception.trip_seq, trip_label: exception.trip_label,
        cover_staff_id: v.cover_staff_id, cover_pay: v.cover_pay, paid_immediately: v.paid_immediately, note: v.note,
      });
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

/* a journey that runs on one date only */
Ops.extraJourneyDialog = function (contract, date, refresh, markDirty) {
  const form = UI.form([
    { name: 'trip_label', label: 'What is the journey?', required: true, span: 'full', placeholder: 'e.g. 1pm hospital appointment collection' },
    { name: 'trip_kind', label: 'Type', type: 'select', placeholder: false, options: [{ value: 'other', label: 'Other journey' }, { value: 'outbound', label: 'Out — home to school' }, { value: 'return', label: 'Back — school to home' }] },
    { name: 'amount', label: 'Extra pay for the driver (£)', type: 'number', step: '0.01', help: 'Paid on top of the normal day. Leave blank if it is already covered.' },
    { name: 'note', label: 'Note', span: 'full' },
  ], {});
  const saveBtn = h('button', { class: 'btn primary' }, 'Add journey');
  const dlg = UI.modal({
    title: `Extra journey — ${contract.code} ${fmt.date(date)}`,
    body: h('div', null,
      h('div', { class: 'note-box', style: 'margin-bottom:12px' },
        h('strong', 'This adds a journey to this date only.'),
        ' If it happens every week, set it on the contract’s weekly schedule instead so it generates by itself.'),
      form),
    footer: [h('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'), saveBtn],
  });
  saveBtn.onclick = async () => {
    if (!form.validate()) return;
    const v = form.read();
    saveBtn.disabled = true;
    try {
      await api.post('/api/exceptions', { contract_id: contract.id, date, type: 'extra_journey', leg: 'DAY', ...v });
      markDirty(); toast('Extra journey added', 'ok'); dlg.close(); refresh();
    } catch (e) { toast(e.message, 'err'); saveBtn.disabled = false; }
  };
};

Ops.cancelRunDialog = function (contract, date, day, scope, refresh, markDirty) {
  const choices = scopeChoices(day);
  const initial = choices.findIndex(choice => choice.trip_seq === scope.trip_seq && choice.leg === scope.leg);
  const form = UI.form([
    { name: 'which', label: 'Which runs', type: 'select', placeholder: false, options: choices.map((choice, index) => ({ value: index, label: choice.label })) },
    { name: 'reason', label: 'Reason', type: 'select', placeholder: false, options: ['School closure', 'Illness', 'Child absent', 'Vehicle breakdown', 'Weather', 'Other'] },
    { name: 'note', label: 'Additional details', type: 'textarea', span: 'full', rows: 3 },
  ], { which: initial < 0 ? 0 : initial });
  const saveBtn = h('button', { class: 'btn danger' }, 'Mark run cancelled');
  const dlg = UI.modal({ title: `Cancel run — ${contract.code} ${fmt.date(date)}`,
    body: h('div', null, h('div', { class: 'note-box', style: 'margin-bottom:12px' },
      'Council contract income is retained. The driver and PA will not be paid for the selected runs, so the saved staff cost increases profit.'), form),
    footer: [h('button', { class: 'btn', onclick: () => dlg.close() }, 'Back'), saveBtn] });
  saveBtn.onclick = async () => {
    if (!form.validate()) return;
    const values = form.read(), chosen = choices[Number(values.which)] || ALL_DAY;
    if (values.reason === 'Other' && !values.note.trim()) { toast('Enter a reason in Additional details.', 'err'); return; }
    saveBtn.disabled = true;
    try {
      await api.post('/api/exceptions', { contract_id: contract.id, date, type: 'journey_cancelled',
        ...payloadOf(chosen), note: [values.reason, values.note.trim()].filter(Boolean).join(': ') });
      markDirty(); toast('Run cancelled — council income retained', 'ok'); dlg.close(); await refresh();
    } catch (error) { toast(error.message, 'err'); saveBtn.disabled = false; }
  };
};

/* A run taken off was never needed. Unlike a cancellation it is not billed
   to the council, so the invoice for the period counts that date as a half
   day, or nothing if every run was taken off. */
Ops.removeRunDialog = function (contract, date, day, scope, refresh, markDirty) {
  const choices = scopeChoices(day);
  const initial = choices.findIndex(choice => choice.trip_seq === scope.trip_seq && choice.leg === scope.leg);
  const form = UI.form([
    { name: 'which', label: 'Which runs', type: 'select', placeholder: false, options: choices.map((choice, index) => ({ value: index, label: choice.label })) },
    { name: 'note', label: 'Reason', span: 'full', placeholder: 'e.g. Council removed the PM run this week' },
  ], { which: initial < 0 ? 0 : initial });
  const saveBtn = h('button', { class: 'btn primary' }, 'Take run off');
  const dlg = UI.modal({ title: `Take run off — ${contract.code} ${fmt.date(date)}`,
    body: h('div', null, h('div', { class: 'note-box', style: 'margin-bottom:12px' },
      h('strong', 'Not billed, not paid. '), 'Use this when the run was not needed. If the council cancelled a run late and still pays for it, use Run cancelled instead.'), form),
    footer: [h('button', { class: 'btn', onclick: () => dlg.close() }, 'Back'), saveBtn] });
  saveBtn.onclick = async () => {
    const values = form.read(), chosen = choices[Number(values.which)] || ALL_DAY;
    saveBtn.disabled = true;
    try {
      await api.post('/api/exceptions', { contract_id: contract.id, date, type: 'journey_removed', ...payloadOf(chosen), note: values.note });
      markDirty(); toast('Run taken off — not billed', 'ok'); dlg.close(); await refresh();
    } catch (error) { toast(error.message, 'err'); saveBtn.disabled = false; }
  };
};

Ops.schoolClosureDialog = function (contract, date, day, refresh, markDirty) {
  const choices = scopeChoices(day);
  const form = UI.form([
    { name: 'scope', label: 'Applies to', type: 'select', placeholder: false, options: [{ value: 'school', label: `The whole school (${contract.school_name}) — every contract` }, { value: 'contract', label: `This contract only (${contract.code})` }] },
    { name: 'which', label: 'Which journeys', type: 'select', placeholder: false, options: choices.map((c, i) => ({ value: i, label: c.label })) },
    { name: 'note', label: 'Reason', span: 'full', value: 'School closed' },
    { name: 'repeat_days', label: 'Repeat for this many consecutive days', type: 'number', min: 1, max: 30, value: 1, help: 'Use for half-terms and holidays. Council income is retained, cancelled runs have no staff pay, and no child is marked absent.' },
  ], {});
  const saveBtn = h('button', { class: 'btn primary' }, 'Record closure');
  const dlg = UI.modal({ title: 'School closed — ' + fmt.date(date), body: form, footer: [h('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'), saveBtn] });
  saveBtn.onclick = async () => {
    const v = form.read();
    const chosen = choices[Number(v.which)] || { ...ALL_DAY };
    const dates = []; for (let i = 0; i < Math.max(1, v.repeat_days || 1); i++) dates.push(D.add(date, i));
    saveBtn.disabled = true;
    try {
      await api.post('/api/exceptions', {
        dates, type: 'school_closed', note: v.note, ...payloadOf(chosen),
        school_id: v.scope === 'school' ? contract.school_id : null,
        contract_id: v.scope === 'school' ? null : contract.id,
      });
      markDirty(); toast(`Closure recorded for ${plural(dates.length, 'day')}`, 'ok'); dlg.close(); refresh();
    } catch (e) { toast(e.message, 'err'); saveBtn.disabled = false; }
  };
};

Ops.noteDialog = function (contract, date, day, refresh, markDirty) {
  const choices = scopeChoices(day);
  const form = UI.form([
    { name: 'which', label: 'Applies to', type: 'select', placeholder: false, options: choices.map((c, i) => ({ value: i, label: c.label })) },
    { name: 'note', label: 'Note', type: 'textarea', span: 'full', required: true, rows: 3 },
  ], {});
  const saveBtn = h('button', { class: 'btn primary' }, 'Save note');
  const dlg = UI.modal({ title: 'Add note — ' + contract.code + ' ' + fmt.date(date), body: form, footer: [h('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'), saveBtn] });
  saveBtn.onclick = async () => {
    if (!form.validate()) return;
    const v = form.read();
    const chosen = choices[Number(v.which)] || { ...ALL_DAY };
    try { await api.post('/api/exceptions', { contract_id: contract.id, date, type: 'note', note: v.note, ...payloadOf(chosen) }); markDirty(); toast('Note saved', 'ok'); dlg.close(); refresh(); }
    catch (e) { toast(e.message, 'err'); }
  };
};

Ops.payOverrideDialog = function (contract, date, day, refresh, markDirty) {
  const choices = scopeChoices(day);
  const form = UI.form([
    { name: 'role', label: 'Who', type: 'select', placeholder: false, options: [{ value: 'driver', label: `Driver (${contract.driver_name || 'unassigned'})` }, { value: 'pa', label: `PA (${contract.pa_name || 'unassigned'})` }] },
    { name: 'which', label: 'Applies to', type: 'select', placeholder: false, options: choices.map((c, i) => ({ value: i, label: c.label })) },
    { name: 'amount', label: 'Pay for this date (£)', type: 'number', step: '0.01', required: true, help: 'Chosen for the whole day, this replaces the day rate. Chosen for one journey, it replaces that journey’s rate.' },
    { name: 'note', label: 'Reason', span: 'full', placeholder: 'e.g. Extra run, long diversion, bank holiday rate' },
  ], {});
  const saveBtn = h('button', { class: 'btn primary' }, 'Save override');
  const dlg = UI.modal({ title: 'Pay override — ' + contract.code + ' ' + fmt.date(date), body: form, footer: [h('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'), saveBtn] });
  saveBtn.onclick = async () => {
    if (!form.validate()) return;
    const v = form.read();
    const chosen = choices[Number(v.which)] || { ...ALL_DAY };
    try { await api.post('/api/exceptions', { contract_id: contract.id, date, type: 'pay_override', role: v.role, amount: v.amount, note: v.note, ...payloadOf(chosen) }); markDirty(); toast('Override saved', 'ok'); dlg.close(); refresh(); }
    catch (e) { toast(e.message, 'err'); }
  };
};
