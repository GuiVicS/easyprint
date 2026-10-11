'use strict';
/*!
 * EasyPrint Cloud — SDK de servidor (Node 18+). Sem dependências. Protocolo v2.
 * Use no back-end do seu ERP / loja virtual para mandar impressões para os computadores das lojas.
 *
 *   const { EasyPrintCloud, generateKeys } = require('./easyprint-cloud');
 *   const keys = generateKeys();                 // 1x — guarde a privada em segredo (cofre / env)
 *   const cloud = new EasyPrintCloud({ relayUrl, apiKey, privateKey: keys.privateKey, publicKey: keys.publicKey });
 *
 *   // 1x por loja: guarde { deviceId, deviceSecret } no seu banco (deviceSecret é SEGREDO) e mostre o código ao lojista
 *   const { deviceId, deviceSecret, connectionCode } = await cloud.createDevice('Loja Centro');
 *
 *   // depois que o lojista colar o código no EasyPrint:
 *   await cloud.print({ deviceId, deviceSecret }, { route: 'etiqueta', raw: { text: zpl } });
 *
 * Segurança:
 *  - Cada trabalho é ASSINADO (Ed25519, sua chave) e CIFRADO de ponta a ponta (X25519 + AES-256-GCM)
 *    para a chave gerada no computador da loja. O relay só vê bytes cifrados.
 *  - A chave da loja é autenticada com o deviceSecret (que nunca passa pelo relay): se o relay tentar
 *    trocar a chave para ler os pedidos, print() recusa com KEY_MISMATCH.
 */
const crypto = require('crypto');

const KEY_MAC_LABEL = 'easyprint-device-key-v2';
const HKDF_INFO = 'easyprint-job-v2';

function generateKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

const fingerprint = (b64) => crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex').slice(0, 16).match(/.{4}/g).join(' ');

function toBase64(data) {
  if (data === undefined || data === null) return undefined;
  if (typeof data === 'string') return data.replace(/^data:[^,]*,/, '');
  if (Buffer.isBuffer(data) || data instanceof Uint8Array) return Buffer.from(data).toString('base64');
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString('base64');
  throw new TypeError('Use string base64, Buffer, Uint8Array ou ArrayBuffer.');
}

function keyMac(deviceSecret, deviceId, encryptionKey) {
  return crypto.createHmac('sha256', Buffer.from(deviceSecret, 'base64url')).update(`${KEY_MAC_LABEL}:${deviceId}:${encryptionKey}`).digest('hex');
}

function connectionCode({ relayUrl, pairToken, deviceSecret, deviceId, name, publicKey }) {
  const json = JSON.stringify({ v: 2, url: relayUrl.replace(/\/+$/, ''), pairToken, pairSecret: deviceSecret, deviceId, name, publicKey });
  return 'EPC2.' + Buffer.from(json, 'utf8').toString('base64url');
}

