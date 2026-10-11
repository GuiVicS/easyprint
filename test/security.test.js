'use strict';
// Ataques locais: site comprometido, abuso antes da aprovação, arquivos maliciosos, HTML.
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { startAgent, wsClient, waitFor } = require('./helpers');
const { RateLimiter } = require('../agent/src/printing');
const { decodePng } = require('../agent/src/render/png');
const { prepareHtml } = require('../agent/src/render/html');
const { newer } = require('../agent/src/updates');

let agent;
test.before(async () => {
  agent = await startAgent();
  await agent.api('default', { printer: 'EasyPrint Simulador' });
  await agent.api('sites/add', { origin: 'https://loja.exemplo.com' });
});
test.after(() => agent.stop());

test('site aprovado NÃO abre a gaveta por padrão; o lojista libera por site', async () => {
  const c = wsClient(agent.port, 'https://loja.exemplo.com');
  assert.strictEqual((await c.call('hello', {})).result.state, 'ready');
  let r = await c.call('print', { printer: 'Simulador', document: [{ type: 'drawer' }] });
  assert.strictEqual(r.error.code, 'POLICY_BLOCKED');
  r = await c.call('print', { printer: 'Simulador', raw: Buffer.from([0x1b, 0x70, 0, 25, 250]).toString('base64') });
  assert.strictEqual(r.error.code, 'POLICY_BLOCKED', 'também via RAW');
  await agent.api('sites/update', { origin: 'https://loja.exemplo.com', allowDrawer: true });
  r = await c.call('print', { printer: 'Simulador', document: [{ type: 'drawer' }] });
  assert.ok(r.ok, JSON.stringify(r.error));
  c.close();
});

test('token de app local também começa sem gaveta', async () => {
  const t = (await agent.api('tokens', { name: 'PDV' })).result;
  const c = wsClient(agent.port, null);
  await c.call('hello', { token: t.token });
  assert.strictEqual((await c.call('print', { printer: 'Simulador', document: [{ type: 'drawer' }] })).error.code, 'POLICY_BLOCKED');
  await agent.api('tokens/update', { id: t.id, allowDrawer: true });
  assert.ok((await c.call('print', { printer: 'Simulador', document: [{ type: 'drawer' }] })).ok);
  c.close();
});

test('limite de impressões por origem (site invadido imprimindo em loop)', () => {
  const rl = new RateLimiter({ perMinute: 3, perHour: 100 });
  rl.hit('site:a'); rl.hit('site:a'); rl.hit('site:a');
  assert.throws(() => rl.hit('site:a'), (e) => e.code === 'RATE_LIMITED' && !!e.hint);
  assert.doesNotThrow(() => rl.hit('site:b'), 'outras origens não são afetadas');
});

test('antes da aprovação: mensagem grande derruba só a conexão', async () => {
  const c = wsClient(agent.port, 'https://desconhecido.example');
  const closed = new Promise((r) => (c.ws.onclose = (e) => r(e.code)));
  await c.call('hello', {}).catch(() => {});
  c.ws.send(JSON.stringify({ id: 9, method: 'print', params: { text: 'x'.repeat(200 * 1024) } }));
  assert.strictEqual(await closed, 1009);
  // o agente continua de pé
  assert.strictEqual((await (await fetch(`http://127.0.0.1:${agent.port}/api/hello`)).json()).name, 'EasyPrint');
});

test('antes da aprovação: excesso de mensagens fecha a conexão', async () => {
  const c = wsClient(agent.port, 'https://spam.example');
  const closed = new Promise((r) => (c.ws.onclose = (e) => r(e.code)));
  await c.call('ping');
  for (let i = 0; i < 40; i++) c.ws.send(JSON.stringify({ id: 100 + i, method: 'ping' }));
  assert.strictEqual(await closed, 1008);
});

test('limite de conexões por origem', async () => {
  const conns = [];
  let refused = 0;
  for (let i = 0; i < 14; i++) {
    const ws = new WebSocket(`ws://127.0.0.1:${agent.port}/ws`, { headers: { Origin: 'https://flood.example' } });
    conns.push(ws);
    await new Promise((r) => { ws.onopen = r; ws.onerror = () => { refused++; r(); }; });
  }
  assert.ok(refused >= 4, `esperava recusar as excedentes (recusadas: ${refused})`);
  conns.forEach((w) => { try { w.close(); } catch { /* ignora */ } });
});

test('spam de pedidos de permissão: no máximo 5 pendentes', async () => {
  const cs = [];
  for (let i = 0; i < 8; i++) { const c = wsClient(agent.port, `https://spam${i}.example`); await c.call('hello', {}); cs.push(c); }
  const pending = (await agent.api('state')).result.pending;
  assert.ok(pending.length <= 5, `pendentes: ${pending.length}`);
  cs.forEach((c) => c.close());
});

test('PNG bomba de descompressão é recusado sem estourar memória', () => {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data])) >>> 0);
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(10, 0); ihdr.writeUInt32BE(10, 4); ihdr[8] = 8; ihdr[9] = 0;
  const bomb = zlib.deflateSync(Buffer.alloc(200 * 1024 * 1024)); // 200 MB de zeros → ~200 KB
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', bomb), chunk('IEND', Buffer.alloc(0))]);
  assert.throws(() => decodePng(png), /maliciosa|corrompida/);
  const huge = Buffer.from(png); huge.writeUInt32BE(100000, 16);
  assert.throws(() => decodePng(huge), /grande demais/);
});

test('HTML: sem rede local, sem arquivos do computador, sem scripts', () => {
  const out = prepareHtml('<img src="http://192.168.0.1/reboot"><img src="file:///C:/segredo.png"><script>fetch("x")</script><p onclick="x">ok</p>');
  const csp = /content="([^"]+)"/.exec(out.match(/Content-Security-Policy[^>]+/)[0])[1];
  assert.ok(csp.includes("default-src 'none'"));
  assert.ok(csp.includes('img-src https: data:'), 'imagens só por HTTPS ou embutidas (bloqueia http://192.168…, file://)');
  assert.ok(csp.includes("script-src 'none'"));
  assert.ok(!/<script/i.test(out), 'tags script removidas');
});

test('aviso de versão compara números corretamente', () => {
  assert.ok(newer('1.0.10', '1.0.9'));
  assert.ok(newer('v2.0.0', '1.9.9'));
  assert.ok(!newer('1.0.1', '1.0.1'));
  assert.ok(!newer('1.0.0', '1.0.1'));
});
