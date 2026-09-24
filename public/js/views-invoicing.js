/* views-invoicing: invoices to the council, one per contract per period.
 *
 * Preview first, with the working shown; numbers are only taken when the
 * batch is generated, and an issued invoice never changes afterwards.
 */
'use strict';
const Inv = window.Inv = {};

function daysText(n) { const v = Number(n) || 0; return Number.isInteger(v) ? String(v) : v.toFixed(1); }
Inv.daysText = daysText;

App.views.invoicing = async function ({ query }) {
  const L = await UI.lookups();
  const tabs = [
    { id: 'generate', label: 'Generate invoices', render: () => Inv.generatePanel(L, query) },
    { id: 'register', label: 'Invoice register', render: () => Inv.registerPanel(L, query) },
    { id: 'rates', label: 'Rates & PO numbers', render: () => Inv.ratesPanel() },
  ];
  return h('div', null,
    UI.pageHead('Invoicing', 'One invoice per contract per period. Preview the days first; numbers are only taken when you generate.',
      [h('a', { class: 'btn', href: '#/settings' }, 'Invoice settings')]),
    UI.tabs(tabs, query.tab));
};

/* =========================================================
   GENERATE
   ========================================================= */
Inv.generatePanel = function (L, query) {
  const today = D.today();
  const state = {
    from: query.from || D.monthStart(today), to: query.to || today,
    invoice_date: today, contract_ids: [], preview: null, rows: [],
  };
  const wrap = h('div');
  const fromIn = h('input', { type: 'date', value: state.from, onchange: e => { state.from = e.target.value; } });
  const toIn = h('input', { type: 'date', value: state.to, onchange: e => { state.to = e.target.value; } });
  const dateIn = h('input', { type: 'date', value: state.invoice_date, onchange: e => { state.invoice_date = e.target.value; } });
  const allBox = h('input', { type: 'checkbox', checked: true });
  const pick = h('select', { multiple: true, size: 6, disabled: true, style: 'min-width:240px' },
    ...L.contracts.map(c => h('option', { value: c.id }, `${c.code}${c.school_name ? ' · ' + c.school_name : ''}`)));
  allBox.onchange = () => { pick.disabled = allBox.checked; };
  const setRange = (a, b) => { state.from = a; state.to = b; fromIn.value = a; toIn.value = b; };
  const quick = h('div', { class: 'pill-row' },
    h('button', { class: 'btn xs', onclick: () => setRange(D.monthStart(today), D.monthEnd(today)) }, 'This month'),
    h('button', { class: 'btn xs', onclick: () => { const lm = D.add(D.monthStart(today), -1); setRange(D.monthStart(lm), lm); } }, 'Last month'),
    h('button', { class: 'btn xs', onclick: () => setRange(D.weekStart(today), D.add(D.weekStart(today), 6)) }, 'This week'),
    h('button', { class: 'btn xs', onclick: () => { const ws = D.add(D.weekStart(today), -7); setRange(ws, D.add(ws, 6)); } }, 'Last week'));

  const previewBtn = h('button', { class: 'btn primary' }, 'Preview');
  const results = h('div');
  previewBtn.onclick = async () => {
    state.contract_ids = allBox.checked ? [] : [...pick.selectedOptions].map(o => Number(o.value));
    if (!allBox.checked && !state.contract_ids.length) return toast('Choose at least one contract, or tick All contracts', 'err');
    previewBtn.disabled = true; previewBtn.textContent = 'Working out the days…';
    try {
      const pv = await api.get('/api/invoicing/preview', { from: state.from, to: state.to, invoice_date: state.invoice_date, contract_ids: state.contract_ids.join(',') });
      state.preview = pv;
      results.innerHTML = '';
      results.appendChild(Inv.previewTable(pv, state, results));
    } catch (e) { toast(e.message, 'err'); }
    previewBtn.disabled = false; previewBtn.textContent = 'Preview';
  };

  wrap.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('div', { class: 'filters' },
      h('div', { class: 'field' }, h('label', 'From'), fromIn),
      h('div', { class: 'field' }, h('label', 'To'), toIn),
      h('div', { class: 'field' }, h('label', 'Quick'), quick),
      h('div', { class: 'field' }, h('label', 'Invoice date'), dateIn),
      h('div', { class: 'field' }, h('label', h('span', { class: 'pill-row', style: 'gap:6px' }, allBox, 'All contracts')), pick),
      h('div', { class: 'field' }, h('label', ' '), previewBtn))),
    h('div', { class: 'card-body' },
      h('div', { class: 'note-box' },
        h('strong', 'How days are counted. '),
        'Every date the contract runs is worth 1 day when all of its runs operated or were cancelled, ½ day when only some did, and nothing when the whole day was taken off. Cancelled runs are billed; runs taken off are not. Weekends and days the contract does not run are never counted.'))));
  wrap.appendChild(results);
  return wrap;
};

