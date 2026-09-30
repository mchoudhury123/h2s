/* views: wages, profitability, compliance, staff pool, reports, settings, audit */
'use strict';
const Fin = window.Fin = {};

/* =========================================================
   WAGE CALCULATION
   ========================================================= */
App.views.wages = async function ({ query }) {
  const today = D.today();
  const from = query.from || D.monthStart(today);
  const to = query.to || today;
  const staffId = query.staff || '';
  const contractId = query.contract || '';
  const type = query.type || '';
  const L = await UI.lookups();

  const go = (q) => Router.go('/wages?' + new URLSearchParams(clean({ from, to, staff: staffId, contract: contractId, type, ...q })));

  const controls = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', 'Pay period')),
    h('div', { class: 'card-body' },
      UI.dateRange(from, to, (a, b) => go({ from: a, to: b })),
      h('div', { class: 'filters', style: 'margin-top:12px' },
        h('div', { class: 'field' }, h('label', 'Staff member'),
          h('select', { onchange: e => go({ staff: e.target.value }) },
            h('option', { value: '' }, 'All staff'),
            h('optgroup', { label: 'Drivers' }, ...L.drivers.map(s => h('option', { value: s.id, selected: String(s.id) === staffId }, s.name))),
            h('optgroup', { label: 'PAs' }, ...L.pas.map(s => h('option', { value: s.id, selected: String(s.id) === staffId }, s.name))))),
        h('div', { class: 'field' }, h('label', 'Contract'),
          h('select', { onchange: e => go({ contract: e.target.value }) },
            h('option', { value: '' }, 'All contracts'),
            ...L.contracts.map(c => h('option', { value: c.id, selected: String(c.id) === contractId }, c.code)))),
        h('div', { class: 'field' }, h('label', 'Staff type'),
          h('select', { onchange: e => go({ type: e.target.value }) },
            h('option', { value: '' }, 'Drivers and PAs'),
            h('option', { value: 'driver', selected: type === 'driver' }, 'Drivers only'),
            h('option', { value: 'pa', selected: type === 'pa' }, 'PAs only'))))));

  const data = await api.get('/api/wages', clean({ from, to, staff_ids: staffId, contract_id: contractId, type }));

  const totals = h('div', { class: 'stats' },
    UI.stat({ label: 'Staff to pay', value: data.totals.staff_count }),
    UI.stat({ label: 'Driver wages', value: fmt.money0(data.totals.drivers) }),
    UI.stat({ label: 'PA wages', value: fmt.money0(data.totals.pas) }),
    UI.stat({ label: 'Gross earned', value: fmt.money0(data.totals.gross), hint: 'Before deducting payments already made' }),
    UI.stat({ label: 'Already paid', value: fmt.money0(data.totals.already_paid), hint: 'Cover paid immediately and past payroll', tone: data.totals.already_paid ? 'amber' : '' }),
    UI.stat({ label: 'Total to pay', value: fmt.money0(data.totals.total_due), tone: 'green' }));

  const summary = UI.table([
    { key: 'name', label: 'Staff', value: r => h('a', { href: '#', title: 'Open the breakdown', onclick: e => { e.preventDefault(); Fin.breakdown(r, from, to); } }, h('strong', r.staff.name)), sort: r => r.staff.name },
    { label: 'Type', value: r => h('span', { class: 'badge blue' }, r.staff.type === 'driver' ? 'Driver' : 'PA'), sort: r => r.staff.type },
    { label: 'Days', num: true, value: r => r.totals.normal_days, sort: r => r.totals.normal_days },
    { label: 'Journeys', num: true, value: r => r.totals.journeys, sort: r => r.totals.journeys },
    { label: 'Normal earnings', num: true, value: r => fmt.money(r.totals.normal_earnings), sort: r => r.totals.normal_earnings },
    { label: 'Cover', num: true, value: r => r.totals.cover_earnings ? h('span', { class: 'badge purple' }, fmt.money(r.totals.cover_earnings)) : '—', sort: r => r.totals.cover_earnings },
    { label: 'Gross', num: true, value: r => fmt.money(r.totals.gross), sort: r => r.totals.gross },
    { label: 'Already paid', num: true, value: r => r.totals.already_paid ? h('span', { style: 'color:var(--red)' }, '-' + fmt.money(r.totals.already_paid)) : '—', sort: r => r.totals.already_paid },
    { label: 'Amount due', num: true, value: r => h('strong', fmt.money(r.totals.amount_due)), sort: r => r.totals.amount_due },
    { label: '', sortable: false, value: r => h('button', { class: 'btn xs primary', onclick: () => Fin.breakdown(r, from, to) }, 'Breakdown') },
  ], data.results, {
    empty: 'Nothing to pay for this period',
    onRow: r => Fin.breakdown(r, from, to),
    footer: h('tr', h('td', { colspan: 6, class: 'tfoot-title' }, 'TOTAL'),
      h('td', { class: 'num', 'data-label': 'Gross' }, fmt.money(data.totals.gross)),
      h('td', { class: 'num', 'data-label': 'Already paid' }, data.totals.already_paid ? '-' + fmt.money(data.totals.already_paid) : '—'),
      h('td', { class: 'num', 'data-label': 'Amount due' }, fmt.money(data.totals.total_due)), h('td')),
  });

  const actions = [
    h('a', { class: 'btn', href: `/api/reports/payroll.csv?from=${from}&to=${to}`, target: '_blank' }, Icon.el('download', 14), 'Export summary'),
    h('a', { class: 'btn', href: `/api/reports/wage-breakdown.csv?from=${from}&to=${to}`, target: '_blank' }, Icon.el('download', 14), 'Export full breakdown'),
    h('button', { class: 'btn', onclick: () => window.print() }, Icon.el('print', 14), 'Print'),
    App.can('wages') && data.totals.total_due > 0 ? h('button', { class: 'btn primary', onclick: () => Fin.markPaid(from, to, data) }, 'Mark period as paid') : null,
  ];

  return h('div', null,
    UI.pageHead('Wage calculation', `${fmt.dateLong(from)} to ${fmt.dateLong(to)} — calculated from journeys actually operated`, actions),
    controls, h('div', { style: 'height:14px' }), totals, h('div', { style: 'height:14px' }),
    UI.cardTight('Wages due', summary),
    h('div', { style: 'height:14px' }),
    UI.card('How these figures are produced', h('div', { style: 'color:var(--text-dim);font-size:13px' },
      h('p', { style: 'margin:0 0 6px' }, 'Every contract generates its scheduled AM and PM journeys automatically for its operating days. The calculation then applies each recorded exception:'),
      h('ul', { style: 'margin:0;padding-left:20px' },
        h('li', 'A staff absence removes that person\'s pay for the affected journeys. A run without a PA still goes ahead, so the driver is paid; a run without a driver does not.'),
        h('li', 'A cover assignment pays the cover staff member the agreed rate, which can be overridden per journey.'),
        h('li', 'Cancelled journeys, school closures and days where every child is absent are not paid.'),
        h('li', 'Anything marked "paid immediately" is deducted so it is never paid twice.')))));
};

