'use strict';
// Invoicing: one invoice per contract per period, numbered once and never
// reused, printed from a snapshot so a contract can change later without an
// issued invoice changing with it.
//
// Days come from the same journey engine as the calendar and the wages. A
// date counts as a full day when every run on it was operated or cancelled
// (the council still pays for a cancelled run), half a day when only some
// runs were, and nothing when the whole day was taken off. Weekends and days
// the contract does not run are never counted.
const crypto = require('crypto');
const { all, get, run, transaction, getSetting, setSetting, insert } = require('../db');
const cal = require('./calendar');
const { Pdf } = require('../pdf');
const { round2 } = cal;

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ['issued', 'paid', 'void'];

// ---------------------------------------------------------------- settings

const DEFAULTS = {
  prefix: 'INV',
  next_number: 1,
  vat_rate: 20,
  from: { name: '', address: '', tel: '', vat_no: '' },
  bill_to: '',
  footer: '',
};

/** Every invoicing setting for a business, with sensible blanks. */
async function settings(orgId) {
  const companyName = await getSetting(orgId, 'company_name', '');
  let from = { ...DEFAULTS.from, name: companyName };
  try { from = { ...from, ...JSON.parse(await getSetting(orgId, 'invoice_from', '{}')) }; } catch (_) { /* keep the blanks */ }
  await ensureCounter(orgId);
  const maxIssued = await get('SELECT MAX(number) AS n FROM invoices WHERE organisation_id = ?', [orgId]);
  return {
    prefix: await getSetting(orgId, 'invoice_prefix', DEFAULTS.prefix),
    next_number: Number(await getSetting(orgId, 'invoice_next_number', DEFAULTS.next_number)),
    vat_rate: Number(await getSetting(orgId, 'invoice_vat_rate', DEFAULTS.vat_rate)),
    from,
    bill_to: await getSetting(orgId, 'invoice_bill_to', DEFAULTS.bill_to),
    footer: await getSetting(orgId, 'invoice_footer', DEFAULTS.footer),
    max_issued: maxIssued && maxIssued.n != null ? Number(maxIssued.n) : null,
  };
}

/** The counter row must exist before a batch can lock and advance it. */
async function ensureCounter(orgId) {
  const row = await get("SELECT value FROM settings WHERE organisation_id = ? AND key = 'invoice_next_number'", [orgId]);
  if (!row) await setSetting(orgId, 'invoice_next_number', DEFAULTS.next_number);
}

/**
 * Saves invoicing settings. The next invoice number can only go up, and never
 * to a number already used, so a duplicate can never be issued by accident.
 * Returns { settings, changes } or { error }.
 */
async function saveSettings(orgId, body) {
  const before = await settings(orgId);
  const changes = [];
  if (body.prefix !== undefined) {
    const p = String(body.prefix).trim();
    if (!p) return { error: 'Enter an invoice number prefix, for example BLSOLO' };
    if (p.length > 20) return { error: 'That prefix is too long' };
    if (p !== before.prefix) { await setSetting(orgId, 'invoice_prefix', p); changes.push(`prefix ${before.prefix} → ${p}`); }
  }
  if (body.next_number !== undefined && body.next_number !== '') {
    const n = Number(body.next_number);
    if (!Number.isInteger(n) || n < 1) return { error: 'The next invoice number must be a whole number' };
    if (n < before.next_number) return { error: `The next invoice number can only be raised. It is currently ${before.next_number}.` };
    if (before.max_issued != null && n <= before.max_issued) return { error: `Invoice number ${before.max_issued} has already been issued. Choose a higher number.` };
    if (n !== before.next_number) { await setSetting(orgId, 'invoice_next_number', n); changes.push(`next invoice number ${before.next_number} → ${n}`); }
  }
  if (body.vat_rate !== undefined && body.vat_rate !== '') {
    const v = Number(body.vat_rate);
    if (!(v >= 0 && v <= 100)) return { error: 'VAT rate must be between 0 and 100' };
    if (v !== before.vat_rate) { await setSetting(orgId, 'invoice_vat_rate', v); changes.push(`VAT rate ${before.vat_rate}% → ${v}%`); }
  }
  if (body.from !== undefined) {
    const f = {
      name: String(body.from.name || '').trim(),
      address: String(body.from.address || '').trim(),
      tel: String(body.from.tel || '').trim(),
      vat_no: String(body.from.vat_no || '').trim(),
    };
    if (JSON.stringify(f) !== JSON.stringify(before.from)) { await setSetting(orgId, 'invoice_from', JSON.stringify(f)); changes.push('our details'); }
  }
  if (body.bill_to !== undefined && String(body.bill_to).trim() !== before.bill_to) {
    await setSetting(orgId, 'invoice_bill_to', String(body.bill_to).trim()); changes.push('bill-to address');
  }
  if (body.footer !== undefined && String(body.footer).trim() !== before.footer) {
    await setSetting(orgId, 'invoice_footer', String(body.footer).trim()); changes.push('payment footer');
  }
  return { settings: await settings(orgId), changes };
}

