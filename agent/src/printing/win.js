'use strict';
// Driver Windows: conversa com o helper PowerShell persistente (winspool + GDI).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { extract } = require('../assets');

class WindowsDriver {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.proc = null;
    this.pending = new Map();
    this.seq = 0;
    this.ready = null;
    this.tmp = config.path('tmp');
    fs.mkdirSync(this.tmp, { recursive: true });
  }

  start() {
    if (this.ready) return this.ready;
    const script = extract('win-helper.ps1', this.config.path('runtime'));
    this.ready = new Promise((resolve, reject) => {
      const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.proc = proc;
      let buf = '';
      const timer = setTimeout(() => reject(new Error('O helper de impressão não respondeu.')), 30000);
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          let msg; try { msg = JSON.parse(line); } catch { this.log('helper:', line); continue; }
          if (msg.ready) { clearTimeout(timer); resolve(); continue; }
          const p = this.pending.get(msg.id);
          if (p) { this.pending.delete(msg.id); msg.ok ? p.resolve(msg.result) : p.reject(new Error(String(msg.error))); }
        }
      });
      proc.stderr.on('data', (d) => this.log('helper stderr:', d.toString().trim()));
      proc.on('exit', (code) => {
        this.log('helper saiu com código', code);
        clearTimeout(timer);
        for (const p of this.pending.values()) p.reject(new Error('O helper de impressão foi encerrado.'));
        this.pending.clear();
        this.proc = null; this.ready = null;
        reject(new Error('O helper de impressão não iniciou.'));
      });
    });
    return this.ready;
  }

  async call(cmd, payload = {}, timeoutMs = 60000) {
    await this.start();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error('TIMEOUT')); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.proc.stdin.write(JSON.stringify({ id, cmd, ...payload }) + '\n');
    });
  }

  async list() {
    const r = await this.call('list');
    return (Array.isArray(r) ? r : r ? [r] : []).map((p) => ({ ...p, online: !p.offline }));
  }

  _tmpFile(ext, data) {
    const f = path.join(this.tmp, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    fs.writeFileSync(f, data);
    return f;
  }

  async raw(printer, bytes, { docName = 'EasyPrint', copies = 1 } = {}) {
    const file = this._tmpFile('.bin', bytes);
    try { return await this.call('raw', { printer, file, docName, copies }); }
    catch (e) { throw translate(e); }
    finally { fs.rm(file, { force: true }, () => {}); }
  }

  async office(printer, lines, { docName = 'EasyPrint', copies = 1, fontSize } = {}) {
    const files = [];
    const prepared = lines.map((l) => {
      if (l.kind !== 'image') return l;
      const b64 = String(l.src).replace(/^data:image\/\w+;base64,/, '');
      const f = this._tmpFile('.png', Buffer.from(b64, 'base64')); files.push(f);
      return { kind: 'image', file: f, align: l.align };
    });
    try { return await this.call('office', { printer, lines: prepared, docName, copies, fontSize }); }
    catch (e) { throw translate(e); }
    finally { for (const f of files) fs.rm(f, { force: true }, () => {}); }
  }

  // Renderiza PDF -> PNGs (um por página). opts: { dpi } ou { width } em pixels, pages (índices 0-based), maxPages
  async renderPdf(pdfBytes, opts = {}) {
    const dir = path.join(this.tmp, 'pdf-' + crypto.randomBytes(6).toString('hex'));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'doc.pdf');
    fs.writeFileSync(file, pdfBytes);
    try {
      const r = await this.call('pdf-render', { file, outDir: dir, dpi: opts.dpi || 200, width: opts.width, pages: opts.pages, maxPages: opts.maxPages || 200 }, 120000);
      const pages = (Array.isArray(r.pages) ? r.pages : r.pages ? [r.pages] : []).map((p) => ({ ...p, data: fs.readFileSync(p.file) }));
      return { pageCount: r.pageCount, pages };
    } catch (e) {
      throw translatePdf(e);
    } finally {
      fs.rm(dir, { recursive: true, force: true }, () => {});
    }
  }

  async printImages(printer, pngBuffers, { docName = 'EasyPrint', copies = 1, fit = 'page', paperSize = 'auto' } = {}) {
    const files = pngBuffers.map((b) => this._tmpFile('.png', b));
    try { return await this.call('images', { printer, files, docName, copies, fit, paperSize }, 300000); }
    catch (e) { throw translate(e); }
    finally { for (const f of files) fs.rm(f, { force: true }, () => {}); }
  }

  async protect(text) { return this.call('protect', { text }); }
  async unprotect(data) { return this.call('unprotect', { data }); }

  stop() { if (this.proc) this.proc.kill(); }
}

function translate(e) {
  const m = String(e.message || e);
  const err = new Error(m);
  if (m.includes('PRINTER_NOT_FOUND') || m.includes('WIN32_1801')) {
    err.code = 'PRINTER_NOT_FOUND'; err.message = 'Impressora não encontrada no Windows.';
  } else if (m.includes('WIN32_5')) {
    err.code = 'PRINT_FAILED'; err.message = 'O Windows negou acesso à impressora.';
  } else if (m === 'TIMEOUT') {
    err.code = 'TIMEOUT'; err.message = 'A impressora demorou demais para responder.';
  } else {
    err.code = 'PRINT_FAILED';
  }
  return err;
}

function translatePdf(e) {
  const m = String(e.message || e);
  const err = new Error(m);
  err.code = 'INVALID_DOCUMENT';
  if (m.includes('PDF_PASSWORD')) { err.message = 'O PDF está protegido por senha.'; err.hint = 'Gere o PDF sem senha para imprimir.'; }
  else if (m.includes('PDF_INVALID')) { err.message = 'O arquivo não é um PDF válido.'; err.hint = 'Confira se a URL ou o arquivo realmente retorna um PDF.'; }
  else if (m.includes('PDF_TOO_MANY_PAGES')) { err.message = 'O PDF tem páginas demais para uma única impressão.'; err.hint = 'Use a opção "pages" para escolher as páginas (ex.: "1-50").'; }
  else if (m.includes('PDF_TIMEOUT') || m === 'TIMEOUT') { err.code = 'TIMEOUT'; err.message = 'O PDF demorou demais para ser processado.'; }
  else { err.code = 'PRINT_FAILED'; err.message = 'Não foi possível processar o PDF: ' + m; }
  return err;
}

module.exports = { WindowsDriver };
