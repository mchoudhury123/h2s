'use strict';
// Minimal HTTP plumbing: body parsing (JSON + multipart), static files, CSV/JSON responses.
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.webp': 'image/webp', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function readBody(req, maxBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('Payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function parseBody(req) {
  const ct = req.headers['content-type'] || '';
  const buf = await readBody(req);
  if (!buf.length) return { fields: {}, files: [] };
  if (ct.includes('application/json')) {
    try { return { fields: JSON.parse(buf.toString('utf8')), files: [] }; }
    catch (e) { throw new Error('Invalid JSON body'); }
  }
  if (ct.includes('multipart/form-data')) return parseMultipart(buf, ct);
  if (ct.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(buf.toString('utf8'));
    return { fields: Object.fromEntries(params), files: [] };
  }
  return { fields: {}, files: [], raw: buf };
}

function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) throw new Error('Missing multipart boundary');
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
  const fields = {}; const files = [];
  let pos = buf.indexOf(boundary);
  if (pos < 0) return { fields, files };
  pos += boundary.length;
  while (pos < buf.length) {
    if (buf[pos] === 45 && buf[pos + 1] === 45) break; // closing --
    if (buf[pos] === 13 && buf[pos + 1] === 10) pos += 2;
    const headerEnd = buf.indexOf('\r\n\r\n', pos);
    if (headerEnd < 0) break;
    const headers = buf.slice(pos, headerEnd).toString('utf8');
    const start = headerEnd + 4;
    let next = buf.indexOf(boundary, start);
    if (next < 0) next = buf.length;
    const end = next - 2; // trailing \r\n
    const content = buf.slice(start, Math.max(start, end));
    const nameM = /name="([^"]*)"/i.exec(headers);
    const fileM = /filename="([^"]*)"/i.exec(headers);
    const typeM = /Content-Type:\s*([^\r\n]+)/i.exec(headers);
    const name = nameM ? nameM[1] : null;
    if (name) {
      if (fileM && fileM[1]) files.push({ field: name, filename: fileM[1], mime: typeM ? typeM[1].trim() : 'application/octet-stream', data: content });
      else fields[name] = content.toString('utf8');
    }
    pos = next + boundary.length;
  }
  return { fields, files };
}

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}
function error(res, message, status = 400, extra = {}) { json(res, { error: message, ...extra }, status); }

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCSV(columns, rows) {
  const head = columns.map(c => csvEscape(c.label || c.key)).join(',');
  const body = rows.map(r => columns.map(c => csvEscape(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(',')).join('\r\n');
  return '﻿' + head + '\r\n' + body + '\r\n';
}
function sendCSV(res, filename, csv) {
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"` });
  res.end(csv);
}

function serveStatic(res, root, urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const rel = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '');
  const full = path.join(root, rel);
  if (!full.startsWith(path.resolve(root))) { res.writeHead(403); res.end('Forbidden'); return true; }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return false;
  const ext = path.extname(full).toLowerCase();
  const stat = fs.statSync(full);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'no-cache' });
  fs.createReadStream(full).pipe(res);
  return true;
}

module.exports = { parseBody, json, error, toCSV, sendCSV, serveStatic, MIME, csvEscape };
