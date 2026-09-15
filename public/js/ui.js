/* ui: modal, forms, tables, and shared building blocks */
'use strict';
const UI = window.UI = {};
UI.openModals = new Set();
UI.closeAll = function () { for (const close of [...UI.openModals]) close(); };

/* ---------- modal ---------- */
UI.modal = function ({ title, body, footer, width, onClose }) {
  const root = document.getElementById('modal-root');
  const bg = h('div', { class: 'modal-bg' });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    bg.remove();
    document.removeEventListener('keydown', esc);
    window.removeEventListener('hashchange', close);
    UI.openModals.delete(close);
    if (onClose) onClose();
  };
  const esc = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc);
  // A link inside the modal navigates the app, so the modal must not linger over the new page.
  window.addEventListener('hashchange', close);
  UI.openModals.add(close);
  bg.addEventListener('mousedown', e => { if (e.target === bg) close(); });
  const modal = h('div', { class: 'modal ' + (width || '') },
    h('div', { class: 'modal-head' }, h('h2', title), h('button', { class: 'x', onclick: close, title: 'Close' }, '×')),
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-foot' }, footer) : null);
  bg.appendChild(modal);
  root.appendChild(bg);
  const first = modal.querySelector('input:not([type=hidden]), select, textarea');
  if (first) setTimeout(() => first.focus(), 40);
  return { close, modal, bg };
};

UI.confirm = function (message, onYes, { title = 'Please confirm', yes = 'Confirm', danger = true } = {}) {
  const m = UI.modal({
    title, width: 'narrow',
    body: h('p', { style: 'margin:0' }, message),
    footer: [
      h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
      h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: async () => { m.close(); await onYes(); } }, yes),
    ],
  });
  return m;
};

/* ---------- form builder ----------
   fields: [{ name, label, type, options, value, required, help, span, min, max, step, rows, when }] */
UI.form = function (fields, values = {}) {
  const wrap = h('div', { class: 'form-grid' });
  const controls = {};
  for (const f of fields) {
    if (f.type === 'section') { wrap.appendChild(h('div', { class: 'field full', style: 'margin-top:4px' }, h('h3', { style: 'color:var(--text-faint);font-size:11px;text-transform:uppercase;letter-spacing:.07em' }, f.label))); continue; }
    const v = values[f.name] !== undefined && values[f.name] !== null ? values[f.name] : (f.value !== undefined ? f.value : '');
    let input;
    if (f.type === 'select') {
      input = h('select', { name: f.name, required: f.required },
        ...(f.placeholder !== false ? [h('option', { value: '' }, f.placeholder || '— none —')] : []),
        ...(f.options || []).map(o => {
          const val = typeof o === 'object' ? o.value : o;
          const lab = typeof o === 'object' ? o.label : o;
          return h('option', { value: val, selected: String(val) === String(v) }, lab);
        }));
    } else if (f.type === 'textarea') {
      input = h('textarea', { name: f.name, rows: f.rows || 3, required: f.required, placeholder: f.placeholder || '' }, String(v ?? ''));
    } else if (f.type === 'checkbox') {
      input = h('input', { type: 'checkbox', name: f.name, checked: !!Number(v) });
      const fieldEl = h('div', { class: 'field check ' + (f.span === 'full' ? 'full' : '') }, input, h('label', f.label));
      wrap.appendChild(fieldEl); controls[f.name] = input; continue;
    } else if (f.type === 'days') {
      const set = String(v || '1,2,3,4,5').split(',').filter(Boolean);
      const names = [['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat'], ['0', 'Sun']];
      input = h('div', { class: 'daypicker', dataset: { name: f.name } },
        ...names.map(([val, lab]) => h('label', h('input', { type: 'checkbox', value: val, checked: set.includes(val) }), h('span', lab))));
      wrap.appendChild(h('div', { class: 'field full' }, h('label', f.label), input, f.help ? h('div', { class: 'help' }, f.help) : null));
      controls[f.name] = input; continue;
    } else {
      input = h('input', { type: f.type || 'text', name: f.name, value: v ?? '', required: f.required, min: f.min, max: f.max, step: f.step, placeholder: f.placeholder || '', autocomplete: 'off' });
    }
    const field = h('div', { class: 'field ' + (f.span === 'full' ? 'full' : '') },
      h('label', f.label + (f.required ? ' *' : '')), input, f.help ? h('div', { class: 'help' }, f.help) : null);
    wrap.appendChild(field);
    controls[f.name] = input;
  }
  wrap.read = function () {
    const out = {};
    for (const f of fields) {
      if (f.type === 'section') continue;
      const c = controls[f.name];
      if (!c) continue;
      if (f.type === 'checkbox') out[f.name] = c.checked ? 1 : 0;
      else if (f.type === 'days') out[f.name] = [...c.querySelectorAll('input:checked')].map(i => i.value).join(',');
      else if (f.type === 'number') out[f.name] = c.value === '' ? null : Number(c.value);
      else out[f.name] = c.value;
    }
    return out;
  };
  wrap.controls = controls;
  wrap.validate = function () {
    for (const name in controls) {
      const c = controls[name];
      if (c.checkValidity && !c.checkValidity()) { c.reportValidity(); return false; }
    }
    return true;
  };
  return wrap;
};

