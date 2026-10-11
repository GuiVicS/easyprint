'use strict';
// EasyPrint — agente local de impressão para aplicações web.
const fs = require('fs');
const http = require('http');
const { Config, VERSION, DEFAULT_PORTS } = require('./config');
const { Security } = require('./security');
const { PrintService } = require('./printing');
const { createServer } = require('./server');
const system = require('./system');

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

if (flag('--version')) { console.log(VERSION); process.exit(0); }
if (flag('--help')) {
  console.log(`EasyPrint ${VERSION}
  --background   inicia sem abrir o painel
  --port N       usa a porta N (padrão ${DEFAULT_PORTS.join('/')})
  --no-tray      sem ícone na bandeja
  --no-open      nunca abre o navegador automaticamente
  --no-install   não se copia para a pasta de programas`);
  process.exit(0);
}

const config = new Config();
const logFile = config.path('easyprint.log');
try { if (fs.statSync(logFile).size > 2e6) fs.renameSync(logFile, logFile + '.1'); } catch { /* sem log anterior */ }
function log(...a) {
  const line = `${new Date().toISOString()} ${a.join(' ')}`;
  if (process.stdout.isTTY) console.log(line);
  fs.appendFile(logFile, line + '\n', () => {});
}

const noOpen = flag('--no-open');
const ports = opt('--port') ? [Number(opt('--port'))] : DEFAULT_PORTS;

function hello(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/hello', timeout: 1500 }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b).name === 'EasyPrint'); } catch { resolve(false); } });
    });
    req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function main() {
  if (system.installSelfIfNeeded(log)) return;

  // Já está rodando? Então só abre o painel da instância existente.
  for (const p of ports) {
    if (await hello(p)) {
      log(`EasyPrint já está rodando na porta ${p}.`);
      if (!flag('--background') && !noOpen) system.openApp(`http://127.0.0.1:${p}/`);
      return;
    }
  }

  const driver = process.platform === 'win32'
    ? new (require('./printing/win').WindowsDriver)(config, log)
    : new (require('./printing/unix').UnixDriver)(config, log);
  const security = new Security(config);
  const printing = new PrintService(config, driver, log, { findBrowser: system.findAppBrowser });
  const cloud = new (require('./cloud').CloudRelay)({ config, printing, driver, log });

  let tray = null;
  const shutdown = () => {
    log('Encerrando EasyPrint.');
    try { app.close(); } catch { /* já fechado */ }
    cloud.stopAll();
    driver.stop();
    if (tray) tray.kill();
    setTimeout(() => process.exit(0), 300);
  };

  const app = createServer({ config, security, printing, cloud, log, onQuit: shutdown });
  if (noOpen) { system.openUrl = () => {}; system.openApp = () => {}; }
  const port = await app.listen(ports);
  log(`EasyPrint ${VERSION} ouvindo em http://127.0.0.1:${port} (config: ${config.dir})`);

  driver.start && driver.start().catch((e) => log('Helper de impressão:', e.message));
  cloud.startAll();
  tray = system.startTray({ port, adminToken: security.adminToken, runtimeDir: config.path('runtime'), log });

  if (!config.get('setupDone') && !flag('--background')) system.openApp(`http://127.0.0.1:${port}/#/assistente`);
  else if (!flag('--background')) system.openApp(`http://127.0.0.1:${port}/`);

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => { log('Falha fatal:', e.stack || e.message); process.exit(1); });
