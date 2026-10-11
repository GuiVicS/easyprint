'use strict';
// Testa o SDK real (sdk/easyprint.js) contra o agente real.
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EasyPrint = require('../sdk/easyprint.js');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'easyprint-sdk-'));
let proc, port, admin;

test.before(async () => {
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'agent', 'src', 'main.js'), '--port', '0', '--no-open', '--no-tray', '--background'], {
    env: { ...process.env, EASYPRINT_HOME: home }, stdio: 'ignore',
  });
  const logFile = path.join(home, 'easyprint.log');
  port = await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      let log = ''; try { log = fs.readFileSync(logFile, 'utf8'); } catch { /* ainda não */ }
      const m = /ouvindo em http:\/\/127\.0\.0\.1:(\d+)/.exec(log);
      if (m) { clearInterval(iv); resolve(Number(m[1])); }
      if (Date.now() - t0 > 20000) { clearInterval(iv); reject(new Error('agente não subiu')); }
    }, 100);
  });
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  admin = /easyprint-admin" content="([^"]+)/.exec(html)[1];
});

test.after(() => proc.kill());

test('sem agente: status not_running com passos de correção', async () => {
  const c = EasyPrint.connect({ fresh: true, ports: [1], autoReconnect: false, downloadUrl: 'https://exemplo.com/easyprint' });
  await assert.rejects(c.ready(3000), (e) => e.code === 'NOT_RUNNING');
  const d = c.diagnose();
  assert.strictEqual(d.status, 'not_running');
  assert.ok(d.steps.some((s) => s.includes('https://exemplo.com/easyprint')));
  c.disconnect();
});

test('com token: conecta, lista impressoras e imprime cupom no simulador', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/admin/tokens`, { method: 'POST', headers: { 'X-EasyPrint-Admin': admin, 'Content-Type': 'application/json' }, body: '{"name":"sdk-test"}' });
  const { token } = (await r.json()).result;

  const c = EasyPrint.connect({ fresh: true, ports: [port], token, appName: 'Teste SDK' });
  const statuses = [];
  c.on('status', (s) => statuses.push(s));
  await c.ready();
  assert.strictEqual(c.status, 'ready');
  assert.deepStrictEqual(c.diagnose().ok, true);

  const printers = await c.printers();
  assert.ok(printers.find((p) => p.kind === 'virtual'));

  const res = await c.print(
    EasyPrint.receipt().title('PEDIDO #7').line().item(1, 'Açaí 500ml', 'R$ 22,00', 'com granola').total('TOTAL', 'R$ 22,00').qr('https://x.y/7').cut(),
    { printer: 'Simulador' }
  );
  assert.strictEqual(res.status, 'done');

  const raw = await c.printRaw([new Uint8Array([0x1b, 0x40]), 'Teste\n'], { printer: 'Simulador' });
  assert.strictEqual(raw.status, 'done');

  await assert.rejects(c.print({ blocks: [{ type: 'nope' }] }, { printer: 'Simulador' }), (e) => e.code === 'INVALID_DOCUMENT' && !!e.hint);
  assert.ok(statuses.includes('ready'));
  c.disconnect();
});