Inv.previewTable = function (pv, state, host) {
  const items = new Map();   // contract_id -> { include, days, reason }
  for (const r of pv.rows) items.set(r.contract_id, { include: r.can_invoice && !r.needs_confirmation, days: r.days, reason: '' });

  const totalsLine = h('div', { style: 'font-weight:650' });
  const recalc = () => {
    let n = 0, days = 0, sub = 0, vat = 0, tot = 0;
    for (const r of pv.rows) {
      const it = items.get(r.contract_id);
      if (!it.include || !r.po_number || it.days <= 0) continue;
      const s = Math.round(it.days * r.daily_rate * 100) / 100;
      const v = Math.round(s * pv.vat_rate) / 100;
      n++; days += it.days; sub += s; vat += v; tot += s + v;
    }
    totalsLine.textContent = `${plural(n, 'invoice')} · ${daysText(days)} days · subtotal ${fmt.money(sub)} · VAT ${fmt.money(vat)} · total ${fmt.money(tot)}`;
    genBtn.disabled = n === 0;
    genBtn.textContent = n ? `Generate ${plural(n, 'invoice')} (numbers from ${pv.prefix} ${pv.next_number})` : 'Nothing to generate';
  };

  const rowsEl = pv.rows.map(r => {
    const it = items.get(r.contract_id);
    const include = h('input', { type: 'checkbox', checked: it.include, disabled: !r.can_invoice });
    const daysIn = h('input', { type: 'number', step: '0.5', min: '0', value: r.days, style: 'width:72px', disabled: !r.can_invoice });
    const reasonIn = h('input', { type: 'text', placeholder: 'Reason for the change (required)', style: 'width:220px', hidden: true });
    const b = r.breakdown;
    daysIn.oninput = () => {
      const v = Number(daysIn.value);
      it.days = v;
      reasonIn.hidden = v === r.days;
      recalc();
    };
    reasonIn.oninput = () => { it.reason = reasonIn.value; };
    include.onchange = () => {
      if (include.checked && r.needs_confirmation) {
        UI.confirm(`${r.code} has already been invoiced for dates in this period (${r.overlaps.map(o => o.invoice_no).join(', ')}). Invoice it again anyway?`,
          () => { it.include = true; recalc(); }, { yes: 'Invoice it again', danger: false });
        include.checked = false; it.include = false;
        return;
      }
      it.include = include.checked; recalc();
    };
    const detail = h('div', { class: 'inv-dates', hidden: true },
      UI.table([
        { key: 'date', label: 'Date', value: d => fmt.dateLong(d.date), nowrap: true },
        { key: 'runs', label: 'Runs', num: true },
        { key: 'billable', label: 'Billed', num: true },
        { key: 'value', label: 'Days', num: true, value: d => d.value === 0.5 ? '½' : d.value },
        { label: 'What happened', sortable: false, value: d => d.detail },
      ], b.dates, { empty: 'No scheduled dates in this period' }));
    const showBtn = h('button', { class: 'btn xs', onclick: () => { detail.hidden = !detail.hidden; showBtn.textContent = detail.hidden ? 'Show dates' : 'Hide dates'; } }, 'Show dates');
    return h('div', { class: 'inv-row' + (r.can_invoice ? '' : ' blocked') },
      h('div', { class: 'inv-main' },
        h('label', { class: 'inv-pick' }, include),
        h('div', { class: 'inv-who' },
          h('a', { href: '#/contracts/' + r.contract_id }, h('strong', r.code)),
          h('div', { style: 'font-size:12px;color:var(--text-dim)' }, r.school_name || 'No school'),
          r.po_number ? h('div', { style: 'font-size:12px' }, 'PO ', h('strong', r.po_number)) : h('span', { class: 'badge red' }, 'No PO number')),
        h('div', { class: 'inv-break' },
          h('div', null, `${plural(b.scheduled_days, 'scheduled day')} · ${b.full_days} full · ${b.half_days} half · ${b.days_removed} removed · ${b.days_added} added · ${b.cancelled_days} cancelled (billed)`),
          h('div', { style: 'margin-top:3px' }, 'Billable days: ', h('strong', daysText(b.billable_days)), ' ', showBtn)),
        h('div', { class: 'inv-days' }, h('label', 'Days'), daysIn, reasonIn),
        h('div', { class: 'inv-money' },
          h('div', null, `${daysText(r.days)} × ${fmt.money(r.daily_rate)}`),
          h('div', null, 'Subtotal ', h('strong', fmt.money(r.subtotal))),
          h('div', null, `VAT ${pv.vat_rate}% `, fmt.money(r.vat)),
          h('div', null, 'Total ', h('strong', fmt.money(r.total))))),
      r.warnings.length ? h('div', { class: 'inv-warn' }, ...r.warnings.map(w => h('div', { class: 'badge ' + (w.level === 'block' ? 'red' : w.level === 'warn' ? 'amber' : '') }, w.text))) : null,
      detail);
  });

  const genBtn = h('button', { class: 'btn primary' });
  genBtn.onclick = async () => {
    const chosen = pv.rows.filter(r => items.get(r.contract_id).include && r.can_invoice);
    for (const r of chosen) {
      const it = items.get(r.contract_id);
      if (it.days !== r.days && !it.reason.trim()) return toast(`${r.code}: give a reason for changing the days`, 'err');
    }
    const allowOverlap = chosen.some(r => r.needs_confirmation);
    genBtn.disabled = true; genBtn.textContent = 'Generating…';
    try {
      const res = await api.post('/api/invoicing/generate', {
        from: pv.from, to: pv.to, invoice_date: state.invoice_date, allow_overlap: allowOverlap,
        items: chosen.map(r => { const it = items.get(r.contract_id); return { contract_id: r.contract_id, days: it.days, reason: it.reason }; }),
      });
      toast(`${plural(res.invoices.length, 'invoice')} generated`, 'ok');
      host.innerHTML = '';
      host.appendChild(Inv.batchResult(res));
    } catch (e) { toast(e.message, 'err'); genBtn.disabled = false; recalc(); }
  };
  recalc();

  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', `Preview · ${fmt.date(pv.from)} to ${fmt.date(pv.to)} · invoice date ${fmt.date(pv.invoice_date)}`),
      h('span', { style: 'color:var(--text-dim);font-size:12.5px' }, 'No numbers have been assigned yet')),
    h('div', { class: 'card-body' },
      pv.rows.length ? rowsEl : UI.empty('No active contracts to invoice'),
      h('div', { class: 'pill-row', style: 'margin-top:14px;justify-content:space-between' }, totalsLine, genBtn)));
};

