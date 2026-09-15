/* app shell: sign-in, layout, navigation, universal search, routing table */
'use strict';

/* ---------- sign in ---------- */
App.renderLogin = function (message) {
  const root = document.getElementById('root');
  const err = h('div', { class: 'login-err', hidden: !message }, message || '');
  const user = h('input', { type: 'text', name: 'username', required: true, autocomplete: 'username', autofocus: true });
  const pass = h('input', { type: 'password', name: 'password', required: true, autocomplete: 'current-password' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Sign in');
  const form = h('form', { onsubmit: async e => {
    e.preventDefault();
    btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      const r = await api.post('/api/login', { username: user.value, password: pass.value });
      App.state.user = r.user; App.state.roles = r.roles;
      await App.loadMe();
      App.renderShell();
      if (!location.hash || location.hash === '#/login') location.hash = '#/';
      Router.handle();
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false;
      btn.disabled = false; btn.textContent = 'Sign in'; pass.value = ''; pass.focus();
    }
  } },
    err,
    h('div', { class: 'field' }, h('label', 'Username'), user),
    h('div', { class: 'field' }, h('label', 'Password'), pass),
    btn);

  root.innerHTML = '';
  root.appendChild(h('div', { class: 'login-page' },
    h('div', { class: 'login-card' },
      h('h1', '🚐 Transport CRM'),
      h('div', { class: 'sub' }, 'Home-to-school transport management'),
      form,
      h('div', { class: 'login-hint' },
        h('strong', 'Demo accounts'), h('br'),
        'admin / admin123 — full access', h('br'),
        'manager / manager123 — operations and finance', h('br'),
        'ops / ops123 — operations, no financial data', h('br'),
        'finance / finance123 — wages and profitability', h('br'),
        'viewer / viewer123 — read only'))));
};

App.signedOut = function () {
  App.state.user = null;
  App.renderLogin('Your session has ended. Please sign in again.');
};

App.loadMe = async function () {
  const me = await api.get('/api/me');
  App.state.user = me.user;
  App.state.permissions = me.permissions;
  App.state.roles = me.roles;
  App.state.settings = me.settings;
  App.state.docTypes = me.doc_types;
  return me;
};

/* ---------- shell ---------- */
const NAV = [
  { group: 'Operations', items: [
    { path: '/', label: 'Dashboard', icon: '▦' },
    { path: '/calendar', label: 'Calendar', icon: '▤', perm: 'view' },
    { path: '/day/today', label: 'Today', icon: '◉', perm: 'view' },
  ] },
  { group: 'Records', items: [
    { path: '/contracts', label: 'Contracts', icon: '📋', perm: 'view' },
    { path: '/children', label: 'Children', icon: '🧒', perm: 'view' },
    { path: '/staff/list/driver', label: 'Drivers', icon: '🚐', perm: 'view' },
    { path: '/staff/list/pa', label: 'Passenger assistants', icon: '🧑‍🤝‍🧑', perm: 'view' },
    { path: '/schools', label: 'Schools', icon: '🏫', perm: 'view' },
    { path: '/councils', label: 'Councils', icon: '🏛', perm: 'view' },
    { path: '/vehicles', label: 'Vehicles', icon: '🚙', perm: 'view' },
  ] },
  { group: 'Staffing', items: [
    { path: '/pool', label: 'Staff pool', icon: '🔍', perm: 'view' },
    { path: '/compliance', label: 'Compliance', icon: '🚦', perm: 'view', countKey: 'compliance' },
  ] },
  { group: 'Money', items: [
    { path: '/wages', label: 'Wages', icon: '💷', perm: 'wages' },
    { path: '/payroll', label: 'Payroll history', icon: '🧾', perm: 'wages' },
    { path: '/finance', label: 'Profitability', icon: '📈', perm: 'finance' },
    { path: '/expenses', label: 'Expenses', icon: '🧮', perm: 'finance' },
  ] },
  { group: 'Admin', items: [
    { path: '/reports', label: 'Reports', icon: '📑', perm: 'reports' },
    { path: '/audit', label: 'Audit log', icon: '🕓', perm: 'audit' },
    { path: '/settings', label: 'Settings', icon: '⚙', perm: 'view' },
  ] },
];

App.renderShell = function () {
  const root = document.getElementById('root');
  const u = App.state.user;
  const sidebar = h('aside', { class: 'sidebar', id: 'sidebar' },
    h('div', { class: 'brand' },
      h('div', { class: 'logo' }, '🚐 ', h('span', 'Transport CRM')),
      h('div', { class: 'sub' }, App.state.settings.company_name || 'Operations')),
    h('nav', { class: 'nav', id: 'nav' }),
    h('div', { class: 'userbox' },
      h('div', { class: 'who' }, u.name),
      h('div', { class: 'role' }, (App.state.roles[u.role] || {}).label || u.role),
      h('div', { class: 'acts' },
        h('a', { href: '#', onclick: e => { e.preventDefault(); App.toggleTheme(); } }, 'Theme'),
        h('a', { href: '#', onclick: async e => { e.preventDefault(); await api.post('/api/logout'); App.state.user = null; App.renderLogin('You have been signed out.'); } }, 'Sign out'))));

  const searchInput = h('input', { type: 'search', placeholder: 'Search children, schools, contracts, drivers, PAs, postcodes…', id: 'usearch', autocomplete: 'off' });
  const resultsBox = h('div', { class: 'results', hidden: true, id: 'sresults' });
  const topbar = h('header', { class: 'topbar' },
    h('button', { class: 'btn menu-btn', onclick: () => document.getElementById('sidebar').classList.toggle('open') }, '☰'),
    h('div', { class: 'searchwrap' },
      h('span', { class: 'sicon' }, '🔍'), searchInput, h('kbd', '/'), resultsBox),
    h('a', { class: 'btn', href: '#/calendar' }, 'Calendar'),
    App.can('calendar') ? h('button', { class: 'btn primary', onclick: () => App.quickException() }, '+ Exception') : null);

  root.innerHTML = '';
  root.appendChild(h('div', { id: 'app' }, sidebar,
    h('div', { class: 'main' }, topbar, h('main', { class: 'content', id: 'view' }))));

  App.buildNav();
  App.wireSearch(searchInput, resultsBox);
};

App.buildNav = function (counts) {
  const nav = document.getElementById('nav');
  if (!nav) return;
  nav.innerHTML = '';
  for (const g of NAV) {
    const items = g.items.filter(i => !i.perm || App.can(i.perm));
    if (!items.length) continue;
    const grp = h('div', { class: 'nav-group' }, h('div', { class: 'nav-title' }, g.group));
    for (const i of items) {
      const href = i.path === '/day/today' ? '#/day/' + D.today() : '#' + i.path;
      grp.appendChild(h('a', { href, dataset: { path: i.path } },
        h('span', { class: 'ico' }, i.icon), h('span', i.label),
        i.countKey && counts && counts[i.countKey] ? h('span', { class: 'count' + (counts[i.countKey + '_tone'] === 'amber' ? ' amber' : '') }, counts[i.countKey]) : null));
    }
    nav.appendChild(grp);
  }
  App.setActiveNav(Router.parse().path);
};
App.refreshNavCounts = function (dash) {
  App.buildNav({ compliance: dash.compliance.red, compliance_tone: dash.compliance.red ? 'red' : 'amber' });
};
App.setActiveNav = function (path) {
  document.querySelectorAll('#nav a').forEach(a => {
    const p = a.dataset.path;
    const active = p === '/' ? path === '/' : (p === '/day/today' ? path.startsWith('/day/') : path.startsWith(p.replace('/list/driver', '/list/driver').replace('/list/pa', '/list/pa')));
    a.classList.toggle('active', !!active);
  });
  document.getElementById('sidebar')?.classList.remove('open');
};
App.toggleTheme = function () {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : cur === 'light' ? '' : 'dark';
  if (next) document.documentElement.setAttribute('data-theme', next); else document.documentElement.removeAttribute('data-theme');
  try { localStorage.setItem('h2s-theme', next); } catch (e) {}
  toast(next ? `Theme: ${next}` : 'Theme: follow system');
};

/* ---------- universal search ---------- */
App.wireSearch = function (input, box) {
  let timer = null, items = [], sel = -1;
  const hide = () => { box.hidden = true; sel = -1; };
  const render = data => {
    box.innerHTML = ''; items = [];
    if (!data.groups.length) { box.appendChild(h('div', { class: 'empty' }, `Nothing found for “${data.query}”`)); box.hidden = false; return; }
    for (const g of data.groups) {
      const grp = h('div', { class: 'grp' }, h('div', { class: 'glabel' }, g.label));
      for (const it of g.items) {
        const a = h('a', { class: 'item', href: it.href, onclick: () => { hide(); input.value = ''; } },
          h('div', { class: 't' }, it.title, it.badge ? h('span', { class: 'badge', style: 'margin-left:7px' }, fmt.titleCase(it.badge)) : null),
          it.subtitle ? h('div', { class: 's' }, it.subtitle) : null,
          it.meta ? h('div', { class: 'm' }, it.meta) : null);
        grp.appendChild(a); items.push(a);
      }
      box.appendChild(grp);
    }
    box.hidden = false;
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { hide(); return; }
    timer = setTimeout(async () => {
      try { render(await api.get('/api/search', { q })); } catch (e) { hide(); }
    }, 160);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { hide(); input.blur(); return; }
    if (box.hidden || !items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[sel]?.classList.remove('sel');
      sel = e.key === 'ArrowDown' ? Math.min(sel + 1, items.length - 1) : Math.max(sel - 1, 0);
      items[sel].classList.add('sel'); items[sel].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = items[sel >= 0 ? sel : 0];
      if (target) { location.hash = target.getAttribute('href').slice(1); input.value = ''; hide(); input.blur(); }
    }
  });
  document.addEventListener('click', e => { if (!box.contains(e.target) && e.target !== input) hide(); });
  document.addEventListener('keydown', e => {
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) { e.preventDefault(); input.focus(); input.select(); }
  });
};