Fin.breakdown = function (r, from, to) {
  const lines = r.lines;
  const group = kind => lines.filter(l => l.kind === kind);
  const box = h('div', { class: 'breakdown' });

  const normal = group('normal');
  if (normal.length) {
    const byContract = {};
    for (const l of normal) { const k = l.contract_code + '|' + l.rate; (byContract[k] ||= { code: l.contract_code, rate: l.rate, count: 0, amount: 0, dates: new Set() }); byContract[k].count++; byContract[k].amount += l.amount; byContract[k].dates.add(l.date); }
    box.appendChild(h('div', { class: 'bl sub' }, h('span', { class: 'btx' }, 'Normal scheduled journeys'), h('span', { class: 'bam' }, fmt.money(r.totals.normal_earnings))));
    for (const k in byContract) {
      const g = byContract[k];
      box.appendChild(h('div', { class: 'bl' },
        h('span', { class: 'bd' }, plural(g.count / 2, 'day')),
        h('span', { class: 'btx' }, `${g.code} — ${plural(g.count, 'journey', 'journeys')} at ${fmt.money(g.rate)}/day`),
        h('span', { class: 'bam' }, fmt.money(g.amount))));
    }
  }

  const cover = group('cover');
  if (cover.length) {
    box.appendChild(h('div', { class: 'bl sub', style: 'margin-top:8px' }, h('span', { class: 'btx' }, 'Cover journeys'), h('span', { class: 'bam' }, fmt.money(r.totals.cover_earnings))));
    for (const l of cover) box.appendChild(h('div', { class: 'bl' + (l.amount === 0 ? ' zero' : '') },
      h('span', { class: 'bd' }, fmt.date(l.date)),
      h('span', { class: 'btx' }, l.description, l.paid_immediately ? h('span', { class: 'badge green', style: 'margin-left:6px' }, 'paid immediately') : null, l.note ? h('span', { style: 'color:var(--text-faint)' }, ' · ' + l.note) : null),
      h('span', { class: 'bam' }, fmt.money(l.amount))));
  }

  const missed = [...group('absence'), ...group('not_operated')];
  if (missed.length) {
    box.appendChild(h('div', { class: 'bl sub', style: 'margin-top:8px' }, h('span', { class: 'btx' }, 'Journeys not paid'), h('span', { class: 'bam' }, fmt.money(0))));
    for (const l of missed) box.appendChild(h('div', { class: 'bl zero' },
      h('span', { class: 'bd' }, fmt.date(l.date)), h('span', { class: 'btx' }, l.description), h('span', { class: 'bam' }, '£0.00')));
  }

  const paid = group('already_paid');
  const canUndo = App.can('wages');
  // Undoing closes this dialog and reloads the page, so the figures are fresh.
  const undo = (message, call, done) => UI.confirm(message, async () => {
    const res = await call();
    toast(done(res), 'ok');
    Router.handle();
  }, { title: 'Undo payment', yes: 'Yes, undo it' });
  if (paid.length) {
    box.appendChild(h('div', { class: 'bl sub', style: 'margin-top:8px' }, h('span', { class: 'btx' }, 'Payments already made'), h('span', { class: 'bam' }, '-' + fmt.money(r.totals.already_paid))));
    // Tick any number of payments and undo them together. Payroll lines are
    // undone as a run, below, so they cannot be ticked.
    const picked = new Map();
    const undoBtn = h('button', { class: 'btn xs danger', disabled: true }, 'Undo selected');
    const refreshUndo = () => {
      const amount = [...picked.values()].reduce((a, l) => a + -l.amount, 0);
      undoBtn.disabled = !picked.size;
      undoBtn.textContent = picked.size ? `Undo selected (${picked.size}, ${fmt.money(amount)})` : 'Undo selected';
    };
    const boxes = [];
    for (const l of paid) {
      const tickable = canUndo && l.payment_id && !l.payroll_run_id;
      const tick = tickable ? h('input', { type: 'checkbox', class: 'pay-pick', 'aria-label': 'Select payment for ' + fmt.date(l.date), onchange: e => { if (e.target.checked) picked.set(l.payment_id, l); else picked.delete(l.payment_id); refreshUndo(); } }) : null;
      if (tick) boxes.push(tick);
      box.appendChild(h('div', { class: 'bl neg' },
        h('span', { class: 'bd' }, tick, fmt.date(l.date)), h('span', { class: 'btx' }, l.description),
        h('span', { class: 'bam' }, fmt.money(l.amount))));
    }
    undoBtn.onclick = () => {
      const lines = [...picked.values()];
      const total = fmt.money(lines.reduce((a, l) => a + -l.amount, 0));
      const cover = lines.filter(l => l.exception_id).length;
      m.close();
      undo(`Undo ${plural(lines.length, 'payment')} totalling ${total}? ${r.staff.name} will be owed that again${cover ? `, and ${plural(cover, 'cover payment')} go back to payroll` : ''}.`,
        () => api.post('/api/payments/undo', { ids: lines.map(l => l.payment_id) }), res => `${plural(res.removed, 'payment')} undone`);
    };
    if (boxes.length) {
      box.appendChild(h('div', { class: 'pill-row', style: 'margin-top:8px' },
        h('button', { class: 'btn xs', onclick: () => { const all = boxes.every(b => b.checked); for (const b of boxes) { b.checked = !all; b.dispatchEvent(new Event('change')); } } }, boxes.length > 1 ? 'Select all' : 'Select'),
        undoBtn));
    }
    // Days paid together, and payroll runs, can be undone in one go.
    const batches = new Map(), runs = new Map();
    for (const l of paid) {
      if (l.batch) (batches.get(l.batch) || batches.set(l.batch, []).get(l.batch)).push(l);
      if (l.payroll_run_id) (runs.get(l.payroll_run_id) || runs.set(l.payroll_run_id, []).get(l.payroll_run_id)).push(l);
    }
    const groupRow = h('div', { class: 'pill-row', style: 'margin-top:8px' });
    for (const [batch, lines] of batches) {
      if (lines.length < 2) continue;
      const dates = lines.map(l => l.date).sort();
      const total = fmt.money(-lines.reduce((a, l) => a + l.amount, 0));
      groupRow.appendChild(h('button', { class: 'btn xs danger', onclick: () => { m.close(); undo(
        `Undo all ${plural(lines.length, 'day')} (${total}) recorded as already paid for ${fmt.date(dates[0])} to ${fmt.date(dates[dates.length - 1])}? ${r.staff.name} will be owed them again.`,
        () => api.del('/api/payments/batch/' + encodeURIComponent(batch)), res => `${plural(res.removed, 'day')} undone`); } },
      `Undo the ${plural(lines.length, 'day')} paid together (${fmt.date(dates[0])} – ${fmt.date(dates[dates.length - 1])})`));
    }
    for (const [runId, lines] of runs) {
      groupRow.appendChild(h('button', { class: 'btn xs danger', onclick: () => { m.close(); undo(
        `Undo this payroll run? Every member of staff paid in it, not only ${r.staff.name}, will be owed for that period again.`,
        () => api.del('/api/payroll-runs/' + runId), res => `Payroll run undone for ${plural(res.removed, 'member', 'members')} of staff`); } },
      `Undo payroll run (${fmt.money(-lines.reduce((a, l) => a + l.amount, 0))} here)`));
    }
    if (canUndo && groupRow.children.length) box.appendChild(groupRow);
  }

  box.appendChild(h('div', { class: 'bl total' }, h('span', { class: 'btx' }, 'AMOUNT DUE'), h('span', { class: 'bam' }, fmt.money(r.totals.amount_due))));

  const m = UI.modal({
    title: `${r.staff.name} — ${fmt.date(from)} to ${fmt.date(to)}`,
    width: 'wide',
    body: h('div', null,
      h('div', { class: 'pill-row', style: 'margin-bottom:14px' },
        h('span', { class: 'badge blue' }, r.staff.type === 'driver' ? 'Driver' : 'Passenger assistant'),
        h('span', { class: 'badge' }, `${plural(r.totals.normal_days, 'day')} worked`),
        h('span', { class: 'badge' }, plural(r.totals.journeys, 'journey', 'journeys')),
        r.totals.cover_days ? h('span', { class: 'badge purple' }, plural(r.totals.cover_days, 'cover day')) : null,
        r.totals.missed_journeys ? h('span', { class: 'badge amber' }, `${plural(r.totals.missed_journeys, 'journey', 'journeys')} not paid`) : null),
      box),
    footer: [
      h('a', { class: 'btn left', href: '#/staff/' + r.staff.id, onclick: () => m.close() }, 'Open staff profile'),
      App.can('wages') ? h('button', { class: 'btn', onclick: () => { m.close(); Fin.payDays(r.staff, from, to); } }, 'Already paid for days…') : null,
      App.can('wages') ? h('button', { class: 'btn', onclick: () => { m.close(); Fin.recordPayment(r.staff, r.totals.amount_due, to); } }, 'Record a payment') : null,
      h('button', { class: 'btn primary', onclick: () => m.close() }, 'Close'),
    ],
  });
};