Inv.batchResult = function (res) {
  const list = UI.table([
    { key: 'invoice_no', label: 'Invoice', value: i => h('strong', i.invoice_no) },
    { key: 'code', label: 'Contract' },
    { key: 'po_number', label: 'PO' },
    { key: 'days', label: 'Days', num: true, value: i => daysText(i.days) + (i.override_reason ? ' *' : '') },
    { key: 'daily_rate', label: 'Rate', num: true, value: i => fmt.money(i.daily_rate) },
    { key: 'subtotal', label: 'Subtotal', num: true, value: i => fmt.money(i.subtotal) },
    { key: 'vat', label: 'VAT', num: true, value: i => fmt.money(i.vat) },
    { key: 'total', label: 'Total', num: true, value: i => fmt.money(i.total) },
    { label: '', sortable: false, value: i => h('a', { class: 'btn xs primary', href: `/api/invoices/${i.id}/pdf`, target: '_blank' }, 'Download PDF') },
  ], res.invoices);
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', `${plural(res.invoices.length, 'invoice')} generated · ${fmt.date(res.from)} to ${fmt.date(res.to)}`),
      h('div', { class: 'pill-row' },
        h('a', { class: 'btn sm', href: `/api/invoicing/batch/${res.batch_id}/zip` }, 'Download all (ZIP)'),
        h('a', { class: 'btn sm', href: `/api/invoicing/batch/${res.batch_id}/pdf`, target: '_blank' }, 'Download as one combined PDF'),
        h('a', { class: 'btn sm', href: '#/invoicing?tab=register' }, 'Open the register'))),
    h('div', { class: 'card-body tight' }, list,
      res.skipped && res.skipped.length ? h('div', { style: 'padding:10px 12px;color:var(--text-dim);font-size:12.5px' },
        'Skipped: ' + res.skipped.map(s => `${s.code} (${s.reason})`).join(', ')) : null,
      res.invoices.some(i => i.override_reason) ? h('div', { style: 'padding:6px 12px;color:var(--text-faint);font-size:12px' }, '* day count adjusted by hand; the reason is on the invoice and in the audit log') : null));
};