/* Standard record editor modal backed by the form builder. */
UI.editor = function ({ title, fields, values, onSave, width = 'wide', extraFooter }) {
  const form = UI.form(fields, values || {});
  const saveBtn = h('button', { class: 'btn primary' }, 'Save');
  const m = UI.modal({
    title, width, body: form,
    footer: [extraFooter || null, h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), saveBtn],
  });
  saveBtn.onclick = async () => {
    if (!form.validate()) return;
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    try { await onSave(form.read()); m.close(); }
    catch (e) { toast(e.message, 'err'); saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
  };
  return m;
};

/* ---------- tables ----------
   columns: [{ key, label, value(row)->Node|string, num, width, sort(row)->comparable, nowrap }] */
UI.table = function (columns, rows, opts = {}) {
  let sortKey = opts.sortKey || null, sortDir = opts.sortDir || 1;
  const wrap = h('div', { class: 'table-wrap' });
  const render = () => {
    let data = rows.slice();
    if (sortKey) {
      const col = columns.find(c => (c.key || c.label) === sortKey);
      if (col) {
        const gv = r => col.sort ? col.sort(r) : (col.key ? r[col.key] : '');
        data.sort((a, b) => {
          const x = gv(a), y = gv(b);
          if (x === y) return 0;
          if (x === null || x === undefined) return 1;
          if (y === null || y === undefined) return -1;
          return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * sortDir;
        });
      }
    }
    const table = h('table', { class: 'tbl' },
      h('thead', h('tr', ...columns.map(c => {
        const key = c.key || c.label;
        const th = h('th', { class: (c.num ? 'num ' : '') + (c.sortable === false ? '' : 'sortable'), style: c.width ? `width:${c.width}` : null },
          c.label + (sortKey === key ? (sortDir === 1 ? ' ▲' : ' ▼') : ''));
        if (c.sortable !== false) { th.style.cursor = 'pointer'; th.onclick = () => { if (sortKey === key) sortDir = -sortDir; else { sortKey = key; sortDir = 1; } redraw(); }; }
        return th;
      }))),
      h('tbody', ...(data.length ? data.map(r => {
        const tr = h('tr', { class: opts.onRow ? 'clickable' : '' }, ...columns.map(c => {
          const cell = c.value ? c.value(r) : (r[c.key] ?? '—');
          return h('td', { class: (c.num ? 'num ' : '') + (c.nowrap ? 'nowrap' : '') }, cell);
        }));
        if (opts.onRow) tr.onclick = e => { if (e.target.closest('a,button,input,select')) return; opts.onRow(r); };
        return tr;
      }) : [h('tr', h('td', { colspan: columns.length }, h('div', { class: 'empty-state' }, opts.empty || 'No records found')))])),
      opts.footer ? h('tfoot', opts.footer) : null);
    return table;
  };
  const redraw = () => { wrap.innerHTML = ''; wrap.appendChild(render()); };
  redraw();
  wrap.setRows = r => { rows = r; redraw(); };
  return wrap;
};