/* Tick off a day or a run of days someone has already been paid for. One
   payment is written per day, so any later calculation deducts exactly the
   days it covers. */
Fin.payDays = function (staff, from, to) {
  const form = UI.form([
    { name: 'from', label: 'Paid from', type: 'date', value: from, required: true },
    { name: 'to', label: 'Paid to', type: 'date', value: to, required: true, help: 'One day: put the same date in both.' },
    { name: 'amount', label: 'Amount paid (£)', type: 'number', step: '0.01', help: 'Suggested from what those days are worth. Change it if a different sum was handed over; it is then spread across the days.' },
    { name: 'paid_date', label: 'Date paid', type: 'date', value: D.today() },
    { name: 'method', label: 'Method', type: 'select', options: ['Bank transfer', 'Cash', 'Cheque', 'Other'] },
    { name: 'reference', label: 'Reference' },
    { name: 'note', label: 'Note', span: 'full', placeholder: 'e.g. Paid in cash on Friday' },
  ], {});
  const preview = h('div', { style: 'margin:10px 0' });
  const saveBtn = h('button', { class: 'btn primary' }, 'Record as already paid');
  let owed = null;

  async function load() {
    const a = form.controls.from.value, b = form.controls.to.value;
    if (!a || !b) return;
    if (a > b) { preview.replaceChildren(h('div', { class: 'note-box danger' }, 'The from date is after the to date.')); saveBtn.disabled = true; return; }
    preview.replaceChildren(h('div', { style: 'color:var(--text-dim);font-size:12px' }, 'Working out what those days are worth…'));
    try {
      owed = await api.get('/api/wages/days-owed', { staff_id: staff.id, from: a, to: b });
    } catch (e) { preview.replaceChildren(h('div', { class: 'note-box danger' }, e.message)); saveBtn.disabled = true; return; }
    const rows = owed.days.filter(d => d.earned || d.already_paid);
    const table = h('table', { class: 'table', style: 'font-size:12.5px' },
      h('thead', h('tr', h('th', 'Date'), h('th', 'Journeys'), h('th', { class: 'num' }, 'Earned'), h('th', { class: 'num' }, 'Already paid'), h('th', { class: 'num' }, 'Still due'))),
      h('tbody', ...rows.map(d => h('tr', { style: d.due ? '' : 'color:var(--text-faint)' },
        h('td', fmt.date(d.date)), h('td', d.journeys || '—'),
        h('td', { class: 'num' }, fmt.money(d.earned)),
        h('td', { class: 'num' }, d.already_paid ? '-' + fmt.money(d.already_paid) : '—'),
        h('td', { class: 'num' }, d.due ? h('strong', fmt.money(d.due)) : h('span', { class: 'badge green' }, 'paid'))))),
      h('tfoot', h('tr', h('td', { colspan: 4 }, h('strong', `Still due for ${plural(owed.days.filter(d => d.due).length, 'day')}`)), h('td', { class: 'num' }, h('strong', fmt.money(owed.total_due))))));
    preview.replaceChildren(rows.length ? table
      : h('div', { class: 'note-box' }, `${staff.name} has no journeys between ${fmt.date(a)} and ${fmt.date(b)}.`));
    form.controls.amount.value = owed.total_due ? owed.total_due.toFixed(2) : '';
    saveBtn.disabled = !owed.total_due;
  }
  form.controls.from.addEventListener('change', load);
  form.controls.to.addEventListener('change', load);

  const m = UI.modal({
    title: 'Already paid — ' + staff.name,
    width: 'wide',
    body: h('div', null,
      h('div', { class: 'note-box', style: 'margin-bottom:10px' },
        'Use this when ', h('strong', staff.name), ' has already been paid for a day or a run of days, for example in cash. ',
        'Each day is recorded as paid for what it earned, so it drops out of every future wage calculation and cannot be paid twice.'),
      form, preview),
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), saveBtn],
  });
  load();
  saveBtn.onclick = async () => {
    if (!form.validate()) return;
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    try {
      const r = await api.post('/api/payments/days', { staff_id: staff.id, ...form.read() });
      toast(`${fmt.money(r.total)} recorded as already paid for ${plural(r.paid_days, 'day')}`, 'ok'); m.close(); Router.handle();
    } catch (e) { toast(e.message, 'err'); saveBtn.disabled = false; saveBtn.textContent = 'Record as already paid'; }
  };
};

Fin.recordPayment = function (staff, amount, workDate) {
  const form = UI.form([
    { name: 'amount', label: 'Amount paid (£)', type: 'number', step: '0.01', required: true, value: amount },
    { name: 'work_date', label: 'Work date this covers', type: 'date', value: workDate, required: true, help: 'The payment is deducted from any wage calculation covering this date.' },
    { name: 'paid_date', label: 'Date paid', type: 'date', value: D.today() },
    { name: 'method', label: 'Method', type: 'select', options: ['Bank transfer', 'Cash', 'Cheque', 'Other'] },
    { name: 'reference', label: 'Reference' },
    { name: 'note', label: 'Note', span: 'full' },
  ], {});
  const saveBtn = h('button', { class: 'btn primary' }, 'Record payment');
  const m = UI.modal({ title: 'Record payment — ' + staff.name, body: form, footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), saveBtn] });
  saveBtn.onclick = async () => {
    if (!form.validate()) return;
    try { await api.post('/api/payments', { staff_id: staff.id, source: 'manual', ...form.read() }); toast('Payment recorded', 'ok'); m.close(); Router.handle(); }
    catch (e) { toast(e.message, 'err'); }
  };
};

