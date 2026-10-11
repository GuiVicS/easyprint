'use strict';
// Modelo de segurança do EasyPrint (bem mais simples que o QZ Tray, sem CA raiz nem assinatura):
//  1. O agente só escuta em 127.0.0.1 — nada fica exposto na rede.
//  2. Cada site (Origin enviado pelo navegador, que a página não consegue falsificar) precisa ser
//     aprovado UMA vez pelo usuário, com um clique, na janela do próprio EasyPrint.
//  3. Apps sem navegador (backend local, Electron, scripts) usam um token criado no painel.
//  4. O painel de administração exige um token secreto por execução + verificação de Host/Origin
//     (protege contra CSRF e DNS rebinding).
const crypto = require('crypto');
const { EventEmitter } = require('events');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function normalizeOrigin(origin) {
  if (!origin || origin === 'null') return null;
  try {
    const u = new URL(origin);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    return u.origin;
  } catch { return null; }
}

class Security extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.adminToken = crypto.randomBytes(24).toString('hex');
    this.pending = new Map(); // id -> { id, origin, appName, createdAt, waiters:Set }
    this.lastPrompt = new Map(); // origin -> timestamp
  }

  isAllowed(origin) { return this.config.get('sites').some((s) => s.origin === origin); }
  siteFor(origin) { return this.config.get('sites').find((s) => s.origin === origin) || null; }

  // Permissões finas por site/app (gaveta desligada por padrão)
  updateSite(origin, patch) {
    const sites = this.config.get('sites');
    const s = sites.find((x) => x.origin === origin);
    if (!s) return false;
    if (patch.allowDrawer !== undefined) s.allowDrawer = !!patch.allowDrawer;
    this.config.set('sites', sites);
    return true;
  }

  updateToken(id, patch) {
    const tokens = this.config.get('tokens');
    const t = tokens.find((x) => x.id === id);
    if (!t) return false;
    if (patch.allowDrawer !== undefined) t.allowDrawer = !!patch.allowDrawer;
    this.config.set('tokens', tokens);
    return true;
  }
  isDenied(origin) { return this.config.get('denied').some((s) => s.origin === origin); }

  touch(origin) {
    const sites = this.config.get('sites');
    const s = sites.find((x) => x.origin === origin);
    if (s) { s.lastUsed = new Date().toISOString(); this.config.set('sites', sites); }
  }

  checkToken(token) {
    if (!token) return null;
    const hash = sha256(String(token));
    const tokens = this.config.get('tokens');
    const t = tokens.find((x) => crypto.timingSafeEqual(Buffer.from(x.hash), Buffer.from(hash)));
    if (t) { t.lastUsed = new Date().toISOString(); this.config.set('tokens', tokens); }
    return t || null;
  }

  createToken(name) {
    const token = 'ep_' + crypto.randomBytes(24).toString('base64url');
    const tokens = this.config.get('tokens');
    const entry = { id: crypto.randomBytes(4).toString('hex'), name: String(name || 'App local').slice(0, 60), hash: sha256(token), createdAt: new Date().toISOString(), lastUsed: null, allowDrawer: false };
    tokens.push(entry);
    this.config.set('tokens', tokens);
    return { ...entry, token };
  }

  revokeToken(id) { this.config.set('tokens', this.config.get('tokens').filter((t) => t.id !== id)); }

  // Pede aprovação; devolve a solicitação pendente (o chamador espera o evento)
  requestPairing(origin, appName, waiter) {
    for (const p of this.pending.values()) {
      if (p.origin === origin) { if (waiter) p.waiters.add(waiter); return { request: p, isNew: false }; }
    }
    // Proteção contra spam de pedidos: no máximo 5 pedidos pendentes ao mesmo tempo
    if (this.pending.size >= 5) return { request: null, isNew: false };
    const p = { id: crypto.randomBytes(6).toString('hex'), origin, appName: String(appName || '').slice(0, 80) || null, createdAt: new Date().toISOString(), waiters: new Set() };
    if (waiter) p.waiters.add(waiter);
    this.pending.set(p.id, p);
    const last = this.lastPrompt.get(origin) || 0;
    const shouldOpen = Date.now() - last > 120000; // reabre a janela no máximo a cada 2 min por site
    this.lastPrompt.set(origin, Date.now());
    this.emit('pairing', this.publicRequest(p), shouldOpen);
    return { request: p, isNew: true };
  }

  publicRequest(p) { return { id: p.id, origin: p.origin, appName: p.appName, createdAt: p.createdAt }; }
  pendingList() { return [...this.pending.values()].map((p) => this.publicRequest(p)); }

  removeWaiter(waiter) {
    for (const p of this.pending.values()) p.waiters.delete(waiter);
  }

  resolve(id, approved, { remember = true } = {}) {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    if (approved) {
      const sites = this.config.get('sites').filter((s) => s.origin !== p.origin);
      sites.push({ origin: p.origin, appName: p.appName, approvedAt: new Date().toISOString(), lastUsed: null, allowDrawer: false });
      this.config.set('sites', sites);
      this.config.set('denied', this.config.get('denied').filter((d) => d.origin !== p.origin));
    } else if (remember) {
      const denied = this.config.get('denied').filter((d) => d.origin !== p.origin);
      denied.push({ origin: p.origin, appName: p.appName, at: new Date().toISOString() });
      this.config.set('denied', denied);
    }
    for (const w of p.waiters) w(approved);
    this.emit('resolved', { id, origin: p.origin, approved });
    return true;
  }

  addSite(origin, appName = null) {
    const o = normalizeOrigin(origin);
    if (!o) return null;
    const sites = this.config.get('sites').filter((s) => s.origin !== o);
    sites.push({ origin: o, appName, approvedAt: new Date().toISOString(), lastUsed: null, allowDrawer: false });
    this.config.set('sites', sites);
    this.config.set('denied', this.config.get('denied').filter((d) => d.origin !== o));
    return o;
  }

  removeSite(origin) { this.config.set('sites', this.config.get('sites').filter((s) => s.origin !== origin)); }
  unblock(origin) { this.config.set('denied', this.config.get('denied').filter((d) => d.origin !== origin)); }

  // Verificações HTTP do painel
  validHost(req, port) {
    const host = String(req.headers.host || '').toLowerCase();
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  }

  isAdmin(req, port) {
    if (!this.validHost(req, port)) return false;
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return false;
    const url = new URL(req.url, 'http://x');
    const token = req.headers['x-easyprint-admin'] || url.searchParams.get('admin');
    if (!token || token.length !== this.adminToken.length) return false;
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(this.adminToken));
  }
}

module.exports = { Security, normalizeOrigin };