/* Searchable list page: filter box + table. */
UI.listPage = function ({ title, subtitle, actions, columns, rows, onRow, searchFields, filters, empty, extra }) {
  let query = '';
  const activeFilters = {};
  const tableHost = h('div');
  const countEl = h('span', { class: 'badge' }, '');
  const apply = () => {
    let data = rows;
    if (query) {
      const q = query.toLowerCase();
      data = data.filter(r => (searchFields || Object.keys(r)).some(f => String(r[f] ?? '').toLowerCase().includes(q)));
    }
    for (const k in activeFilters) {
      if (activeFilters[k] === '') continue;
      data = data.filter(r => String(r[k] ?? '') === activeFilters[k]);
    }
    tableHost.innerHTML = '';
    tableHost.appendChild(UI.table(columns, data, { onRow, empty }));
    countEl.textContent = `${data.length} of ${rows.length}`;
  };
  const search = h('input', { type: 'search', placeholder: 'Filter this list…', style: 'max-width:260px', oninput: e => { query = e.target.value; apply(); } });
  const filterControls = (filters || []).map(f => {
    activeFilters[f.key] = f.value || '';
    return h('div', { class: 'field' }, h('label', f.label),
      h('select', { onchange: e => { activeFilters[f.key] = e.target.value; apply(); } },
        h('option', { value: '' }, f.all || 'All'),
        ...f.options.map(o => h('option', { value: typeof o === 'object' ? o.value : o, selected: String(typeof o === 'object' ? o.value : o) === String(f.value || '') }, typeof o === 'object' ? o.label : fmt.titleCase(o)))));
  });
  apply();
  return h('div', null,
    h('div', { class: 'page-head' },
      h('div', { class: 'grow' }, h('h1', title), subtitle ? h('div', { class: 'sub' }, subtitle) : null),
      h('div', { class: 'actions' }, actions || null)),
    extra || null,
    h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', { class: 'field', style: 'flex:1;min-width:180px' }, h('label', 'Search'), search),
        ...filterControls, h('div', { style: 'align-self:flex-end;padding-bottom:7px' }, countEl)),
      h('div', { class: 'card-body tight' }, tableHost)));
};

/* ---------- detail page scaffolding ---------- */
UI.pageHead = function (title, subtitle, actions, badges) {
  return h('div', { class: 'page-head' },
    h('div', { class: 'grow' },
      h('h1', title, badges ? h('span', { style: 'margin-left:10px;font-size:13px;vertical-align:middle' }, badges) : null),
      subtitle ? h('div', { class: 'sub' }, subtitle) : null),
    h('div', { class: 'actions' }, actions || null));
};
UI.card = function (title, body, headExtra) {
  return h('div', { class: 'card' },
    title ? h('div', { class: 'card-head' }, h('h2', title), headExtra || null) : null,
    h('div', { class: 'card-body' + (body && body.dataset && body.dataset.tight ? ' tight' : '') }, body));
};
UI.cardTight = function (title, body, headExtra) {
  return h('div', { class: 'card' },
    title ? h('div', { class: 'card-head' }, h('h2', title), headExtra || null) : null,
    h('div', { class: 'card-body tight' }, body));
};
UI.kv = function (pairs) {
  const dl = h('dl', { class: 'kv' });
  for (const [k, v] of pairs) {
    if (v === false) continue;
    const empty = v === null || v === undefined || v === '' || v === '—';
    dl.appendChild(h('dt', k));
    dl.appendChild(h('dd', { class: empty ? 'empty' : '' }, empty ? 'Not recorded' : v));
  }
  return dl;
};
UI.link = function (href, text, cls) { return h('a', { href, class: cls || '' }, text); };
// Remembers the open tab per page, so re-rendering after a save keeps the user where they were.
UI.tabMemory = new Map();
UI.tabs = function (items, initial) {
  const key = Router.parse().path;
  const remembered = UI.tabMemory.get(key);
  let current = (remembered && items.some(i => i.id === remembered)) ? remembered : (initial || items[0].id);
  UI.tabMemory.set(key, current);
  const bar = h('div', { class: 'tabs' });
  const host = h('div', { style: 'margin-top:14px' });
  const draw = () => {
    UI.tabMemory.set(key, current);
    bar.innerHTML = '';
    items.forEach(it => bar.appendChild(h('button', { class: current === it.id ? 'on' : '', onclick: () => { current = it.id; draw(); } }, it.label + (it.count !== undefined ? ` (${it.count})` : ''))));
    host.innerHTML = '';
    const item = items.find(i => i.id === current);
    const node = typeof item.render === 'function' ? item.render() : item.render;
    if (node) host.appendChild(node);
  };
  draw();
  return h('div', null, bar, host);
};
UI.empty = function (msg, icon) { return h('div', { class: 'empty-state' }, h('div', { class: 'big' }, icon || '📭'), msg); };
UI.stat = function ({ label, value, hint, href, tone, onclick }) {
  const el = href ? h('a', { class: 'stat ' + (tone || ''), href }) : h('button', { class: 'stat ' + (tone || ''), onclick: onclick || null, type: 'button' });
  el.appendChild(h('div', { class: 'label' }, label));
  el.appendChild(h('div', { class: 'value' }, value));
  if (hint) el.appendChild(h('div', { class: 'hint' }, hint));
  return el;
};

