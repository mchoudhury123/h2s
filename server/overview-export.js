'use strict';
// Excel and PDF versions of the contracts overview. Both carry the company,
// the report title, when it was generated and the period, and both hold only
// the columns the account may see and asked for.
const { workbook } = require('./xlsx');
const { Pdf } = require('./pdf');
const overview = require('./services/overview');

function ukDate(s) { if (!s) return ''; const [y, m, d] = String(s).slice(0, 10).split('-'); return `${d}/${m}/${y}`; }
function money(n) { const v = Number(n) || 0; return (v < 0 ? '-£' : '£') + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function stamp() { const d = new Date(); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }

/** The value of one column for one row, as the export should print it. */
function cellValue(col, row) {
  const v = row[col.key];
  if (col.type === 'money' || col.type === 'pct' || col.type === 'int') return v === null || v === undefined ? null : Number(v);
  if (col.type === 'date') return v ? ukDate(v) : overview.NOT_PROVIDED;
  if (v === null || v === undefined || v === '') return overview.NOT_PROVIDED;
  return String(v);
}

function titleLines(data, meta) {
  return [
    `${meta.company_label} — Contracts Overview`,
    `Generated ${stamp()} by ${meta.user_name}`,
    `Reporting period ${ukDate(data.from)} to ${ukDate(data.to)}${meta.filters ? ' · ' + meta.filters : ''}`,
    data.confidential ? 'Includes staff costs and gross profit (confidential)' : 'Contract overview without staff costs or profit',
  ];
}

function totalsRow(columns, rows, confidential) {
  const sum = k => Math.round(rows.reduce((a, r) => a + (Number(r[k]) || 0), 0) * 100) / 100;
  return columns.map((c, i) => {
    if (i === 0) return `Totals (${rows.length} contract${rows.length === 1 ? '' : 's'})`;
    if (c.type === 'money') return sum(c.key);
    if (c.key === 'child_count') return sum('child_count');
    if (c.key === 'margin_range' && confidential) { const inc = sum('income_range'); return inc > 0 ? Math.round((inc - sum('staff_cost_range')) / inc * 1000) / 10 : 0; }
    return null;
  });
}

function summarySheet(data, companies) {
  const columns = [{ label: 'Figure', width: 36 }, ...companies.map(c => ({ label: c.name, type: 'text', width: 24 }))];
  const line = (label, key, type) => [label, ...companies.map(c => c[key] === undefined ? null : (type === 'money' ? money(c[key]) : type === 'pct' ? `${c[key]}%` : c[key]))];
  const rows = [
    line('Active contracts', 'active_contracts'), line('Contracts shown', 'contracts'), line('Schools', 'schools'), line('Children', 'children'),
    line('Assigned drivers', 'drivers'), line('Assigned passenger assistants', 'pas'),
    line('Contract revenue for period', 'revenue', 'money'), line('  of which recorded to date', 'revenue_actual', 'money'), line('  of which projected', 'revenue_projected', 'money'),
    line('Invoiced in period (actual)', 'invoiced', 'money'),
  ];
  if (data.confidential) rows.push(line('Staff costs for period', 'staff_cost', 'money'), line('  of which recorded to date', 'staff_cost_actual', 'money'), line('  of which projected', 'staff_cost_projected', 'money'),
    line('Gross profit (revenue less direct staff costs)', 'gross_profit', 'money'), line('Gross profit margin', 'margin', 'pct'));
  return { name: 'Summary', title: ['Summary by company', data.confidential ? 'Gross profit is contract revenue less recorded direct staff costs; other operating expenses are not included.' : 'Contract revenue only; staff costs and profit are not included in this file.'], columns, rows };
}

function companiesForSummary(data, rows) {
  const ids = [...new Set(rows.map(r => r.company_id))];
  const list = data.summary.companies.filter(c => ids.includes(c.id)).map(c => ({ ...c, ...overview.summarise(rows.filter(r => r.company_id === c.id), data.confidential) }));
  if (ids.length > 1) list.push({ id: 0, name: 'All companies', ...overview.summarise(rows, data.confidential) });
  return list;
}

/** The .xlsx file. */
function toXlsx(data, rows, columns, meta) {
  const sheet = {
    name: 'Contracts overview',
    title: titleLines(data, meta),
    columns: columns.map(c => ({ label: c.label, type: c.type || 'text', wrap: ['children_names', 'children_pickup', 'children_dropoff', 'children_am', 'children_pm', 'children_requirements', 'other_staff', 'school_address'].includes(c.key), width: c.type === 'money' ? 16 : c.type === 'pct' || c.type === 'int' ? 11 : c.key.startsWith('children_') || c.key === 'other_staff' ? 38 : 22 })),
    rows: rows.map(r => columns.map(c => cellValue(c, r))),
    totals: [totalsRow(columns, rows, data.confidential)],
  };
  return workbook([sheet, summarySheet(data, companiesForSummary(data, rows))]);
}

/** The print-ready PDF: landscape A4, header repeated on every page, totals at the end. */
function toPdf(data, rows, columns, meta) {
  const pdf = new Pdf({ landscape: true });
  const W = pdf.W, H = pdf.H, L = 28, R = W - 28;
  const weights = columns.map(c => c.type === 'money' ? 1.1 : c.type === 'pct' || c.type === 'int' ? 0.8 : c.type === 'date' ? 0.9 : c.key.startsWith('children_') || c.key === 'other_staff' || c.key === 'school_address' ? 2.2 : c.key === 'company_name' || c.key === 'school_name' || c.key === 'code' ? 1.5 : 1.2);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map(w => (R - L) * w / totalWeight);
  const size = columns.length > 12 ? 6.5 : columns.length > 8 ? 7 : 8;
  const lh = size * 1.3;
  const grey = [0.45, 0.45, 0.45];

  let y = 0;
  const header = () => {
    pdf.addPage();
    const t = titleLines(data, meta);
    pdf.text(L, 34, t[0], { font: 'HB', size: 14 });
    pdf.text(R, 34, 'Contracts Overview', { font: 'HB', size: 10, align: 'right', color: grey });
    pdf.text(L, 48, `${t[1]} · ${t[2]}`, { size: 8, color: grey });
    pdf.text(L, 59, t[3], { size: 8, color: grey });
    y = 70;
    pdf.rect(L, y, R - L, lh * 2 + 4, { fill: [0.22, 0.19, 0.64] });
    let x = L;
    columns.forEach((c, i) => {
      const lines = wrap(pdf, c.label, widths[i] - 6, 'HB', size, 2);
      lines.forEach((ln, k) => pdf.text(x + 3, y + lh * (k + 1), ln, { font: 'HB', size, color: [1, 1, 1], align: 'left' }));
      x += widths[i];
    });
    y += lh * 2 + 8;
  };
  const wrap = (p, text, width, font, sz, maxLines) => {
    const out = [];
    for (const raw of String(text).split(/\r?\n/)) {
      let line = '';
      for (const w of raw.split(/\s+/).filter(Boolean)) {
        const trial = line ? line + ' ' + w : w;
        if (p.width(trial, font, sz) > width && line) { out.push(line); line = w; } else line = trial;
      }
      if (line) out.push(line);
      if (out.length >= maxLines) break;
    }
    if (out.length > maxLines) { out.length = maxLines; }
    if (out.length === maxLines && String(text).split(/\r?\n/).join(' ').length > out.join(' ').length) out[maxLines - 1] = out[maxLines - 1].slice(0, Math.max(0, out[maxLines - 1].length - 1)) + '…';
    return out.length ? out : [''];
  };
  const printRow = (cells, { bold = false, shade = false } = {}) => {
    const lines = cells.map((v, i) => wrap(pdf, v, widths[i] - 6, bold ? 'HB' : 'H', size, 6));
    const rowH = Math.max(...lines.map(l => l.length)) * lh + 4;
    if (y + rowH > H - 30) header();
    if (shade) pdf.rect(L, y - 2, R - L, rowH, { fill: [0.95, 0.95, 0.97] });
    let x = L;
    cells.forEach((v, i) => {
      const right = ['money', 'pct', 'int'].includes(columns[i].type);
      lines[i].forEach((ln, k) => pdf.text(right ? x + widths[i] - 3 : x + 3, y + lh * (k + 1) - 2, ln, { font: bold ? 'HB' : 'H', size, align: right ? 'right' : 'left' }));
      x += widths[i];
    });
    y += rowH;
    pdf.line(L, y - 1, R, y - 1, { width: 0.3, color: [0.8, 0.8, 0.8] });
  };
  const printable = (c, r) => {
    const v = cellValue(c, r);
    if (c.type === 'money') return v === null ? '' : money(v);
    if (c.type === 'pct') return v === null ? '' : `${Number(v).toFixed(1)}%`;
    if (c.type === 'int') return v === null ? '' : String(v);
    return v === null ? '' : String(v);
  };
  header();
  rows.forEach((r, i) => printRow(columns.map(c => printable(c, r)), { shade: i % 2 === 1 }));
  const totals = totalsRow(columns, rows, data.confidential);
  printRow(columns.map((c, i) => totals[i] === null || totals[i] === undefined ? '' : (c.type === 'money' ? money(totals[i]) : c.type === 'pct' ? `${totals[i]}%` : String(totals[i]))), { bold: true });

  // Summary block per company.
  const companies = companiesForSummary(data, rows);
  if (y + lh * 12 > H - 30) header();
  y += lh;
  pdf.text(L, y, 'Summary by company', { font: 'HB', size: 10 }); y += lh * 1.6;
  const lines = [['Active contracts', 'active_contracts'], ['Schools', 'schools'], ['Children', 'children'], ['Assigned drivers', 'drivers'], ['Assigned PAs', 'pas'],
    ['Contract revenue for period', 'revenue', 'money'], ['Recorded to date', 'revenue_actual', 'money'], ['Projected', 'revenue_projected', 'money'], ['Invoiced (actual)', 'invoiced', 'money']];
  if (data.confidential) lines.push(['Staff costs for period', 'staff_cost', 'money'], ['Gross profit (revenue less direct staff costs)', 'gross_profit', 'money'], ['Gross profit margin', 'margin', 'pct']);
  const colW = Math.min(120, (R - L - 200) / Math.max(1, companies.length));
  pdf.text(L, y, 'Figure', { font: 'HB', size: 8 });
  companies.forEach((c, i) => pdf.text(L + 200 + colW * (i + 1), y, c.name, { font: 'HB', size: 8, align: 'right' }));
  y += lh * 1.4;
  for (const [label, key, type] of lines) {
    if (y > H - 30) { header(); y += lh; }
    pdf.text(L, y, label, { size: 8 });
    companies.forEach((c, i) => pdf.text(L + 200 + colW * (i + 1), y, type === 'money' ? money(c[key]) : type === 'pct' ? `${c[key]}%` : String(c[key] ?? ''), { size: 8, align: 'right' }));
    y += lh * 1.3;
  }
  pdf.text(L, y + lh, data.confidential ? 'Gross profit is contract revenue less recorded direct staff costs; other operating expenses are not included.' : 'Contract revenue only; staff costs and profit are not included in this document.', { size: 7, color: grey });
  return pdf.render();
}

module.exports = { toXlsx, toPdf };