Fin.markPaid = function (from, to, data) {
  UI.confirm(
    `Record ${fmt.money(data.totals.total_due)} as paid to ${data.totals.staff_count} staff for ${fmt.date(from)} to ${fmt.date(to)}? Each amount is logged as a payment so it will not appear in a future wage calculation.`,
    async () => {
      try { const r = await api.post('/api/payroll-runs', { from, to }); toast(`Payroll recorded: ${r.paid} staff, ${fmt.money(r.total)}`, 'ok'); Router.handle(); }
      catch (e) { toast(e.message, 'err'); }
    }, { title: 'Mark payroll as paid', yes: 'Yes, record as paid', danger: false });
};

App.views.payrollRuns = async function () {
  const rows = await api.get('/api/payroll-runs');
  return UI.listPage({
    title: 'Payroll history', subtitle: `${rows.length} runs recorded`,
    actions: [h('a', { class: 'btn primary', href: '#/wages' }, 'New wage calculation')],
    columns: [
      { key: 'created_at', label: 'Recorded', value: r => fmt.datetime(r.created_at), nowrap: true },
      { key: 'description', label: 'Description' },
      { key: 'from_date', label: 'Period', value: r => `${fmt.date(r.from_date)} – ${fmt.date(r.to_date)}`, nowrap: true },
      { key: 'staff_count', label: 'Staff', num: true },
      { key: 'total', label: 'Total', num: true, value: r => fmt.money(r.total) },
      { key: 'created_by', label: 'Recorded by' },
      { label: '', sortable: false, value: r => h('div', { class: 'pill-row', style: 'justify-content:flex-end' },
        h('a', { class: 'btn xs', href: `#/wages?from=${r.from_date}&to=${r.to_date}` }, 'Re-open period'),
        App.can('wages') ? h('button', { class: 'btn xs danger', onclick: () => UI.confirm(
          `Undo this payroll run of ${fmt.money(r.total)} for ${fmt.date(r.from_date)} to ${fmt.date(r.to_date)}? Its payment records are removed, so the ${plural(r.staff_count, 'member', 'members')} of staff will show as owed for that period again.`,
          async () => { const res = await api.del('/api/payroll-runs/' + r.id); toast(`Payroll run undone for ${plural(res.removed, 'member', 'members')} of staff`, 'ok'); Router.handle(); },
          { title: 'Undo payroll run', yes: 'Yes, undo it' }) }, 'Undo') : null) },
    ],
    rows, searchFields: ['description', 'created_by'], empty: 'No payroll has been recorded yet',
  });
};

/* =========================================================
   PROFITABILITY
   ========================================================= */
App.views.finance = async function ({ query }) {
  const today = D.today();
  const from = query.from || D.monthStart(today);
  const to = query.to || D.monthEnd(today);
  const L = await UI.lookups();
  const go = q => Router.go('/finance?' + new URLSearchParams(clean({ from, to, contract: query.contract, school: query.school, council: query.council, ...q })));
  const data = await api.get('/api/profitability', clean({ from, to, contract_id: query.contract, school_id: query.school, council_id: query.council }));

  const t = data.totals;
  const stats = h('div', { class: 'stats' },
    UI.stat({
      label: 'Contract income', value: fmt.money0(t.income),
      hint: data.reconciliation
        ? (data.reconciliation.matches ? `Matches invoicing ✓ · ${plural(t.contracts, 'contract')}` : `Does not match invoicing: ${fmt.money(Math.abs(data.reconciliation.difference))} ${data.reconciliation.difference > 0 ? 'more' : 'less'} than invoicing would bill`)
        : `${t.contracts} contracts`,
      tone: data.reconciliation && !data.reconciliation.matches ? 'red' : '',
    }),
    UI.stat({ label: 'Driver cost', value: fmt.money0(t.driver_cost) }),
    UI.stat({ label: 'PA cost', value: fmt.money0(t.pa_cost) }),
    UI.stat({ label: 'Other direct costs', value: fmt.money0(t.other_costs), hint: 'Including ad-hoc expenses' }),
    UI.stat({ label: 'Gross profit', value: fmt.money0(t.gross_profit), tone: t.gross_profit >= 0 ? 'green' : 'red' }),
    UI.stat({ label: 'Margin', value: fmt.pct(t.margin), tone: t.margin >= 20 ? 'green' : t.margin >= 10 ? 'amber' : 'red' }));

  const contractCols = [
    { key: 'code', label: 'Contract', value: r => h('a', { href: '#/contracts/' + r.contract_id }, h('strong', r.code)) },
    { key: 'school_name', label: 'School' },
    { key: 'council_name', label: 'Council' },
    { key: 'children', label: 'Children', num: true },
    { key: 'journeys_operated', label: 'Journeys', num: true, value: r => h('span', { title: `${r.journeys_scheduled} scheduled` }, `${r.journeys_operated}/${r.journeys_scheduled}`) },
    { key: 'income', label: 'Income', num: true, value: r => fmt.money(r.income) },
    { key: 'driver_cost', label: 'Driver', num: true, value: r => fmt.money(r.driver_cost) },
    { key: 'pa_cost', label: 'PA', num: true, value: r => fmt.money(r.pa_cost) },
    { key: 'other_costs', label: 'Other', num: true, value: r => fmt.money(r.other_costs + r.adhoc_expenses) },
    { key: 'gross_profit', label: 'Gross profit', num: true, value: r => h('strong', { style: r.gross_profit < 0 ? 'color:var(--red)' : '' }, fmt.money(r.gross_profit)) },
    { key: 'margin', label: 'Margin', num: true, value: r => h('span', { class: 'badge ' + (r.margin >= 20 ? 'green' : r.margin >= 10 ? 'amber' : 'red') }, fmt.pct(r.margin)) },
  ];
  const groupCols = [
    { key: 'label', label: 'Name', value: g => h('strong', g.label) },
    { key: 'contracts', label: 'Contracts', num: true },
    { key: 'income', label: 'Income', num: true, value: g => fmt.money(g.income) },
    { key: 'total_cost', label: 'Total cost', num: true, value: g => fmt.money(g.total_cost) },
    { key: 'gross_profit', label: 'Gross profit', num: true, value: g => h('strong', fmt.money(g.gross_profit)) },
    { key: 'margin', label: 'Margin', num: true, value: g => h('span', { class: 'badge ' + (g.margin >= 20 ? 'green' : g.margin >= 10 ? 'amber' : 'red') }, fmt.pct(g.margin)) },
  ];

  const tabs = [
    { id: 'contract', label: 'By contract', count: data.rows.length, render: () => UI.cardTight(null, UI.table(contractCols, data.rows, { sortKey: 'gross_profit', sortDir: -1, onRow: r => Router.go('/contracts/' + r.contract_id) })) },
    { id: 'school', label: 'By school', count: data.by_school.length, render: () => UI.cardTight(null, UI.table(groupCols, data.by_school, { sortKey: 'gross_profit', sortDir: -1 })) },
    { id: 'council', label: 'By council', count: data.by_council.length, render: () => UI.cardTight(null, UI.table(groupCols, data.by_council, { sortKey: 'gross_profit', sortDir: -1 })) },
    { id: 'daily', label: 'By day', render: () => UI.cardTight(null, UI.table([
        { key: 'date', label: 'Date', value: r => h('a', { href: '#/day/' + r.date }, fmt.dateLong(r.date)), nowrap: true },
        { key: 'journeys', label: 'Journeys operated', num: true },
        { key: 'income', label: 'Income', num: true, value: r => fmt.money(r.income) },
      ], data.daily, { sortKey: 'date' })) },
  ];

  const filters = h('div', { class: 'card' }, h('div', { class: 'card-body' },
    UI.dateRange(from, to, (a, b) => go({ from: a, to: b })),
    h('div', { class: 'filters', style: 'margin-top:12px' },
      h('div', { class: 'field' }, h('label', 'Contract'),
        h('select', { onchange: e => go({ contract: e.target.value }) }, h('option', { value: '' }, 'All contracts'),
          ...L.contracts.map(c => h('option', { value: c.id, selected: String(c.id) === String(query.contract || '') }, c.code)))),
      h('div', { class: 'field' }, h('label', 'School'),
        h('select', { onchange: e => go({ school: e.target.value }) }, h('option', { value: '' }, 'All schools'),
          ...L.schools.map(c => h('option', { value: c.id, selected: String(c.id) === String(query.school || '') }, c.name)))),
      h('div', { class: 'field' }, h('label', 'Council'),
        h('select', { onchange: e => go({ council: e.target.value }) }, h('option', { value: '' }, 'All councils'),
          ...L.councils.map(c => h('option', { value: c.id, selected: String(c.id) === String(query.council || '') }, c.name)))))));

  return h('div', null,
    UI.pageHead('Contract profitability', `${fmt.dateLong(from)} to ${fmt.dateLong(to)} — based on journeys actually operated`,
      [h('a', { class: 'btn', href: `/api/reports/contract-profitability.csv?from=${from}&to=${to}`, target: '_blank' }, Icon.el('download', 14), 'Export'),
       h('button', { class: 'btn', onclick: () => window.print() }, Icon.el('print', 14), 'Print'),
       h('a', { class: 'btn', href: '#/expenses' }, 'Expenses')]),
    filters, h('div', { style: 'height:14px' }), stats, h('div', { style: 'height:14px' }), UI.tabs(tabs));
};

