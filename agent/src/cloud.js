'use strict';
// Impressão pela nuvem: o EasyPrint busca trabalhos numa fila HTTPS (o "relay") e imprime.
// Serve para ERPs e lojas virtuais que disparam impressão pelo servidor (ex.: novo pedido às 3h).
//
// Segurança (defesa em profundidade):
//  1. Só conexões de SAÍDA: nenhuma porta é aberta no computador da loja.
//  2. HTTPS obrigatório (http só para localhost, em desenvolvimento).
//  3. Cada trabalho é ASSINADO com Ed25519 pela chave privada do ERP. O EasyPrint só aceita
//     assinaturas da chave pública fixada no momento da conexão — um relay invadido não consegue
//     forjar impressões.
//  4. O trabalho é amarrado ao dispositivo (deviceId), tem validade (expiresAt) e um id único que
//     nunca é aceito duas vezes (anti-replay, persistido em disco).
//  5. Políticas por conexão: abrir gaveta bloqueado por padrão; RAW e PDF podem ser desligados.
//  6. Token do dispositivo guardado com DPAPI (só o usuário do Windows consegue ler).
const crypto = require('crypto');
const fs = require('fs');
const { EventEmitter } = require('events');
const { EPError, toErrorPayload } = require('./errors');
const { VERSION } = require('./config');

const CODE_PREFIX = 'EPC1.';
const MAX_JOB_TTL_MS = 7 * 24 * 3600 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_RESPONSE_BYTES = 40 * 1024 * 1024;

function isLocalHost(h) { return h === 'localhost' || h === '127.0.0.1' || h === '[::1]'; }

function parseConnectionCode(code) {
  const raw = String(code || '').trim();
  if (!raw.startsWith(CODE_PREFIX)) throw new EPError('INVALID_CODE', 'Código de conexão inválido.', 'Copie o código completo gerado pelo seu sistema (começa com "EPC1.").');
  let data;
  try { data = JSON.parse(Buffer.from(raw.slice(CODE_PREFIX.length), 'base64url').toString('utf8')); }
  catch { throw new EPError('INVALID_CODE', 'Código de conexão corrompido.', 'Copie o código novamente, sem cortar o final.'); }
  if (data.v !== 1 || !data.url || !data.token || !data.deviceId || !data.publicKey) throw new EPError('INVALID_CODE', 'Código de conexão incompleto.');
  let url;
  try { url = new URL(data.url); } catch { throw new EPError('INVALID_CODE', 'Endereço do servidor inválido no código.'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.hostname))) {
    throw new EPError('INSECURE_URL', 'O servidor precisa usar HTTPS.', 'Por segurança, o EasyPrint só aceita filas na nuvem com HTTPS.');
  }
  if (url.username || url.password) throw new EPError('INVALID_CODE', 'O endereço não pode conter usuário/senha.');
  let key;
  try { key = crypto.createPublicKey({ key: Buffer.from(data.publicKey, 'base64'), format: 'der', type: 'spki' }); }
  catch { throw new EPError('INVALID_CODE', 'Chave pública inválida no código.'); }
  if (key.asymmetricKeyType !== 'ed25519') throw new EPError('INVALID_CODE', 'A chave do código precisa ser Ed25519.');
  return {
    url: url.origin + url.pathname.replace(/\/+$/, ''),
    token: String(data.token),
    deviceId: String(data.deviceId).slice(0, 100),
    name: String(data.name || url.hostname).slice(0, 60),
    publicKey: data.publicKey,
    fingerprint: crypto.createHash('sha256').update(Buffer.from(data.publicKey, 'base64')).digest('hex').slice(0, 16).match(/.{4}/g).join(' '),
    dev: url.protocol === 'http:',
  };
}

