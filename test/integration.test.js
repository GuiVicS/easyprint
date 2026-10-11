'use strict';
// Sobe o agente de verdade (porta aleatória, pasta temporária) e exercita a API como um site faria.
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'easyprint-test-'));
let proc, port, admin;

function waitForPort() {
  const logFile = path.join(home, 'easyprint.log');
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const iv = setInterval(() => {
      let log = ''; try { log = fs.readFileSync(logFile, 'utf8'); } catch { /* ainda não existe */ }
      const m = /ouvindo em http:\/\/127\.0\.0\.1:(\d+)/.exec(log);
      if (m) { clearInterval(iv); resolve(Number(m[1])); }
      if (Date.now() - started > 20000) { clearInterval(iv); reject(new Error('agente não subiu: ' + log)); }
    }, 100);
  });
}

const adminApi = async (p, body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/admin/${p}`, {
    method: body ? 'POST' : 'GET', headers: { 'X-EasyPrint-Admin': admin, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
  });
  return r.json();
};

function client(origin, onEvent) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, origin ? { headers: { Origin: origin } } : undefined);
  let seq = 0; const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.event) return onEvent && onEvent(m);
    pending.get(m.id)(m); pending.delete(m.id);
  };
  const opened = new Promise((r) => (ws.onopen = r));
  return {
    ws,
    call: async (method, params) => { await opened; const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pending.set(id, r)); },
  };
}

test.before(async () => {
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'agent', 'src', 'main.js'), '--port', '0', '--no-open', '--no-tray', '--background'], {
    env: { ...process.env, EASYPRINT_HOME: home }, stdio: 'ignore',
  });
  port = await waitForPort();
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  admin = /easyprint-admin" content="([^"]+)/.exec(html)[1];
});

test.after(() => { proc.kill(); });

test('descoberta pública responde com CORS e Private Network Access', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/hello`, { headers: { Origin: 'https://loja.com' } });
  assert.strictEqual(r.headers.get('access-control-allow-private-network'), 'true');
  assert.strictEqual((await r.json()).name, 'EasyPrint');
});

test('painel bloqueia Host estranho (DNS rebinding) e admin sem token', async () => {
  const http = require('http');
  const status = await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', agent: false, headers: { Host: 'attacker.com', Connection: 'close' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
  });
  assert.strictEqual(status, 421);
  assert.strictEqual((await fetch(`http://127.0.0.1:${port}/api/admin/state`)).status, 401);
});

test('fluxo completo: site pede permissão, usuário aprova, site imprime', async () => {
  let authorized;
  const gotAuth = new Promise((r) => (authorized = r));
  const c = client('https://pedidos.exemplo.com.br', (m) => m.event === 'authorization' && authorized(m.data.state));
  const hello = await c.call('hello', { appName: 'Exemplo' });
  assert.strictEqual(hello.result.state, 'awaiting_approval');
  assert.strictEqual((await c.call('printers.list')).error.code, 'NOT_AUTHORIZED');

  const state = (await adminApi('state')).result;
  assert.strictEqual(state.pending[0].origin, 'https://pedidos.exemplo.com.br');
  await adminApi('pairing', { id: state.pending[0].id, approve: true });
  assert.strictEqual(await gotAuth, 'ready');

  const printers = (await c.call('printers.list')).result;
  assert.ok(printers.some((p) => p.name === 'EasyPrint Simulador'));

  const res = await c.call('print', { printer: 'EasyPrint Simulador', document: { blocks: [{ type: 'title', value: 'Pedido 1' }, { type: 'cut' }] } });
  assert.strictEqual(res.result.status, 'done');
  const jobs = (await adminApi('jobs')).result;
  assert.strictEqual(jobs[0].origin, 'https://pedidos.exemplo.com.br');
  c.ws.close();

  // reconectar não pede permissão de novo
  const c2 = client('https://pedidos.exemplo.com.br');
  assert.strictEqual((await c2.call('hello', {})).result.state, 'ready');
  c2.ws.close();
});

test('site bloqueado recebe "denied"', async () => {
  const c = client('https://malicioso.example');
  await c.call('hello', {});
  const state = (await adminApi('state')).result;
  const req = state.pending.find((p) => p.origin === 'https://malicioso.example');
  await adminApi('pairing', { id: req.id, approve: false });
  c.ws.close();
  const c2 = client('https://malicioso.example');
  assert.strictEqual((await c2.call('hello', {})).result.state, 'denied');
  c2.ws.close();
});

test('app local com token funciona sem Origin', async () => {
  const t = (await adminApi('tokens', { name: 'Servidor' })).result;
  const c = client(null);
  assert.strictEqual((await c.call('hello', { token: 'errado' })).error.code, 'INVALID_TOKEN');
  assert.strictEqual((await c.call('hello', { token: t.token })).result.state, 'ready');
  const r = await c.call('print', { printer: 'Simulador', text: 'olá' });
  assert.strictEqual(r.result.printer, 'EasyPrint Simulador');
  c.ws.close();
});

test('impressora inexistente gera erro com dica', async () => {
  const t = (await adminApi('tokens', { name: 'x' })).result;
  const c = client(null);
  await c.call('hello', { token: t.token });
  const r = await c.call('print', { printer: 'Nao Existe 3000', text: 'x' });
  assert.strictEqual(r.error.code, 'PRINTER_NOT_FOUND');
  assert.ok(r.error.hint.includes('EasyPrint Simulador'));
  c.ws.close();
});