App.views.expenses = async function ({ query }) {
  const today = D.today();
  const from = query.from || D.monthStart(today), to = query.to || D.monthEnd(today);
  const [rows, L] = await Promise.all([api.get('/api/expenses', { from, to }), UI.lookups()]);
  const editor = e => UI.editor({
    title: e ? 'Edit expense' : 'New expense', width: '',
    fields: [
      { name: 'date', label: 'Date', type: 'date', required: true, value: today },
      { name: 'contract_id', label: 'Contract', type: 'select', options: L.contracts.map(c => ({ value: c.id, label: c.code })), help: 'Leave blank for a general overhead.' },
      { name: 'category', label: 'Category', type: 'select', required: true, placeholder: false, options: ['Fuel', 'Vehicle repair', 'Vehicle hire', 'Parking / tolls', 'Training', 'Equipment', 'Other'] },
      { name: 'amount', label: 'Amount (£)', type: 'number', step: '0.01', required: true },
      { name: 'description', label: 'Description', span: 'full' },
    ],
    values: e || { date: today },
    onSave: async v => { if (e) await api.put('/api/expenses/' + e.id, v); else await api.post('/api/expenses', v); toast('Expense saved', 'ok'); Router.handle(); },
  });
  const total = rows.reduce((a, r) => a + r.amount, 0);
  return UI.listPage({
    title: 'Direct expenses',
    subtitle: `${fmt.dateLong(from)} to ${fmt.dateLong(to)} — ${fmt.money(total)} total`,
    actions: [App.can('finance') ? h('button', { class: 'btn primary', onclick: () => editor(null) }, '+ New expense') : null],
    extra: h('div', { class: 'card', style: 'margin-bottom:14px' }, h('div', { class: 'card-body' },
      UI.dateRange(from, to, (a, b) => Router.go(`/expenses?from=${a}&to=${b}`)))),
    columns: [
      { key: 'date', label: 'Date', value: r => fmt.date(r.date), nowrap: true },
      { key: 'contract_code', label: 'Contract', value: r => r.contract_id ? h('a', { href: '#/contracts/' + r.contract_id }, r.contract_code) : h('span', { class: 'badge' }, 'General') },
      { key: 'category', label: 'Category' },
      { key: 'description', label: 'Description' },
      { key: 'amount', label: 'Amount', num: true, value: r => fmt.money(r.amount) },
      { label: '', sortable: false, value: r => App.can('finance') ? h('div', { class: 'pill-row' },
        h('button', { class: 'btn xs', onclick: () => editor(r) }, 'Edit'),
        h('button', { class: 'btn xs danger', onclick: () => UI.confirm('Delete this expense?', async () => { await api.del('/api/expenses/' + r.id); toast('Deleted', 'ok'); Router.handle(); }) }, 'Delete')) : null },
    ],
    rows, searchFields: ['category', 'description', 'contract_code'], empty: 'No expenses in this period',
  });
};

/* =========================================================
   COMPLIANCE CENTRE
   ========================================================= */
App.views.compliance = async function ({ query }) {
  const data = await api.get('/api/compliance', clean({ status: query.status }));
  const expiring = await api.get('/api/compliance/expiring', { days: 90 });

  const stats = h('div', { class: 'stats' },
    UI.stat({ label: 'Fully compliant', value: data.summary.green, tone: 'green', href: '#/compliance?status=green' }),
    UI.stat({ label: 'Expiring soon', value: data.summary.amber, tone: 'amber', href: '#/compliance?status=amber' }),
    UI.stat({ label: 'Action required', value: data.summary.red, tone: 'red', href: '#/compliance?status=red' }),
    UI.stat({ label: 'Amber warning window', value: data.amber_days + ' days', hint: 'Change in settings', href: '#/settings' }));

  const staffTable = UI.table([
    { label: '', width: '26px', sortable: false, value: r => h('span', { class: 'dot ' + r.status }) },
    { key: 'name', label: 'Staff', value: r => h('a', { href: '#/staff/' + r.id }, h('strong', r.name)) },
    { key: 'type', label: 'Role', value: r => h('span', { class: 'badge blue' }, r.type === 'driver' ? 'Driver' : 'PA') },
    { key: 'staff_status', label: 'Status', value: r => h('span', { class: 'badge' }, fmt.titleCase(r.staff_status)) },
    { key: 'phone', label: 'Telephone' },
    { key: 'status', label: 'Compliance', value: r => rag(r.status) },
    { label: 'Problems', sortable: false, value: r => {
      const bad = r.items.filter(i => i.status !== 'green');
      return bad.length ? h('div', { class: 'pill-row' }, ...bad.map(i => h('span', { class: 'badge ' + i.status }, `${i.doc_type}: ${i.reason}`))) : h('span', { class: 'badge green' }, 'All valid');
    } },
  ], data.staff, { sortKey: 'status', sortDir: -1, onRow: r => Router.go('/staff/' + r.id), empty: 'No staff match this filter' });

  const expiringTable = UI.table([
    { label: '', width: '26px', sortable: false, value: r => h('span', { class: 'dot ' + r.status }) },
    { key: 'entity_label', label: 'Record', value: r => h('a', { href: docLink(r) }, r.entity_label || '—') },
    { key: 'entity_type', label: 'Type', value: r => fmt.titleCase(r.entity_type) },
    { key: 'doc_type', label: 'Document' },
    { key: 'reference', label: 'Reference' },
    { key: 'expiry_date', label: 'Expiry', value: r => fmt.date(r.expiry_date), nowrap: true },
    { key: 'days_left', label: 'Days left', num: true, value: r => r.days_left < 0 ? h('strong', { style: 'color:var(--red)' }, `${-r.days_left} overdue`) : r.days_left },
  ], expiring, { sortKey: 'expiry_date', empty: 'Nothing expiring in the next 90 days' });

  return h('div', null,
    UI.pageHead('Compliance centre', 'Statuses are calculated automatically from document expiry dates',
      [h('a', { class: 'btn', href: '/api/reports/compliance.csv', target: '_blank' }, Icon.el('download', 14), 'Export compliance'),
       h('a', { class: 'btn', href: '/api/reports/expiring-documents.csv?days=90', target: '_blank' }, Icon.el('download', 14), 'Export expiring'),
       App.can('*') ? h('a', { class: 'btn', href: '#/settings' }, 'Configure') : null]),
    stats, h('div', { style: 'height:14px' }),
    UI.tabs([
      { id: 'staff', label: 'Staff traffic lights', count: data.staff.length, render: () => UI.cardTight(null, staffTable) },
      { id: 'expiring', label: 'Expiring documents', count: expiring.length, render: () => UI.cardTight(null, expiringTable) },
      { id: 'required', label: 'Required documents', render: () => h('div', { class: 'grid cols-2' },
        UI.card('Required for drivers', h('div', { class: 'pill-row' }, ...data.required.driver.map(d => h('span', { class: 'badge blue' }, d)))),
        UI.card('Required for PAs', h('div', { class: 'pill-row' }, ...data.required.pa.map(d => h('span', { class: 'badge blue' }, d))))) },
    ]));
};
function docLink(r) {
  if (r.entity_type === 'vehicle') return r.vehicle_driver_id ? '#/staff/' + r.vehicle_driver_id : '#/vehicles';
  const map = { staff: '#/staff/', child: '#/children/', contract: '#/contracts/', school: '#/schools/' };
  return (map[r.entity_type] || '#/') + r.entity_id;
}