// Verifica um trabalho vindo do relay. Retorna o payload ou lança EPError.
function verifyJob(job, conn, seen, now = Date.now()) {
  if (!job || typeof job.id !== 'string' || typeof job.payload !== 'string' || typeof job.signature !== 'string') {
    throw new EPError('BAD_JOB', 'Trabalho malformado recebido da nuvem.');
  }
  const key = crypto.createPublicKey({ key: Buffer.from(conn.publicKey, 'base64'), format: 'der', type: 'spki' });
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(job.payload, 'utf8'), key, Buffer.from(job.signature, 'base64')); } catch { ok = false; }
  if (!ok) throw new EPError('BAD_SIGNATURE', 'Assinatura inválida: trabalho recusado.', 'O trabalho não foi assinado pela chave do seu sistema. Pode ser uma tentativa de fraude ou chave trocada.');
  let p;
  try { p = JSON.parse(job.payload); } catch { throw new EPError('BAD_JOB', 'Conteúdo do trabalho ilegível.'); }
  if (p.v !== 1 || p.id !== job.id) throw new EPError('BAD_JOB', 'Identificador do trabalho não confere.');
  if (p.deviceId !== conn.deviceId) throw new EPError('WRONG_DEVICE', 'Este trabalho foi emitido para outro computador.');
  if (typeof p.ts !== 'number' || p.ts > now + CLOCK_SKEW_MS) throw new EPError('BAD_JOB', 'Data do trabalho inválida (relógio adiantado?).');
  const expiresAt = typeof p.expiresAt === 'number' ? p.expiresAt : p.ts + 24 * 3600 * 1000;
  if (expiresAt - p.ts > MAX_JOB_TTL_MS) throw new EPError('BAD_JOB', 'Validade do trabalho longa demais.');
  if (now > expiresAt) throw new EPError('EXPIRED', 'Trabalho expirado: não foi impresso.');
  if (seen.has(p.id)) throw new EPError('DUPLICATE', 'Trabalho já impresso antes (ignorado).');
  return { payload: p, expiresAt };
}

class SeenStore {
  constructor(file) {
    this.file = file;
    this.map = new Map();
    try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) this.map.set(k, v); } catch { /* vazio */ }
  }
  has(id) { return this.map.has(id); }
  add(id, expiresAt) {
    this.map.set(id, expiresAt);
    const now = Date.now();
    for (const [k, v] of this.map) if (v < now) this.map.delete(k);
    if (this.map.size > 20000) this.map.delete(this.map.keys().next().value);
    fs.writeFile(this.file, JSON.stringify(Object.fromEntries(this.map)), () => {});
  }
}

class CloudRelay extends EventEmitter {
  constructor({ config, printing, driver, log }) {
    super();
    this.config = config;
    this.printing = printing;
    this.driver = driver;
    this.log = log;
    this.runtime = new Map(); // id -> { state, lastContact, lastError, printed, rejected, controller }
    this.seen = new SeenStore(config.path('cloud-seen.json'));
  }

  connections() { return this.config.get('cloud') || []; }

  publicState() {
    return this.connections().map((c) => {
      const r = this.runtime.get(c.id) || {};
      return {
        id: c.id, name: c.name, host: new URL(c.url).host, deviceId: c.deviceId, fingerprint: c.fingerprint, dev: !!c.dev,
        enabled: c.enabled !== false, allowRaw: c.allowRaw !== false, allowDrawer: !!c.allowDrawer, allowPdf: c.allowPdf !== false,
        addedAt: c.addedAt, state: c.enabled === false ? 'paused' : r.state || 'connecting',
        lastContact: r.lastContact || null, lastError: r.lastError || null, printed: r.printed || 0, rejected: r.rejected || 0,
      };
    });
  }