// ---------------------------------------------------------------- days

/** The council pays for a run that operated, and for one it cancelled. */
function billableRun(t) { return t.status === 'operated' || !!t.cancelled; }

/** One date's worth, in days, from its runs. */
function dayValue(day) {
  const runs = day.trips.length;
  if (!runs) return 0;
  const billable = day.trips.filter(billableRun).length;
  return billable === runs ? 1 : billable > 0 ? 0.5 : 0;
}

/**
 * Billable days for every contract over a period, with the working shown.
 * Returns a Map of contract id -> breakdown.
 */
async function billableDays(orgId, from, to, contractIds = null) {
  const data = await cal.buildCalendar(orgId, from, to, {});
  const out = new Map();
  for (const row of data.rows) {
    if (contractIds && !contractIds.includes(row.contract.id)) continue;
    const b = {
      scheduled_days: 0, full_days: 0, half_days: 0, days_removed: 0, days_added: 0,
      cancelled_days: 0, billable_days: 0, dates: [],
    };
    for (const date of data.dates) {
      const day = row.days[date];
      if (!day || !day.trips.length) continue;
      const value = dayValue(day);
      const cancelled = day.trips.filter(t => t.cancelled && t.status !== 'operated').length;
      const added = day.trips.some(t => t.source === 'extra');
      b.scheduled_days += 1;
      if (value === 1) b.full_days += 1;
      else if (value === 0.5) b.half_days += 1;
      else b.days_removed += 1;
      if (added) b.days_added += 1;
      if (cancelled && value > 0) b.cancelled_days += 1;
      b.billable_days += value;
      b.dates.push({
        date, value, runs: day.trips.length,
        billable: day.trips.filter(billableRun).length,
        cancelled, added,
        detail: day.trips.map(t => `${t.label}: ${billableRun(t) ? (t.status === 'operated' ? 'operated' : 'cancelled, billed') : (t.reason || 'not billed')}`).join('; '),
      });
    }
    out.set(row.contract.id, b);
  }
  return out;
}

// ---------------------------------------------------------------- preview and generate

function checkPeriod(from, to) {
  if (!DATE_RX.test(from || '') || !DATE_RX.test(to || '')) return 'Choose a from and to date';
  if (to < from) return 'The to date is before the from date';
  if (cal.dateRange(from, to).length > 120) return 'An invoice period can be at most 120 days';
  return null;
}

/** Non-void invoices for a contract whose period touches this one. */
async function overlapping(orgId, contractId, from, to) {
  return all(
    `SELECT id, invoice_no, number, period_from, period_to, status FROM invoices
     WHERE organisation_id = ? AND contract_id = ? AND status != 'void'
       AND period_from <= ? AND period_to >= ? ORDER BY number`, [orgId, contractId, to, from]);
}

/**
 * What a batch would produce, with nothing assigned. Every row says whether it
 * can be invoiced and why not.
 */