/* =========================================================
   STAFF POOL / WAITING LIST
   ========================================================= */
App.views.pool = async function ({ query }) {
  const type = query.type || 'driver';
  const postcode = query.postcode || '';
  const date = query.date || '';
  const L = await UI.lookups();
  const go = q => Router.go('/pool?' + new URLSearchParams(clean({ type, postcode, date, wheelchair: query.wheelchair, seats: query.seats, include_assigned: query.include_assigned, ...q })));
  const data = await api.get('/api/pool', clean({ type, postcode, date, wheelchair: query.wheelchair, seats: query.seats, include_assigned: query.include_assigned || '1' }));

  const controls = h('div', { class: 'card' }, h('div', { class: 'card-body' },
    h('div', { class: 'filters' },
      h('div', { class: 'field' }, h('label', 'Looking for'),
        h('select', { onchange: e => go({ type: e.target.value }) },
          h('option', { value: 'driver', selected: type === 'driver' }, 'Drivers'),
          h('option', { value: 'pa', selected: type === 'pa' }, 'Passenger assistants'))),
      h('div', { class: 'field' }, h('label', 'Near postcode'),
        h('input', { type: 'text', value: postcode, placeholder: 'e.g. SR2 7LA', onchange: e => go({ postcode: e.target.value }) })),
      h('div', { class: 'field' }, h('label', 'Or near school'),
        h('select', { onchange: e => go({ postcode: e.target.value }) }, h('option', { value: '' }, 'Choose a school…'),
          ...L.schools.map(s => h('option', { value: s.postcode || '', selected: s.postcode === postcode }, s.name)))),
      h('div', { class: 'field' }, h('label', 'Free on date'),
        h('input', { type: 'date', value: date, onchange: e => go({ date: e.target.value }) })),
      ...(type === 'driver' ? [
        h('div', { class: 'field' }, h('label', 'Minimum seats'),
          h('input', { type: 'number', min: 1, value: query.seats || '', onchange: e => go({ seats: e.target.value }) })),
        h('div', { class: 'field check', style: 'padding-bottom:8px' },
          h('input', { type: 'checkbox', id: 'wav', checked: query.wheelchair === '1', onchange: e => go({ wheelchair: e.target.checked ? '1' : '' }) }),
          h('label', { for: 'wav' }, 'Wheelchair accessible only'))] : []),
      h('div', { class: 'field check', style: 'padding-bottom:8px' },
        h('input', { type: 'checkbox', id: 'inc', checked: query.include_assigned !== '0', onchange: e => go({ include_assigned: e.target.checked ? '1' : '0' }) }),
        h('label', { for: 'inc' }, 'Include staff already on contracts')))));

  const cols = [
    { label: '', width: '26px', sortable: false, value: s => h('span', { class: 'dot ' + s.compliance }) },
    { key: 'name', label: 'Name', value: s => h('a', { href: '#/staff/' + s.id }, h('strong', s.name)) },
    { key: 'status', label: 'Availability type', value: s => h('span', { class: 'badge ' + (s.status === 'pool' ? 'blue' : '') }, s.status === 'pool' ? 'Staff pool' : plural(s.contract_count, 'contract')) },
    { key: 'phone', label: 'Contact', value: s => h('div', null, s.phone || '—', s.email ? h('div', { style: 'font-size:11.5px;color:var(--text-dim)' }, s.email) : null) },
    { key: 'postcode', label: 'Home postcode' },
    { key: 'proximity_score', label: 'Proximity', value: s => s.proximity ? h('span', { class: 'badge ' + (s.proximity_score >= 80 ? 'green' : s.proximity_score >= 55 ? 'amber' : '') }, s.proximity) : '—' },
    ...(type === 'driver' ? [{ key: 'vehicle_summary', label: 'Vehicle', value: s => s.vehicle_summary || h('span', { class: 'badge amber' }, 'None recorded') }] : []),
    { key: 'compliance', label: 'Compliance', value: s => h('div', null, rag(s.compliance), s.compliance_problems.length ? h('div', { style: 'font-size:11px;color:var(--text-dim);margin-top:3px' }, s.compliance_problems.join('; ')) : null) },
    { key: 'busy', label: date ? 'On ' + fmt.date(date) : 'Availability', value: s => !date ? h('span', { style: 'color:var(--text-faint)' }, 'Choose a date to check') : (s.busy ? h('span', { class: 'badge amber' }, s.busy) : h('span', { class: 'badge green' }, 'Free')) },
    { key: 'availability', label: 'Stated availability', value: s => s.availability || '—' },
    { key: 'preferred_areas', label: 'Preferred areas', value: s => s.preferred_areas || '—' },
    ...(App.can('finance') ? [{ key: 'default_day_rate', label: 'Day rate', num: true, value: s => fmt.money(s.default_day_rate) }] : []),
  ];

  return h('div', null,
    UI.pageHead('Staff pool & availability',
      'Find the closest suitable driver or PA for cover or a new contract',
      [App.can('edit') ? h('button', { class: 'btn primary', onclick: () => Rec.staffEditor(null, type) }, '+ Add to pool') : null,
       h('a', { class: 'btn', href: '/api/reports/' + (type === 'driver' ? 'drivers' : 'pas') + '.csv', target: '_blank' }, Icon.el('download', 14), 'Export')]),
    controls, h('div', { style: 'height:14px' }),
    UI.cardTight(`${data.staff.length} ${type === 'driver' ? 'drivers' : 'PAs'}${postcode ? ' sorted by distance from ' + postcode : ''}`,
      UI.table(cols, data.staff, { onRow: s => Router.go('/staff/' + s.id), empty: 'No staff match these criteria' })),
    h('div', { style: 'margin-top:10px;font-size:12px;color:var(--text-faint)' },
      'Proximity compares the outward part of the postcode (for example SR2 against SR3). It is an approximation, not a road distance.'));
};