/* =========================================================
   REGISTER
   ========================================================= */
Inv.registerPanel = function (L, query) {
  const wrap = h('div');
  const f = { from: query.rfrom || '', to: query.rto || '', contract_id: query.contract || '', status: query.status || '', q: query.q || '' };
  const body = h('div');
  const load = async () => {
    body.innerHTML = '<div class="loading"><span class="spinner"></span></div>';
    const rows = await api.get('/api/invoices', clean(f));
    body.innerHTML = '';
    body.appendChild(UI.table([
      { key: 'number', label: 'Invoice', value: i => h('div', null, h('strong', i.invoice_no), i.override_reason ? h('div', { style: 'font-size:11px;color:var(--text-faint)' }, 'days adjusted') : null) },
      { key: 'contract_code', label: 'Contract', value: i => i.contract_id ? h('a', { href: '#/contracts/' + i.contract_id }, i.contract_code) : i.contract_code },
      { key: 'school_name', label: 'School' },
      { key: 'po_number', label: 'PO' },
      { key: 'period_from', label: 'Period', value: i => `${fmt.date(i.period_from)} – ${fmt.date(i.period_to)}`, nowrap: true },
      { key: 'invoice_date', label: 'Invoice date', value: i => fmt.date(i.invoice_date), nowrap: true },
      { key: 'days', label: 'Days', num: true, value: i => daysText(i.days) },
      { key: 'subtotal', label: 'Subtotal', num: true, value: i => fmt.money(i.subtotal) },
      { key: 'vat', label: 'VAT', num: true, value: i => fmt.money(i.vat) },
      { key: 'total', label: 'Total', num: true, value: i => fmt.money(i.total) },
      { key: 'status', label: 'Status', value: i => h('span', { class: 'badge ' + (i.status === 'paid' ? 'green' : i.status === 'void' ? 'red' : 'blue'), title: i.void_reason || (i.paid_date ? 'Paid ' + fmt.date(i.paid_date) : '') }, fmt.titleCase(i.status)) },
      { label: '', sortable: false, value: i => h('div', { class: 'pill-row' },
        h('a', { class: 'btn xs', href: `/api/invoices/${i.id}/pdf`, target: '_blank' }, 'PDF'),
        i.status === 'issued' ? h('button', { class: 'btn xs', onclick: () => UI.confirm(`Mark ${i.invoice_no} as paid?`, async () => { try { await api.put('/api/invoices/' + i.id, { status: 'paid' }); toast('Marked as paid', 'ok'); load(); } catch (e) { toast(e.message, 'err'); } }, { yes: 'Mark paid', danger: false }) }, 'Mark paid') : null,
        i.status !== 'void' ? h('button', { class: 'btn xs danger', onclick: () => Inv.voidDialog(i, load) }, 'Void') : null) },
    ], rows, { empty: 'No invoices match', sortKey: 'number', sortDir: -1 }));
  };
  const filters = h('div', { class: 'filters' },
    h('div', { class: 'field' }, h('label', 'Invoice date from'), h('input', { type: 'date', value: f.from, onchange: e => { f.from = e.target.value; load(); } })),
    h('div', { class: 'field' }, h('label', 'To'), h('input', { type: 'date', value: f.to, onchange: e => { f.to = e.target.value; load(); } })),
    h('div', { class: 'field' }, h('label', 'Contract'), h('select', { onchange: e => { f.contract_id = e.target.value; load(); } },
      h('option', { value: '' }, 'All contracts'), ...L.contracts.map(c => h('option', { value: c.id, selected: String(c.id) === String(f.contract_id) }, c.code)))),
    h('div', { class: 'field' }, h('label', 'Status'), h('select', { onchange: e => { f.status = e.target.value; load(); } },
      h('option', { value: '' }, 'All'), ...['issued', 'paid', 'void'].map(s => h('option', { value: s, selected: s === f.status }, fmt.titleCase(s))))),
    h('div', { class: 'field' }, h('label', 'Search'), h('input', { type: 'search', placeholder: 'Invoice number, contract or PO', value: f.q, oninput: e => { f.q = e.target.value; clearTimeout(f._t); f._t = setTimeout(load, 300); } })),
    h('div', { class: 'field' }, h('label', ' '), h('a', { class: 'btn sm', href: '#', onclick: e => { e.preventDefault(); window.open('/api/reports/invoices.csv?' + new URLSearchParams(clean(f)), '_blank'); } }, 'Export CSV')));
  wrap.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-head' }, filters), h('div', { class: 'card-body tight' }, body)));
  load();
  return wrap;
};

