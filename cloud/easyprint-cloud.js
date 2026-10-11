'use strict';
/*!
 * EasyPrint Cloud — SDK de servidor (Node 18+). Sem dependências.
 * Use no back-end do seu ERP / loja virtual para mandar impressões para os computadores das lojas.
 *
 *   const { EasyPrintCloud, generateKeys } = require('./easyprint-cloud');
 *   // 1x: gere as chaves e guarde a privada em segredo (variável de ambiente / cofre)
 *   const keys = generateKeys();
 *   const cloud = new EasyPrintCloud({ relayUrl, apiKey, privateKey: keys.privateKey, publicKey: keys.publicKey });
 *   const { deviceId, connectionCode } = await cloud.createDevice('Loja Centro'); // cole o código no EasyPrint
 *   await cloud.print(deviceId, { route: 'etiqueta', raw: { text: zplDoMercadoLivre } });
 *
 * Segurança: cada trabalho é assinado com Ed25519. O EasyPrint só imprime trabalhos com assinatura
 * da SUA chave — nem quem controla o relay consegue forjar impressões.
 */
const crypto = require('crypto');

function generateKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

function toBase64(data) {
  if (data === undefined || data === null) return undefined;
  if (typeof data === 'string') return data.replace(/^data:[^,]*,/, '');
  if (Buffer.isBuffer(data) || data instanceof Uint8Array) return Buffer.from(data).toString('base64');
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString('base64');
  throw new TypeError('Use string base64, Buffer, Uint8Array ou ArrayBuffer.');
}

function connectionCode({ relayUrl, token, deviceId, name, publicKey }) {
  const json = JSON.stringify({ v: 1, url: relayUrl.replace(/\/+$/, ''), token, deviceId, name, publicKey });
  return 'EPC1.' + Buffer.from(json, 'utf8').toString('base64url');
}

/** Monta e assina um trabalho. Útil se você implementar o relay no seu próprio back-end. */
function signJob({ deviceId, job, privateKey, ttlMs = 24 * 3600 * 1000 }) {
  if (!deviceId) throw new Error('deviceId é obrigatório');
  if (ttlMs > 7 * 24 * 3600 * 1000) throw new Error('A validade máxima é 7 dias');
  const key = typeof privateKey === 'string'
    ? crypto.createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' })
    : privateKey;
  const ts = Date.now();
  const payloadObj = {
    v: 1, id: crypto.randomUUID(), deviceId: String(deviceId), ts, expiresAt: ts + ttlMs,
    printer: job.printer, route: job.route, copies: job.copies, jobName: job.jobName, options: job.options,
    document: job.document && typeof job.document.build === 'function' ? job.document.build() : job.document,
    text: job.text, image: job.image,
    raw: job.raw === undefined ? undefined : (job.raw && typeof job.raw === 'object' && !Buffer.isBuffer(job.raw) && !(job.raw instanceof Uint8Array) ? job.raw : toBase64(job.raw)),
    pdf: toBase64(job.pdf), pdfOptions: job.pdfOptions, html: job.html, htmlOptions: job.htmlOptions,
  };
  const payload = JSON.stringify(payloadObj);
  const signature = crypto.sign(null, Buffer.from(payload, 'utf8'), key).toString('base64');
  return { id: payloadObj.id, payload, signature };
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

  /** Cria um computador/loja. Mostre o connectionCode para o lojista colar no EasyPrint (Nuvem → Conectar). */
  async createDevice(name) {
    const d = await this._req('POST', '/v1/devices', { name });
    return { deviceId: d.deviceId, connectionCode: connectionCode({ relayUrl: this.relayUrl, token: d.token, deviceId: d.deviceId, name, publicKey: this.publicKey }) };
  }

  /** Status: { online, lastSeen, agent, printers, routes } */
  device(deviceId) { return this._req('GET', `/v1/devices/${encodeURIComponent(deviceId)}`); }

  /** Revoga o acesso de um computador (o EasyPrint dele para de receber trabalhos). */
  revokeDevice(deviceId) { return this._req('DELETE', `/v1/devices/${encodeURIComponent(deviceId)}`); }

  /**
   * Envia uma impressão.
   * job: { route?, printer?, copies?, jobName?, document? | text? | image? | raw? | pdf?, pdfOptions?, options? }
   * opts: { ttlMs } validade do trabalho (padrão 24h, máx. 7 dias)
   */
  async print(deviceId, job, opts = {}) {
    const signed = signJob({ deviceId, job, privateKey: this.privateKey, ttlMs: opts.ttlMs });
    await this._req('POST', `/v1/devices/${encodeURIComponent(deviceId)}/jobs`, signed);
    return { jobId: signed.id };
  }

  /** Situação do trabalho: queued | delivered | done | failed | rejected | duplicate */
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

module.exports = { EasyPrintCloud, generateKeys, signJob, connectionCode };
