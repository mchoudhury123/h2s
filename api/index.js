'use strict';
// Serverless entry point (Vercel and similar).
//
// The same request handler the local server uses. Static files are served by
// the host from public/, so only /api/* reaches here.
const { handleRequest } = require('../server/app');

module.exports = (req, res) => handleRequest(req, res);