function encryptFor(encryptionKey, { id, deviceId }, plainObj) {
  const devicePub = crypto.createPublicKey({ key: Buffer.from(encryptionKey, 'base64'), format: 'der', type: 'spki' });
  const eph = crypto.generateKeyPairSync('x25519');
  const epk = eph.publicKey.export({ format: 'der', type: 'spki' });
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: devicePub });
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, epk, `${HKDF_INFO}:${id}`, 32));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${id}:${deviceId}`));
  const ct = Buffer.concat([cipher.update(JSON.stringify(plainObj), 'utf8'), cipher.final()]);
  return { alg: 'X25519-HKDF-SHA256-A256GCM', epk: epk.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

/** Monta, cifra e assina um trabalho. Útil se você implementar o relay no seu próprio back-end. */
function signJob({ deviceId, encryptionKey, job, privateKey, ttlMs = 24 * 3600 * 1000 }) {
  if (!deviceId) throw new Error('deviceId é obrigatório');
  if (!encryptionKey) throw new Error('encryptionKey (chave do computador da loja) é obrigatória');
  if (ttlMs > 7 * 24 * 3600 * 1000) throw new Error('A validade máxima é 7 dias');
  const key = typeof privateKey === 'string'
    ? crypto.createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' })
    : privateKey;
  const ts = Date.now();
  const id = crypto.randomUUID();
  const inner = {
    printer: job.printer, route: job.route, copies: job.copies, jobName: job.jobName, options: job.options,
    document: job.document && typeof job.document.build === 'function' ? job.document.build() : job.document,
    text: job.text, image: job.image,
    raw: job.raw === undefined ? undefined : (job.raw && typeof job.raw === 'object' && !Buffer.isBuffer(job.raw) && !(job.raw instanceof Uint8Array) ? job.raw : toBase64(job.raw)),
    pdf: toBase64(job.pdf), pdfOptions: job.pdfOptions, html: job.html, htmlOptions: job.htmlOptions,
  };
  const outer = { v: 2, id, deviceId: String(deviceId), ts, expiresAt: ts + ttlMs };
  outer.enc = encryptFor(encryptionKey, outer, inner);
  const payload = JSON.stringify(outer);
  const signature = crypto.sign(null, Buffer.from(payload, 'utf8'), key).toString('base64');
  return { id, payload, signature };
}

class EasyPrintCloud {
  /**
   * @param {object} o
   * @param {string} o.relayUrl   URL do relay (https)
   * @param {string} o.apiKey     chave da API do relay (segredo do servidor)
   * @param {string} o.privateKey chave privada Ed25519 (base64 PKCS8) — NUNCA envie ao navegador
   * @param {string} o.publicKey  chave pública Ed25519 (base64 SPKI) — vai no código de conexão
   */
  constructor({ relayUrl, apiKey, privateKey, publicKey }) {
    if (!relayUrl || !apiKey || !privateKey || !publicKey) throw new Error('relayUrl, apiKey, privateKey e publicKey são obrigatórios');
    this.relayUrl = relayUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.privateKey = crypto.createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' });
    this.publicKey = publicKey;
    this.keys = new Map(); // deviceId -> encryptionKey já verificada
  }

  async _req(method, path, body) {
    const res = await fetch(this.relayUrl + path, {
      method, headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const e = new Error((data && data.error && data.error.message) || `Relay respondeu ${res.status}`);
      e.status = res.status; e.code = data && data.error && data.error.code;
      throw e;
    }
    return data;
  }

  /**
   * Cria um computador/loja. Guarde deviceId e deviceSecret (segredo!) no seu banco e mostre o
   * connectionCode para o lojista colar no EasyPrint (Nuvem → Conectar). O código é de uso único.
   */
  async createDevice(name) {
    const d = await this._req('POST', '/v1/devices', { name });
    const deviceSecret = crypto.randomBytes(32).toString('base64url');
    return {
      deviceId: d.deviceId,
      deviceSecret,
      connectionCode: connectionCode({ relayUrl: this.relayUrl, pairToken: d.pairToken, deviceSecret, deviceId: d.deviceId, name, publicKey: this.publicKey }),
    };
  }

  /** Status: { online, paired, lastSeen, agent, printers, routes, encryptionFingerprint } */
  async device(deviceId) {
    const d = await this._req('GET', `/v1/devices/${encodeURIComponent(deviceId)}`);
    return { ...d, encryptionFingerprint: d.encryptionKey ? fingerprint(d.encryptionKey) : null };
  }

  /** Revoga o acesso de um computador (o EasyPrint dele para de receber trabalhos). */
  revokeDevice(deviceId) { this.keys.delete(deviceId); return this._req('DELETE', `/v1/devices/${encodeURIComponent(deviceId)}`); }

  /** Busca a chave de criptografia da loja e confere que ela não foi trocada pelo relay. */
  async deviceKey({ deviceId, deviceSecret }) {
    if (this.keys.has(deviceId)) return this.keys.get(deviceId);
    if (!deviceSecret) throw Object.assign(new Error('deviceSecret é obrigatório (guardado ao criar o dispositivo).'), { code: 'MISSING_SECRET' });
    const d = await this._req('GET', `/v1/devices/${encodeURIComponent(deviceId)}`);
    if (!d.paired || !d.encryptionKey) throw Object.assign(new Error('Este computador ainda não colou o código de conexão no EasyPrint.'), { code: 'NOT_PAIRED' });
    const expected = keyMac(deviceSecret, deviceId, d.encryptionKey);
    const ok = typeof d.keyMac === 'string' && d.keyMac.length === expected.length && crypto.timingSafeEqual(Buffer.from(d.keyMac), Buffer.from(expected));
    if (!ok) throw Object.assign(new Error('A chave do computador não confere: possível adulteração no relay. Nada foi enviado.'), { code: 'KEY_MISMATCH' });
    this.keys.set(deviceId, d.encryptionKey);
    return d.encryptionKey;
  }

  /**
   * Envia uma impressão (cifrada e assinada).
   * device: { deviceId, deviceSecret }
   * job: { route?, printer?, copies?, jobName?, document? | text? | image? | raw? | pdf? | html?, pdfOptions?, htmlOptions?, options? }
   * opts: { ttlMs } validade do trabalho (padrão 24h, máx. 7 dias)
   */
  async print(device, job, opts = {}) {
    if (!device || typeof device !== 'object' || !device.deviceId) throw new TypeError('Use cloud.print({ deviceId, deviceSecret }, job)');
    const encryptionKey = await this.deviceKey(device);
    const signed = signJob({ deviceId: device.deviceId, encryptionKey, job, privateKey: this.privateKey, ttlMs: opts.ttlMs });
    await this._req('POST', `/v1/devices/${encodeURIComponent(device.deviceId)}/jobs`, signed);
    return { jobId: signed.id };
  }

  /** Situação do trabalho: queued | delivered | done | failed | rejected */
  job(jobId) { return this._req('GET', `/v1/jobs/${encodeURIComponent(jobId)}`); }

  /** Espera o resultado (útil em scripts e testes). */
  async waitJob(jobId, { timeoutMs = 60000, intervalMs = 1000 } = {}) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const j = await this.job(jobId);
      if (!['queued', 'delivered'].includes(j.status)) return j;
      if (Date.now() > end) return j;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

module.exports = { EasyPrintCloud, generateKeys, signJob, encryptFor, keyMac, fingerprint, connectionCode };