/* =========================================================
   REPORTS
   ========================================================= */
const REPORTS = [
  { id: 'payroll', name: 'Full payroll report', desc: 'Every driver and PA with amounts due for a period.', dates: true, perm: 'wages' },
  { id: 'driver-wages', name: 'Driver wage report', desc: 'Driver earnings, cover and deductions.', dates: true, perm: 'wages' },
  { id: 'pa-wages', name: 'PA wage report', desc: 'Passenger assistant earnings for a period.', dates: true, perm: 'wages' },
  { id: 'wage-breakdown', name: 'Full wage breakdown', desc: 'Every individual journey and adjustment behind each wage figure.', dates: true, perm: 'wages' },
  { id: 'contract-profitability', name: 'Contract profitability', desc: 'Income, costs and margin per contract.', dates: true, perm: 'finance' },
  { id: 'contract-income', name: 'Contract income', desc: 'Income by contract and council.', dates: true, perm: 'finance' },
  { id: 'journeys', name: 'Journey & attendance report', desc: 'Every AM and PM journey with its outcome.', dates: true, perm: 'reports' },
  { id: 'attendance', name: 'Child absence report', desc: 'Children who did not travel, by date and journey.', dates: true, perm: 'reports' },
  { id: 'cover-staff', name: 'Cover staff report', desc: 'Who covered what, at what rate, and whether already paid.', dates: true, perm: 'reports' },
  { id: 'compliance', name: 'Compliance report', desc: 'Traffic-light status of every driver and PA.', dates: false, perm: 'reports' },
  { id: 'expiring-documents', name: 'Expiring documents', desc: 'Documents expiring within a chosen window.', dates: false, days: true, perm: 'reports' },
  { id: 'children', name: 'Child list', desc: 'All children with school, contract, staff and needs.', dates: false, perm: 'reports' },
  { id: 'drivers', name: 'Driver list', desc: 'All drivers with vehicles, contracts and compliance.', dates: false, perm: 'reports' },
  { id: 'pas', name: 'PA list', desc: 'All passenger assistants.', dates: false, perm: 'reports' },
  { id: 'school-contracts', name: 'School contracts', desc: 'Contracts and staffing grouped by school.', dates: false, perm: 'reports' },
  { id: 'audit', name: 'Audit log', desc: 'Record of every important change.', dates: false, perm: 'audit' },
];

App.views.reports = async function ({ query }) {
  const today = D.today();
  let from = query.from || D.monthStart(today), to = query.to || today, days = query.days || 30;
  const available = REPORTS.filter(r => App.can(r.perm) || App.can('*'));
  const host = h('div');
  const rangeCard = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', 'Report period')),
    h('div', { class: 'card-body' },
      UI.dateRange(from, to, (a, b) => { from = a; to = b; draw(); }),
      h('div', { class: 'filters', style: 'margin-top:12px' },
        h('div', { class: 'field' }, h('label', 'Expiry window (days)'),
          h('input', { type: 'number', value: days, min: 1, max: 730, onchange: e => { days = e.target.value; draw(); } })))));

  const draw = () => {
    host.innerHTML = '';
    const grid = h('div', { class: 'grid cols-3' });
    for (const r of available) {
      const qs = new URLSearchParams(clean({ from: r.dates ? from : null, to: r.dates ? to : null, days: r.days ? days : null }));
      grid.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-body' },
        h('h3', r.name),
        h('div', { style: 'color:var(--text-dim);font-size:12.5px;margin:4px 0 10px' }, r.desc),
        r.dates ? h('div', { style: 'font-size:11.5px;color:var(--text-faint);margin-bottom:8px' }, `${fmt.date(from)} – ${fmt.date(to)}`) : null,
        h('div', { class: 'pill-row' },
          h('button', { class: 'btn sm primary', onclick: () => Fin.viewReport(r, qs.toString()) }, 'View'),
          h('a', { class: 'btn sm', href: `/api/reports/${r.id}.csv?${qs}`, target: '_blank' }, Icon.el('download', 14), 'CSV / Excel')))));
    }
    host.appendChild(grid);
  };
  draw();

  return h('div', null,
    UI.pageHead('Reports & exports', 'View on screen, export to Excel or CSV, or print to PDF'),
    rangeCard, h('div', { style: 'height:14px' }), host);
};

Fin.viewReport = async function (report, qs) {
  const m = UI.modal({ title: report.name, width: 'wide', body: h('div', { class: 'loading' }, h('span', { class: 'spinner' })) });
  try {
    const data = await api.get(`/api/reports/${report.id}?${qs}`);
    const body = m.modal.querySelector('.modal-body');
    body.innerHTML = '';
    m.modal.querySelector('.modal-head h2').textContent = data.title;
    body.appendChild(UI.table(data.columns.map(c => ({
      key: c.key, label: c.label,
      value: r => { const v = r[c.key]; return v === null || v === undefined || v === '' ? '—' : String(v); },
    })), data.rows, { empty: 'No data for this period' }));
    if (data.totals) body.appendChild(h('div', { class: 'note-box', style: 'margin-top:12px' },
      Object.entries(data.totals).map(([k, v]) => h('div', null, h('strong', fmt.titleCase(k) + ': '), typeof v === 'number' && /income|cost|profit|gross|due|paid/.test(k) ? fmt.money(v) : String(v)))));
    m.modal.querySelector('.modal-foot')?.remove();
    m.modal.appendChild(h('div', { class: 'modal-foot' },
      h('span', { class: 'left', style: 'color:var(--text-faint);font-size:12px' }, `${data.rows.length} rows`),
      h('a', { class: 'btn', href: `/api/reports/${report.id}.csv?${qs}`, target: '_blank' }, Icon.el('download', 14), 'Export CSV'),
      h('button', { class: 'btn primary', onclick: () => m.close() }, 'Close')));
  } catch (e) { m.close(); toast(e.message, 'err'); }
};

/* =========================================================
   SETTINGS + USERS + AUDIT
   ========================================================= */
