'use strict';
/*!
 * EasyPrint Relay — servidor de fila de referência (Node 18+, sem dependências).
 *
 * Variáveis de ambiente:
 *   RELAY_API_KEY  (obrigatória, ≥ 32 caracteres) chave usada pelo back-end do ERP
 *   PORT           porta (padrão 8787)
 *   DATA_FILE      arquivo JSON de persistência (padrão ./relay-data.json)
 *   TLS_CERT, TLS_KEY  caminhos do certificado — ou rode atrás de um proxy HTTPS (recomendado)
 *
 * O relay NÃO tem a chave privada: só guarda e entrega trabalhos já assinados pelo ERP.
 * Mesmo que alguém invada o relay, o EasyPrint recusa trabalhos sem assinatura válida.
 *
 * API do ERP (Authorization: Bearer RELAY_API_KEY)
 *   POST   /v1/devices                 { name }                    -> { deviceId, token }
 *   GET    /v1/devices/:id                                         -> status do computador
 *   DELETE /v1/devices/:id                                         -> revoga
 *   POST   /v1/devices/:id/jobs        { id, payload, signature }  -> { id, status: 'queued' }
 *   GET    /v1/jobs/:id                                            -> { status, result }
 * API do EasyPrint (Authorization: Bearer <token do dispositivo>)
 *   GET    /v1/agent/jobs?wait=25      long-polling                -> { jobs: [...] }
 *   POST   /v1/agent/jobs/:id/result   { status, error?, printer?, pages? }
 *   POST   /v1/agent/status            { agent, printers, routes }
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

const MAX_BODY = 40 * 1024 * 1024;
const REDELIVER_MS = 2 * 60 * 1000;
const MAX_QUEUE = 1000;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function createRelay({ apiKey, dataFile } = {}) {
  if (!apiKey || apiKey.length < 32) throw new Error('RELAY_API_KEY precisa ter pelo menos 32 caracteres.');
  let db = { devices: {}, jobs: {} };
  if (dataFile) { try { db = JSON.parse(fs.readFileSync(dataFile, 'utf8')); } catch { /* novo */ } }
  let saveTimer = null;
  const save = () => {
    if (!dataFile || saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; fs.writeFile(dataFile + '.tmp', JSON.stringify(db), (e) => { if (!e) fs.rename(dataFile + '.tmp', dataFile, () => {}); }); }, 200);
  };
  const waiters = new Map(); // deviceId -> Set(fn)
  const wake = (deviceId) => { for (const fn of waiters.get(deviceId) || []) fn(); };

  const prune = () => {
    const limit = Date.now() - 7 * 24 * 3600 * 1000;
    for (const [id, j] of Object.entries(db.jobs)) if (j.createdAt < limit) delete db.jobs[id];
  };
  setInterval(prune, 3600 * 1000).unref();

  function pendingFor(deviceId) {
    const now = Date.now();
    return Object.values(db.jobs)
      .filter((j) => j.deviceId === deviceId && (j.status === 'queued' || (j.status === 'delivered' && now - j.deliveredAt > REDELIVER_MS)))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, 20);
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://relay');
    const parts = url.pathname.split('/').filter(Boolean); // ['v1', ...]
    const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
    const fail = (status, code, message) => json(status, { error: { code, message } });
    if (parts[0] !== 'v1') return fail(404, 'NOT_FOUND', 'Rota inexistente.');

    // ---------- API do EasyPrint (agente) ----------
    if (parts[1] === 'agent') {
      const device = auth && Object.values(db.devices).find((d) => !d.revoked && safeEq(d.tokenHash, sha256(auth)));
      if (!device) return fail(401, 'UNAUTHORIZED', 'Token do dispositivo inválido ou revogado.');
      device.lastSeen = Date.now(); save();

      if (req.method === 'GET' && parts[2] === 'jobs' && !parts[3]) {
        const wait = Math.min(30, Math.max(0, Number(url.searchParams.get('wait')) || 0)) * 1000;
        const deliver = () => {
          const jobs = pendingFor(device.id);
          const now = Date.now();
          for (const j of jobs) { j.status = 'delivered'; j.deliveredAt = now; j.attempts = (j.attempts || 0) + 1; }
          if (jobs.length) save();
          return jobs.map((j) => ({ id: j.id, payload: j.payload, signature: j.signature }));
        };
        let jobs = deliver();
        if (jobs.length || !wait) return json(200, { jobs });
        const set = waiters.get(device.id) || new Set(); waiters.set(device.id, set);
        let done = false;
        const finish = () => { if (done) return; done = true; set.delete(fn); clearTimeout(t); json(200, { jobs: deliver() }); };
        const fn = () => setImmediate(finish);
        set.add(fn);
        const t = setTimeout(finish, wait);
        req.on('close', () => { done = true; set.delete(fn); clearTimeout(t); });
        return;
      }
      if (req.method === 'POST' && parts[2] === 'jobs' && parts[4] === 'result') {
        const job = db.jobs[parts[3]];
        if (!job || job.deviceId !== device.id) return fail(404, 'NOT_FOUND', 'Trabalho não encontrado.');
        const body = await readJson(req, 64 * 1024);
        const status = ['done', 'failed', 'rejected', 'duplicate'].includes(body.status) ? body.status : 'failed';
        // "duplicate" significa que o EasyPrint já imprimiu esse trabalho antes — conta como concluído
        if (!(status === 'duplicate' && job.status === 'done')) job.status = status === 'duplicate' ? 'done' : status;
        job.result = { status, error: body.error || null, printer: body.printer || null, pages: body.pages || null, at: Date.now() };
        save();
        return json(200, { ok: true });
      }
      if (req.method === 'POST' && parts[2] === 'status') {
        const body = await readJson(req, 256 * 1024);
        device.agent = body.agent || null;
        device.printers = Array.isArray(body.printers) ? body.printers.slice(0, 100) : [];
        device.routes = body.routes && typeof body.routes === 'object' ? body.routes : {};
        save();
        return json(200, { ok: true });
      }
      return fail(404, 'NOT_FOUND', 'Rota inexistente.');
    }

    // ---------- API do ERP ----------
    if (!safeEq(auth, apiKey)) return fail(401, 'UNAUTHORIZED', 'Chave da API inválida.');

    if (req.method === 'POST' && parts[1] === 'devices' && !parts[2]) {
      const body = await readJson(req, 16 * 1024);
      const id = 'dev_' + crypto.randomBytes(9).toString('base64url');
      const token = 'epd_' + crypto.randomBytes(32).toString('base64url');
      db.devices[id] = { id, name: String(body.name || 'Computador').slice(0, 80), tokenHash: sha256(token), createdAt: Date.now(), lastSeen: null, revoked: false };
      save();
      return json(201, { deviceId: id, token });
    }
    const device = parts[1] === 'devices' && db.devices[parts[2]];
    if (parts[1] === 'devices' && (!device || device.revoked)) return fail(404, 'NOT_FOUND', 'Dispositivo não encontrado.');
    if (req.method === 'GET' && device && !parts[3]) {
      const { tokenHash, ...pub } = device;
      return json(200, { ...pub, online: !!device.lastSeen && Date.now() - device.lastSeen < 60000 });
    }
    if (req.method === 'DELETE' && device && !parts[3]) {
      device.revoked = true; device.tokenHash = sha256(crypto.randomBytes(32)); save(); wake(device.id);
      return json(200, { ok: true });
    }
    if (req.method === 'POST' && device && parts[3] === 'jobs') {
      const body = await readJson(req, MAX_BODY);
      if (typeof body.id !== 'string' || typeof body.payload !== 'string' || typeof body.signature !== 'string') return fail(400, 'BAD_REQUEST', 'Envie { id, payload, signature } gerados pelo SDK.');
      let p; try { p = JSON.parse(body.payload); } catch { return fail(400, 'BAD_REQUEST', 'payload inválido.'); }
      if (p.id !== body.id || p.deviceId !== device.id) return fail(400, 'BAD_REQUEST', 'O trabalho não pertence a este dispositivo.');
      if (db.jobs[body.id]) return fail(409, 'DUPLICATE', 'Trabalho já enviado.');
      const queued = Object.values(db.jobs).filter((j) => j.deviceId === device.id && j.status === 'queued').length;
      if (queued >= MAX_QUEUE) return fail(429, 'QUEUE_FULL', 'Fila cheia: o computador está offline há muito tempo?');
      db.jobs[body.id] = { id: body.id, deviceId: device.id, payload: body.payload, signature: body.signature, status: 'queued', createdAt: Date.now() };
      save(); wake(device.id);
      return json(202, { id: body.id, status: 'queued' });
    }
    if (req.method === 'GET' && parts[1] === 'jobs' && parts[2]) {
      const j = db.jobs[parts[2]];
      if (!j) return fail(404, 'NOT_FOUND', 'Trabalho não encontrado.');
      return json(200, { id: j.id, deviceId: j.deviceId, status: j.status, createdAt: j.createdAt, deliveredAt: j.deliveredAt || null, attempts: j.attempts || 0, result: j.result || null });
    }
    return fail(404, 'NOT_FOUND', 'Rota inexistente.');
  }

  const listener = (req, res) => handler(req, res).catch((e) => {
    if (!res.headersSent) { res.writeHead(e.status || 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: e.code || 'INTERNAL', message: e.status ? e.message : 'Erro interno.' } })); }
  });
  return { listener, db };
}

function readJson(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > max) { reject(Object.assign(new Error('Corpo grande demais.'), { status: 413, code: 'TOO_LARGE' })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('JSON inválido.'), { status: 400, code: 'BAD_REQUEST' })); } });
    req.on('error', reject);
  });
}

if (require.main === module) {
  const { listener } = createRelay({ apiKey: process.env.RELAY_API_KEY, dataFile: process.env.DATA_FILE || './relay-data.json' });
  const port = Number(process.env.PORT) || 8787;
  const server = process.env.TLS_CERT
    ? https.createServer({ cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }, listener)
    : http.createServer(listener);
  server.requestTimeout = 60000;
  server.listen(port, () => console.log(`EasyPrint Relay ouvindo na porta ${port}${process.env.TLS_CERT ? ' (HTTPS)' : ' (use um proxy HTTPS em produção)'}`));
}

module.exports = { createRelay };
