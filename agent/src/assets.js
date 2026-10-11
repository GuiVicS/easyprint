'use strict';
// Em desenvolvimento lê de agent/assets; no executável os arquivos vêm embutidos pelo build.js.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'assets');

function asset(name) {
  if (typeof globalThis.__EASYPRINT_ASSETS__ === 'object') {
    const v = globalThis.__EASYPRINT_ASSETS__[name];
    if (v === undefined) return null;
    return Buffer.from(v, 'base64');
  }
  const base = name.startsWith('sdk/') ? path.join(ROOT, '..', '..') : ROOT;
  const file = path.join(base, name);
  if (!file.startsWith(base) || !fs.existsSync(file)) return null;
  return fs.readFileSync(file);
}

// Extrai um asset para disco (scripts do PowerShell precisam existir como arquivo)
function extract(name, dir) {
  let data = asset(name);
  // O Windows PowerShell 5.1 só lê acentos corretamente em scripts UTF-8 com BOM
  if (name.endsWith('.ps1') && !(data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf)) {
    data = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), data]);
  }
  const target = path.join(dir, path.basename(name));
  fs.mkdirSync(dir, { recursive: true });
  let current = null;
  try { current = fs.readFileSync(target); } catch { /* ainda não existe */ }
  if (!current || !current.equals(data)) fs.writeFileSync(target, data);
  return target;
}

module.exports = { asset, extract };