async function preview(orgId, { from, to, contract_ids = null, invoice_date = null }) {
  const bad = checkPeriod(from, to);
  if (bad) return { error: bad };
  const date = invoice_date && DATE_RX.test(invoice_date) ? invoice_date : cal.today();
  const conf = await settings(orgId);
  const ids = contract_ids && contract_ids.length ? contract_ids.map(Number) : null;

  let sql = `SELECT c.id, c.code, c.name, c.income_per_day, c.po_number, c.status, c.days_of_week, s.name AS school_name
    FROM contracts c LEFT JOIN schools s ON s.id = c.school_id
    WHERE c.organisation_id = ? AND c.status IN ('active','suspended')`;
  const params = [orgId];
  if (ids) { sql += ` AND c.id IN (${ids.map(() => '?').join(',')})`; params.push(...ids); }
  sql += ' ORDER BY c.code';
  const contracts = await all(sql, params);
  const days = await billableDays(orgId, from, to, ids);

  const rows = [];
  for (const c of contracts) {
    const b = days.get(c.id) || { scheduled_days: 0, full_days: 0, half_days: 0, days_removed: 0, days_added: 0, cancelled_days: 0, billable_days: 0, dates: [] };
    const rate = round2(c.income_per_day || 0);
    const overlaps = await overlapping(orgId, c.id, from, to);
    const warnings = [];
    if (!c.po_number) warnings.push({ level: 'block', text: 'No PO number on this contract. Add one on the Rates & PO numbers tab before invoicing.' });
    if (b.billable_days === 0) warnings.push({ level: 'skip', text: 'No billable days in this period, so nothing to invoice.' });
    if (overlaps.length) warnings.push({ level: 'warn', text: `Already invoiced for these dates: ${overlaps.map(o => `${o.invoice_no} (${ukDate(o.period_from)} to ${ukDate(o.period_to)})`).join(', ')}.` });
    if (!rate) warnings.push({ level: 'warn', text: 'The daily rate is £0.00.' });
    const subtotal = round2(b.billable_days * rate);
    const vat = round2(subtotal * conf.vat_rate / 100);
    rows.push({
      contract_id: c.id, code: c.code, name: c.name, school_name: c.school_name || '', po_number: c.po_number || '',
      status: c.status, daily_rate: rate, breakdown: b, days: b.billable_days,
      subtotal, vat, total: round2(subtotal + vat),
      overlaps, warnings,
      can_invoice: !!c.po_number && b.billable_days > 0,
      needs_confirmation: overlaps.length > 0,
    });
  }
  return {
    from, to, invoice_date: date, prefix: conf.prefix, next_number: conf.next_number, vat_rate: conf.vat_rate,
    rows,
    totals: {
      contracts: rows.filter(r => r.can_invoice).length,
      days: rows.filter(r => r.can_invoice).reduce((a, r) => a + r.days, 0),
      subtotal: round2(rows.filter(r => r.can_invoice).reduce((a, r) => a + r.subtotal, 0)),
      vat: round2(rows.filter(r => r.can_invoice).reduce((a, r) => a + r.vat, 0)),
      total: round2(rows.filter(r => r.can_invoice).reduce((a, r) => a + r.total, 0)),
    },
  };
}

/**
 * Issues invoices. Numbers are taken inside one transaction that advances the
 * counter with a single UPDATE, which the database serialises, so two batches
 * started together can never share a number. A unique index on the number is
 * the last line of defence.
 *
 * items: [{ contract_id, days?, reason? }]. A `days` value overrides the
 * calculated figure, in halves, and must come with a reason.
 */
