'use strict';
// Servidor da página de demonstração: node examples/serve.js  ->  http://localhost:5500
const http = require('http');
const fs = require('fs');
const path = require('path');
const { makePdf } = require('../test/fixtures');

const port = Number(process.env.PORT) || 5500;
http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/' || p === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(path.join(__dirname, 'demo.html'))); }
  if (p === '/easyprint.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); return res.end(fs.readFileSync(path.join(__dirname, '..', 'sdk', 'easyprint.js'))); }
  if (p === '/exemplo.pdf') { res.writeHead(200, { 'Content-Type': 'application/pdf' }); return res.end(makePdf(2)); }
  res.writeHead(404); res.end();
}).listen(port, '127.0.0.1', () => console.log(`Demo em http://127.0.0.1:${port}`));