  async add(code) {
    const info = parseConnectionCode(code);
    const list = this.connections();
    if (list.some((c) => c.url === info.url && c.deviceId === info.deviceId)) {
      throw new EPError('ALREADY_CONNECTED', 'Este computador já está conectado a esse sistema.');
    }
    const secret = await this._protect(info.token);
    const conn = {
      id: crypto.randomBytes(5).toString('hex'), name: info.name, url: info.url, deviceId: info.deviceId,
      publicKey: info.publicKey, fingerprint: info.fingerprint, dev: info.dev, ...secret,
      enabled: true, allowRaw: true, allowDrawer: false, allowPdf: true, addedAt: new Date().toISOString(),
    };
    list.push(conn);
    this.config.set('cloud', list);
    this._start(conn);
    return this.publicState().find((c) => c.id === conn.id);
  }

  update(id, patch) {
    const list = this.connections();
    const c = list.find((x) => x.id === id);
    if (!c) throw new EPError('NOT_FOUND', 'Conexão não encontrada.');
    for (const k of ['enabled', 'allowRaw', 'allowDrawer', 'allowPdf']) if (patch[k] !== undefined) c[k] = !!patch[k];
    this.config.set('cloud', list);
    this._stop(id);
    if (c.enabled !== false) this._start(c);
    return true;
  }

  remove(id) {
    this._stop(id);
    this.runtime.delete(id);
    this.config.set('cloud', this.connections().filter((c) => c.id !== id));
    return true;
  }

  startAll() { for (const c of this.connections()) if (c.enabled !== false) this._start(c); }
  stopAll() { for (const id of this.runtime.keys()) this._stop(id); }

  async _protect(token) {
    if (this.driver.protect) {
      try { return { tokenProtected: await this.driver.protect(token) }; } catch (e) { this.log('DPAPI indisponível:', e.message); }
    }
    return { tokenPlain: token };
  }

  async _token(c) {
    if (c.tokenProtected) return this.driver.unprotect(c.tokenProtected);
    return c.tokenPlain;
  }

  _stop(id) {
    const r = this.runtime.get(id);
    if (r && r.controller) r.controller.abort();
    if (r) { r.controller = null; r.state = 'paused'; }
  }

  _start(conn) {
    this._stop(conn.id);
    const r = this.runtime.get(conn.id) || { printed: 0, rejected: 0 };
    r.controller = new AbortController();
    r.state = 'connecting';
    this.runtime.set(conn.id, r);
    this._loop(conn, r, r.controller.signal).catch((e) => this.log('Nuvem: loop encerrado', e.message));
  }

  _set(r, state, error, conn) {
    const changed = r.state !== state || r.lastError !== (error || null);
    r.state = state; r.lastError = error || null;
    if (state === 'online') r.lastContact = new Date().toISOString();
    if (changed) this.emit('state', { id: conn.id, state, error: r.lastError });
  }

