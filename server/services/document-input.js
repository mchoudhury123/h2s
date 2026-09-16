'use strict';

const { Worker } = require('worker_threads');

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DATE_PATTERN = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/.\-]\d{1,2}[/.\-]\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})\b/g;

function normaliseRegistration(value) {
  const registration = String(value || '').toUpperCase().replace(/\s/g, '');
  return /^[A-Z0-9]{2,8}$/.test(registration) && /[A-Z]/.test(registration) && /\d/.test(registration) ? registration : null;
}

function registrationFromText(lines) {
  const registrations = [];
  const label = /\b(?:(?:car|vehicle)\s+reg(?:istration)?(?:\s*(?:number|no\.?))?|registration(?:\s*(?:number|no\.?|mark))?|reg(?:\.?\s*(?:number|no\.?)?)|VRM)\b\s*[:#\-]?\s*/i;
  for (let index = 0; index < lines.length; index++) {
    const match = label.exec(lines[index]);
    if (!match) continue;
    const raw = lines[index].slice(match.index + match[0].length).trim() || lines[index + 1] || '';
    const plate = raw.match(/^(?:[A-Z]{2}\s?\d{2}\s?[A-Z]{3}|[A-Z]\s?\d{1,3}\s?[A-Z]{3}|[A-Z]{3}\s?\d{1,3}\s?[A-Z]|[A-Z]{1,3}\s?\d{1,4}|\d{1,4}\s?[A-Z]{1,3})(?![A-Z0-9])/i)?.[0];
    const normalised = normaliseRegistration(plate);
    if (normalised) registrations.push(normalised);
  }
  return [...new Set(registrations)];
}

function normaliseDate(value) {
  let year, month, day;
  if (/^\d{4}-/.test(value)) [year, month, day] = value.split('-').map(Number);
  else {
    const parts = value.split(/[/.\-\s]+/);
    day = Number(parts[0]); month = /^\d+$/.test(parts[1]) ? Number(parts[1]) : MONTHS.indexOf(parts[1].slice(0, 3).toLowerCase()) + 1;
    year = Number(parts[2]);
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 1900 && year <= 2200 && month > 0 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date.toISOString().slice(0, 10) : null;
}

function extractFields(text, types, selectedType, warnings = []) {
  const fields = {};
  const issues = [...warnings];
  const lines = text.replace(/\r/g, '').split('\n').map(line => line.trim()).filter(Boolean);
  const aliases = {
    'Driving Licence': /driving licen[cs]e/i,
    'Driver Badge': /\bdriver(?:'s)?\s+(?:badge|licen[cs]e)|(?:private hire|hackney carriage)\s+driver/i,
    'Vehicle Licence': /hackney carriage licen[cs]e|(?:hackney carriage|private hire)\s+vehicle\s+licen[cs]e|vehicle licen[cs]e/i,
    DBS: /\bDBS\b|disclosure and barring|criminal record certificate/i,
    MOT: /\bMOT\b|ministry of transport/i, 'Vehicle Insurance': /(?:motor|vehicle|car) insurance|certificate of insurance/i,
    'Safeguarding Training': /safeguarding/i, 'First Aid': /first aid/i,
  };
  const matches = types.filter(type => type !== 'Other' && type !== 'Selfie picture' && (aliases[type] || new RegExp(type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).test(text));
  const heading = lines.slice(0, 6).join('\n');
  const headlineType = /hackney carriage licen[cs]e/i.test(heading) ? 'Vehicle Licence'
    : /\bdriver(?:'s)?\s+licen[cs]e\s*(?:number|no\.?)/i.test(heading) ? 'Driver Badge'
    : /driving licen[cs]e/i.test(heading) ? 'Driving Licence' : null;
  if (headlineType && types.includes(headlineType)) fields.doc_type = headlineType;
  else if (matches.length === 1) fields.doc_type = matches[0];
  else issues.push(matches.length ? 'Several document types found; confirm the document type.' : 'Document type could not be confirmed; select it manually.');
  const type = fields.doc_type || selectedType;
  const registrations = registrationFromText(lines);
  if (registrations.length === 1) fields.vehicle_registration = registrations[0];
  else if (registrations.length > 1) issues.push('Several car registrations found; choose the correct vehicle registration.');
  else if (['Vehicle Licence', 'Vehicle Insurance'].includes(type)) issues.push('Car registration not found; enter it manually.');
  const labels = {
    issue_date: /(?:date\s+(?:of\s+)?issue|issue(?:d)?\s*(?:date|on)?|valid\s+from|commencement\s+date|start\s+date|4a\.?)/i,
    expiry_date: /(?:expir(?:y|es|ation)(?:\s+date)?|valid\s+(?:until|to)|end\s+date|4b\.?)/i,
  };
  for (const [field, label] of Object.entries(labels)) {
    const dates = [];
    let labelled = false;
    for (let index = 0; index < lines.length; index++) {
      const match = label.exec(lines[index]);
      if (!match) continue;
      labelled = true;
      let remainder = lines[index].slice(match.index + match[0].length);
      const nextLabel = Object.values(labels).map(re => re.exec(remainder)?.index).filter(value => value !== undefined);
      if (nextLabel.length) remainder = remainder.slice(0, Math.min(...nextLabel));
      let values = remainder.match(DATE_PATTERN) || [];
      if (!values.length && lines[index + 1] && !Object.values(labels).some(re => re.test(lines[index + 1]))) values = lines[index + 1].match(DATE_PATTERN) || [];
      dates.push(...values.map(normaliseDate).filter(Boolean));
    }
    const unique = [...new Set(dates)];
    if (unique.length === 1) fields[field] = unique[0];
    else issues.push(unique.length > 1 ? `Conflicting ${field.replace('_', ' ')}s; enter the correct date.` : `${field === 'issue_date' ? 'Issue' : 'Expiry'} date ${labelled ? 'could not be read' : 'not found'}; enter it or confirm it does not apply.`);
  }
  const refs = [];
  const genericReferenceLabel = /(?:reference(?:\s*(?:number|no\.?))?|(?:certificate|licen[cs]e|badge|policy|document|DBS)\s*(?:number|no\.?)|ref\.?\s*(?:no\.?)?)\s*[:#\-]?\s*/i;
  const referenceLabel = type === 'Driving Licence' ? /(?:^|\s)5\s*[.)]\s*[:#\-]?\s*/i
    : type === 'Driver Badge' ? /\bdriver(?:'s)?\s+licen[cs]e\s*(?:number|no\.?)\s*[:#\-]?\s*/i : genericReferenceLabel;
  for (let index = 0; index < lines.length; index++) {
    const match = referenceLabel.exec(lines[index]);
    if (!match) continue;
    const raw = lines[index].slice(match.index + match[0].length).trim() || lines[index + 1] || '';
    const candidate = raw.split(/\s+(?:4[ab]\s*[.)]|issue|expiry|valid|registration|car reg|vehicle reg|policy)/i)[0].match(/^[A-Z0-9][A-Z0-9 /\-]{2,49}/i)?.[0]?.trim();
    if (candidate && /\d/.test(candidate) && !DATE_PATTERN.test(candidate) && !/date|issued|expiry|valid/i.test(candidate)) refs.push(candidate);
    DATE_PATTERN.lastIndex = 0;
  }
  const uniqueRefs = [...new Set(refs)];
  if (uniqueRefs.length === 1) fields.reference = uniqueRefs[0];
  else if (!uniqueRefs.length && fields.vehicle_registration && ['Vehicle Licence', 'Vehicle Insurance'].includes(type)) fields.reference = fields.vehicle_registration;
  else issues.push(uniqueRefs.length ? 'Several reference numbers found; choose the correct one.' : 'Reference / number not found; enter it or confirm it does not apply.');
  if (fields.issue_date && fields.expiry_date && fields.expiry_date < fields.issue_date) {
    delete fields.issue_date; delete fields.expiry_date;
    issues.push('Expiry date is before issue date; both dates need checking.');
  }
  if (!text.trim()) issues.push('No readable text found. Use a clearer scan or enter the details manually.');
  if (type === 'Selfie picture') issues.push('A selfie needs a person to check identity; auto input cannot verify it.');
  return { fields, issues: [...new Set(issues)], text_preview: text.slice(0, 4000), review_required: true };
}

function readDocument(file, types, selectedType) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(require.resolve('./document-reader'), { workerData: { file, types, selectedType } });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('Document reading timed out. Try a smaller or clearer file, or enter the details manually.')); }, 45000);
    worker.once('message', result => { clearTimeout(timer); worker.terminate(); result.error ? reject(new Error(result.error)) : resolve(result); });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error('Document reader stopped. Please enter the details manually.')); });
  });
}

module.exports = { normaliseDate, normaliseRegistration, extractFields, readDocument };
