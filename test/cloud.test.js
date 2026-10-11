'use strict';
// Impressão pela nuvem: relay de referência + SDK de servidor + agente real, incluindo ataques simulados.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const { createRelay } = require('../cloud/relay-server');
const { EasyPrintCloud, generateKeys, signJob } = require('../cloud/easyprint-cloud');
const { parseConnectionCode, verifyJob } = require('../agent/src/cloud');
const { startAgent, waitFor } = require('./helpers');

const API_KEY = crypto.randomBytes(24).toString('hex');
let relay, relayServer, relayUrl, agent, cloud, keys, deviceId, connId;

test.before(async () => {
  relay = createRelay({ apiKey: API_KEY });
  relayServer = http.createServer(relay.listener);
  await new Promise((r) => relayServer.listen(0, '127.0.0.1', r));
  relayUrl = `http://127.0.0.1:${relayServer.address().port}`;
  keys = generateKeys();
  cloud = new EasyPrintCloud({ relayUrl, apiKey: API_KEY, ...keys });
  agent = await startAgent();
  await agent.api('default', { printer: 'EasyPrint Simulador' });
});

test.after(() => { agent.stop(); relayServer.closeAllConnections(); relayServer.close(); });

test('relay recusa chave de API errada', async () => {
  const bad = new EasyPrintCloud({ relayUrl, apiKey: 'x'.repeat(48), ...keys });
  await assert.rejects(bad.createDevice('X'), (e) => e.status === 401);
});

test('código de conexão: exige HTTPS fora de localhost e chave Ed25519', () => {
  const mk = (o) => 'EPC1.' + Buffer.from(JSON.stringify({ v: 1, token: 't', deviceId: 'd', publicKey: keys.publicKey, ...o })).toString('base64url');
  assert.throws(() => parseConnectionCode(mk({ url: 'http://erp.exemplo.com' })), (e) => e.code === 'INSECURE_URL');
  assert.ok(parseConnectionCode(mk({ url: 'https://erp.exemplo.com/print' })).url.endsWith('/print'));
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  assert.throws(() => parseConnectionCode(mk({ url: 'https://a.com', publicKey: rsa })), /Ed25519/);
  assert.throws(() => parseConnectionCode('qualquer coisa'), (e) => e.code === 'INVALID_CODE');
});

test('conecta o computador e imprime um pedido enviado pelo servidor', async () => {
  const dev = await cloud.createDevice('Loja Centro');
  deviceId = dev.deviceId;
  const added = await agent.api('cloud/add', { code: dev.connectionCode });
  assert.ok(added.ok, JSON.stringify(added));
  connId = added.result.id;
  assert.strictEqual(added.result.allowDrawer, false, 'gaveta bloqueada por padrão');

  await waitFor(async () => (await agent.api('cloud')).result[0].state === 'online');
  const { jobId } = await cloud.print(deviceId, { printer: 'Simulador', jobName: 'Pedido 77', document: { blocks: [{ type: 'title', value: 'PEDIDO #77' }, { type: 'cut' }] } });
  const j = await cloud.waitJob(jobId, { timeoutMs: 20000, intervalMs: 300 });
  assert.strictEqual(j.status, 'done', JSON.stringify(j));
  assert.strictEqual(j.result.printer, 'EasyPrint Simulador');

  const st = await waitFor(async () => { const d = await cloud.device(deviceId); return d.printers && d.printers.length ? d : null; });
  assert.strictEqual(st.online, true);
  assert.ok(st.printers.some((p) => p.name === 'EasyPrint Simulador'));
});

test('ataque: relay injeta trabalho assinado por outra chave → recusado', async () => {
  const attacker = generateKeys();
  const forged = signJob({ deviceId, privateKey: attacker.privateKey, job: { text: 'golpe', printer: 'Simulador' } });
  const r = await fetch(`${relayUrl}/v1/devices/${deviceId}/jobs`, { method: 'POST', headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(forged) });
  assert.strictEqual(r.status, 202);
  const j = await cloud.waitJob(forged.id, { timeoutMs: 20000, intervalMs: 300 });
  assert.strictEqual(j.status, 'rejected');
  assert.strictEqual(j.result.error.code, 'BAD_SIGNATURE');
});

