'use strict';
const assert = require('node:assert/strict');
const { extractFields, normaliseDate, readDocument } = require('../server/services/document-input');
const compliance = require('../server/services/compliance');
const { createCanvas } = require('@napi-rs/canvas');

const types = compliance.DOC_TYPES.staff;
const source = 'DBS Certificate\nCertificate number: 00123456789\nIssue date: 16/09/2026\nExpiry date: 20 December 2028';
function makePdf(text) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 650 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = 'BT /F1 18 Tf 30 250 Td ' + text.split('\n').map((line, index) => (index ? '0 -35 Td ' : '') + `(${line}) Tj`).join('\n') + ' ET';
  objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

async function main() {
  const expected = { doc_type: 'DBS', issue_date: '2026-09-16', expiry_date: '2028-12-20', reference: '00123456789' };
  assert.deepEqual(extractFields(source, types, 'Other').fields, expected);
  const vehicleLicence = extractFields('Hackney Carriage Licence\nIssue date: 16/09/2026\nExpiry date: 20/12/2028\nCar reg: AB12 CDE', types, 'Other');
  assert.deepEqual(vehicleLicence.fields, { doc_type: 'Vehicle Licence', issue_date: '2026-09-16', expiry_date: '2028-12-20', vehicle_registration: 'AB12CDE', reference: 'AB12CDE' });
  assert.equal(extractFields('Hackney Carriage Licence', types, 'Vehicle Licence').fields.doc_type, 'Vehicle Licence');
  const badge = extractFields('Driver Licence No: LN/00007306\nIssue date: 16/09/2026\nExpiry date: 20/12/2028\nDriving Licence number: IGNORE123', types, 'Other');
  assert.equal(badge.fields.doc_type, 'Driver Badge');
  assert.equal(badge.fields.reference, 'LN/00007306');
  const driving = extractFields('Driving Licence\n5. SMITH801013AB9CD\n4a. 16/09/2026 4b. 20/12/2028\nPolicy number: IGNORE123', types, 'Other');
  assert.equal(driving.fields.reference, 'SMITH801013AB9CD');
  assert.equal(driving.fields.expiry_date, '2028-12-20');
  assert.equal(extractFields('Driving Licence\nPolicy number: IGNORE123', types, 'Driving Licence').fields.reference, undefined);
  const insurance = extractFields('Certificate of Insurance\nPolicy No: POL-12345\nIssue date: 16/09/2026\nExpiry date: 20/12/2028\nReg: AB12 CDE', types, 'Other');
  assert.equal(insurance.fields.doc_type, 'Vehicle Insurance');
  assert.equal(insurance.fields.vehicle_registration, 'AB12CDE');
  assert.equal(insurance.fields.reference, 'POL-12345');
  const conflictingRegs = extractFields('Certificate of Insurance\nReg: AB12 CDE\nCar registration: XY23 ZAB', types, 'Vehicle Insurance');
  assert.equal(conflictingRegs.fields.vehicle_registration, undefined);
  assert(conflictingRegs.issues.some(issue => /Several car registrations/.test(issue)));
  assert(extractFields('Certificate of Insurance', types, 'Vehicle Insurance').issues.some(issue => /Car registration not found/.test(issue)));
  assert.equal(normaliseDate('31/02/2026'), null);
  assert.equal(normaliseDate('02/03/2026'), '2026-03-02');
  assert.equal(normaliseDate('20 December 2028'), '2028-12-20');
  assert.deepEqual(extractFields('DBS\n4a. 16/09/2026 4b. 20/12/2028', types, 'DBS').fields, { doc_type: 'DBS', issue_date: '2026-09-16', expiry_date: '2028-12-20' });
  const conflicts = extractFields(source + '\nExpiry date: 01/01/2029', types, 'Other');
  assert.equal(conflicts.fields.expiry_date, undefined);
  assert(conflicts.issues.some(issue => /Conflicting/.test(issue)));
  const unlabelled = extractFields('DBS\nDate of birth: 01/01/1980\n16/09/2026', types, 'DBS');
  assert.equal(unlabelled.fields.issue_date, undefined);
  assert.equal(unlabelled.fields.expiry_date, undefined);
  const backwards = extractFields('DBS\nIssue date: 01/01/2029\nExpiry date: 01/01/2028', types, 'DBS');
  assert.equal(backwards.fields.issue_date, undefined);
  assert(backwards.issues.some(issue => /before issue/.test(issue)));
  assert(extractFields('', types, 'Other').issues.some(issue => /No readable/.test(issue)));
  assert.equal(compliance.docStatus({ status: 'needs_review' }, 30, '2026-09-16'), 'amber');
  assert.equal(compliance.docStatus({ status: 'needs_review', expiry_date: '2020-01-01' }, 30, '2026-09-16'), 'red');
  const pdf = await readDocument({ data: makePdf(source), filename: 'certificate.pdf', mime: 'application/pdf' }, types, 'Other');
  assert.deepEqual(pdf.fields, expected);
  const canvas = createCanvas(1500, 420);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'black'; ctx.font = '42px Arial';
  source.split('\n').forEach((line, index) => ctx.fillText(line, 30, 65 + index * 80));
  const image = await readDocument({ data: canvas.toBuffer('image/png'), filename: 'certificate.png', mime: 'image/png' }, types, 'Other');
  assert.deepEqual(image.fields, expected);
  // Put a bitmap into a PDF to exercise the scan-rendering path, with no text layer.
  const jpeg = canvas.toBuffer('image/jpeg');
  const imageStream = Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1500 /Height 420 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from('\nendstream')]);
  const drawing = 'q 650 0 0 182 0 0 cm /Scan Do Q';
  const scanObjects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 650 182] /Resources << /XObject << /Scan 4 0 R >> >> /Contents 5 0 R >>'),
    imageStream,
    Buffer.from(`<< /Length ${drawing.length} >>\nstream\n${drawing}\nendstream`),
  ];
  const scanParts = [Buffer.from('%PDF-1.4\n')];
  const scanOffsets = [];
  for (let index = 0; index < scanObjects.length; index++) {
    scanOffsets.push(Buffer.concat(scanParts).length);
    scanParts.push(Buffer.from(`${index + 1} 0 obj\n`), scanObjects[index], Buffer.from('\nendobj\n'));
  }
  const scanXref = Buffer.concat(scanParts).length;
  scanParts.push(Buffer.from('xref\n0 6\n0000000000 65535 f \n' + scanOffsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${scanXref}\n%%EOF`));
  const scan = await readDocument({ data: Buffer.concat(scanParts), filename: 'scan.pdf', mime: 'application/pdf' }, types, 'Other');
  assert.deepEqual(scan.fields, expected);
  const JSZip = require('jszip');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + source.split('\n').map(line => `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`).join('') + '</w:body></w:document>');
  const word = await readDocument({ data: await zip.generateAsync({ type: 'nodebuffer' }), filename: 'certificate.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, types, 'Other');
  assert.deepEqual(word.fields, expected);
  await assert.rejects(readDocument({ data: Buffer.from('unsupported'), filename: 'file.xls', mime: 'application/vnd.ms-excel' }, types, 'Other'), /supports PDF/);
  console.log('Document input checks passed: PDF text, scanned PDF, image OCR, DOCX, references, UK dates, conflicts, missing details and review status.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