Inv.voidDialog = function (inv, reload) {
  const form = UI.form([{ name: 'reason', label: 'Why is this invoice void?', type: 'textarea', rows: 3, required: true, span: 'full', placeholder: 'e.g. Wrong day count, replaced by BLSOLO 321' }], {});
  const btn = h('button', { class: 'btn danger' }, 'Void invoice');
  const dlg = UI.modal({
    title: `Void ${inv.invoice_no}`,
    body: h('div', null, h('div', { class: 'note-box warn', style: 'margin-bottom:12px' }, 'The number ', h('strong', inv.invoice_no), ' stays used for ever. A replacement gets the next new number.'), form),
    footer: [h('button', { class: 'btn', onclick: () => dlg.close() }, 'Cancel'), btn],
  });
  btn.onclick = async () => {
    if (!form.validate()) return;
    try { await api.put('/api/invoices/' + inv.id, { status: 'void', reason: form.read().reason }); toast('Invoice voided', 'ok'); dlg.close(); reload(); }
    catch (e) { toast(e.message, 'err'); }
  };
};

/* =========================================================
   RATES AND PO NUMBERS
   ========================================================= */
Inv.ratesPanel = function () {
  const wrap = h('div');
  const body = h('div');
  const load = async () => {
    const rows = (await api.get('/api/contracts')).filter(c => c.status !== 'ended');
    const save = async (c, field, value, input) => {
      const before = c[field];
      const v = field === 'income_per_day' ? (value === '' ? 0 : Number(value)) : String(value).trim();
      if (String(before ?? '') === String(v)) return;
      input.disabled = true;
      try {
        await api.put('/api/contracts/' + c.id, { [field]: v });
        c[field] = v;
        UI.invalidateLookups();
        toast(`${c.code}: ${field === 'income_per_day' ? 'daily rate' : 'PO number'} saved — this updates the contract everywhere`, 'ok');
      } catch (e) { toast(e.message, 'err'); input.value = before ?? ''; }
      input.disabled = false;
    };
    const editable = (c, field, type) => {
      const input = h('input', { type, step: type === 'number' ? '0.01' : null, value: c[field] ?? '', style: 'width:' + (type === 'number' ? '96px' : '120px'), placeholder: field === 'po_number' ? 'Add PO' : '' });
      input.onchange = () => save(c, field, input.value, input);
      input.onkeydown = e => { if (e.key === 'Enter') input.blur(); };
      return input;
    };
    body.innerHTML = '';
    body.appendChild(UI.table([
      { key: 'code', label: 'Contract', value: c => h('a', { href: '#/contracts/' + c.id }, h('strong', c.code)) },
      { key: 'school_name', label: 'School', value: c => c.school_name || '—' },
      { key: 'days_of_week', label: 'Days', value: c => fmt.days(c.days_of_week), nowrap: true },
      { key: 'status', label: 'Status', value: c => h('span', { class: 'badge ' + (c.status === 'active' ? 'green' : '') }, fmt.titleCase(c.status)) },
      { key: 'income_per_day', label: 'Daily rate (£)', num: true, value: c => editable(c, 'income_per_day', 'number') },
      { key: 'po_number', label: 'PO number', value: c => h('div', null, editable(c, 'po_number', 'text'), c.po_number ? null : h('span', { class: 'badge red', style: 'margin-left:6px' }, 'Missing')) },
    ], rows, { empty: 'No contracts' }));
  };
  wrap.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', 'Daily rates and PO numbers'),
      h('span', { style: 'color:var(--text-dim);font-size:12.5px' }, 'These are the contract’s own fields. A change here shows on the contract, in profitability and on every future invoice; invoices already issued are unchanged.')),
    h('div', { class: 'card-body tight' }, body)));
  load();
  return wrap;
};

