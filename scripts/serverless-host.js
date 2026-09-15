/**
 * Runs the serverless entry point behind a plain HTTP server, one process per
 * "instance", so the serverless behaviour can be checked without deploying.
 * Used by check-serverless.js. Not part of running the CRM.
 */
'use strict';
const http = require('http');
const handler = require('../api/index.js');

const PORT = Number(process.env.PORT || 4123);
http.createServer((req, res) => handler(req, res)).listen(PORT, '127.0.0.1', () => {
  console.log('instance ready on ' + PORT);
});