async function generate(orgId, user, { from, to, invoice_date, items, allow_overlap = false }) {
  const bad = checkPeriod(from, to);
  if (bad) return { error: bad };
  if (!Array.isArray(items) || !items.length) return { error: 'Choose at least one contract to invoice' };
  const date = invoice_date && DATE_RX.test(invoice_date) ? invoice_date : cal.today();
  const ids = [...new Set(items.map(i => Number(i.contract_id)).filter(Boolean))];
  const pv = await preview(orgId, { from, to, contract_ids: ids, invoice_date: date });
  if (pv.error) return { error: pv.error };
  const conf = await settings(orgId);

  const planned = [];
  const skipped = [];
  for (const item of items) {
    const row = pv.rows.find(r => r.contract_id === Number(item.contract_id));
    if (!row) return { error: `Contract ${item.contract_id} is not one that can be invoiced` };
    if (!row.po_number) return { error: `${row.code} has no PO number, so it cannot be invoiced` };
    let days = row.days;
    let overrideReason = null;
    if (item.days !== undefined && item.days !== null && item.days !== '' && Number(item.days) !== row.days) {
      const d = Number(item.days);
      if (!(d >= 0) || Math.round(d * 2) !== d * 2) return { error: `${row.code}: days must be a whole or half number` };
      if (!String(item.reason || '').trim()) return { error: `${row.code}: give a reason for changing the day count from ${daysText(row.days)} to ${daysText(d)}` };
      days = d;
      overrideReason = String(item.reason).trim();
    }
    if (days === 0) { skipped.push({ contract_id: row.contract_id, code: row.code, reason: 'No billable days' }); continue; }
    if (row.overlaps.length && !allow_overlap) {
      return { error: `${row.code} has already been invoiced for dates in this period (${row.overlaps.map(o => o.invoice_no).join(', ')}). Confirm to invoice it again.`, overlap: true };
    }
    const subtotal = round2(days * row.daily_rate);
    const vat = round2(subtotal * conf.vat_rate / 100);
    planned.push({ row, days, overrideReason, subtotal, vat, total: round2(subtotal + vat) });
  }
  if (!planned.length) return { error: 'Nothing to invoice: every chosen contract was skipped', skipped };

  // Stable numbering: alphabetical by contract code, whatever order was sent.
  planned.sort((a, b) => a.row.code.localeCompare(b.row.code));
  const batchId = crypto.randomBytes(8).toString('hex');
  const created = [];

  await transaction(async tx => {
    // Advance the counter first. On Postgres this UPDATE takes the row lock,
    // so a second batch waits here until this one has committed.
    await tx.run(
      `UPDATE settings SET value = CAST(CAST(value AS INTEGER) + CAST(? AS INTEGER) AS TEXT)
       WHERE organisation_id = ? AND key = 'invoice_next_number'`, [planned.length, orgId]);
    const after = await tx.get("SELECT value FROM settings WHERE organisation_id = ? AND key = 'invoice_next_number'", [orgId]);
    if (!after) throw new Error('The invoice counter is missing');
    let number = Number(after.value) - planned.length;

    for (const p of planned) {
      const r = p.row;
      const invoiceNo = `${conf.prefix} ${number} - ${r.school_name || r.code}`;
      const snapshot = {
        from: conf.from, bill_to: conf.bill_to, footer: conf.footer, prefix: conf.prefix, vat_rate: conf.vat_rate,
        breakdown: r.breakdown, calculated_days: r.days, override_reason: p.overrideReason,
        contract_name: r.name, generated_by: user ? user.name : null,
      };
      const id = await insert('invoices', {
        number, invoice_no: invoiceNo, contract_id: r.contract_id, contract_code: r.code,
        school_name: r.school_name || '', po_number: r.po_number,
        period_from: from, period_to: to, invoice_date: date,
        days: p.days, calculated_days: r.days, override_reason: p.overrideReason,
        daily_rate: r.daily_rate, subtotal: p.subtotal, vat_rate: conf.vat_rate, vat: p.vat, total: p.total,
        status: 'issued', batch_id: batchId, snapshot: JSON.stringify(snapshot),
        created_by: user ? user.name : null,
      }, INVOICE_COLS, tx, orgId);
      created.push({ id, number, invoice_no: invoiceNo, contract_id: r.contract_id, code: r.code, school_name: r.school_name || '',
        po_number: r.po_number, days: p.days, calculated_days: r.days, override_reason: p.overrideReason,
        daily_rate: r.daily_rate, subtotal: p.subtotal, vat: p.vat, total: p.total });
      number += 1;
    }
  });
  return { batch_id: batchId, invoices: created, skipped, from, to, invoice_date: date };
}

const INVOICE_COLS = ['number', 'invoice_no', 'contract_id', 'contract_code', 'school_name', 'po_number',
  'period_from', 'period_to', 'invoice_date', 'days', 'calculated_days', 'override_reason', 'daily_rate',
  'subtotal', 'vat_rate', 'vat', 'total', 'status', 'batch_id', 'snapshot', 'created_by'];

// ---------------------------------------------------------------- register