App.views.settings = async function () {
  const s = await api.get('/api/settings');
  const users = App.can('*') ? await api.get('/api/users') : [];
  const form = UI.form([
    { name: 'company_name', label: 'Company name', span: 'full', value: s.company_name },
    { name: 'amber_days', label: 'Amber warning (days before expiry)', type: 'number', min: 0, max: 365, value: s.amber_days, help: 'How far ahead a document turns amber in the compliance traffic lights.' },
  ], s);
  const saveBtn = h('button', { class: 'btn primary', onclick: async () => {
    try { await api.post('/api/settings', form.read()); toast('Settings saved', 'ok'); await App.loadMe(); Router.handle(); }
    catch (e) { toast(e.message, 'err'); }
  } }, 'Save settings');

  const docPicker = (key, all, selected) => {
    const box = h('div', { class: 'pill-row' });
    all.forEach(t => {
      const on = selected.includes(t);
      const chip = h('button', { class: 'chip' + (on ? ' on' : ''), onclick: async () => {
        const next = chip.classList.contains('on') ? selected.filter(x => x !== t) : [...selected, t];
        try { await api.post('/api/settings', { [key]: next }); toast('Required documents updated', 'ok'); Router.handle(); }
        catch (e) { toast(e.message, 'err'); }
      } }, t);
      box.appendChild(chip);
    });
    return box;
  };

  const userTable = UI.table([
    { key: 'name', label: 'Name', value: u => h('strong', u.name) },
    { key: 'email', label: 'Email address' },
    { key: 'home', label: 'Account', value: u => u.home
      ? (u.business_count > 1 ? h('span', { class: 'badge blue', title: 'Created here, and added to other businesses' }, `Also in ${plural(u.business_count - 1, 'other business', 'other businesses')}`) : h('span', { class: 'badge' }, 'This business'))
      : h('span', { class: 'badge purple', title: 'Created by another business and added here. They switch between businesses from the top left.' }, 'Shared from another business') },
    { key: 'active', label: 'Status', value: u => u.active ? h('span', { class: 'badge green' }, 'Active') : h('span', { class: 'badge' }, 'Disabled') },
    { key: 'last_login', label: 'Last signed in', value: u => u.last_login ? fmt.datetime(u.last_login) : 'Never' },
    { key: 'created_at', label: 'Added', value: u => fmt.datetime(u.created_at) },
    { label: '', sortable: false, value: u => h('div', { class: 'pill-row' },
      (u.home || u.id === App.state.user.id) ? h('button', { class: 'btn xs', onclick: () => Fin.userEditor(u) }, 'Edit') : null,
      u.id !== App.state.user.id
        ? h('button', { class: 'btn xs danger', onclick: () => UI.confirm(
            u.business_count > 1
              ? `Remove ${u.email} from ${App.state.settings.company_name || 'this business'}? They keep their account and their other ${plural(u.business_count - 1, 'business', 'businesses')}.`
              : `Remove ${u.email} from ${App.state.settings.company_name || 'your business'}? They will no longer be able to sign in.`,
            async () => { const r = await api.del('/api/users/' + u.id); toast(r.account_closed ? 'Account removed' : 'Removed from this business', 'ok'); Router.handle(); })
          }, 'Remove')
        : h('span', { class: 'badge blue' }, 'You')) },
  ], users, { empty: 'No accounts' });

  return h('div', null,
    UI.pageHead('Settings', 'Your business, compliance rules and the people who can sign in'),
    UI.tabs([
      { id: 'general', label: 'Business', render: () => UI.card('Your business', h('div', null, form, h('div', { style: 'margin-top:14px' }, saveBtn))) },
      { id: 'compliance', label: 'Required documents', render: () => h('div', { class: 'grid cols-2' },
        UI.card('Required for drivers', h('div', null,
          h('p', { style: 'color:var(--text-dim);font-size:13px;margin:0 0 10px' }, 'A driver is green only when every selected document is present and in date.'),
          docPicker('required_docs_driver', s.all_doc_types.staff, s.required_docs_driver))),
        UI.card('Required for PAs', h('div', null,
          h('p', { style: 'color:var(--text-dim);font-size:13px;margin:0 0 10px' }, 'Click to add or remove a required document.'),
          docPicker('required_docs_pa', s.all_doc_types.staff, s.required_docs_pa)))) },
      { id: 'invoicing', label: 'Invoicing', render: () => { const box = h('div', h('div', { class: 'loading' }, h('span', { class: 'spinner' }))); Inv.settingsTab().then(el => { box.innerHTML = ''; box.appendChild(el); }).catch(e => { box.textContent = e.message; }); return box; } },
      { id: 'users', label: 'Who can sign in', count: users.length, render: () => h('div', null,
        UI.cardTight('Accounts for ' + (App.state.settings.company_name || 'your business'), userTable,
          h('button', { class: 'btn sm primary', onclick: () => Fin.userEditor(null) }, '+ Add someone')),
        h('p', { style: 'color:var(--text-dim);font-size:13px;margin-top:12px' },
          'Everyone here has full access to this business and nothing outside it. ',
          'No other firm using this system can see your records. ',
          'Add someone who already signs in elsewhere and they keep their one account and password, and switch between businesses from the top left.')) },
    ]));
};

Fin.userEditor = function (u) {
  UI.editor({
    title: u ? 'Edit ' + u.name : 'Add someone to your team', width: '',
    fields: [
      { name: 'name', label: 'Full name', required: true, span: 'full' },
      ...(u ? [] : [{ name: 'email', label: 'Email address', type: 'email', required: true, span: 'full',
        help: 'They sign in with this address. If it already signs in to another business, that account is added here as it is.' }]),
      { name: 'password', label: u ? 'New password (leave blank to keep the current one)' : 'Password for a new account',
        type: 'password', required: false, span: 'full',
        help: u ? 'At least 8 characters, including a letter and a number.'
          : 'At least 8 characters, including a letter and a number. Leave blank for someone who already has an account; their password is not changed.' },
      ...(u ? [{ name: 'active', label: 'This account can sign in', type: 'checkbox', span: 'full' }] : []),
    ],
    values: u || {},
    onSave: async v => {
      if (u) { if (!v.password) delete v.password; await api.put('/api/users/' + u.id, v); toast('Account updated', 'ok'); }
      else {
        const r = await api.post('/api/users', v);
        toast(r.existing ? `${r.email} added. They can switch to this business from the top left.` : 'Account created', 'ok');
      }
      Router.handle();
    },
  });
};

App.views.audit = async function ({ query }) {
  const rows = await api.get('/api/audit', clean({ entity_type: query.type, from: query.from, to: query.to, limit: 500 }));
  return UI.listPage({
    title: 'Audit log', subtitle: `${rows.length} most recent changes`,
    actions: [h('a', { class: 'btn', href: '/api/reports/audit.csv', target: '_blank' }, Icon.el('download', 14), 'Export')],
    columns: [
      { key: 'created_at', label: 'When', value: r => fmt.datetime(r.created_at), nowrap: true },
      { key: 'user_name', label: 'User' },
      { key: 'entity_type', label: 'Record type', value: r => h('span', { class: 'badge' }, fmt.titleCase(r.entity_type)) },
      { key: 'entity_label', label: 'Record', value: r => r.entity_label || '—' },
      { key: 'action', label: 'Action', value: r => h('span', { class: 'badge ' + (r.action === 'delete' ? 'red' : r.action === 'create' ? 'green' : '') }, fmt.titleCase(r.action)) },
      { key: 'field', label: 'Field' },
      { key: 'old_value', label: 'Previous value', value: r => r.old_value ?? '—' },
      { key: 'new_value', label: 'New value', value: r => r.new_value ?? '—' },
      { key: 'summary', label: 'Summary' },
    ],
    rows, searchFields: ['user_name', 'entity_label', 'summary', 'field', 'old_value', 'new_value'],
    filters: [{ key: 'entity_type', label: 'Record type', options: ['contracts', 'children', 'staff', 'schools', 'exceptions', 'councils', 'user', 'settings'] }],
    empty: 'No changes recorded',
  });
};
