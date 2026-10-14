'use strict';
const http = require('http');
const path = require('path');
const { handleUpgrade, MAX_PAYLOAD } = require('./ws');

const PRE_AUTH_MAX_PAYLOAD = 64 * 1024;   // antes de autorizado: mensagens pequenas
const MAX_CLIENTS = 64;
const MAX_CLIENTS_PER_ORIGIN = 10;
const { asset } = require('./assets');
const { VERSION } = require('./config');
const { EPError, toErrorPayload } = require('./errors');
const { normalizeOrigin } = require('./security');
const { testDocument } = require('./test-document');
const system = require('./system');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function createServer({ config, security, printing, cloud, updates, log, onQuit }) {
  let port = null;
  const sse = new Set();
  const trayQueue = [];
  const clients = new Set();

  const broadcastAdmin = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sse) res.write(msg);
  };

  security.on('pairing', (req, shouldOpen) => {
    broadcastAdmin('pairing', req);
    trayQueue.push({ title: 'Novo site quer imprimir', text: `${req.appName ? req.appName + ' — ' : ''}${req.origin}\nClique para permitir ou bloquear.`, level: 'Warning' });
    if (shouldOpen) system.openApp(`http://127.0.0.1:${port}/#/aprovar/${req.id}`, { width: 560, height: 680 });
  });
  security.on('resolved', (r) => broadcastAdmin('resolved', r));
  printing.onJob((job) => {
    broadcastAdmin('job', job);
    if (job.status === 'failed' && config.get('notifications')) {
      trayQueue.push({ title: 'Falha ao imprimir', text: `${job.printer}: ${job.error}`, level: 'Error' });
    }
  });

  if (cloud) {
    cloud.on('state', (s) => broadcastAdmin('cloud', s));
    cloud.on('security', (s) => {
      broadcastAdmin('cloud', s);
      trayQueue.push({ title: 'EasyPrint bloqueou um trabalho', text: `${s.connection}: ${s.message}`, level: 'Warning' });
    });
  }

  if (updates) {
    updates.onUpdate = (u) => {
      broadcastAdmin('update', u);
      trayQueue.push({ title: `EasyPrint ${u.latest} disponível`, text: 'Abra o painel para baixar a nova versão com correções.', level: 'Info' });
    };
  }

  // ---------- HTTP ----------
  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (e) {
      log('Erro HTTP:', e.stack || e.message);
      sendJson(res, e instanceof EPError ? 400 : 500, { ok: false, error: toErrorPayload(e) });
    }
  });

  async function route(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;

    // Endpoint público de descoberta (o SDK usa para saber se o EasyPrint está rodando)
    if (p === '/api/hello') {
      res.writeHead(200, { ...corsPublic(req), 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ name: 'EasyPrint', version: VERSION, ws: `/ws` }));
    }
    if (req.method === 'OPTIONS') { res.writeHead(204, corsPublic(req)); return res.end(); }

    if (!security.validHost(req, port)) { res.writeHead(421); return res.end('Host inválido'); }

    if (p.startsWith('/api/admin/')) {
      if (!security.isAdmin(req, port)) return sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Acesso negado.' } });
      return admin(req, res, p.slice('/api/admin/'.length), url);
    }

    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    if (p === '/' || p === '/index.html') {
      const html = asset('panel/index.html').toString('utf8')
        .replace('__ADMIN_TOKEN__', security.adminToken)
        .replace('__VERSION__', VERSION);
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'" });
      return res.end(html);
    }
    if (p === '/docs') { res.writeHead(301, { Location: '/docs/' }); return res.end(); }
    if (p === '/docs/') {
      const page = asset('docs/index.html');
      if (!page) { res.writeHead(404); return res.end('Documentação não incluída nesta versão.'); }
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      return res.end('<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body>' + page.toString('utf8') + '</body></html>');
    }
    if (p.startsWith('/docs/')) {
      const name = 'docs/' + path.basename(p);
      const data = asset(name);
      if (!data || name === 'docs/index.html') { res.writeHead(404); return res.end(); }
      const type = name.endsWith('.zip') ? 'application/zip' : name.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${path.basename(name)}"` });
      return res.end(data);
    }
    if (p === '/icon.png' || p === '/favicon.ico') {
      const data = asset(p === '/icon.png' ? 'icon.png' : 'icon.ico');
      res.writeHead(200, { 'Content-Type': p === '/icon.png' ? 'image/png' : 'image/x-icon', 'Cache-Control': 'max-age=86400' });
      return res.end(data);
    }
    if (p.startsWith('/panel/') || p === '/easyprint.js') {
      const name = p === '/easyprint.js' ? 'sdk/easyprint.js' : p.slice(1);
      const data = asset(name);
      if (!data) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      return res.end(data);
    }
    res.writeHead(404); res.end('Não encontrado');
  }

  async function admin(req, res, action, url) {
    const body = req.method === 'POST' ? await readJson(req) : {};
    const ok = (result) => sendJson(res, 200, { ok: true, result });

    switch (`${req.method} ${action}`) {
      case 'GET state': return ok(await state());
      case 'GET printers': return ok(await printing.list({ fresh: url.searchParams.has('fresh') }));
      case 'GET jobs': return ok(printing.recentJobs());
      case 'POST profile':
        printing.setProfile(body.printer, body.profile); // perfil vazio volta para a detecção automática
        return ok(true);
      case 'POST default':
        config.set('defaultPrinter', body.printer || null); printing.cache.at = 0; return ok(true);
      case 'POST test-print':
        return ok(await printing.print({ printer: body.printer || undefined, document: testDocument(body.variant), jobName: 'EasyPrint - Teste' }, { appName: 'Painel EasyPrint' }));
      case 'POST pairing': return ok(security.resolve(body.id, !!body.approve, { remember: body.remember !== false }));
      case 'POST sites/add': {
        const o = security.addSite(body.origin, body.appName || null);
        if (!o) throw new EPError('INVALID_ORIGIN', 'Endereço inválido.', 'Use o formato https://meusite.com.br');
        return ok(o);
      }
      case 'POST sites/remove': security.removeSite(body.origin); return ok(true);
      case 'POST sites/update': return ok(security.updateSite(String(body.origin), body));
      case 'POST tokens/update': return ok(security.updateToken(String(body.id), body));
      case 'POST sites/unblock': security.unblock(body.origin); return ok(true);
      case 'POST tokens': return ok(security.createToken(body.name));
      case 'POST tokens/revoke': security.revokeToken(body.id); return ok(true);
      case 'POST autostart': return ok(await system.setAutostart(!!body.enabled).then((v) => { config.set('autostart', v); return v; }));
      case 'POST settings':
        if (body.notifications !== undefined) config.set('notifications', !!body.notifications);
        if (body.setupDone !== undefined) config.set('setupDone', !!body.setupDone);
        if (body.checkUpdates !== undefined) config.set('checkUpdates', !!body.checkUpdates);
        return ok(true);
      case 'GET tray': {
        const notifications = config.get('notifications') ? trayQueue.splice(0, trayQueue.length) : trayQueue.splice(0, trayQueue.length).filter((n) => n.level === 'Warning');
        return ok({ pending: security.pending.size, notifications });
      }
      case 'GET events': {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`event: hello\ndata: {}\n\n`);
        sse.add(res);
        const ka = setInterval(() => res.write(': ka\n\n'), 25000);
        req.on('close', () => { sse.delete(res); clearInterval(ka); });
        return;
      }
      case 'POST routes':
        printing.setRoute(String(body.route || ''), body.printer || null); printing.cache.at = 0; return ok(true);
      case 'GET cloud': return ok(cloud ? cloud.publicState() : []);
      case 'POST cloud/add':
        if (!cloud) throw new EPError('UNSUPPORTED', 'Impressão pela nuvem indisponível.');
        return ok(await cloud.add(body.code));
      case 'POST cloud/update': return ok(cloud.update(String(body.id), body));
      case 'POST cloud/remove': return ok(cloud.remove(String(body.id)));
      case 'POST quit':
        ok(true); setTimeout(onQuit, 200); return;
      default:
        return sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Ação desconhecida.' } });
    }
  }

  async function state() {
    return {
      version: VERSION, port, platform: process.platform, packaged: system.isPackaged,
      setupDone: config.get('setupDone'), autostart: await system.getAutostart(),
      notifications: config.get('notifications'), defaultPrinter: config.get('defaultPrinter'),
      sites: config.get('sites'), denied: config.get('denied'),
      tokens: config.get('tokens').map(({ hash, ...t }) => t),
      routes: config.get('routes') || {}, knownRoutes: config.get('knownRoutes') || {},
      cloud: cloud ? cloud.publicState() : [],
      update: updates ? updates.state : null, checkUpdates: config.get('checkUpdates') !== false,
      pending: security.pendingList(), connections: clients.size, configDir: config.dir,
    };
  }

  // ---------- WebSocket (API usada pelos sites) ----------
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/ws' || !security.validHost(req, port)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const origin = normalizeOrigin(req.headers.origin);
    const sameOrigin = [...clients].filter((c) => c.origin === origin).length;
    if (clients.size >= MAX_CLIENTS || sameOrigin >= MAX_CLIENTS_PER_ORIGIN) { socket.end('HTTP/1.1 429 Too Many Requests\r\n\r\n'); return; }
    const ws = handleUpgrade(req, socket);
    if (!ws) return;
    ws.maxPayload = PRE_AUTH_MAX_PAYLOAD;
    const client = { ws, origin, rawOrigin: req.headers.origin || null, authorized: false, appName: null, via: null, msgs: [] };
    clients.add(client);
    const waiter = (approved) => {
      client.authorized = approved;
      if (approved) { authorize(client, 'site'); security.touch(client.origin); printing.registerRoutes(client.routes, client.origin); }
      ws.send({ event: 'authorization', data: { state: approved ? 'ready' : 'denied' } });
    };
    client.waiter = waiter;
    ws.on('message', (text) => onMessage(client, text));
    ws.on('close', () => { clients.delete(client); security.removeWaiter(waiter); });
  });

  function authorize(client, via) {
    client.authorized = true;
    client.via = via;
    client.ws.maxPayload = MAX_PAYLOAD;
  }

  const rateNotified = new Map();
  async function onMessage(client, text) {
    // Antes da autorização: no máximo 30 mensagens a cada 10 s (evita abuso por sites não aprovados)
    if (!client.authorized) {
      const now = Date.now();
      client.msgs = client.msgs.filter((t) => now - t < 10000);
      client.msgs.push(now);
      if (client.msgs.length > 30) { client.ws.close(1008, 'Mensagens demais'); return; }
    }
    let msg;
    try { msg = JSON.parse(text); } catch { return client.ws.send({ ok: false, error: { code: 'BAD_REQUEST', message: 'JSON inválido.' } }); }
    const { id, method, params = {} } = msg;
    const reply = (result) => client.ws.send({ id, ok: true, result });
    const fail = (e) => client.ws.send({ id, ok: false, error: toErrorPayload(e) });
    try {
      if (method === 'ping') return reply('pong');
      if (method === 'hello') return reply(hello(client, params));
      if (!client.authorized) {
        throw new EPError('NOT_AUTHORIZED', 'Este site ainda não foi autorizado no EasyPrint.', 'Confirme a permissão na janela do EasyPrint que abriu no computador.');
      }
      switch (method) {
        case 'printers.list': return reply((await printing.list()).map(publicPrinter));
        case 'routes.list': {
          const routes = config.get('routes') || {};
          const known = config.get('knownRoutes') || {};
          return reply(Object.keys({ ...known, ...routes }).map((k) => ({ route: k, label: (known[k] || {}).label || k, printer: routes[k] || null })));
        }
        case 'printers.default': {
          const list = await printing.list();
          const d = list.find((p) => p.isDefault);
          return reply(d ? publicPrinter(d) : null);
        }
        case 'print': {
          if (client.origin) security.touch(client.origin);
          const entry = client.tokenId ? config.get('tokens').find((t) => t.id === client.tokenId) : security.siteFor(client.origin);
          const rateKey = client.tokenId ? `token:${client.tokenId}` : `site:${client.origin}`;
          try {
            return reply(await printing.print(params, {
              origin: client.origin || client.via, appName: client.appName, rateKey,
              policy: { allowDrawer: !!(entry && entry.allowDrawer) },
            }));
          } catch (e) {
            if (e.code === 'RATE_LIMITED' && Date.now() - (rateNotified.get(rateKey) || 0) > 5 * 60000) {
              rateNotified.set(rateKey, Date.now());
              trayQueue.push({ title: 'Impressões demais bloqueadas', text: `${client.origin || client.via} tentou imprimir muitas vezes em pouco tempo.`, level: 'Warning' });
              broadcastAdmin('ratelimit', { source: client.origin || client.via });
            }
            throw e;
          }
        }
        default: throw new EPError('UNKNOWN_METHOD', `Método desconhecido: ${method}`);
      }
    } catch (e) { fail(e); }
  }

  function hello(client, params) {
    client.appName = params.appName ? String(params.appName).slice(0, 80) : null;
    client.routes = params.routes && typeof params.routes === 'object' ? params.routes : null;
    const agent = { name: 'EasyPrint', version: VERSION, features: ['document', 'raw', 'pdf', 'routes', 'cloud'] };
    if (params.token) {
      const t = security.checkToken(params.token);
      if (!t) throw new EPError('INVALID_TOKEN', 'Token inválido ou revogado.', 'Crie um novo token no painel do EasyPrint, em "Apps locais".');
      authorize(client, `token:${t.name}`);
      client.tokenId = t.id;
      printing.registerRoutes(client.routes, client.via);
      return { agent, state: 'ready' };
    }
    if (!client.origin) {
      throw new EPError('ORIGIN_REQUIRED', 'Conexões sem navegador (ou de arquivo local) precisam de um token.',
        'Abra a página por http(s), ou crie um token no painel do EasyPrint em "Apps locais" e passe em EasyPrint.connect({ token }).');
    }
    if (security.isAllowed(client.origin)) {
      authorize(client, 'site'); security.touch(client.origin);
      printing.registerRoutes(client.routes, client.origin);
      return { agent, state: 'ready' };
    }
    if (security.isDenied(client.origin)) return { agent, state: 'denied' };
    security.requestPairing(client.origin, client.appName, client.waiter);
    return { agent, state: 'awaiting_approval' };
  }

  function publicPrinter(p) {
    const pr = p.profile;
    return {
      name: p.name, kind: p.kind, online: p.online, isDefault: p.isDefault, mode: pr.mode, columns: pr.columns,
      paperWidth: pr.paperWidth, labelWidth: pr.labelWidth, labelHeight: pr.labelHeight || null, dpi: pr.dpi, paperSize: pr.paperSize,
    };
  }

  return {
    server,
    listen(ports) {
      return new Promise((resolve, reject) => {
        const tryPort = (i) => {
          if (i >= ports.length) return reject(Object.assign(new Error('Nenhuma porta disponível'), { code: 'EADDRINUSE' }));
          server.once('error', (e) => (e.code === 'EADDRINUSE' ? tryPort(i + 1) : reject(e)));
          server.listen(ports[i], '127.0.0.1', () => { port = server.address().port; server.removeAllListeners('error'); resolve(port); });
        };
        tryPort(0);
      });
    },
    get port() { return port; },
    close() { for (const c of clients) c.ws.close(1001, 'EasyPrint encerrado'); for (const r of sse) r.end(); server.close(); },
  };
}

function corsPublic(req) {
  return {
    'Access-Control-Allow-Origin': req.headers.origin || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true', // Private Network Access / Local Network Access
    Vary: 'Origin',
  };
}

function sendJson(res, status, obj) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 1e6) { reject(new EPError('TOO_LARGE', 'Requisição grande demais.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new EPError('BAD_REQUEST', 'JSON inválido.')); } });
  });
}

module.exports = { createServer };