async function list(orgId, q = {}) {
  let sql = 'SELECT * FROM invoices WHERE organisation_id = ?';
  const params = [orgId];
  if (q.from) { sql += ' AND invoice_date >= ?'; params.push(q.from); }
  if (q.to) { sql += ' AND invoice_date <= ?'; params.push(q.to); }
  if (q.contract_id) { sql += ' AND contract_id = ?'; params.push(Number(q.contract_id)); }
  if (q.status && STATUSES.includes(q.status)) { sql += ' AND status = ?'; params.push(q.status); }
  if (q.batch_id) { sql += ' AND batch_id = ?'; params.push(String(q.batch_id)); }
  if (q.q) { sql += ' AND (LOWER(invoice_no) LIKE ? OR LOWER(contract_code) LIKE ? OR LOWER(po_number) LIKE ?)'; const like = '%' + String(q.q).toLowerCase() + '%'; params.push(like, like, like); }
  sql += ' ORDER BY number DESC';
  const rows = await all(sql, params);
  return rows.map(r => { delete r.snapshot; return r; });
}

async function one(orgId, id) {
  const row = await get('SELECT * FROM invoices WHERE id = ? AND organisation_id = ?', [id, orgId]);
  if (!row) return null;
  try { row.snapshot = JSON.parse(row.snapshot || '{}'); } catch (_) { row.snapshot = {}; }
  return row;
}

async function byBatch(orgId, batchId) {
  const rows = await all('SELECT * FROM invoices WHERE organisation_id = ? AND batch_id = ? ORDER BY number', [orgId, batchId]);
  for (const r of rows) { try { r.snapshot = JSON.parse(r.snapshot || '{}'); } catch (_) { r.snapshot = {}; } }
  return rows;
}

/** Paid, or void with a reason. A void invoice keeps its number for ever. */
async function setStatus(orgId, id, status, reason) {
  const inv = await one(orgId, id);
  if (!inv) return { error: 'Invoice not found' };
  if (!STATUSES.includes(status)) return { error: 'Unknown status' };
  if (inv.status === 'void') return { error: 'A void invoice cannot be changed' };
  if (status === 'void' && !String(reason || '').trim()) return { error: 'Give the reason this invoice is void' };
  const paidDate = status === 'paid' ? cal.today() : null;
  await run('UPDATE invoices SET status = ?, void_reason = ?, paid_date = ? WHERE id = ? AND organisation_id = ?',
    [status, status === 'void' ? String(reason).trim() : null, paidDate, id, orgId]);
  return { invoice: await one(orgId, id), before: inv.status };
}

// ---------------------------------------------------------------- pdf

