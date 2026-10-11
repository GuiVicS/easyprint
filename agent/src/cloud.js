'use strict';
// Impressão pela nuvem: o EasyPrint busca trabalhos numa fila HTTPS (o "relay") e imprime.
// Serve para ERPs e lojas virtuais que disparam impressão pelo servidor (ex.: novo pedido às 3h).
//
// Segurança (protocolo v2, defesa em profundidade):
//  1. Só conexões de SAÍDA, por HTTPS (http só para localhost, em desenvolvimento).
//  2. AUTENTICIDADE: cada trabalho é assinado com Ed25519 pela chave do ERP, fixada no código de conexão.
//     Um relay invadido não consegue forjar impressões.
//  3. SIGILO (ponta a ponta): o EasyPrint gera um par X25519 na própria loja; o ERP cifra cada trabalho
//     (AES-256-GCM) para essa chave. O relay — e quem tiver só o token — vê apenas bytes cifrados.
//  4. Chave da loja autenticada por um segredo que só existe no código de conexão (o relay nunca o vê):
//     o relay não consegue trocar a chave para ler os pedidos (ataque "man-in-the-middle").
//  5. Código de conexão de USO ÚNICO: no pareamento o token é trocado por um novo, então uma foto do
//     código depois de conectado não serve para nada.
//  6. Trabalho amarrado ao dispositivo, com validade e id único nunca aceito duas vezes (anti-replay).
//  7. Políticas por conexão (gaveta bloqueada por padrão) e segredos guardados com DPAPI / arquivo 0600.
const crypto = require('crypto');
const fs = require('fs');
const { EventEmitter } = require('events');
const { EPError, toErrorPayload } = require('./errors');
const { VERSION } = require('./config');

const CODE_PREFIX = 'EPC2.';
const MAX_JOB_TTL_MS = 7 * 24 * 3600 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_RESPONSE_BYTES = 40 * 1024 * 1024;
const KEY_MAC_LABEL = 'easyprint-device-key-v2';
const HKDF_INFO = 'easyprint-job-v2';

function isLocalHost(h) { return h === 'localhost' || h === '127.0.0.1' || h === '[::1]'; }

const fingerprint = (b64) => crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex').slice(0, 16).match(/.{4}/g).join(' ');

// HMAC que prova ao ERP que a chave de criptografia veio de quem tinha o código de conexão
function keyMac(pairSecret, deviceId, encryptionKey) {
  return crypto.createHmac('sha256', Buffer.from(pairSecret, 'base64url')).update(`${KEY_MAC_LABEL}:${deviceId}:${encryptionKey}`).digest('hex');
}

function parseConnectionCode(code) {
  const raw = String(code || '').trim();
  if (raw.startsWith('EPC1.')) throw new EPError('INVALID_CODE', 'Este código é de uma versão antiga do EasyPrint.', 'Gere um novo código de conexão no seu sistema (ele deve começar com "EPC2.").');
  if (!raw.startsWith(CODE_PREFIX)) throw new EPError('INVALID_CODE', 'Código de conexão inválido.', 'Copie o código completo gerado pelo seu sistema (começa com "EPC2.").');
  let data;
  try { data = JSON.parse(Buffer.from(raw.slice(CODE_PREFIX.length), 'base64url').toString('utf8')); }
  catch { throw new EPError('INVALID_CODE', 'Código de conexão corrompido.', 'Copie o código novamente, sem cortar o final.'); }
  if (data.v !== 2 || !data.url || !data.pairToken || !data.pairSecret || !data.deviceId || !data.publicKey) throw new EPError('INVALID_CODE', 'Código de conexão incompleto.');
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
  if (Buffer.from(String(data.pairSecret), 'base64url').length < 32) throw new EPError('INVALID_CODE', 'Segredo de pareamento fraco ou ausente.');
  return {
    url: url.origin + url.pathname.replace(/\/+$/, ''),
    pairToken: String(data.pairToken),
    pairSecret: String(data.pairSecret),
    deviceId: String(data.deviceId).slice(0, 100),
    name: String(data.name || url.hostname).slice(0, 60),
    publicKey: data.publicKey,
    fingerprint: fingerprint(data.publicKey),
    dev: url.protocol === 'http:',
  };
}

