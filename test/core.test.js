'use strict';
// Núcleo embutido (easyprint/core): impressão e fila da nuvem dentro do processo de outro aplicativo,
// com conexão gerenciada (sem código de conexão) e token que muda com o tempo.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRelay } = require('../cloud/relay-server');
const { EasyPrintCloud, generateKeys, keyMac } = require('../cloud/easyprint-cloud');
const { createCore, generateEncryptionKeys } = require('../agent/src/core');
const { waitFor } = require('./helpers');

const API_KEY = crypto.randomBytes(24).toString('hex');
let relay, server, relayUrl, cloud, keys, core, home, connected;

test.before(async () => {
  relay = createRelay({ apiKey: API_KEY });
  server = http.createServer(relay.listener);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  relayUrl = `http://127.0.0.1:${server.address().port}`;
  keys = generateKeys();
  cloud = new EasyPrintCloud({ relayUrl, apiKey: API_KEY, ...keys });
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'easyprint-core-'));
  core = createCore({ home });
  await core.start();
  core.setDefaultPrinter('EasyPrint Simulador');
});
test.after(() => { core.stop(); server.closeAllConnections(); server.close(); });

/** O que o aplicativo hospedeiro faz: gera a chave e a registra no servidor pelo próprio canal (aqui, o pareamento do relay). */
async function register(name) {
  const d = await cloud.createDevice(name);
  const info = JSON.parse(Buffer.from(d.connectionCode.slice(5), 'base64url').toString('utf8'));
  const k = generateEncryptionKeys();
  const r = await fetch(relayUrl + '/v1/agent/pair', { method: 'POST', headers: { Authorization: `Bearer ${info.pairToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ encryptionKey: k.encryptionKey, keyMac: keyMac(d.deviceSecret, d.deviceId, k.encryptionKey) }) });
  assert.strictEqual(r.status, 200);
  return { device: { deviceId: d.deviceId, deviceSecret: d.deviceSecret }, token: (await r.json()).token, keys: k };
}

test('o núcleo sobe sem servidor local e lista as impressoras do computador', async () => {
  const list = await core.printers();
  assert.ok(list.some((p) => p.name === 'EasyPrint Simulador'));
  assert.ok(!fs.existsSync(path.join(home, 'runtime', 'tray')), 'sem bandeja');
  assert.throws(() => createCore({}), (e) => e.code === 'INVALID_CONFIG');
});

test('conexão gerenciada: imprime trabalho cifrado, usa o token atual a cada chamada e não grava segredo no config', async () => {
  const { device, token, keys: k } = await register('PC do app'); connected = device;
  let current = 'token-vencido'; let asked = 0;
  const state = core.cloud.attach({ id: 'loja', name: 'Loja', url: relayUrl, deviceId: device.deviceId, publicKey: keys.publicKey, privateKey: k.privateKey, getToken: () => { asked++; return current; }, agent: { name: 'Meu App', version: '9.9.9' } });
  assert.strictEqual(state.managed, true); assert.strictEqual(state.allowDrawer, false);
  await waitFor(() => core.cloud.publicState()[0].state === 'unauthorized');   // token ruim: recusado, sem derrubar o laço
  current = token;                                                             // o aplicativo renovou o token
  await waitFor(() => core.cloud.publicState()[0].state === 'online', 20000);
  assert.ok(asked >= 2, 'pede o token de novo a cada chamada');

  const { jobId } = await cloud.print(device, { printer: 'Simulador', jobName: 'Pedido 12', document: { blocks: [{ type: 'title', value: 'PEDIDO #12' }, { type: 'cut' }] } });
  const j = await cloud.waitJob(jobId, { timeoutMs: 20000, intervalMs: 300 });
  assert.strictEqual(j.status, 'done', JSON.stringify(j));
  assert.strictEqual(j.result.printer, 'EasyPrint Simulador');
  assert.strictEqual(core.cloud.publicState()[0].printed, 1);

  const info = await cloud.device(device.deviceId);
  assert.strictEqual(info.agent.name, 'Meu App'); assert.strictEqual(info.agent.version, '9.9.9');
  assert.ok(info.printers.some((p) => p.name === 'EasyPrint Simulador'));
  assert.strictEqual(await core.cloud.reportStatus('loja'), 200);

  const saved = fs.readFileSync(path.join(home, 'config.json'), 'utf8');
  assert.ok(!saved.includes(token) && !saved.includes(k.privateKey), 'token e chave ficam com o aplicativo');
  assert.deepStrictEqual(JSON.parse(saved).cloud, []);
});

test('a rota definida pelo aplicativo decide a impressora', async () => {
  core.setRoutes({ cozinha: 'EasyPrint Simulador' });
  const { jobId } = await cloud.print(connected, { route: 'cozinha', text: 'pela rota' });
  const j = await cloud.waitJob(jobId, { timeoutMs: 20000, intervalMs: 300 });
  assert.strictEqual(j.status, 'done', JSON.stringify(j)); assert.strictEqual(j.result.printer, 'EasyPrint Simulador');
  core.setRoutes({ cozinha: 'Impressora Que Não Existe' });
  const lost = await cloud.waitJob((await cloud.print(connected, { route: 'cozinha', text: 'sem impressora' })).jobId, { timeoutMs: 20000, intervalMs: 300 });
  assert.strictEqual(lost.status, 'failed', 'impressora mapeada sumiu: falha, sem imprimir em outra por conta própria');
});

test('detach encerra a conexão; chaves erradas não entram', async () => {
  assert.strictEqual(core.cloud.detach('loja'), true);
  assert.deepStrictEqual(core.cloud.publicState(), []);
  assert.strictEqual(core.cloud.detach('loja'), false);
  const k = generateEncryptionKeys();
  assert.throws(() => core.cloud.attach({ id: 'x', url: 'http://exemplo.com', deviceId: 'd', publicKey: keys.publicKey, privateKey: k.privateKey, getToken: () => 't' }), (e) => e.code === 'INSECURE_URL');
  assert.throws(() => core.cloud.attach({ id: 'x', url: relayUrl, deviceId: 'd', publicKey: k.encryptionKey, privateKey: k.privateKey, getToken: () => 't' }), (e) => e.code === 'INVALID_CONNECTION');
  assert.throws(() => core.cloud.attach({ id: 'x', url: relayUrl, deviceId: 'd', publicKey: keys.publicKey, privateKey: k.privateKey }), (e) => e.code === 'INVALID_CONNECTION');
});

test('perfil da impressora (tamanho do papel) e página de teste pelo núcleo', async () => {
  const before = (await core.printerProfiles()).find((p) => p.name === 'EasyPrint Simulador');
  assert.ok(before && before.profile && before.profile.mode);
  core.setProfile('EasyPrint Simulador', { paperWidth: 58 });
  const after = (await core.printerProfiles()).find((p) => p.name === 'EasyPrint Simulador');
  assert.strictEqual(after.profile.paperWidth, 58); assert.strictEqual(after.profile.columns, 32); assert.strictEqual(after.profile.configured, true);
  const r = await core.testPrint('EasyPrint Simulador', { blocks: [{ type: 'title', value: 'Teste Pediu' }] });
  assert.strictEqual(r.printer, 'EasyPrint Simulador', JSON.stringify(r));
  core.setProfile('EasyPrint Simulador', {});                                                             // volta para a detecção automática
  assert.strictEqual((await core.printerProfiles()).find((p) => p.name === 'EasyPrint Simulador').profile.configured, false);
});
