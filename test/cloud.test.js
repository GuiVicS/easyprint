'use strict';
// Impressão pela nuvem (protocolo v2): relay de referência + SDK de servidor + agente real,
// incluindo ataques simulados contra autenticidade, sigilo e reutilização.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const { createRelay } = require('../cloud/relay-server');
const { EasyPrintCloud, generateKeys, signJob } = require('../cloud/easyprint-cloud');
const { parseConnectionCode, verifyJob } = require('../agent/src/cloud');
const { startAgent, waitFor } = require('./helpers');

const API_KEY = crypto.randomBytes(24).toString('hex');
let relay, relayServer, relayUrl, agent, cloud, keys, device, connId, code;

const relayPost = (path, body) => fetch(relayUrl + path, { method: 'POST', headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

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

test('código de conexão: exige HTTPS fora de localhost, Ed25519 e recusa versão antiga', () => {
  const mk = (o) => 'EPC2.' + Buffer.from(JSON.stringify({ v: 2, pairToken: 't', pairSecret: crypto.randomBytes(32).toString('base64url'), deviceId: 'd', publicKey: keys.publicKey, ...o })).toString('base64url');
  assert.throws(() => parseConnectionCode(mk({ url: 'http://erp.exemplo.com' })), (e) => e.code === 'INSECURE_URL');
  assert.ok(parseConnectionCode(mk({ url: 'https://erp.exemplo.com/print' })).url.endsWith('/print'));
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  assert.throws(() => parseConnectionCode(mk({ url: 'https://a.com', publicKey: rsa })), /Ed25519/);
  assert.throws(() => parseConnectionCode(mk({ url: 'https://a.com', pairSecret: 'curto' })), /fraco/);
  assert.throws(() => parseConnectionCode('EPC1.abc'), /versão antiga/);
  assert.throws(() => parseConnectionCode('qualquer coisa'), (e) => e.code === 'INVALID_CODE');
});

test('antes do pareamento o ERP não consegue enviar (não há chave da loja)', async () => {
  const d = await cloud.createDevice('Loja Pendente');
  await assert.rejects(cloud.print({ deviceId: d.deviceId, deviceSecret: d.deviceSecret }, { text: 'x' }), (e) => e.code === 'NOT_PAIRED');
});

test('pareia com chave gerada na loja e imprime um pedido cifrado enviado pelo servidor', async () => {
  const d = await cloud.createDevice('Loja Centro');
  device = { deviceId: d.deviceId, deviceSecret: d.deviceSecret };
  code = d.connectionCode;
  const added = await agent.api('cloud/add', { code });
  assert.ok(added.ok, JSON.stringify(added));
  connId = added.result.id;
  assert.strictEqual(added.result.allowDrawer, false, 'gaveta bloqueada por padrão');

  const info = await cloud.device(device.deviceId);
  assert.strictEqual(info.paired, true);
  assert.strictEqual(info.encryptionFingerprint, added.result.encryptionFingerprint, 'mesma impressão digital nos dois lados');

  await waitFor(async () => (await agent.api('cloud')).result[0].state === 'online');
  const { jobId } = await cloud.print(device, { printer: 'Simulador', jobName: 'Pedido 77', document: { blocks: [{ type: 'title', value: 'PEDIDO #77 João Araújo' }, { type: 'cut' }] } });
  const j = await cloud.waitJob(jobId, { timeoutMs: 20000, intervalMs: 300 });
  assert.strictEqual(j.status, 'done', JSON.stringify(j));
  assert.strictEqual(j.result.printer, 'EasyPrint Simulador');
});

test('sigilo: o relay só guarda bytes cifrados (nada do pedido em claro)', async () => {
  const { jobId } = await cloud.print(device, { printer: 'Simulador', text: 'Cliente Maria Secreta, Rua Sigilosa 42' });
  const stored = JSON.stringify(relay.db.jobs[jobId]);
  assert.ok(!stored.includes('Maria Secreta') && !stored.includes('Sigilosa'), 'conteúdo não pode aparecer no relay');
  assert.strictEqual((await cloud.waitJob(jobId, { timeoutMs: 20000, intervalMs: 300 })).status, 'done');
});

test('ataque: código de conexão copiado não serve depois do pareamento', async () => {
  const again = await agent.api('cloud/add', { code });
  assert.strictEqual(again.ok, false);
  assert.ok(['ALREADY_CONNECTED', 'CODE_USED'].includes(again.error.code));
  // atacante tentando parear direto no relay com o mesmo código
  const info = parseConnectionCode(code);
  const r = await fetch(relayUrl + '/v1/agent/pair', { method: 'POST', headers: { Authorization: `Bearer ${info.pairToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ encryptionKey: 'x', keyMac: '0'.repeat(64) }) });
  assert.strictEqual(r.status, 401);
});

test('ataque: relay troca a chave da loja para ler os pedidos → ERP recusa enviar', async () => {
  const d = await cloud.createDevice('Loja Vitima');
  const added = await agent.api('cloud/add', { code: d.connectionCode });
  assert.ok(added.ok);
  const evil = crypto.generateKeyPairSync('x25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  relay.db.devices[d.deviceId].encryptionKey = evil; // relay malicioso
  const fresh = new EasyPrintCloud({ relayUrl, apiKey: API_KEY, ...keys });
  await assert.rejects(fresh.print({ deviceId: d.deviceId, deviceSecret: d.deviceSecret }, { text: 'x' }), (e) => e.code === 'KEY_MISMATCH');
  await agent.api('cloud/remove', { id: added.result.id });
});

test('ataque: relay injeta trabalho assinado por outra chave → recusado', async () => {
  const attacker = generateKeys();
  const encKey = relay.db.devices[device.deviceId].encryptionKey;
  const forged = signJob({ deviceId: device.deviceId, encryptionKey: encKey, privateKey: attacker.privateKey, job: { text: 'golpe', printer: 'Simulador' } });
  const r = await relayPost(`/v1/devices/${device.deviceId}/jobs`, forged);
  assert.strictEqual(r.status, 202);
  const j = await cloud.waitJob(forged.id, { timeoutMs: 20000, intervalMs: 300 });
  assert.strictEqual(j.status, 'rejected');
  assert.strictEqual(j.result.error.code, 'BAD_SIGNATURE');
});

test('ataque: replay do mesmo trabalho não imprime de novo', async () => {
  const { jobId } = await cloud.print(device, { printer: 'Simulador', jobName: 'Replay', text: 'uma vez só' });
  assert.strictEqual((await cloud.waitJob(jobId, { timeoutMs: 20000, intervalMs: 300 })).status, 'done');
  relay.db.jobs[jobId].status = 'queued';                                  // relay malicioso reenvia
  await cloud.print(device, { printer: 'Simulador', jobName: 'Acorda', text: 'acorda a fila' });
  await waitFor(() => relay.db.jobs[jobId].result && relay.db.jobs[jobId].result.status === 'duplicate');
  const jobs = (await agent.api('jobs')).result.filter((x) => x.jobName === 'Replay');
  assert.strictEqual(jobs.length, 1, 'impresso só uma vez');
});

test('política: gaveta bloqueada por padrão, liberada pelo lojista', async () => {
  const doc = { blocks: ['Sangria', { type: 'drawer' }] };
  const a = await cloud.print(device, { printer: 'Simulador', document: doc });
  const ja = await cloud.waitJob(a.jobId, { timeoutMs: 20000, intervalMs: 300 });
  assert.strictEqual(ja.status, 'rejected');
  assert.strictEqual(ja.result.error.code, 'POLICY_BLOCKED');

  const raw = await cloud.print(device, { printer: 'Simulador', raw: Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]) });
  assert.strictEqual((await cloud.waitJob(raw.jobId, { timeoutMs: 20000, intervalMs: 300 })).result.error.code, 'POLICY_BLOCKED');

  await agent.api('cloud/update', { id: connId, allowDrawer: true });
  await waitFor(async () => (await agent.api('cloud')).result.find((c) => c.id === connId).state === 'online');
  const b = await cloud.print(device, { printer: 'Simulador', document: doc });
  assert.strictEqual((await cloud.waitJob(b.jobId, { timeoutMs: 20000, intervalMs: 300 })).status, 'done');
});

test('verificação: dispositivo errado, expirado, data no futuro, adulteração e falta de cifra', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const encKey = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const conn = { deviceId: 'dev_A', publicKey: keys.publicKey };
  const seen = new Set();
  const wrong = signJob({ deviceId: 'dev_B', encryptionKey: encKey, privateKey: keys.privateKey, job: { text: 'x' } });
  assert.throws(() => verifyJob(wrong, conn, seen, Date.now(), privateKey), (e) => e.code === 'WRONG_DEVICE');
  const old = signJob({ deviceId: 'dev_A', encryptionKey: encKey, privateKey: keys.privateKey, job: { text: 'x' }, ttlMs: 1000 });
  assert.throws(() => verifyJob(old, conn, seen, Date.now() + 5000, privateKey), (e) => e.code === 'EXPIRED');
  const ok = signJob({ deviceId: 'dev_A', encryptionKey: encKey, privateKey: keys.privateKey, job: { text: 'olá' } });
  assert.throws(() => verifyJob(ok, conn, seen, Date.now() - 10 * 60 * 1000, privateKey), /adiantado/);
  assert.strictEqual(verifyJob(ok, conn, seen, Date.now(), privateKey).payload.text, 'olá');
  // adulterar o texto cifrado quebra a assinatura
  const p = JSON.parse(ok.payload); p.enc.ct = Buffer.from('lixo').toString('base64');
  assert.throws(() => verifyJob({ ...ok, payload: JSON.stringify(p) }, conn, seen, Date.now(), privateKey), (e) => e.code === 'BAD_SIGNATURE');
  // chave errada da loja não decifra
  const other = crypto.generateKeyPairSync('x25519').privateKey;
  assert.throws(() => verifyJob(ok, conn, seen, Date.now(), other), /decifrar/);
  // trabalho sem cifra (mesmo assinado) é recusado
  const plain = JSON.stringify({ v: 2, id: 'j1', deviceId: 'dev_A', ts: Date.now(), expiresAt: Date.now() + 1000, text: 'x' });
  const sig = crypto.sign(null, Buffer.from(plain), crypto.createPrivateKey({ key: Buffer.from(keys.privateKey, 'base64'), format: 'der', type: 'pkcs8' })).toString('base64');
  assert.throws(() => verifyJob({ id: 'j1', payload: plain, signature: sig }, conn, seen, Date.now(), privateKey), /sem criptografia/);
});

test('revogar o dispositivo desconecta o EasyPrint', async () => {
  await cloud.revokeDevice(device.deviceId);
  await waitFor(async () => (await agent.api('cloud')).result.find((c) => c.id === connId).state === 'unauthorized', 20000);
});

test('segredos da nuvem não ficam em texto puro no disco (DPAPI no Windows)', { skip: process.platform !== 'win32' }, () => {
  const cfg = require('fs').readFileSync(require('path').join(agent.home, 'config.json'), 'utf8');
  assert.ok(!/epd_[A-Za-z0-9_-]{20,}/.test(cfg), 'token do dispositivo não pode aparecer em claro');
  assert.ok(!/MC4CAQAwBQYDK2Vu/.test(cfg), 'chave privada X25519 não pode aparecer em claro');
  assert.ok(/tokenProtected/.test(cfg) && /encPrivateProtected/.test(cfg));
});