/* =========================================================
   SETTINGS TAB (rendered inside Settings)
   ========================================================= */
Inv.settingsTab = async function () {
  const s = await api.get('/api/invoicing/settings');
  const form = UI.form([
    { type: 'section', label: 'Invoice numbers' },
    { name: 'prefix', label: 'Prefix', value: s.prefix, help: 'Invoices are numbered "PREFIX number - School", for example BLSOLO 300 - Bamburgh Secondary.' },
    { name: 'next_number', label: 'Next invoice number', type: 'number', min: 1, value: s.next_number, help: s.max_issued != null ? `Highest number issued so far: ${s.max_issued}. This can only be raised, never lowered.` : 'Nothing issued yet. This can only be raised, never lowered.' },
    { name: 'vat_rate', label: 'VAT rate (%)', type: 'number', step: '0.5', min: 0, max: 100, value: s.vat_rate },
    { type: 'section', label: 'From (our details)' },
    { name: 'from_name', label: 'Company name', value: s.from.name, span: 'full' },
    { name: 'from_address', label: 'Address', type: 'textarea', rows: 2, value: s.from.address, span: 'full' },
    { name: 'from_tel', label: 'Telephone', value: s.from.tel },
    { name: 'from_vat_no', label: 'VAT registration number', value: s.from.vat_no },
    { type: 'section', label: 'Bill to' },
    { name: 'bill_to', label: 'Bill-to address, one line per row', type: 'textarea', rows: 5, value: s.bill_to, span: 'full' },
    { type: 'section', label: 'Payment footer' },
    { name: 'footer', label: 'Printed below the totals', type: 'textarea', rows: 3, value: s.footer, span: 'full', placeholder: 'Payment to company account …\nSort code: …\nAccount number: …' },
  ], {});
  const btn = h('button', { class: 'btn primary', onclick: async () => {
    const v = form.read();
    try {
      await api.post('/api/invoicing/settings', {
        prefix: v.prefix, next_number: v.next_number, vat_rate: v.vat_rate,
        from: { name: v.from_name, address: v.from_address, tel: v.from_tel, vat_no: v.from_vat_no },
        bill_to: v.bill_to, footer: v.footer,
      });
      toast('Invoice settings saved', 'ok'); Router.handle();
    } catch (e) { toast(e.message, 'err'); }
  } }, 'Save invoice settings');
  return UI.card('Invoicing', h('div', null, form, h('div', { style: 'margin-top:14px' }, btn)));
};