/* ---------- documents panel (shared by every record type) ---------- */
UI.documentsPanel = function (entityType, entityId, docs, onChange) {
  const canEdit = App.can('documents') || App.can('*');
  const rows = docs || [];
  const list = UI.table([
    { label: '', width: '26px', sortable: false, value: d => h('span', { class: 'dot ' + (d.calculated_status || 'grey'), title: d.calculated_status }) },
    { key: 'doc_type', label: 'Document' },
    { key: 'reference', label: 'Reference', value: d => d.reference || '—' },
    { key: 'issue_date', label: 'Issued', value: d => fmt.date(d.issue_date), nowrap: true },
    { key: 'expiry_date', label: 'Expires', value: d => d.expiry_date ? h('span', null, fmt.date(d.expiry_date), d.days_left !== null && d.days_left <= 60 ? h('span', { class: 'badge ' + (d.days_left < 0 ? 'red' : 'amber'), style: 'margin-left:6px' }, d.days_left < 0 ? `${-d.days_left}d ago` : `${d.days_left}d`) : null) : 'No expiry', nowrap: true },
    { key: 'status', label: 'Status', value: d => h('span', { class: 'badge ' + (d.status === 'valid' ? '' : 'red') }, fmt.titleCase(d.status)) },
    { key: 'file_name', label: 'File', value: d => d.stored_name ? h('a', { href: `/api/documents/${d.id}/file`, target: '_blank' }, d.file_name || 'View') : h('span', { style: 'color:var(--text-faint)' }, 'No file') },
    {
      label: '', sortable: false, value: d => canEdit ? h('div', { class: 'pill-row' },
        h('button', { class: 'btn xs', onclick: () => UI.documentEditor(entityType, entityId, d, onChange) }, 'Edit'),
        h('button', { class: 'btn xs danger', onclick: () => UI.confirm(`Delete the ${d.doc_type} document? This cannot be undone.`, async () => { await api.del('/api/documents/' + d.id); toast('Document deleted', 'ok'); onChange(); }) }, 'Delete')) : null
    },
  ], rows, { empty: 'No documents uploaded yet' });
  return h('div', null,
    canEdit ? h('div', { style: 'padding:10px 14px;border-bottom:1px solid var(--border)' },
      h('button', { class: 'btn primary sm', onclick: () => UI.documentEditor(entityType, entityId, null, onChange) }, '+ Add document')) : null,
    list);
};

