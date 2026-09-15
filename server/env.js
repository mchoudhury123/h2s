'use strict';
// Minimal .env loader so credentials live in a file that is never committed.
const fs = require('fs');
const path = require('path');

let loaded = false;

function load(file) {
  if (loaded) return process.env;
  loaded = true;
  const envPath = file || path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return process.env;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip matching surrounding quotes, which are common in pasted connection strings.
    if (value.length > 1 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return process.env;
}

module.exports = { load };
