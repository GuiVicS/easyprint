'use strict';
// Núcleo do EasyPrint para embutir em outro aplicativo (ex.: um app Electron): impressão, renderizadores e a fila da nuvem,
// sem o servidor local, o painel, a bandeja nem o instalador. Roda dentro do processo de quem chama.
//
//   const { createCore, generateEncryptionKeys } = require('easyprint/core');
//   const core = createCore({ home: pastaDeDadosDoApp, log: console.log });
//   await core.start();
//   const impressoras = await core.printers();
//   core.cloud.attach({ id: 'loja', url, deviceId, publicKey, privateKey, getToken: () => tokenAtual });
//   ...
//   core.stop();
const fs = require('fs');
const { Config, VERSION } = require('./config');
const { PrintService } = require('./printing');
const { CloudRelay, generateEncryptionKeys, verifyJob, fingerprint } = require('./cloud');
const { EPError, toErrorPayload } = require('./errors');
const { testDocument } = require('./test-document');

/**
 * @param {object} o
 * @param {string} o.home  pasta de dados exclusiva do núcleo (config, perfis das impressoras, trabalhos já impressos)
 * @param {(...a: unknown[]) => void} [o.log]
 */
function createCore({ home, log = () => {} } = {}) {
  if (!home) throw new EPError('INVALID_CONFIG', 'Informe a pasta de dados (home) do núcleo de impressão.');
  fs.mkdirSync(home, { recursive: true });
  const config = new Config(home);
  const driver = process.platform === 'win32'
    ? new (require('./printing/win').WindowsDriver)(config, log)
    : new (require('./printing/unix').UnixDriver)(config, log);
  // o HTML → PDF usa um navegador já instalado no computador (Edge/Chrome); sem ele, só esse tipo de trabalho falha
  let findBrowser = () => null;
  try { findBrowser = require('./system').findAppBrowser; } catch { /* sem navegador do sistema */ }
  const printing = new PrintService(config, driver, log, { findBrowser });
  const cloud = new CloudRelay({ config, printing, driver, log });
  let started = false;
  return {
    version: VERSION, config, driver, printing, cloud,
    /** Sobe o auxiliar de impressão do sistema e as conexões salvas. */
    async start() {
      if (started) return;
      started = true;
      if (driver.start) await driver.start().catch((e) => log('Helper de impressão:', e.message));
      cloud.startAll();
    },
    stop() {
      if (!started) return;
      started = false;
      cloud.stopAll();
      try { driver.stop && driver.stop(); } catch { /* já parado */ }
    },
    /** Impressoras que este computador enxerga: [{ name, kind, online, isDefault }] */
    async printers() { return (await printing.list()).map((p) => ({ name: p.name, kind: p.kind, online: p.online, isDefault: p.isDefault })); },
    /** Finalidade → impressora (ex.: { cozinha: 'EPSON TM-T20' }). Quem embute decide de onde isso vem (ex.: do servidor). */
    setRoutes(routes) { config.set('routes', { ...(routes || {}) }); },
    setDefaultPrinter(name) { config.set('defaultPrinter', name || null); },
    /** Impressoras com o perfil de cada uma: { name, kind, online, isDefault, profile: { mode, paperWidth, columns, paperSize, … } } */
    async printerProfiles() { return (await printing.list({ fresh: true })).map((p) => ({ name: p.name, kind: p.kind, online: p.online, isDefault: p.isDefault, profile: p.profile })); },
    /** Muda o perfil de uma impressora (ex.: { mode: 'escpos', paperWidth: 58 }); {} volta para a detecção automática. */
    setProfile(name, profile) { printing.setProfile(name, profile); },
    /** Imprime uma página de teste (a do EasyPrint ou o documento informado) na impressora indicada ou na padrão. */
    testPrint(name, document) { return printing.print({ printer: name || undefined, document: document || testDocument(), jobName: 'Teste de impressão' }, { appName: 'Teste de impressão' }); },
  };
}

module.exports = { createCore, generateEncryptionKeys, verifyJob, fingerprint, EPError, toErrorPayload, VERSION };