/* ---------- quick exception from anywhere ---------- */
App.quickException = async function () {
  const L = await UI.lookups();
  const active = L.contracts.filter(c => c.status === 'active');
  const form = UI.form([
    { name: 'contract_id', label: 'Contract', type: 'select', required: true, options: active.map(c => ({ value: c.id, label: c.code })) },
    { name: 'date', label: 'Date', type: 'date', required: true, value: D.today() },
  ], {});
  const btn = h('button', { class: 'btn primary' }, 'Open day');
  const m = UI.modal({
    title: 'Record an exception', width: 'narrow',
    body: h('div', null, h('p', { style: 'margin:0 0 12px;color:var(--text-dim)' }, 'Choose the contract and date, then record what was different.'), form),
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), btn],
  });
  btn.onclick = () => {
    if (!form.validate()) return;
    const v = form.read();
    m.close();
    Ops.dayDialog(Number(v.contract_id), v.date, () => Router.handle());
  };
};

/* ---------- routes ---------- */
Router.on('/', App.views.dashboard);
Router.on('/calendar', App.views.calendar);
Router.on('/day/:date', App.views.day);
Router.on('/contracts', App.views.contracts);
Router.on('/contracts/:id', App.views.contractDetail);
Router.on('/children', App.views.children);
Router.on('/children/:id', App.views.childDetail);
Router.on('/staff/list/:type', App.views.staffList);
Router.on('/staff/:id', App.views.staffDetail);
Router.on('/schools', App.views.schools);
Router.on('/schools/:id', App.views.schoolDetail);
Router.on('/councils', App.views.councils);
Router.on('/councils/:id', App.views.councilDetail);
Router.on('/vehicles', App.views.vehicles);
Router.on('/pool', App.views.pool);
Router.on('/compliance', App.views.compliance);
Router.on('/wages', App.views.wages);
Router.on('/payroll', App.views.payrollRuns);
Router.on('/finance', App.views.finance);
Router.on('/expenses', App.views.expenses);
Router.on('/reports', App.views.reports);
Router.on('/audit', App.views.audit);
Router.on('/settings', App.views.settings);

/* ---------- boot ---------- */
(async function boot() {
  try { const t = localStorage.getItem('h2s-theme'); if (t) document.documentElement.setAttribute('data-theme', t); } catch (e) {}
  try {
    await App.loadMe();
    App.renderShell();
    if (!location.hash) location.hash = '#/';
    Router.handle();
  } catch (e) {
    App.renderLogin();
  }
})();