function decryptJob(enc, { id, deviceId }, privateKey) {
  try {
    const epk = crypto.createPublicKey({ key: Buffer.from(enc.epk, 'base64'), format: 'der', type: 'spki' });
    if (epk.asymmetricKeyType !== 'x25519') throw new Error('epk');
    const shared = crypto.diffieHellman({ privateKey, publicKey: epk });
    const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(enc.epk, 'base64'), `${HKDF_INFO}:${id}`, 32));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(enc.iv, 'base64'));
    decipher.setAAD(Buffer.from(`${id}:${deviceId}`));
    decipher.setAuthTag(Buffer.from(enc.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(enc.ct, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch {
    throw new EPError('BAD_JOB', 'Não foi possível decifrar o trabalho.', 'O sistema cifrou para outra chave. Reconecte este computador com um novo código.');
  }
}

// Verifica e decifra um trabalho vindo do relay. Retorna { payload, expiresAt } ou lança EPError.
function verifyJob(job, conn, seen, now = Date.now(), privateKey = null) {
  if (!job || typeof job.id !== 'string' || typeof job.payload !== 'string' || typeof job.signature !== 'string') {
    throw new EPError('BAD_JOB', 'Trabalho malformado recebido da nuvem.');
  }
  const key = crypto.createPublicKey({ key: Buffer.from(conn.publicKey, 'base64'), format: 'der', type: 'spki' });
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(job.payload, 'utf8'), key, Buffer.from(job.signature, 'base64')); } catch { ok = false; }
  if (!ok) throw new EPError('BAD_SIGNATURE', 'Assinatura inválida: trabalho recusado.', 'O trabalho não foi assinado pela chave do seu sistema. Pode ser uma tentativa de fraude ou chave trocada.');
  let p;
  try { p = JSON.parse(job.payload); } catch { throw new EPError('BAD_JOB', 'Conteúdo do trabalho ilegível.'); }
  if (p.v !== 2 || p.id !== job.id) throw new EPError('BAD_JOB', 'Versão ou identificador do trabalho não confere.');
  if (p.deviceId !== conn.deviceId) throw new EPError('WRONG_DEVICE', 'Este trabalho foi emitido para outro computador.');
  if (typeof p.ts !== 'number' || p.ts > now + CLOCK_SKEW_MS) throw new EPError('BAD_JOB', 'Data do trabalho inválida (relógio adiantado?).');
  const expiresAt = typeof p.expiresAt === 'number' ? p.expiresAt : p.ts + 24 * 3600 * 1000;
  if (expiresAt - p.ts > MAX_JOB_TTL_MS) throw new EPError('BAD_JOB', 'Validade do trabalho longa demais.');
  if (now > expiresAt) throw new EPError('EXPIRED', 'Trabalho expirado: não foi impresso.');
  if (seen.has(p.id)) throw new EPError('DUPLICATE', 'Trabalho já impresso antes (ignorado).');
  if (!p.enc || typeof p.enc !== 'object') throw new EPError('BAD_JOB', 'Trabalho sem criptografia recusado.');
  if (!privateKey) throw new EPError('BAD_JOB', 'Chave de criptografia indisponível.');
  return { payload: decryptJob(p.enc, p, privateKey), expiresAt };
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
    fs.writeFile(this.file, JSON.stringify(Object.fromEntries(this.map)), { mode: 0o600 }, () => {});
  }
}

class CloudRelay extends EventEmitter {
  constructor({ config, printing, driver, log }) {
    super();
    this.config = config;
    this.printing = printing;
    this.driver = driver;
    this.log = log;
    this.runtime = new Map(); // id -> { state, lastContact, lastError, printed, rejected, controller, privateKey }
    this.seen = new SeenStore(config.path('cloud-seen.json'));
  }

  connections() { return this.config.get('cloud') || []; }

