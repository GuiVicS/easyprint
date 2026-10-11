'use strict';
// Driver Linux/macOS:
//  - impressoras do CUPS (lpstat / lp), inclusive filas "raw" de térmicas e etiquetas
//  - impressoras USB diretas (/dev/usb/lp*), comuns em térmicas sem fila no CUPS
//  - PDF -> imagem com pdftoppm (poppler-utils) para térmicas e etiquetas
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { toPlainText } = require('../render/layout');
const { EPError } = require('../errors');

const run = (cmd, args, timeout = 60000) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(Object.assign(new Error(stderr || err.message), { code: err.code })) : resolve(stdout)));
});

const USB_PREFIX = 'USB direto ';

function usbDevices() {
  const out = [];
  for (const dir of ['/dev/usb', '/dev']) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!/^lp\d+$/.test(n)) continue;
      const dev = path.join(dir, n);
      if (out.some((d) => d.dev === dev)) continue;
      out.push({ dev, name: `${USB_PREFIX}(${dir === '/dev/usb' ? n : 'paralela ' + n})` });
    }
  }
  return out;
}

function lpError(e) {
  const err = new EPError('PRINT_FAILED', 'O sistema recusou a impressão: ' + String(e.message).trim().slice(0, 200), 'Confira a impressora no CUPS (http://localhost:631) e se ela está ligada.');
  if (e.code === 'ENOENT') { err.message = 'O CUPS não está instalado.'; err.hint = 'Instale com: sudo apt install cups (Debian/Ubuntu) ou sudo dnf install cups (Fedora).'; }
  return err;
}

class UnixDriver {
  constructor(config, log) { this.config = config; this.log = log; this.tmp = config.path('tmp'); fs.mkdirSync(this.tmp, { recursive: true }); }

  async list() {
    const printers = [];
    try {
      const out = await run('lpstat', ['-p', '-d'], 10000);
      const def = (/system default destination: (.+)/.exec(out) || /destino padrão do sistema: (.+)/.exec(out) || [])[1];
      for (const m of out.matchAll(/^(?:printer|impressora) (\S+) (.*)$/gm)) {
        printers.push({ name: m[1], driver: '', port: 'cups', isDefault: m[1] === def, offline: /disabled|desabilitad/.test(m[2]), online: !/disabled|desabilitad/.test(m[2]) });
      }
      // Descobre o modelo (ajuda a detectar térmica/etiqueta)
      await Promise.all(printers.map(async (p) => {
        try { const info = await run('lpoptions', ['-p', p.name], 5000); p.driver = ((/printer-make-and-model='([^']+)'/.exec(info) || /printer-make-and-model=(\S+)/.exec(info) || [])[1]) || ''; } catch { /* sem modelo */ }
      }));
    } catch (e) { this.log('lpstat indisponível:', e.message); }
    for (const d of usbDevices()) printers.push({ name: d.name, driver: 'USB direto ESC/POS', port: d.dev, isDefault: false, online: true });
    return printers;
  }

  _tmp(ext, data) { const f = path.join(this.tmp, crypto.randomBytes(6).toString('hex') + ext); fs.writeFileSync(f, data); return f; }

  _usb(printer) { const d = usbDevices().find((x) => x.name === printer); return d ? d.dev : null; }

  async raw(printer, bytes, { docName = 'EasyPrint', copies = 1 } = {}) {
    const dev = this._usb(printer);
    if (dev) {
      try { for (let i = 0; i < copies; i++) fs.writeFileSync(dev, bytes); return; }
      catch (e) {
        if (e.code === 'EACCES') throw new EPError('PRINT_FAILED', `Sem permissão para usar ${dev}.`, 'Rode: sudo usermod -aG lp $USER — depois saia e entre de novo na sessão.');
        throw new EPError('PRINT_FAILED', `Falha ao escrever em ${dev}: ${e.message}`, 'Confira o cabo USB e se a impressora está ligada.');
      }
    }
    const f = this._tmp('.bin', bytes);
    try { await run('lp', ['-d', printer, '-n', String(copies), '-t', docName, '-o', 'raw', f]); }
    catch (e) { throw lpError(e); }
    finally { fs.rm(f, { force: true }, () => {}); }
  }

  async office(printer, lines, { docName = 'EasyPrint', copies = 1 } = {}) {
    const f = this._tmp('.txt', toPlainText(lines, 64));
    try { await run('lp', ['-d', printer, '-n', String(copies), '-t', docName, f]); }
    catch (e) { throw lpError(e); }
    finally { fs.rm(f, { force: true }, () => {}); }
  }

  async pdf(printer, bytes, { docName = 'EasyPrint', copies = 1, fit = 'page', paperSize = 'auto', pages } = {}) {
    const f = this._tmp('.pdf', bytes);
    const args = ['-d', printer, '-n', String(copies), '-t', docName];
    if (fit === 'page') args.push('-o', 'fit-to-page');
    if (paperSize && paperSize !== 'auto') args.push('-o', `media=${paperSize}`);
    if (pages && pages.length) args.push('-P', pages.map((p) => p + 1).join(','));
    try { await run('lp', [...args, f]); }
    catch (e) { throw lpError(e); }
    finally { fs.rm(f, { force: true }, () => {}); }
  }

  // PDF -> PNGs com pdftoppm (pacote poppler-utils)
  async renderPdf(pdfBytes, opts = {}) {
    const dir = path.join(this.tmp, 'pdf-' + crypto.randomBytes(6).toString('hex'));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'doc.pdf');
    fs.writeFileSync(file, pdfBytes);
    try {
      let pageCount = 0;
      try { pageCount = Number((/Pages:\s+(\d+)/.exec(await run('pdfinfo', [file], 30000)) || [])[1]) || 0; }
      catch (e) {
        if (e.code === 'ENOENT') throw new EPError('UNSUPPORTED', 'Para imprimir PDF em térmica/etiqueta no Linux é preciso o poppler-utils.', 'Instale com: sudo apt install poppler-utils');
        throw new EPError('INVALID_DOCUMENT', 'O arquivo não é um PDF válido.', 'Confira se a URL ou o arquivo realmente retorna um PDF.');
      }
      const indexes = opts.pages && opts.pages.length ? opts.pages.filter((i) => i < pageCount) : [...Array(pageCount).keys()];
      if (indexes.length > (opts.maxPages || 200)) throw new EPError('INVALID_DOCUMENT', 'O PDF tem páginas demais para uma única impressão.', 'Use a opção "pages".');
      const pages = [];
      for (const i of indexes) {
        const prefix = path.join(dir, `p${i}`);
        const args = ['-png', '-f', String(i + 1), '-l', String(i + 1), '-singlefile'];
        if (opts.width) args.push('-scale-to-x', String(opts.width), '-scale-to-y', '-1');
        else args.push('-r', String(opts.dpi || 200));
        await run('pdftoppm', [...args, file, prefix], 120000);
        const data = fs.readFileSync(prefix + '.png');
        pages.push({ index: i, data, width: data.readUInt32BE(16), height: data.readUInt32BE(20) });
      }
      return { pageCount, pages };
    } finally {
      fs.rm(dir, { recursive: true, force: true }, () => {});
    }
  }

  // Sem DPAPI: o arquivo de configuração fica legível só pelo usuário (0600)
  stop() {}
}

module.exports = { UnixDriver, usbDevices, USB_PREFIX };
