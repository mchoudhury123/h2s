/* core: api client, state, router, formatting helpers */
'use strict';
const App = window.App = {
  state: { user: null, organisation: null, settings: {}, lookups: null, docTypes: {}, alertCount: 0 },
  views: {},
};

/* ---------- tiny DOM builder ---------- */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs && (typeof attrs !== 'object' || Array.isArray(attrs) || attrs instanceof Node)) { children.unshift(attrs); attrs = null; }
  for (const k in attrs || {}) {
    const v = attrs[k];
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  add(el, children);
  return el;
}
function add(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === true) continue;
    if (Array.isArray(c)) add(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
window.h = h;

/* ---------- api ---------- */
const api = window.api = {
  async request(method, path, body, isForm) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined && body !== null) {
      if (isForm) opts.body = body;
      else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    }
    const res = await fetch(path, opts);
    if (res.status === 401 && !path.endsWith('/api/login')) { App.signedOut(); throw new Error('Session expired. Please sign in again.'); }
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      if (!res.ok) throw new Error(await res.text() || res.statusText);
      return res;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  },
  get(p, q) { return api.request('GET', q ? p + '?' + new URLSearchParams(clean(q)) : p); },
  post(p, b) { return api.request('POST', p, b); },
  put(p, b) { return api.request('PUT', p, b); },
  del(p) { return api.request('DELETE', p); },
  form(p, fd) { return api.request('POST', p, fd, true); },
};
function clean(o) { const r = {}; for (const k in o) if (o[k] !== '' && o[k] !== null && o[k] !== undefined) r[k] = o[k]; return r; }
window.clean = clean;

/* ---------- formatting ---------- */
const fmt = window.fmt = {
  money(n, dash) {
    if (n === null || n === undefined || n === '') return dash === false ? '' : '—';
    const v = Number(n);
    return (v < 0 ? '-£' : '£') + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },
  money0(n) { if (n === null || n === undefined) return '—'; const v = Number(n); return (v < 0 ? '-£' : '£') + Math.abs(Math.round(v)).toLocaleString('en-GB'); },
  pct(n) { return n === null || n === undefined ? '—' : Number(n).toFixed(1) + '%'; },
  date(s) { if (!s) return '—'; const [y, m, d] = String(s).slice(0, 10).split('-'); return `${d}/${m}/${y}`; },
  dateLong(s) { if (!s) return '—'; const d = new Date(s + 'T00:00:00Z'); return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); },
  dateShort(s) { if (!s) return '—'; const d = new Date(s + 'T00:00:00Z'); return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }); },
  datetime(s) { if (!s) return '—'; return String(s).replace('T', ' ').slice(0, 16); },
  time(s) { return s ? String(s).slice(0, 5) : '—'; },
  days(mask) {
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const set = String(mask || '').split(',').filter(Boolean).map(Number);
    if (set.length === 5 && [1, 2, 3, 4, 5].every(d => set.includes(d))) return 'Mon–Fri';
    return set.map(d => names[d]).join(', ') || '—';
  },
  age(dob) { if (!dob) return null; const b = new Date(dob), n = new Date(); let a = n.getFullYear() - b.getFullYear(); const m = n.getMonth() - b.getMonth(); if (m < 0 || (m === 0 && n.getDate() < b.getDate())) a--; return a; },
  name(r) { return r ? (r.name || `${r.first_name || ''} ${r.last_name || ''}`.trim()) : ''; },
  titleCase(s) { return String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); },
};

/* ---------- dates ---------- */
const D = window.D = {
  today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; },
  add(s, n) { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); },
  dow(s) { return new Date(s + 'T00:00:00Z').getUTCDay(); },
  weekStart(s) { return D.add(s, -((D.dow(s) + 6) % 7)); },
  monthStart(s) { return s.slice(0, 8) + '01'; },
  monthEnd(s) { const [y, m] = s.split('-').map(Number); const last = new Date(Date.UTC(y, m, 0)); return last.toISOString().slice(0, 10); },
  range(a, b) { const out = []; let d = a; let guard = 0; while (d <= b && guard++ < 500) { out.push(d); d = D.add(d, 1); } return out; },
  isWeekend(s) { const w = D.dow(s); return w === 0 || w === 6; },
};

/* ---------- permissions ----------
   There are no roles. Everyone who can sign in administers their own firm and
   sees everything belonging to it. This is kept as a function so the views read
   the same, and so a future restriction has one place to live. */
App.can = function () { return true; };

/* ---------- router ---------- */
const Router = window.Router = {
  routes: [],
  on(pattern, handler) {
    const keys = [];
    const rx = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/?]+)'; }) + '$');
    Router.routes.push({ rx, keys, handler });
  },
  parse() {
    const raw = location.hash.replace(/^#/, '') || '/';
    const [path, qs] = raw.split('?');
    return { path, query: Object.fromEntries(new URLSearchParams(qs || '')) };
  },
  go(to, replace) { if (replace) location.replace('#' + to); else location.hash = to; },
  // Each navigation takes a ticket. A page that finishes loading after the user has
  // already moved on throws its result away instead of overwriting the newer page.
  // Without this, a slow page clobbers a fast one you navigated to in the meantime.
  _ticket: 0,
  async handle() {
    const ticket = ++Router._ticket;
    const stale = () => ticket !== Router._ticket;
    const { path, query } = Router.parse();
    const root = document.getElementById('root');
    const host = () => document.getElementById('view') || root;

    for (const r of Router.routes) {
      const m = r.rx.exec(path);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => params[k] = decodeURIComponent(m[i + 1]));
      App.setActiveNav(path);
      host().innerHTML = '<div class="loading"><span class="spinner"></span></div>';
      try {
        const node = await r.handler({ params, query, path });
        if (stale()) return;
        const el = host();
        el.innerHTML = '';
        if (node) el.appendChild(node);
        window.scrollTo(0, 0);
        return;
      } catch (e) {
        if (stale()) return;
        console.error(e);
        const el = host();
        el.innerHTML = '';
        el.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-body' },
          h('h2', { style: 'color:var(--red)' }, 'Could not load this page'),
          h('p', { style: 'color:var(--text-dim)' }, e.message),
          h('button', { class: 'btn', onclick: () => Router.handle() }, 'Try again'))));
        return;
      }
    }
    if (stale()) return;
    const el = host();
    el.innerHTML = '';
    el.appendChild(h('div', { class: 'empty-state' }, h('div', { class: 'big' }, '🤔'), 'Page not found: ' + path));
  },
};
window.addEventListener('hashchange', () => Router.handle());

/* ---------- toasts ---------- */
window.toast = function (msg, kind) {
  const el = h('div', { class: 'toast ' + (kind || '') }, msg);
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, kind === 'err' ? 6000 : 3200);
};

/* ---------- which journeys an exception covers ----------
   A journey number is more specific than a leg, so it wins when both are set. */
window.journeyText = function (e) {
  if (!e) return '—';
  if (e.trip_seq) return e.trip_label || `Journey ${e.trip_seq}`;
  if (!e.leg || e.leg === 'DAY') return 'All day';
  return e.leg;
};

/* ---------- pluralisation ---------- */
window.plural = function (n, one, many) { return `${n} ${n === 1 ? one : (many || one + 's')}`; };

/* ---------- traffic-light helper ---------- */
window.rag = function (status, label) {
  const map = { green: 'Compliant', amber: 'Action soon', red: 'Action required' };
  return h('span', { class: 'badge ' + (status || 'grey') }, h('span', { class: 'dot ' + (status || 'grey') }), label || map[status] || '—');
};
