'use strict';
const crypto = require('crypto');
const { layout } = require('../render/layout');
const { renderEscPos, renderEscPosBitmaps, paperDots } = require('../render/escpos');
const { renderZpl, renderZplBitmaps, labelDots } = require('../render/zpl');
const { monoFromPng, trimMono, encodeMonoPng } = require('../render/png');
const { htmlToPdf } = require('../render/html');
const { EPError } = require('../errors');

const VIRTUAL = 'EasyPrint Simulador';
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_RAW_BYTES = 10 * 1024 * 1024;
const ROUTE_RX = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

const RX_THERMAL = /(usb direto|tm-?[tmhlpu]\d|epson.*tm|elgin|\bi[789]\b|bematech|mp-?\d{4}|daruma|dr-?\d{3}|tanca|knup|pos-?(58|80)|xprinter|\bxp-|generic.*text|58\s?mm|80\s?mm|t[eé]rmica|sweda|control ?id|print ?id|jetway|gainscha|rongta|hprt|sunmi|star tsp|tsp\d|bixolon|srp-|epos|receipt)/i;
const RX_LABEL = /(zdesigner|zebra|\bzd\d|gc420|gk420|gt800|zt\d{3}|\bl42\b|elgin l42)/i;
const RX_SYSTEM = /(microsoft print to pdf|microsoft xps|onenote|^fax$|send to onenote|pdf24|cutepdf)/i;

const COLUMNS = { 58: 32, 80: 48 };

function guessProfile(p) {
  const id = `${p.name} ${p.driver || ''}`;
  if (p.name === VIRTUAL) return { mode: 'virtual', paperWidth: 80, codepage: 'cp860', autoCut: true };
  if (RX_LABEL.test(id)) return { mode: 'zpl', labelWidth: 100, labelHeight: null, dpi: /300/.test(id) ? 300 : 203, codepage: 'utf8', autoCut: false };
  if (RX_THERMAL.test(id)) return { mode: 'escpos', paperWidth: /58/.test(id) ? 58 : 80, codepage: 'cp860', autoCut: true };
  return { mode: 'office', paperWidth: 80, codepage: 'cp1252', autoCut: false, fontSize: 10, paperSize: 'auto' };
}

function kindOf(p, profile) {
  if (p.name === VIRTUAL) return 'virtual';
  if (RX_SYSTEM.test(p.name)) return 'system';
  return { escpos: 'thermal', zpl: 'label', office: 'office' }[profile.mode] || 'office';
}

// "1-3,5" -> [0,1,2,4]
function parsePages(spec) {
  if (spec === undefined || spec === null || spec === '') return undefined;
  const out = new Set();
  for (const part of String(spec).split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!m) throw new EPError('INVALID_DOCUMENT', `Intervalo de páginas inválido: "${spec}".`, 'Use o formato "1-3,5".');
    const a = Number(m[1]), b = Number(m[2] || m[1]);
    if (a < 1 || b < a || b - a > 1000) throw new EPError('INVALID_DOCUMENT', `Intervalo de páginas inválido: "${part.trim()}".`);
    for (let i = a; i <= b; i++) out.add(i - 1);
  }
  return [...out].sort((x, y) => x - y);
}

function decodeBase64(data, max, what) {
  if (typeof data !== 'string' || !data.length) throw new EPError('INVALID_DOCUMENT', `${what} vazio ou inválido.`);
  if (data.length > Math.ceil(max * 4 / 3) + 8) throw new EPError('TOO_LARGE', `${what} é grande demais.`, `O limite é ${Math.round(max / 1048576)} MB.`);
  return Buffer.from(data.replace(/^data:[^,]*,/, ''), 'base64');
}

// Limite de impressões por origem (protege contra site invadido gastando papel/abrindo gaveta em loop)
class RateLimiter {
  constructor({ perMinute = 120, perHour = 2000 } = {}) { this.perMinute = perMinute; this.perHour = perHour; this.hits = new Map(); }
  hit(key) {
    const now = Date.now();
    const list = (this.hits.get(key) || []).filter((t) => now - t < 3600000);
    const lastMinute = list.filter((t) => now - t < 60000).length;
    if (lastMinute >= this.perMinute || list.length >= this.perHour) {
      throw new EPError('RATE_LIMITED', 'Muitas impressões em pouco tempo: esta foi bloqueada.',
        'Se for legítimo (lote grande), aguarde um minuto. Se você não reconhece essas impressões, remova a permissão em EasyPrint → Sites e apps.');
    }
    list.push(now);
    this.hits.set(key, list);
  }
}