function ukDate(s) { if (!s) return ''; const [y, m, d] = String(s).slice(0, 10).split('-'); return `${d}/${m}/${y}`; }
function money(n) {
  const v = Number(n) || 0;
  return (v < 0 ? '-£' : '£') + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function daysText(n) { const v = Number(n) || 0; return Number.isInteger(v) ? String(v) : v.toFixed(1); }
function fileName(inv) { return String(inv.invoice_no).replace(/[\\/:*?"<>|]+/g, '-').trim() + '.pdf'; }

/** Draws one invoice on the current page of a Pdf. */
function drawInvoice(pdf, inv) {
  const snap = inv.snapshot || {};
  const from = snap.from || {};
  const L = 48, R = 595.28 - 48;
  const grey = [0.35, 0.35, 0.35];
  const rule = [0.75, 0.75, 0.75];

  pdf.text(L, 70, 'INVOICE', { font: 'HB', size: 24 });
  if (inv.status === 'void') pdf.text(R, 70, 'VOID', { font: 'HB', size: 24, align: 'right', color: [0.8, 0.1, 0.1] });

  // Our details, left.
  let y = 100;
  if (from.name) { pdf.text(L, y, from.name, { font: 'HB', size: 11 }); y += 15; }
  if (from.address) y = pdf.paragraph(L, y, from.address, 260, { size: 9.5 });
  if (from.tel) { pdf.text(L, y, `Tel No: ${from.tel}`, { size: 9.5 }); y += 13; }
  if (from.vat_no) { pdf.text(L, y, `VAT Reg No: ${from.vat_no}`, { size: 9.5 }); y += 13; }
  const leftBottom = y;

  // Invoice facts, right. Each label sits above its value so a long invoice
  // number or date range never runs into the label beside it.
  let ry = 100;
  const fact = (label, value, bold) => {
    pdf.text(R, ry, label, { size: 8.5, color: grey, align: 'right' });
    pdf.text(R, ry + 13, value, { font: bold ? 'HB' : 'H', size: bold ? 11 : 10, align: 'right' });
    ry += 30;
  };
  fact('Invoice number', inv.invoice_no, true);
  fact('Invoice date', ukDate(inv.invoice_date));
  fact('Supply of transport', `${ukDate(inv.period_from)} - ${ukDate(inv.period_to)}`);

  // Bill to.
  y = Math.max(leftBottom, ry) + 22;
  pdf.text(L, y, 'BILL TO', { font: 'HB', size: 9, color: grey }); y += 14;
  y = pdf.paragraph(L, y, snap.bill_to || '', 300, { size: 10 });

  // The line.
  y += 18;
  const cols = [
    { label: 'PO Number', x: L + 6, w: 90, align: 'left' },
    { label: 'No. of days', x: L + 96, w: 70, align: 'right' },
    { label: 'School', x: L + 180, w: 170, align: 'left' },
    { label: 'Daily rate', x: R - 110, w: 90, align: 'right' },
    { label: 'Amount', x: R - 6, w: 90, align: 'right' },
  ];
  pdf.rect(L, y, R - L, 20, { fill: [0.92, 0.92, 0.92] });
  for (const c of cols) pdf.text(c.align === 'right' ? c.x + (c.label === 'No. of days' ? 70 : 0) : c.x, y + 14, c.label, { font: 'HB', size: 9, align: c.align });
  y += 20;
  const rowH = 22;
  pdf.rect(L, y, R - L, rowH, { stroke: rule });
  pdf.text(cols[0].x, y + 15, inv.po_number || '', { size: 10 });
  pdf.text(cols[1].x + 70, y + 15, daysText(inv.days), { size: 10, align: 'right' });
  pdf.text(cols[2].x, y + 15, inv.school_name || inv.contract_code || '', { size: 10 });
  pdf.text(cols[3].x, y + 15, money(inv.daily_rate), { size: 10, align: 'right' });
  pdf.text(cols[4].x, y + 15, money(inv.subtotal), { size: 10, align: 'right' });
  y += rowH;

  // Totals, right.
  y += 16;
  const totalsLabelX = R - 130, totalsValX = R - 6;
  pdf.text(totalsLabelX, y, 'Subtotal', { size: 10 }); pdf.text(totalsValX, y, money(inv.subtotal), { size: 10, align: 'right' }); y += 16;
  pdf.text(totalsLabelX, y, `VAT ${daysText(inv.vat_rate)}%`, { size: 10 }); pdf.text(totalsValX, y, money(inv.vat), { size: 10, align: 'right' }); y += 8;
  pdf.line(totalsLabelX, y, R, y, { color: rule }); y += 14;
  pdf.text(totalsLabelX, y, 'Total', { font: 'HB', size: 11 }); pdf.text(totalsValX, y, money(inv.total), { font: 'HB', size: 11, align: 'right' }); y += 26;

  if (inv.override_reason) {
    pdf.text(L, y, `Days adjusted from ${daysText(inv.calculated_days)} to ${daysText(inv.days)}: ${inv.override_reason}`, { size: 8.5, color: grey });
    y += 14;
  }
  if (inv.status === 'void' && inv.void_reason) {
    pdf.text(L, y, `Void: ${inv.void_reason}`, { size: 8.5, color: [0.8, 0.1, 0.1] });
    y += 14;
  }

  // Payment footer.
  y = Math.max(y + 10, 700);
  pdf.line(L, y, R, y, { color: rule }); y += 18;
  y = pdf.paragraph(L, y, snap.footer || '', R - L, { size: 10 });
}

function pdfFor(inv) { const pdf = new Pdf(); pdf.addPage(); drawInvoice(pdf, inv); return pdf.render(); }
function pdfForMany(invoices) { const pdf = new Pdf(); for (const inv of invoices) { pdf.addPage(); drawInvoice(pdf, inv); } return pdf.render(); }

module.exports = {
  settings, saveSettings, billableDays, preview, generate, list, one, byBatch, setStatus,
  pdfFor, pdfForMany, fileName, ukDate, money, daysText, STATUSES, billableRun, dayValue,
};