test('ataque: replay do mesmo trabalho não imprime de novo', async () => {
  const { jobId } = await cloud.print(deviceId, { printer: 'Simulador', jobName: 'Replay', text: 'uma vez só' });
  assert.strictEqual((await cloud.waitJob(jobId, { timeoutMs: 20000, intervalMs: 300 })).status, 'done');
  // relay malicioso reenvia o mesmo trabalho
  relay.db.jobs[jobId].status = 'queued';
  await cloud.print(deviceId, { printer: 'Simulador', jobName: 'Acorda', text: 'acorda a fila' }); // força nova entrega
  await waitFor(() => relay.db.jobs[jobId].result && relay.db.jobs[jobId].result.status === 'duplicate');
  const jobs = (await agent.api('jobs')).result.filter((x) => x.jobName === 'Replay');
  assert.strictEqual(jobs.length, 1, 'impresso só uma vez');
});

test('política: gaveta bloqueada por padrão, liberada pelo lojista', async () => {
  const doc = { blocks: ['Sangria', { type: 'drawer' }] };
  const a = await cloud.print(deviceId, { printer: 'Simulador', document: doc });
  const ja = await cloud.waitJob(a.jobId, { timeoutMs: 20000, intervalMs: 300 });
  assert.strictEqual(ja.status, 'rejected');
  assert.strictEqual(ja.result.error.code, 'POLICY_BLOCKED');

  const raw = await cloud.print(deviceId, { printer: 'Simulador', raw: Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]) });
  assert.strictEqual((await cloud.waitJob(raw.jobId, { timeoutMs: 20000, intervalMs: 300 })).result.error.code, 'POLICY_BLOCKED');

  await agent.api('cloud/update', { id: connId, allowDrawer: true });
  await waitFor(async () => (await agent.api('cloud')).result[0].state === 'online');
  const b = await cloud.print(deviceId, { printer: 'Simulador', document: doc });
  assert.strictEqual((await cloud.waitJob(b.jobId, { timeoutMs: 20000, intervalMs: 300 })).status, 'done');
});

test('verificação: dispositivo errado, expirado e data no futuro', () => {
  const conn = { deviceId: 'dev_A', publicKey: keys.publicKey };
  const seen = new Set();
  const wrong = signJob({ deviceId: 'dev_B', privateKey: keys.privateKey, job: { text: 'x' } });
  assert.throws(() => verifyJob(wrong, conn, seen), (e) => e.code === 'WRONG_DEVICE');
  const old = signJob({ deviceId: 'dev_A', privateKey: keys.privateKey, job: { text: 'x' }, ttlMs: 1000 });
  assert.throws(() => verifyJob(old, conn, seen, Date.now() + 5000), (e) => e.code === 'EXPIRED');
  const ok = signJob({ deviceId: 'dev_A', privateKey: keys.privateKey, job: { text: 'x' } });
  assert.throws(() => verifyJob(ok, conn, seen, Date.now() - 10 * 60 * 1000), /futuro|adiantado/);
  assert.strictEqual(verifyJob(ok, conn, seen).payload.text, 'x');
  const tampered = { ...ok, payload: ok.payload.replace('"x"', '"y"') };
  assert.throws(() => verifyJob(tampered, conn, seen), (e) => e.code === 'BAD_SIGNATURE');
});

test('revogar o dispositivo desconecta o EasyPrint', async () => {
  await cloud.revokeDevice(deviceId);
  await waitFor(async () => (await agent.api('cloud')).result[0].state === 'unauthorized', 20000);
});

test('token da nuvem não fica em texto puro no disco (DPAPI no Windows)', { skip: process.platform !== 'win32' }, () => {
  const cfg = require('fs').readFileSync(require('path').join(agent.home, 'config.json'), 'utf8');
  assert.ok(!/epd_[A-Za-z0-9_-]{20,}/.test(cfg), 'token do dispositivo não pode aparecer em claro');
  assert.ok(/tokenProtected/.test(cfg));
});