class PrintService {
  constructor(config, driver, log, { findBrowser } = {}) {
    this.findBrowser = findBrowser || (() => null);
    this.config = config;
    this.driver = driver;
    this.log = log;
    this.jobs = [];
    this.queues = new Map();
    this.listeners = new Set();
    this.cache = { at: 0, list: null };
    this.limiter = new RateLimiter();
  }

  onJob(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit(job) { for (const fn of this.listeners) { try { fn(job); } catch { /* ignora */ } } }

  profileFor(p) {
    const saved = this.config.get('profiles')[p.name] || {};
    const profile = { ...guessProfile(p), ...saved, configured: !!this.config.get('profiles')[p.name] };
    profile.columns = profile.columns || (profile.mode === 'office' ? 64 : profile.mode === 'zpl' ? Math.floor((profile.labelWidth || 100) / 2.1) : COLUMNS[profile.paperWidth] || 48);
    return profile;
  }

  async list({ fresh = false } = {}) {
    if (!fresh && this.cache.list && Date.now() - this.cache.at < 5000) return this.cache.list;
    let system = [];
    try { system = await this.driver.list(); } catch (e) { this.log('Falha ao listar impressoras:', e.message); }
    const all = [...system, { name: VIRTUAL, driver: 'EasyPrint', port: 'virtual', isDefault: false, online: true }];
    const def = this.config.get('defaultPrinter');
    const list = all.map((p) => {
      const profile = this.profileFor(p);
      return {
        name: p.name, driver: p.driver || '', port: p.port || '', online: p.online !== false,
        isSystemDefault: !!p.isDefault, isDefault: def ? p.name === def : !!p.isDefault,
        kind: kindOf(p, profile), profile,
      };
    });
    this.cache = { at: Date.now(), list };
    return list;
  }

  // ---------- finalidades (rotas): "etiqueta" -> Zebra, "danfe" -> Laser ----------
  registerRoutes(routes, source) {
    if (!routes || typeof routes !== 'object') return;
    const known = this.config.get('knownRoutes') || {};
    let changed = false;
    for (const [key, label] of Object.entries(routes).slice(0, 30)) {
      if (!ROUTE_RX.test(key)) continue;
      const cleanLabel = String(label || key).slice(0, 60);
      const prev = known[key];
      if (!prev || prev.label !== cleanLabel || prev.source !== source) {
        known[key] = { label: cleanLabel, source: String(source || '').slice(0, 120), firstSeen: prev ? prev.firstSeen : new Date().toISOString() };
        changed = true;
      }
    }
    if (Object.keys(known).length > 100) return; // proteção contra abuso
    if (changed) this.config.set('knownRoutes', known);
  }

  setRoute(route, printer) {
    if (!ROUTE_RX.test(String(route))) throw new EPError('INVALID_ROUTE', 'Nome de finalidade inválido.', 'Use letras, números, "-" ou "_" (ex.: etiqueta, danfe, cozinha).');
    const routes = { ...(this.config.get('routes') || {}) };
    if (printer) routes[route] = printer; else delete routes[route];
    this.config.set('routes', routes);
    const known = this.config.get('knownRoutes') || {};
    if (!known[route]) { known[route] = { label: route, source: 'manual', firstSeen: new Date().toISOString() }; this.config.set('knownRoutes', known); }
  }

  async resolve(name, route) {
    const list = await this.list();
    const find = (n) => list.find((p) => p.name === n)
      || list.find((p) => p.name.toLowerCase() === String(n).toLowerCase())
      || list.find((p) => p.name.toLowerCase().includes(String(n).toLowerCase()));
    if (name) {
      const p = find(name);
      if (!p) {
        throw new EPError('PRINTER_NOT_FOUND', `A impressora "${name}" não foi encontrada.`,
          `Impressoras disponíveis: ${list.map((x) => x.name).join(', ')}. Verifique se ela está ligada e instalada no computador.`);
      }
      return { printer: p, via: 'printer' };
    }
    if (route) {
      if (!ROUTE_RX.test(String(route))) throw new EPError('INVALID_ROUTE', `Finalidade inválida: "${route}".`);
      const target = (this.config.get('routes') || {})[route];
      if (target) {
        const p = find(target);
        if (!p) throw new EPError('PRINTER_NOT_FOUND', `A impressora "${target}", escolhida para "${route}", não foi encontrada.`, 'Ligue a impressora ou escolha outra em EasyPrint → Impressoras → Finalidades.');
        return { printer: p, via: 'route' };
      }
    }
    const def = list.find((p) => p.isDefault);
    if (!def) throw new EPError('NO_DEFAULT_PRINTER', 'Nenhuma impressora padrão foi escolhida.', 'Abra o EasyPrint e escolha a impressora padrão no assistente.');
    return { printer: def, via: route ? 'default-fallback' : 'default' };
  }

  // Enfileira por impressora para nunca misturar dois trabalhos
  _enqueue(printer, task) {
    const prev = this.queues.get(printer) || Promise.resolve();
    const next = prev.catch(() => {}).then(task);
    this.queues.set(printer, next);
    return next;
  }

  // meta: { origin, appName, policy: { allowRaw, allowDrawer, allowPdf } }
  async print(req, meta = {}) {
    if (!req || typeof req !== 'object') throw new EPError('INVALID_DOCUMENT', 'Pedido de impressão inválido.');
    const policy = { allowRaw: true, allowDrawer: true, allowPdf: true, ...(meta.policy || {}) };
    if (meta.rateKey) this.limiter.hit(meta.rateKey);
    const { printer, via } = await this.resolve(req.printer, req.route);
    const profile = { ...printer.profile, ...pickOptions(req.options) };
    const copies = Math.min(50, Math.max(1, Number(req.copies) || 1));
    const job = {
      id: crypto.randomBytes(6).toString('hex'), at: new Date().toISOString(), printer: printer.name,
      mode: profile.mode, origin: meta.origin || null, appName: meta.appName || null, route: req.route || null, routedBy: via,
      jobName: String(req.jobName || 'EasyPrint').slice(0, 80), status: 'printing', copies,
    };

    let payload; // { raw } | { lines } | { pdf }
    if (req.raw !== undefined) {
      if (!policy.allowRaw) throw new EPError('POLICY_BLOCKED', 'Esta conexão não pode enviar comandos RAW.', 'Libere "Comandos RAW" na conexão em EasyPrint → Nuvem.');
      const raw = typeof req.raw === 'string' ? decodeBase64(req.raw, MAX_RAW_BYTES, 'O conteúdo RAW')
        : req.raw && req.raw.hex ? Buffer.from(String(req.raw.hex), 'hex')
        : req.raw && req.raw.text !== undefined ? Buffer.from(String(req.raw.text), 'utf8')
        : req.raw && req.raw.base64 ? decodeBase64(req.raw.base64, MAX_RAW_BYTES, 'O conteúdo RAW') : null;
      if (!raw || !raw.length) throw new EPError('INVALID_DOCUMENT', 'Os dados "raw" estão vazios ou inválidos.', 'Envie base64, { hex } ou { text }.');
      if (raw.length > MAX_RAW_BYTES) throw new EPError('TOO_LARGE', 'Conteúdo RAW grande demais.');
      if (!policy.allowDrawer && hasDrawerPulse(raw)) throw new EPError('POLICY_BLOCKED', 'Abrir a gaveta não está liberado para este site/sistema.', 'O lojista pode liberar em EasyPrint → Sites e apps (ou Nuvem) → "Abrir gaveta".');
      payload = { raw };
      job.preview = [{ kind: 'text', text: rawPreview(raw), align: 'left', size: 1 }];
    } else if (req.pdf !== undefined) {
      if (!policy.allowPdf) throw new EPError('POLICY_BLOCKED', 'Esta conexão não pode imprimir PDF.');
      const pdf = decodeBase64(typeof req.pdf === 'string' ? req.pdf : req.pdf && req.pdf.base64, MAX_PDF_BYTES, 'O PDF');
      if (pdf.subarray(0, 1024).indexOf('%PDF-') < 0) throw new EPError('INVALID_DOCUMENT', 'O arquivo enviado não é um PDF.', 'Confira se a URL ou o arquivo realmente retorna um PDF.');
      const o = req.pdfOptions || {};
      payload = { pdf, pages: parsePages(o.pages), fit: o.fit === 'actual' ? 'actual' : 'page', paperSize: o.paperSize || profile.paperSize || 'auto', dpi: Math.min(600, Math.max(72, Number(o.dpi) || 200)) };
      job.preview = [{ kind: 'text', text: `[PDF ${(pdf.length / 1024).toFixed(0)} KB${o.pages ? ' · páginas ' + o.pages : ''}]`, align: 'left', size: 1 }];
    } else if (req.html !== undefined) {
      if (!policy.allowPdf) throw new EPError('POLICY_BLOCKED', 'Esta conexão não pode imprimir documentos (PDF/HTML).', 'Libere "PDF" na conexão em EasyPrint → Nuvem.');
      const o = req.htmlOptions || {};
      payload = { html: String(req.html), baseUrl: o.baseUrl, javascript: o.javascript === true, fit: 'page', paperSize: o.paperSize || profile.paperSize || 'auto', dpi: 200 };
      job.preview = [{ kind: 'text', text: `[HTML ${(Buffer.byteLength(payload.html) / 1024).toFixed(0)} KB]`, align: 'left', size: 1 }];
    } else {
      let doc = req.document;
      if (!doc && req.text !== undefined) doc = [{ type: 'text', value: String(req.text) }];
      if (!doc && req.image) doc = [{ type: 'image', src: req.image }];
      if (!doc) throw new EPError('INVALID_DOCUMENT', 'Nada para imprimir.', 'Envie "document", "text", "image", "pdf" ou "raw".');
      const lines = layout(doc, profile.columns);
      if (!policy.allowDrawer && lines.some((l) => l.kind === 'drawer')) throw new EPError('POLICY_BLOCKED', 'Abrir a gaveta não está liberado para este site/sistema.', 'O lojista pode liberar em EasyPrint → Sites e apps (ou Nuvem) → "Abrir gaveta".');
      if (profile.autoCut && !lines.some((l) => l.kind === 'cut')) lines.push({ kind: 'feed', lines: 3 }, { kind: 'cut' });
      payload = { lines };
      job.preview = lines;
    }
    job.columns = profile.columns;

    this._record(job);
    try {
      await this._enqueue(printer.name, () => this._send(printer, profile, payload, job, copies));
      job.status = 'done';
    } catch (e) {
      job.status = 'failed';
      job.error = e.message;
      this._emit(job);
      if (e instanceof EPError) throw e;
      throw new EPError(e.code || 'PRINT_FAILED', e.message || 'Falha ao imprimir.',
        e.hint || 'Confira se a impressora está ligada, com papel e conectada. Depois, use "Imprimir teste" no EasyPrint.');
    }
    this._emit(job);
    return { jobId: job.id, printer: printer.name, mode: profile.mode, status: job.status, routedBy: via, ...(job.pages ? { pages: job.pages } : {}) };
  }

  async _send(printer, profile, payload, job, copies) {
    const opts = { docName: job.jobName, copies, fontSize: profile.fontSize };
    if (payload.html !== undefined) {
      // HTML -> PDF no tamanho certo para cada tipo de impressora, depois segue o caminho do PDF
      const mode = profile.mode;
      const pageSize = mode === 'escpos' || mode === 'virtual' ? { width: profile.paperWidth === 58 ? 48 : 72, height: 1000 }
        : mode === 'zpl' ? { width: Number(profile.labelWidth) || 100, height: Number(profile.labelHeight) || 150 }
        : payload.paperSize && payload.paperSize !== 'auto' ? { name: payload.paperSize } : null;
      payload.pdf = await htmlToPdf(payload.html, {
        browser: this.findBrowser(), tmpDir: this.config.path('tmp'), baseUrl: payload.baseUrl, javascript: payload.javascript, pageSize,
      });
      payload.trim = mode === 'escpos' || mode === 'virtual';
    }
    if (payload.pdf) return this._sendPdf(printer, profile, payload, job, copies);
    if (profile.mode === 'virtual') { await new Promise((r) => setTimeout(r, 150)); return; }
    if (payload.raw) return this.driver.raw(printer.name, payload.raw, opts);
    if (profile.mode === 'escpos') {
      const bytes = renderEscPos(payload.lines, profile); job.bytes = bytes.length;
      return this.driver.raw(printer.name, bytes, opts);
    }
    if (profile.mode === 'zpl') {
      const bytes = renderZpl(payload.lines, profile); job.bytes = bytes.length;
      return this.driver.raw(printer.name, bytes, opts);
    }
    return this.driver.office(printer.name, payload.lines, opts);
  }

  async _sendPdf(printer, profile, payload, job, copies) {
    const opts = { docName: job.jobName, copies, fit: payload.fit, paperSize: payload.paperSize };
    // macOS/Linux: o CUPS imprime PDF nativamente em impressoras comuns
    if (profile.mode === 'office' && this.driver.pdf) { await this.driver.pdf(printer.name, payload.pdf, { ...opts, pages: payload.pages }); return; }
    if (!this.driver.renderPdf) throw new EPError('UNSUPPORTED', 'Este sistema não consegue converter PDF para esta impressora.', 'Use uma impressora comum ou envie ZPL/ESC-POS (raw).');
    const threshold = { dither: false, threshold: 160 }; // código de barras nítido
    let rendered;
    if (profile.mode === 'escpos') {
      rendered = await this.driver.renderPdf(payload.pdf, { width: paperDots(profile), pages: payload.pages });
      let mono = rendered.pages.map((p) => monoFromPng(p.data, paperDots(profile), threshold));
      if (payload.trim) mono = mono.map((m) => trimMono(m));
      await this.driver.raw(printer.name, renderEscPosBitmaps(mono, profile), opts);
    } else if (profile.mode === 'zpl') {
      const dots = labelDots(profile);
      rendered = await this.driver.renderPdf(payload.pdf, { width: dots.width, pages: payload.pages });
      const mono = rendered.pages.map((p) => monoFromPng(p.data, dots.width, threshold));
      await this.driver.raw(printer.name, renderZplBitmaps(mono, profile), opts);
    } else if (profile.mode === 'virtual') {
      rendered = await this.driver.renderPdf(payload.pdf, { width: 576, pages: payload.pages, maxPages: 200 });
      job.preview = rendered.pages.slice(0, 5).map((p) => {
        const data = payload.trim ? encodeMonoPng(trimMono(monoFromPng(p.data, 576, { dither: false, threshold: 160 }))) : p.data;
        return { kind: 'image', src: 'data:image/png;base64,' + data.toString('base64'), align: 'center' };
      });
      if (rendered.pages.length > 5) job.preview.push({ kind: 'text', text: `… e mais ${rendered.pages.length - 5} página(s)`, align: 'center', size: 1 });
    } else {
      rendered = await this.driver.renderPdf(payload.pdf, { dpi: payload.dpi, pages: payload.pages });
      await this.driver.printImages(printer.name, rendered.pages.map((p) => p.data), opts);
    }
    job.pages = rendered.pages.length;
  }

  _record(job) {
    this.jobs.unshift(job);
    if (this.jobs.length > 100) this.jobs.length = 100;
    this._emit(job);
  }

  recentJobs(limit = 50) { return this.jobs.slice(0, limit); }
}

function pickOptions(o) {
  if (!o || typeof o !== 'object') return {};
  const out = {};
  for (const k of ['paperWidth', 'codepage', 'columns', 'autoCut', 'labelWidth', 'labelHeight', 'dpi', 'paperSize', 'fontSize']) {
    if (o[k] !== undefined && o[k] !== null) out[k] = o[k];
  }
  return out;
}

// ESC p (1B 70) = pulso da gaveta em ESC/POS; DLE DC4 (10 14 01) também abre em algumas
function hasDrawerPulse(buf) {
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0x1b && buf[i + 1] === 0x70) return true;
    if (buf[i] === 0x10 && buf[i + 1] === 0x14 && buf[i + 2] === 0x01) return true;
  }
  return false;
}

function rawPreview(raw) {
  const head = raw.subarray(0, 400).toString('latin1');
  if (/^\s*\^XA/.test(head)) return `[ZPL ${raw.length} bytes]\n` + head.slice(0, 200);
  return `[${raw.length} bytes RAW]`;
}

module.exports = { PrintService, RateLimiter, guessProfile, parsePages, hasDrawerPulse, VIRTUAL };
