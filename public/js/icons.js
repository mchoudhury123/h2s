/* icons: a small inline SVG set, drawn once here so no page needs emoji.
   Icon.svg(name, size) returns markup; Icon.el(name, size, cls) returns a span. */
'use strict';
(function () {
  const P = {
    dashboard: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
    calendar: '<rect x="3" y="4" width="18" height="17" rx="2.5"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    'calendar-x': '<rect x="3" y="4" width="18" height="17" rx="2.5"/><path d="M16 2v4M8 2v4M3 10h18M10 14l4 4M14 14l-4 4"/>',
    today: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>',
    contracts: '<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h4"/>',
    children: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
    drivers: '<rect x="1" y="4" width="15" height="12" rx="1.5"/><path d="M16 9h4l3 3v4h-7z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
    pas: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    schools: '<path d="M2 7l10-4 10 4-10 4-10-4z"/><path d="M6 9.6V15c0 1.7 3 3 6 3s6-1.3 6-3V9.6"/><path d="M22 7v6"/>',
    councils: '<path d="M3 21h18M3 10h18M5 6.5L12 3l7 3.5"/><path d="M5 10v11M19 10v11M9 14v4M12 14v4M15 14v4"/>',
    vehicles: '<path d="M5 17h14v-5l-2-5H7l-2 5v5z"/><circle cx="7.5" cy="17" r="1.5"/><circle cx="16.5" cy="17" r="1.5"/><path d="M3 12h18"/>',
    pool: '<circle cx="10" cy="8" r="4"/><path d="M2 21v-1a6 6 0 0 1 6-6h3"/><circle cx="17" cy="17" r="3"/><path d="M22 22l-2.5-2.5"/>',
    compliance: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    wages: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 12h.01M18 12h.01"/>',
    payroll: '<path d="M4 2v20l3-2 3 2 3-2 3 2 3-2V2l-3 2-3-2-3 2-3-2-3 2z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    finance: '<path d="M23 6l-9.5 9.5-5-5L1 18"/><path d="M17 6h6v6"/>',
    expenses: '<rect x="1" y="4" width="22" height="16" rx="2"/><path d="M1 10h22M6 15h4"/>',
    invoicing: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
    reports: '<path d="M18 20V10M12 20V4M6 20v-6"/>',
    audit: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>',
    menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    close: '<path d="M18 6L6 18M6 6l12 12"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/>',
    print: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
    home: '<path d="M3 9.5L12 2l9 7.5V20a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22v-9h6v9"/>',
    note: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    'check-circle': '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01"/>',
    person: '<circle cx="12" cy="5" r="2"/><path d="M4 9h16M12 9v6M8 21l4-6 4 6"/>',
    medical: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
    moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>',
    'chevron-left': '<path d="M15 18l-6-6 6-6"/>',
    'chevron-right': '<path d="M9 18l6-6-6-6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    'chevron-up': '<path d="M18 15l-6-6-6 6"/>',
    'chevron-down': '<path d="M6 9l6 6 6-6"/>',
    route: '<circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M12 19h1.5a3.5 3.5 0 0 0 0-7h-3a3.5 3.5 0 0 1 0-7H12"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    pound: '<path d="M18 7a4 4 0 0 0-8 0v10H6M7 12h7M6 17h12"/>',
  };

  function svg(name, size = 18, extraClass = '') {
    const body = P[name] || P.help;
    return `<svg class="svgi ${extraClass}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  }
  function el(name, size = 16, cls = 'ico') { return h('span', { class: cls, html: svg(name, size) }); }

  /* The brand mark: a route drawn on a rounded tile. */
  function logo(size = 30) {
    return `<svg class="logo-mark" width="${size}" height="${size}" viewBox="0 0 40 40" aria-hidden="true">
      <defs><linearGradient id="lg-brand" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#a855f7"/></linearGradient></defs>
      <rect width="40" height="40" rx="11" fill="url(#lg-brand)"/>
      <path d="M11 28c0-6 5-6 9-6s9 0 9-6" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>
      <circle cx="11" cy="28" r="3.2" fill="#fff"/><circle cx="29" cy="16" r="3.2" fill="#fff"/>
    </svg>`;
  }

  /* Legacy callers passed an emoji; map it to a name so nothing draws one. */
  const LEGACY = { '📭': 'inbox', '✅': 'check-circle', '📅': 'calendar', '🚐': 'drivers', '🧑‍🤝‍🧑': 'pas', '🕓': 'audit', '🤔': 'help', '🔍': 'search' };
  function name(n) { return P[n] ? n : (LEGACY[n] || 'inbox'); }

  window.Icon = { svg, el, logo, name, has: n => !!P[n] };
})();