UI.documentEditor = function (entityType, entityId, doc, onChange) {
  const types = (App.state.docTypes && App.state.docTypes[entityType]) || ['Other'];
  const fileInput = h('input', { type: 'file', name: 'file' });
  const form = UI.form([
    { name: 'doc_type', label: 'Document type', type: 'select', options: types, placeholder: false, required: true },
    { name: 'reference', label: 'Reference / number' },
    { name: 'issue_date', label: 'Issue date', type: 'date' },
    { name: 'expiry_date', label: 'Expiry date', type: 'date', help: 'Leave blank if the document does not expire' },
    { name: 'status', label: 'Status', type: 'select', options: [{ value: 'valid', label: 'Valid' }, { value: 'invalid', label: 'Invalid / rejected' }, { value: 'superseded', label: 'Superseded' }], placeholder: false },
    { name: 'notes', label: 'Notes', type: 'textarea', span: 'full' },
  ], doc || { status: 'valid' });
  const body = h('div', null, form,
    h('div', { class: 'field', style: 'margin-top:12px' },
      h('label', doc && doc.file_name ? `Replace file (currently: ${doc.file_name})` : 'Attach file (optional)'), fileInput,
      h('div', { class: 'help' }, 'PDF, image or Office document, up to 25 MB.')));
  const saveBtn = h('button', { class: 'btn primary' }, 'Save document');
  const m = UI.modal({ title: doc ? 'Edit document' : 'Add document', body, footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), saveBtn] });
  saveBtn.onclick = async () => {
    if (!form.validate()) return;
    saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
    try {
      const vals = form.read();
      const file = fileInput.files[0];
      if (doc && !file) { await api.put('/api/documents/' + doc.id, vals); }
      else {
        const fd = new FormData();
        fd.append('entity_type', entityType); fd.append('entity_id', entityId);
        for (const k in vals) fd.append(k, vals[k] ?? '');
        if (file) fd.append('file', file);
        await api.form('/api/documents', fd);
        if (doc) await api.del('/api/documents/' + doc.id);
      }
      toast('Document saved', 'ok'); m.close(); onChange();
    } catch (e) { toast(e.message, 'err'); saveBtn.disabled = false; saveBtn.textContent = 'Save document'; }
  };
};

/* ---------- history panel ---------- */
UI.historyPanel = function (rows) {
  if (!rows || !rows.length) return UI.empty('No changes recorded yet', '🕓');
  return UI.table([
    { key: 'created_at', label: 'When', value: r => fmt.datetime(r.created_at), nowrap: true },
    { key: 'user_name', label: 'User' },
    { key: 'action', label: 'Action', value: r => h('span', { class: 'badge' }, fmt.titleCase(r.action)) },
    { key: 'summary', label: 'Detail', value: r => r.summary || [r.field, r.old_value, '→', r.new_value].filter(Boolean).join(' ') },
  ], rows, { sortKey: 'created_at', sortDir: -1 });
};

/* ---------- date range picker ---------- */
UI.dateRange = function (from, to, onChange) {
  const f = h('input', { type: 'date', value: from });
  const t = h('input', { type: 'date', value: to });
  const fire = () => onChange(f.value, t.value);
  f.onchange = fire; t.onchange = fire;
  const preset = (label, calc) => h('button', { class: 'btn sm', onclick: () => { const [a, b] = calc(); f.value = a; t.value = b; fire(); } }, label);
  const today = D.today();
  return h('div', { class: 'filters' },
    h('div', { class: 'field' }, h('label', 'From'), f),
    h('div', { class: 'field' }, h('label', 'To'), t),
    h('div', { class: 'pill-row', style: 'padding-bottom:1px' },
      preset('This week', () => [D.weekStart(today), D.add(D.weekStart(today), 6)]),
      preset('Last week', () => [D.add(D.weekStart(today), -7), D.add(D.weekStart(today), -1)]),
      preset('This month', () => [D.monthStart(today), D.monthEnd(today)]),
      preset('Last month', () => { const ls = D.monthStart(D.add(D.monthStart(today), -1)); return [ls, D.monthEnd(ls)]; }),
      preset('Last 30 days', () => [D.add(today, -29), today])));
};

/* ---------- lookups cache ---------- */
UI.lookups = async function (force) {
  if (!App.state.lookups || force) App.state.lookups = await api.get('/api/lookups');
  return App.state.lookups;
};
