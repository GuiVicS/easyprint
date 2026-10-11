'use strict';
// HTML -> PDF usando o Edge/Chrome/Chromium já instalado, em modo headless (sem janela).
// Segurança:
//  - JavaScript DESLIGADO por padrão: Content-Security-Policy "script-src 'none'" injetada no topo
//    do documento + remoção das tags <script> (duas barreiras).
//  - Perfil de navegador dedicado e separado do perfil do usuário (sem cookies/senhas dele).
//    Com javascript: true, cada renderização usa um perfil descartável.
//  - Tempo máximo de renderização e limite de tamanho.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { EPError } = require('../errors');

const MAX_HTML = 5 * 1024 * 1024;
const SCRIPT_BLOCK = /<script\b[\s\S]*?<\/script\s*>/gi;
const SCRIPT_OPEN = /<script\b[^>]*>/gi;

function escapeAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

// pageSize: { width, height } em mm (térmica/etiqueta) ou { name: 'A4' } (comum) ou null
function prepareHtml(html, { baseUrl, pageSize, javascript = false } = {}) {
  let s = String(html);
  let head = '<meta charset="utf-8">';
  // CSP: nada de rede local nem arquivos do computador — só imagens/estilos/fontes HTTPS e data:
  const scripts = javascript ? "script-src 'unsafe-inline' https:" : "script-src 'none'";
  head += `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; ${scripts}; img-src https: data:; style-src 'unsafe-inline' https:; font-src https: data:; connect-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri https:">`;
  if (!javascript) s = s.replace(SCRIPT_BLOCK, '').replace(SCRIPT_OPEN, '');
  if (baseUrl) {
    try {
      const u = new URL(baseUrl);
      if (u.protocol === 'http:' || u.protocol === 'https:') head += `<base href="${escapeAttr(u.href)}">`;
    } catch { /* ignora base inválida */ }
  }
  // Nossas regras vêm primeiro: o @page do próprio HTML tem prioridade se existir
  if (pageSize && pageSize.width) {
    head += `<style>@page{size:${pageSize.width}mm ${pageSize.height}mm;margin:0}html,body{margin:0;padding:0}body{width:${pageSize.width}mm;-webkit-print-color-adjust:exact;print-color-adjust:exact}</style>`;
  } else if (pageSize && pageSize.name) {
    head += `<style>@page{size:${pageSize.name}}</style>`;
  }
  if (/<head[^>]*>/i.test(s)) return s.replace(/<head[^>]*>/i, (m) => m + head);
  if (/<html[^>]*>/i.test(s)) return s.replace(/<html[^>]*>/i, (m) => m + '<head>' + head + '</head>');
  return `<!doctype html><html><head>${head}</head><body>${s}</body></html>`;
}

// Um render por vez (o perfil do navegador não pode ser usado por dois processos ao mesmo tempo)
let chain = Promise.resolve();
function lock() {
  let release;
  const next = new Promise((r) => { release = r; });
  const prev = chain;
  chain = prev.then(() => next);
  return prev.then(() => release);
}

async function htmlToPdf(html, { browser, tmpDir, baseUrl, pageSize, javascript = false, timeoutMs = 45000 } = {}) {
  if (typeof html !== 'string' || !html.trim()) throw new EPError('INVALID_DOCUMENT', 'O HTML está vazio.');
  if (Buffer.byteLength(html) > MAX_HTML) throw new EPError('TOO_LARGE', 'O HTML é grande demais (limite de 5 MB).', 'Use imagens por URL em vez de embutidas, ou divida a impressão.');
  if (!browser) {
    throw new EPError('UNSUPPORTED', 'Para imprimir HTML é preciso o Microsoft Edge, Google Chrome ou Chromium instalado.',
      process.platform === 'linux' ? 'Instale o Chromium (ex.: sudo apt install chromium) e tente de novo.' : 'Instale o Google Chrome ou o Microsoft Edge.');
  }
  const dir = path.join(tmpDir, 'html-' + crypto.randomBytes(6).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, 'doc.html');
  const out = path.join(dir, 'doc.pdf');
  fs.writeFileSync(src, prepareHtml(html, { baseUrl, pageSize, javascript }));
  const profile = javascript ? path.join(dir, 'profile') : path.join(tmpDir, '..', 'html-profile');
  const args = [
    '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-sync', '--disable-background-networking', '--disable-component-update', '--disable-default-apps',
    '--mute-audio', '--hide-scrollbars', `--user-data-dir=${profile}`,
    '--no-pdf-header-footer', '--print-to-pdf-no-header', `--print-to-pdf=${out}`,
  ];
  if (process.platform === 'linux' && process.getuid && process.getuid() === 0) args.push('--no-sandbox');
  args.push(pathToFileURL(src).href);

  const release = await lock();
  try {
    await new Promise((resolve, reject) => {
      const p = spawn(browser, args, { windowsHide: true, stdio: 'ignore' });
      const t = setTimeout(() => { p.kill(); reject(new EPError('TIMEOUT', 'O HTML demorou demais para ser renderizado.', 'Simplifique o HTML ou remova recursos externos lentos.')); }, timeoutMs);
      p.on('error', (e) => { clearTimeout(t); reject(new EPError('PRINT_FAILED', 'Não foi possível abrir o navegador para renderizar o HTML: ' + e.message)); });
      p.on('exit', () => { clearTimeout(t); resolve(); });
    });
    // O processo pode sair um pouco antes do arquivo terminar de ser gravado
    for (let i = 0; i < 30 && !fs.existsSync(out); i++) await new Promise((r) => setTimeout(r, 100));
    if (!fs.existsSync(out)) throw new EPError('PRINT_FAILED', 'O navegador não gerou o PDF do HTML.', 'Feche e abra o EasyPrint e tente de novo. Se continuar, atualize o Edge/Chrome.');
    return fs.readFileSync(out);
  } finally {
    release();
    setTimeout(() => fs.rm(dir, { recursive: true, force: true }, () => {}), 2000);
  }
}

module.exports = { htmlToPdf, prepareHtml };