  async _request(conn, path, { method = 'GET', body, signal, timeout = 40000 } = {}) {
    const token = await this._token(conn);
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal && signal.addEventListener('abort', onAbort);
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(conn.url + path, {
        method, signal: ctrl.signal, redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': `EasyPrint/${VERSION}` },
        body: body ? JSON.stringify(body) : undefined,
      });
      const len = Number(res.headers.get('content-length') || 0);
      if (len > MAX_RESPONSE_BYTES) throw new Error('Resposta grande demais do servidor.');
      const text = await res.text();
      if (text.length > MAX_RESPONSE_BYTES) throw new Error('Resposta grande demais do servidor.');
      return { status: res.status, data: text ? safeJson(text) : null };
    } finally {
      clearTimeout(t);
      signal && signal.removeEventListener('abort', onAbort);
    }
  }

  async _loop(conn, r, signal) {
    let backoff = 2000;
    let lastStatus = 0;
    let first = true;
    while (!signal.aborted) {
      try {
        if (Date.now() - lastStatus > 5 * 60 * 1000) {
          const s = await this._sendStatus(conn, signal);
          if (s.status < 400) this._set(r, 'online', null, conn);
          lastStatus = Date.now();
        }
        // 1ª consulta sem espera (pega o que acumulou offline); depois, long-polling de 25 s
        const { status, data } = await this._request(conn, `/v1/agent/jobs?wait=${first ? 0 : 25}`, { signal });
        first = false;
        if (status === 401 || status === 403) {
          this._set(r, 'unauthorized', 'O sistema recusou a conexão (código revogado ou expirado). Gere um novo código de conexão.', conn);
          await sleep(60000, signal); continue;
        }
        if (status >= 400) throw new Error(`O servidor respondeu ${status}.`);
        this._set(r, 'online', null, conn);
        backoff = 2000;
        const jobs = data && Array.isArray(data.jobs) ? data.jobs.slice(0, 50) : [];
        for (const job of jobs) { if (signal.aborted) break; await this._handle(conn, r, job, signal); }
      } catch (e) {
        if (signal.aborted) break;
        this._set(r, 'offline', `Sem conexão com o servidor: ${e.cause ? e.cause.code || e.message : e.message}`, conn);
        await sleep(backoff, signal);
        backoff = Math.min(60000, backoff * 2);
      }
    }
  }

  async _handle(conn, r, job, signal) {
    let result;
    let verified = null;
    try {
      verified = verifyJob(job, conn, this.seen);
      const p = verified.payload;
      // Marca como visto ANTES de imprimir: se cair no meio, nunca imprime em dobro.
      this.seen.add(p.id, verified.expiresAt);
      const req = {
        printer: p.printer, route: p.route, copies: p.copies, jobName: p.jobName, options: p.options,
        document: p.document, text: p.text, image: p.image, raw: p.raw, pdf: p.pdf, pdfOptions: p.pdfOptions, html: p.html, htmlOptions: p.htmlOptions,
      };
      const out = await this.printing.print(req, {
        origin: `nuvem:${conn.name}`, appName: conn.name,
        policy: { allowRaw: conn.allowRaw !== false, allowDrawer: !!conn.allowDrawer, allowPdf: conn.allowPdf !== false },
      });
      r.printed = (r.printed || 0) + 1;
      result = { status: 'done', printer: out.printer, pages: out.pages };
    } catch (e) {
      const err = toErrorPayload(e);
      const security = ['BAD_SIGNATURE', 'WRONG_DEVICE', 'BAD_JOB', 'POLICY_BLOCKED'].includes(err.code);
      if (err.code !== 'DUPLICATE') r.rejected = (r.rejected || 0) + (security || err.code === 'EXPIRED' ? 1 : 0);
      result = { status: err.code === 'DUPLICATE' ? 'duplicate' : security || err.code === 'EXPIRED' ? 'rejected' : 'failed', error: err };
      this.log(`Nuvem (${conn.name}): trabalho ${String(job && job.id).slice(0, 40)} ${result.status}: ${err.message}`);
      if (security) this.emit('security', { connection: conn.name, code: err.code, message: err.message });
    }
    try {
      await this._request(conn, `/v1/agent/jobs/${encodeURIComponent(String(job && job.id).slice(0, 100))}/result`, { method: 'POST', body: result, signal, timeout: 15000 });
    } catch (e) { this.log('Nuvem: falha ao confirmar resultado', e.message); }
  }

  async _sendStatus(conn, signal) {
    let printers = [];
    try { printers = (await this.printing.list()).map((p) => ({ name: p.name, kind: p.kind, online: p.online, isDefault: p.isDefault })); } catch { /* ignora */ }
    return this._request(conn, '/v1/agent/status', {
      method: 'POST', signal, timeout: 15000,
      body: { agent: { name: 'EasyPrint', version: VERSION, platform: process.platform }, printers, routes: this.config.get('routes') || {} },
    });
  }
}

function safeJson(t) { try { return JSON.parse(t); } catch { return null; } }
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal && signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

module.exports = { CloudRelay, parseConnectionCode, verifyJob, CODE_PREFIX };
