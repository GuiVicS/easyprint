'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function startAgent() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'easyprint-t-'));
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'agent', 'src', 'main.js'), '--port', '0', '--no-open', '--no-tray', '--background'], {
    env: { ...process.env, EASYPRINT_HOME: home }, stdio: 'ignore',
  });
  const logFile = path.join(home, 'easyprint.log');
  const port = await new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      let log = ''; try { log = fs.readFileSync(logFile, 'utf8'); } catch { /* ainda não */ }
      const m = /ouvindo em http:\/\/127\.0\.0\.1:(\d+)/.exec(log);
      if (m) { clearInterval(iv); resolve(Number(m[1])); }
      if (Date.now() - t0 > 20000) { clearInterval(iv); reject(new Error('agente não subiu: ' + log)); }
    }, 100);
  });
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  const admin = /easyprint-admin" content="([^"]+)/.exec(html)[1];
  const api = async (p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/admin/${p}`, {
      method: body ? 'POST' : 'GET', headers: { 'X-EasyPrint-Admin': admin, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
    });
    return r.json();
  };
  return { proc, port, admin, api, home, stop: () => proc.kill() };
}

function wsClient(port, origin) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, origin ? { headers: { Origin: origin } } : undefined);
  let seq = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const opened = new Promise((r) => (ws.onopen = r));
  return {
    ws,
    call: async (method, params) => { await opened; const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => pending.set(id, r)); },
    close: () => ws.close(),
  };
}

const waitFor = async (fn, timeoutMs = 15000) => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('tempo esgotado esperando condição');
    await new Promise((r) => setTimeout(r, 200));
  }
};

module.exports = { startAgent, wsClient, waitFor };