  publicState() {
    return this.connections().map((c) => {
      const r = this.runtime.get(c.id) || {};
      return {
        id: c.id, name: c.name, host: new URL(c.url).host, deviceId: c.deviceId, fingerprint: c.fingerprint,
        encryptionFingerprint: c.encryptionKey ? fingerprint(c.encryptionKey) : null, dev: !!c.dev,
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
    // 1. par de chaves de criptografia gerado AQUI (a privada nunca sai deste computador)
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    const encryptionKey = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const encPrivate = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    // 2. pareamento: troca o token de uso único por um token definitivo e registra a chave autenticada
    let res;
    try {
      res = await fetch(info.url + '/v1/agent/pair', {
        method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${info.pairToken}`, 'Content-Type': 'application/json', 'User-Agent': `EasyPrint/${VERSION}` },
        body: JSON.stringify({ encryptionKey, keyMac: keyMac(info.pairSecret, info.deviceId, encryptionKey) }),
      });
    } catch (e) {
      throw new EPError('OFFLINE', 'Não foi possível falar com o servidor do sistema.', 'Confira a internet deste computador e tente de novo.');
    }
    const data = await res.json().catch(() => null);
    if (res.status === 401 || res.status === 409) {
      throw new EPError('CODE_USED', 'Este código de conexão já foi usado ou expirou.', 'Gere um novo código no seu sistema. Se você não usou este código, alguém pode ter copiado — revogue o dispositivo no sistema.');
    }
    if (!res.ok || !data || !data.token) throw new EPError('PAIR_FAILED', `O servidor recusou o pareamento (${res.status}).`);

    const secrets = {
      ...(await this._protect('token', data.token)),
      ...(await this._protect('encPrivate', encPrivate)),
    };
    const conn = {
      id: crypto.randomBytes(5).toString('hex'), name: info.name, url: info.url, deviceId: info.deviceId,
      publicKey: info.publicKey, fingerprint: info.fingerprint, encryptionKey, dev: info.dev, ...secrets,
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

  async _protect(name, value) {
    if (this.driver.protect) {
      try { return { [`${name}Protected`]: await this.driver.protect(value) }; } catch (e) { this.log('DPAPI indisponível:', e.message); }
    }
    return { [`${name}Plain`]: value };
  }

  async _secret(c, name) {
    if (c[`${name}Protected`]) return this.driver.unprotect(c[`${name}Protected`]);
    return c[`${name}Plain`];
  }

  async _privateKey(conn, r) {
    if (!r.privateKey) {
      const der = await this._secret(conn, 'encPrivate');
      if (!der) return null;
      r.privateKey = crypto.createPrivateKey({ key: Buffer.from(der, 'base64'), format: 'der', type: 'pkcs8' });
    }
    return r.privateKey;
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
    const token = await this._secret(conn, 'token');
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
          if (s.status === 401 || s.status === 403) {
            this._set(r, 'unauthorized', 'O sistema recusou a conexão (dispositivo revogado). Gere um novo código de conexão.', conn);
            await sleep(60000, signal); continue;
          }
          if (s.status < 400) this._set(r, 'online', null, conn);
          lastStatus = Date.now();
        }
        // 1ª consulta sem espera (pega o que acumulou offline); depois, long-polling de 25 s
        const { status, data } = await this._request(conn, `/v1/agent/jobs?wait=${first ? 0 : 25}`, { signal });
        first = false;
        if (status === 401 || status === 403) {
          this._set(r, 'unauthorized', 'O sistema recusou a conexão (dispositivo revogado). Gere um novo código de conexão.', conn);
          lastStatus = 0;
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
    try {
      const verified = verifyJob(job, conn, this.seen, Date.now(), await this._privateKey(conn, r));
      const p = verified.payload;
      // Marca como visto ANTES de imprimir: se cair no meio, nunca imprime em dobro.
      this.seen.add(job.id, verified.expiresAt);
      const req = {
        printer: p.printer, route: p.route, copies: p.copies, jobName: p.jobName, options: p.options,
        document: p.document, text: p.text, image: p.image, raw: p.raw, pdf: p.pdf, pdfOptions: p.pdfOptions,
        html: p.html, htmlOptions: p.htmlOptions,
      };
      const out = await this.printing.print(req, {
        origin: `nuvem:${conn.name}`, appName: conn.name, rateKey: `cloud:${conn.id}`,
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

module.exports = { CloudRelay, parseConnectionCode, verifyJob, decryptJob, keyMac, fingerprint, CODE_PREFIX };
