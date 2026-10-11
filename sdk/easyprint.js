/*!
 * EasyPrint SDK v1.0.0 — impressão direta do navegador para impressoras locais.
 * Funciona via <script>, import ESM (bundlers) ou require (CommonJS). Sem dependências.
 *
 *   const printer = EasyPrint.connect({ appName: 'Minha Loja' });
 *   await printer.print(EasyPrint.receipt().title('PEDIDO #1').item(1, 'Pizza', 'R$ 50,00').cut());
 */
(function (root, factory) {
  if (typeof define === 'function' && define.amd) define([], factory);
  else if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EasyPrint = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.0';
  var DEFAULTS = {
    appName: null,
    host: '127.0.0.1',
    ports: [17777, 17778, 17779],
    token: null,
    autoReconnect: true,
    downloadUrl: null,
    routes: null,
    requestTimeout: 60000,
    debug: false,
  };

  // ---------------------------------------------------------------------------
  // Mensagens (pt-BR) — cada status tem título, explicação e passos para resolver
  // ---------------------------------------------------------------------------
  var MESSAGES = {
    connecting: { title: 'Conectando ao EasyPrint…', message: 'Procurando o EasyPrint neste computador.', steps: [] },
    ready: { title: 'Impressora pronta', message: 'O EasyPrint está conectado e este site está autorizado.', steps: [] },
    not_running: {
      title: 'O EasyPrint não está aberto',
      message: 'Para imprimir direto na impressora, o EasyPrint precisa estar rodando neste computador.',
      steps: [
        'Procure o ícone verde do EasyPrint perto do relógio do Windows.',
        'Se ele não estiver lá, abra o EasyPrint pelo menu Iniciar.',
        'Ainda não instalou? Baixe e instale o EasyPrint — leva 2 minutos.',
      ],
    },
    browser_blocked: {
      title: 'O navegador bloqueou o acesso à impressora',
      message: 'O navegador está impedindo este site de falar com o EasyPrint no seu computador.',
      steps: [
        'Clique no ícone à esquerda do endereço do site (cadeado ou ajustes).',
        'Encontre "Acesso à rede local" ou "Apps neste dispositivo" e escolha "Permitir".',
        'Recarregue a página (F5).',
      ],
    },
    awaiting_approval: {
      title: 'Confirme no EasyPrint',
      message: 'Uma janela do EasyPrint abriu no seu computador perguntando se este site pode imprimir.',
      steps: ['Clique em "Permitir" na janela do EasyPrint.', 'Se a janela não apareceu, clique no ícone do EasyPrint perto do relógio.'],
    },
    denied: {
      title: 'Este site foi bloqueado no EasyPrint',
      message: 'Alguém clicou em "Bloquear" quando este site pediu permissão para imprimir.',
      steps: ['Abra o EasyPrint (ícone perto do relógio).', 'Vá em "Sites e apps" e clique em "Desbloquear" ao lado deste site.', 'Recarregue esta página.'],
    },
    unsupported_browser: {
      title: 'Navegador não suportado',
      message: 'O Safari não permite que sites conversem com programas locais.',
      steps: ['Use o Google Chrome, Microsoft Edge ou Firefox para imprimir direto.'],
    },
    disconnected: { title: 'Conexão perdida', message: 'A conexão com o EasyPrint caiu. Tentando reconectar…', steps: [] },
  };

  var ERROR_HINTS = {
    NOT_RUNNING: 'not_running', BROWSER_BLOCKED: 'browser_blocked', NOT_AUTHORIZED: 'awaiting_approval', DENIED: 'denied',
  };

  function EasyPrintError(code, message, hint) {
    var e = new Error(message);
    e.name = 'EasyPrintError';
    e.code = code;
    e.hint = hint || null;
    return e;
  }

  // ---------------------------------------------------------------------------
  // Utilidades
  // ---------------------------------------------------------------------------
  function toBase64(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  function rawToBase64(data) {
    if (typeof data === 'string') {
      var arr = new Uint8Array(data.length);
      for (var i = 0; i < data.length; i++) arr[i] = data.charCodeAt(i) & 0xff;
      return toBase64(arr);
    }
    if (data instanceof ArrayBuffer) return toBase64(new Uint8Array(data));
    if (ArrayBuffer.isView(data)) return toBase64(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    if (Array.isArray(data)) {
      var parts = data.map(function (d) { return typeof d === 'number' ? [d] : Array.from(atob(rawToBase64(d)), function (c) { return c.charCodeAt(0); }); });
      return toBase64(Uint8Array.from([].concat.apply([], parts)));
    }
    throw EasyPrintError('INVALID_DOCUMENT', 'Formato de dados RAW não suportado.', 'Use string, Uint8Array, ArrayBuffer ou array.');
  }

  function isSafariHttps() {
    if (typeof navigator === 'undefined' || typeof location === 'undefined') return false;
    var ua = navigator.userAgent;
    return /Safari\//.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox/.test(ua) && location.protocol === 'https:';
  }

  function permissionState() {
    if (typeof navigator === 'undefined' || !navigator.permissions || !navigator.permissions.query) return Promise.resolve(null);
    var names = ['loopback-network', 'local-network-access', 'local-network'];
    var i = 0;
    function tryNext() {
      if (i >= names.length) return Promise.resolve(null);
      var name = names[i++];
      return navigator.permissions.query({ name: name }).then(function (s) { return s.state; }, tryNext);
    }
    return tryNext();
  }

  // ---------------------------------------------------------------------------
  // Cliente
  // ---------------------------------------------------------------------------
  function Client(options) {
    this.options = Object.assign({}, DEFAULTS, options || {});
    this.status = 'connecting';
    this.agent = null;
    this.port = null;
    this._ws = null;
    this._seq = 0;
    this._pending = {};
    this._listeners = {};
    this._closed = false;
    this._retry = 0;
    this._connect();
  }

  Client.prototype._log = function () {
    if (this.options.debug && typeof console !== 'undefined') console.log.apply(console, ['[EasyPrint]'].concat([].slice.call(arguments)));
  };

  Client.prototype.on = function (event, fn) {
    (this._listeners[event] = this._listeners[event] || []).push(fn);
    if (event === 'status') fn(this.status, this.diagnose());
    var self = this;
    return function off() { self._listeners[event] = (self._listeners[event] || []).filter(function (f) { return f !== fn; }); };
  };

  Client.prototype._emit = function (event, a, b) {
    (this._listeners[event] || []).forEach(function (fn) { try { fn(a, b); } catch (e) { setTimeout(function () { throw e; }); } });
  };

  Client.prototype._setStatus = function (s) {
    if (this.status === s) return;
    this._log('status:', s);
    this.status = s;
    this._emit('status', s, this.diagnose());
    if (s === 'ready') this._emit('ready');
  };

  Client.prototype._connect = function () {
    var self = this;
    if (this._closed) return;
    if (isSafariHttps()) { this._setStatus('unsupported_browser'); return; }
    var ports = this.options.ports.slice();
    if (this.port) ports.unshift(this.port); // tenta primeiro a última porta que funcionou
    ports = ports.filter(function (p, i) { return ports.indexOf(p) === i; });

    (function attempt(i) {
      if (self._closed) return;
      if (i >= ports.length) return self._unreachable();
      var url = 'ws://' + self.options.host + ':' + ports[i] + '/ws';
      var ws, settled = false;
      try { ws = new WebSocket(url); } catch (e) { return attempt(i + 1); }
      var timer = setTimeout(function () { if (!settled) { settled = true; try { ws.close(); } catch (e) { /* ignora */ } attempt(i + 1); } }, 2500);
      ws.onopen = function () {
        if (settled) return;
        settled = true; clearTimeout(timer);
        self._ws = ws; self.port = ports[i]; self._retry = 0;
        self._bind(ws);
        self._hello();
      };
      ws.onerror = function () { if (!settled) { settled = true; clearTimeout(timer); attempt(i + 1); } };
      ws.onclose = function () { if (!settled) { settled = true; clearTimeout(timer); attempt(i + 1); } };
    })(0);
  };

  Client.prototype._unreachable = function () {
    var self = this;
    permissionState().then(function (state) {
      self._setStatus(state === 'denied' ? 'browser_blocked' : 'not_running');
      self._scheduleReconnect();
    });
  };

  Client.prototype._scheduleReconnect = function () {
    var self = this;
    if (this._closed || !this.options.autoReconnect) return;
    var delay = Math.min(10000, 2000 + this._retry++ * 1000);
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(function () { self._connect(); }, delay);
  };

  Client.prototype._bind = function (ws) {
    var self = this;
    ws.onmessage = function (ev) {
      var msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.event === 'authorization') { self._setStatus(msg.data.state); return; }
      if (msg.event) { self._emit(msg.event, msg.data); return; }
      var p = self._pending[msg.id];
      if (!p) return;
      delete self._pending[msg.id];
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(EasyPrintError(msg.error.code, msg.error.message, msg.error.hint));
    };
    ws.onclose = function () {
      self._ws = null;
      Object.keys(self._pending).forEach(function (id) {
        var p = self._pending[id]; clearTimeout(p.timer);
        p.reject(EasyPrintError('DISCONNECTED', 'A conexão com o EasyPrint caiu durante a operação.', 'Verifique se o EasyPrint continua aberto e tente de novo.'));
      });
      self._pending = {};
      clearInterval(self._ping);
      if (!self._closed) { self._setStatus('disconnected'); self._scheduleReconnect(); }
    };
    clearInterval(this._ping);
    this._ping = setInterval(function () { self._call('ping').catch(function () {}); }, 30000);
  };

  Client.prototype._hello = function () {
    var self = this;
    this._call('hello', { appName: this.options.appName, token: this.options.token, routes: this.options.routes, sdkVersion: VERSION }).then(function (r) {
      self.agent = r.agent;
      self._setStatus(r.state);
    }, function (e) {
      self._log('hello falhou', e);
      self.lastError = e;
      self._setStatus(e.code === 'INVALID_TOKEN' ? 'denied' : 'not_running');
    });
  };

  Client.prototype._call = function (method, params, timeout) {
    var self = this;
    return new Promise(function (resolve, reject) {
      if (!self._ws || self._ws.readyState !== 1) return reject(EasyPrintError('NOT_RUNNING', MESSAGES.not_running.title, MESSAGES.not_running.steps.join(' ')));
      var id = ++self._seq;
      var timer = setTimeout(function () {
        delete self._pending[id];
        reject(EasyPrintError('TIMEOUT', 'O EasyPrint demorou demais para responder.', 'Verifique se a impressora está ligada e tente novamente.'));
      }, timeout || self.options.requestTimeout);
      self._pending[id] = { resolve: resolve, reject: reject, timer: timer };
      self._ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });
  };

  /** Espera ficar pronto. Rejeita com erro explicativo se não for possível. */
  Client.prototype.ready = function (timeoutMs) {
    var self = this;
    if (this.status === 'ready') return Promise.resolve(this);
    var limit = timeoutMs || (this.status === 'awaiting_approval' ? 120000 : 8000);
    return new Promise(function (resolve, reject) {
      var done = false;
      var finish = function (ok) {
        if (done) return; done = true; clearTimeout(timer); off();
        if (ok) return resolve(self);
        var d = self.diagnose();
        var code = { not_running: 'NOT_RUNNING', browser_blocked: 'BROWSER_BLOCKED', awaiting_approval: 'NOT_AUTHORIZED', denied: 'DENIED', unsupported_browser: 'UNSUPPORTED_BROWSER' }[self.status] || 'NOT_RUNNING';
        reject(EasyPrintError(code, d.title, d.steps.join(' ')));
      };
      var off = self.on('status', function (s) {
        if (s === 'ready') finish(true);
        else if (s === 'denied' || s === 'unsupported_browser') finish(false);
        else if (s === 'awaiting_approval') { clearTimeout(timer); timer = setTimeout(function () { finish(false); }, 120000); }
      });
      var timer = setTimeout(function () { finish(false); }, limit);
    });
  };

  /** Lista as impressoras disponíveis. */
  Client.prototype.printers = function () {
    var self = this;
    return this.ready().then(function () { return self._call('printers.list'); });
  };

  /** Impressora padrão escolhida no EasyPrint. */
  Client.prototype.defaultPrinter = function () {
    var self = this;
    return this.ready().then(function () { return self._call('printers.default'); });
  };

  /**
   * Imprime. Aceita:
   *  - um builder: EasyPrint.receipt()...
   *  - um documento: { blocks: [...] } ou [...]
   *  - { raw }, { text } ou { image } (veja printRaw/printText/printImage)
   * opções: { printer, copies, jobName }
   */
  Client.prototype.print = function (what, opts) {
    var self = this;
    opts = opts || {};
    var req = { printer: opts.printer, route: opts.route, copies: opts.copies, jobName: opts.jobName, options: opts.options };
    if (what && typeof what.build === 'function') req.document = what.build();
    else if (Array.isArray(what) || (what && what.blocks)) req.document = what;
    else if (what && (what.raw !== undefined || what.text !== undefined || what.image !== undefined || what.pdf !== undefined || what.html !== undefined)) {
      if (what.raw !== undefined) req.raw = typeof what.raw === 'object' && !ArrayBuffer.isView(what.raw) && !(what.raw instanceof ArrayBuffer) && !Array.isArray(what.raw) ? what.raw : rawToBase64(what.raw);
      if (what.text !== undefined) req.text = String(what.text);
      if (what.image !== undefined) req.image = what.image;
      if (what.pdf !== undefined) { req.pdf = what.pdf; req.pdfOptions = what.pdfOptions; }
      if (what.html !== undefined) { req.html = what.html; req.htmlOptions = what.htmlOptions; }
    } else if (typeof what === 'string') req.text = what;
    else return Promise.reject(EasyPrintError('INVALID_DOCUMENT', 'Nada para imprimir.', 'Passe EasyPrint.receipt()..., um documento { blocks } ou um texto.'));
    return this.ready().then(function () { return self._call('print', req); });
  };

  /** Envia bytes direto para a impressora (ESC/POS, ZPL, EPL, PCL…). */
  Client.prototype.printRaw = function (data, opts) { return this.print({ raw: data }, opts); };
  /** Imprime texto simples. */
  Client.prototype.printText = function (text, opts) { return this.print({ text: text }, opts); };
  /** Imprime uma imagem (URL, data URL, <img> ou <canvas>). */
  Client.prototype.printImage = function (src, opts) {
    var self = this;
    return toPngDataUrl(src, opts && opts.maxWidth).then(function (png) { return self.print({ image: png }, opts); });
  };

  /**
   * Imprime um PDF (DANFE, etiqueta de marketplace, boleto, relatório…).
   * source: URL (baixada pelo navegador, com os cookies do seu site), data URL, Blob, ArrayBuffer ou Uint8Array.
   * opts: { printer, route, copies, jobName, pages: '1-3', fit: 'page'|'actual', paperSize: 'A4'|'A5'|'Letter'|'auto' }
   */
  Client.prototype.printPdf = function (source, opts) {
    var self = this;
    opts = opts || {};
    return pdfToBase64(source).then(function (b64) {
      return self.print({ pdf: b64, pdfOptions: { pages: opts.pages, fit: opts.fit, paperSize: opts.paperSize, dpi: opts.dpi } }, opts);
    });
  };

  /**
   * Imprime HTML (layouts prontos do seu sistema: comanda, DANFE em HTML, relatório…).
   * html: string com o HTML ou um elemento da página (os estilos da página são incluídos).
   * opts: { printer, route, copies, jobName, paperSize, javascript: false }
   * O EasyPrint renderiza num navegador isolado: JavaScript fica desligado, a menos que javascript: true.
   */
  Client.prototype.printHtml = function (html, opts) {
    opts = opts || {};
    var content = html;
    if (typeof Element !== 'undefined' && html instanceof Element) {
      var styles = Array.prototype.map.call(document.querySelectorAll('style, link[rel="stylesheet"]'), function (n) {
        if (n.tagName === 'LINK') return '<link rel="stylesheet" href="' + n.href.replace(/"/g, '&quot;') + '">';
        return n.outerHTML;
      }).join('');
      content = '<!doctype html><html><head>' + styles + '</head><body>' + html.outerHTML + '</body></html>';
    }
    if (typeof content !== 'string' || !content.trim()) return Promise.reject(EasyPrintError('INVALID_DOCUMENT', 'O HTML está vazio.'));
    var baseUrl = opts.baseUrl || (typeof location !== 'undefined' && /^https?:/.test(location.href) ? location.href : undefined);
    return this.print({ html: content, htmlOptions: { baseUrl: baseUrl, javascript: opts.javascript === true, paperSize: opts.paperSize } }, opts);
  };

  /** Finalidades configuradas pelo lojista: [{ route, label, printer }] */
  Client.prototype.routes = function () {
    var self = this;
    return this.ready().then(function () { return self._call('routes.list'); });
  };

  /** Explica o status atual em linguagem simples, com passos para resolver. */
  Client.prototype.diagnose = function () {
    var m = MESSAGES[this.status] || MESSAGES.not_running;
    var steps = m.steps.slice();
    if (this.status === 'not_running' && this.options.downloadUrl) steps[2] = 'Ainda não instalou? Baixe em: ' + this.options.downloadUrl;
    if (this.status === 'denied' && this.lastError && this.lastError.code === 'INVALID_TOKEN') {
      return { ok: false, status: this.status, title: 'Token inválido', message: this.lastError.message, steps: [this.lastError.hint] };
    }
    return { ok: this.status === 'ready', status: this.status, title: m.title, message: m.message, steps: steps, downloadUrl: this.options.downloadUrl };
  };

  /** Encerra a conexão. */
  Client.prototype.disconnect = function () {
    this._closed = true;
    clearTimeout(this._reconnectTimer);
    clearInterval(this._ping);
    if (this._ws) this._ws.close();
  };

  // ---------------------------------------------------------------------------
  // Construtor de cupons / recibos (documento universal)
  // ---------------------------------------------------------------------------
  function Receipt() { this.blocks = []; }
  Receipt.prototype._add = function (b) { this.blocks.push(b); return this; };
  /** Texto. opts: { align:'left'|'center'|'right', bold, size:1|2|3, underline, invert } */
  Receipt.prototype.text = function (value, opts) { return this._add(Object.assign({ type: 'text', value: String(value) }, opts)); };
  Receipt.prototype.center = function (value, opts) { return this.text(value, Object.assign({ align: 'center' }, opts)); };
  Receipt.prototype.bold = function (value, opts) { return this.text(value, Object.assign({ bold: true }, opts)); };
  /** Título grande, centralizado e em negrito. */
  Receipt.prototype.title = function (value) { return this._add({ type: 'title', value: String(value) }); };
  /** Linha separadora. */
  Receipt.prototype.line = function (char) { return this._add({ type: 'line', char: char }); };
  /** Duas colunas: texto à esquerda e valor à direita. */
  Receipt.prototype.row = function (left, right, opts) { return this._add(Object.assign({ type: 'row', left: left, right: right }, opts)); };
  /** Item de pedido: "2x X-Burguer ...... R$ 30,00" + observação. */
  Receipt.prototype.item = function (qty, name, price, note) { return this._add({ type: 'item', qty: qty, name: name, price: price, note: note }); };
  /** Total em destaque. */
  Receipt.prototype.total = function (label, value) { return this._add({ type: 'total', label: label, value: value }); };
  Receipt.prototype.qr = function (value, size) { return this._add({ type: 'qr', value: String(value), size: size }); };
  Receipt.prototype.barcode = function (value, format) { return this._add({ type: 'barcode', value: String(value), format: format || 'CODE128' }); };
  /** Imagem PNG em data URL (use: await EasyPrint.image('logo.png')). */
  Receipt.prototype.image = function (src, opts) { return this._add(Object.assign({ type: 'image', src: src }, opts)); };
  Receipt.prototype.feed = function (lines) { return this._add({ type: 'feed', lines: lines || 1 }); };
  Receipt.prototype.cut = function () { return this._add({ type: 'cut' }); };
  /** Abre a gaveta de dinheiro conectada à impressora. */
  Receipt.prototype.drawer = function () { return this._add({ type: 'drawer' }); };
  Receipt.prototype.build = function () { return { blocks: this.blocks.slice() }; };

  var MAX_PDF = 25 * 1024 * 1024;
  function pdfToBase64(source) {
    function fromBuffer(buf) {
      var bytes = new Uint8Array(buf);
      if (bytes.length > MAX_PDF) throw EasyPrintError('TOO_LARGE', 'O PDF é grande demais (limite de 25 MB).', 'Imprima menos páginas ou reduza o arquivo.');
      return toBase64(bytes);
    }
    try {
      if (typeof source === 'string') {
        if (/^data:application\/pdf;base64,/i.test(source)) return Promise.resolve(source.split(',')[1]);
        return fetch(source, { credentials: 'include' }).then(function (r) {
          if (!r.ok) throw EasyPrintError('INVALID_DOCUMENT', 'Não foi possível baixar o PDF (HTTP ' + r.status + ').', 'Confira a URL e se o usuário tem acesso ao arquivo.');
          return r.arrayBuffer();
        }, function () {
          throw EasyPrintError('INVALID_DOCUMENT', 'Não foi possível baixar o PDF.', 'Se o PDF estiver em outro domínio, ele precisa liberar CORS — ou baixe no seu servidor e envie os bytes.');
        }).then(fromBuffer);
      }
      if (typeof Blob !== 'undefined' && source instanceof Blob) return source.arrayBuffer().then(fromBuffer);
      if (source instanceof ArrayBuffer) return Promise.resolve(fromBuffer(source));
      if (ArrayBuffer.isView(source)) return Promise.resolve(fromBuffer(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength)));
    } catch (e) { return Promise.reject(e); }
    return Promise.reject(EasyPrintError('INVALID_DOCUMENT', 'Formato de PDF não suportado.', 'Use URL, Blob, ArrayBuffer ou Uint8Array.'));
  }

  // ---------------------------------------------------------------------------
  // Imagens -> PNG data URL (o formato que o agente entende)
  // ---------------------------------------------------------------------------
  function toPngDataUrl(src, maxWidth) {
    maxWidth = maxWidth || 576;
    if (typeof document === 'undefined') {
      if (typeof src === 'string' && /^data:image\/png;base64,/.test(src)) return Promise.resolve(src);
      return Promise.reject(EasyPrintError('INVALID_DOCUMENT', 'Fora do navegador, envie a imagem já como PNG em data URL.'));
    }
    return new Promise(function (resolve, reject) {
      function draw(img) {
        var w = img.naturalWidth || img.width, hgt = img.naturalHeight || img.height;
        var scale = Math.min(1, maxWidth / w);
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(hgt * scale));
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        try { resolve(c.toDataURL('image/png')); }
        catch (e) { reject(EasyPrintError('INVALID_DOCUMENT', 'Não foi possível ler a imagem (bloqueio de CORS).', 'Hospede a imagem no mesmo domínio do site ou habilite CORS nela.')); }
      }
      if (typeof HTMLCanvasElement !== 'undefined' && src instanceof HTMLCanvasElement) return draw(src);
      if (typeof HTMLImageElement !== 'undefined' && src instanceof HTMLImageElement && src.complete) return draw(src);
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () { draw(img); };
      img.onerror = function () { reject(EasyPrintError('INVALID_DOCUMENT', 'Não foi possível carregar a imagem.', 'Confira o endereço da imagem.')); };
      img.src = typeof src === 'string' ? src : src.src;
    });
  }

  // ---------------------------------------------------------------------------
  // Widget de status pronto (opcional) — mostra o estado e como resolver
  // ---------------------------------------------------------------------------
  function widget(client, container, opts) {
    opts = opts || {};
    if (typeof document === 'undefined') return function () {};
    var host = typeof container === 'string' ? document.querySelector(container) : container;
    if (!host) throw new Error('EasyPrint.widget: elemento não encontrado.');
    var rootEl = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var COLORS = { ready: '#16a34a', connecting: '#64748b', disconnected: '#f59e0b', awaiting_approval: '#f59e0b', not_running: '#dc2626', browser_blocked: '#dc2626', denied: '#dc2626', unsupported_browser: '#dc2626' };
    var style = '<style>' +
      ':host{all:initial;font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:inherit}' +
      '.w{display:inline-block;position:relative}' +
      '.b{display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;font:inherit;cursor:pointer}' +
      '.d{width:9px;height:9px;border-radius:50%}' +
      '.p{position:absolute;z-index:9999;top:calc(100% + 8px);' + (opts.align === 'right' ? 'right:0' : 'left:0') + ';width:320px;max-width:90vw;background:#fff;color:#16191d;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.2);padding:16px}' +
      '.p h4{margin:0 0 6px;font-size:15px}.p p{margin:0 0 8px;color:#5d6670}.p ol{margin:0;padding-left:20px}.p li{margin:4px 0}' +
      '.x{margin-top:12px;display:flex;gap:8px}.x button{padding:6px 12px;border-radius:8px;border:1px solid #d0d5da;background:#fff;cursor:pointer;font:inherit}' +
      '</style>';
    var open = false;
    function render() {
      var d = client.diagnose();
      var label = d.ok ? (opts.readyLabel || 'Impressora pronta') : d.title;
      var html = style + '<div class="w"><button class="b" part="button"><span class="d" style="background:' + (COLORS[d.status] || '#64748b') + '"></span>' + esc(label) + '</button>';
      if (open && !d.ok) {
        html += '<div class="p" role="dialog"><h4>' + esc(d.title) + '</h4><p>' + esc(d.message) + '</p>' +
          (d.steps.length ? '<ol>' + d.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' : '') +
          '<div class="x"><button data-a="retry">Tentar de novo</button>' + (d.downloadUrl && d.status === 'not_running' ? '<button data-a="dl">Baixar EasyPrint</button>' : '') + '</div></div>';
      }
      html += '</div>';
      rootEl.innerHTML = html;
      rootEl.querySelector('.b').onclick = function () { open = !open; render(); };
      var r = rootEl.querySelector('[data-a=retry]'); if (r) r.onclick = function () { open = false; client._retry = 0; client._connect(); render(); };
      var dl = rootEl.querySelector('[data-a=dl]'); if (dl) dl.onclick = function () { window.open(d.downloadUrl, '_blank', 'noopener'); };
    }
    function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    return client.on('status', function () { if (client.status === 'ready') open = false; render(); });
  }

  // ---------------------------------------------------------------------------
  // API pública
  // ---------------------------------------------------------------------------
  var shared = null;
  return {
    VERSION: VERSION,
    /** Conecta ao EasyPrint. Chame uma vez e reutilize o cliente. */
    connect: function (options) {
      if (!options || !options.fresh) {
        if (shared && !shared._closed) return shared;
        shared = new Client(options);
        return shared;
      }
      return new Client(options);
    },
    /** Novo cupom/recibo (builder encadeável). */
    receipt: function () { return new Receipt(); },
    /** Converte imagem (URL, <img>, <canvas>) para PNG data URL. */
    image: toPngDataUrl,
    /** Widget de status com instruções de correção. */
    widget: widget,
    messages: MESSAGES,
    Error: EasyPrintError,
  };
});
