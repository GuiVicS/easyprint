'use strict';
// Recursos para ERP/e-commerce: PDF, finalidades (rotas), tamanhos de etiqueta e políticas.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makePdf } = require('./fixtures');
const { startAgent, wsClient } = require('./helpers');
const { parsePages, hasDrawerPulse } = require('../agent/src/printing');
const { renderZpl, renderZplBitmaps, labelDots } = require('../agent/src/render/zpl');
const { renderEscPosBitmaps } = require('../agent/src/render/escpos');
const { monoFromPng } = require('../agent/src/render/png');
const { layout } = require('../agent/src/render/layout');

const isWin = process.platform === 'win32';
const { which, findAppBrowser } = require('../agent/src/system');
const canPdf = isWin || !!which('pdftoppm');
const canHtml = canPdf && !!findAppBrowser();
let agent, token;

test.before(async () => {
  agent = await startAgent();
  await agent.api('default', { printer: 'EasyPrint Simulador' });
  token = (await agent.api('tokens', { name: 'erp' })).result.token;
});
test.after(() => agent.stop());

test('intervalo de páginas', () => {
  assert.deepStrictEqual(parsePages('1-3,5'), [0, 1, 2, 4]);
  assert.strictEqual(parsePages(''), undefined);
  assert.throws(() => parsePages('3-1'), /inválido/);
  assert.throws(() => parsePages('abc'), /inválido/);
});

test('detecção de pulso de gaveta em RAW', () => {
  assert.ok(hasDrawerPulse(Buffer.from([0x41, 0x1b, 0x70, 0, 25, 250])));
  assert.ok(!hasDrawerPulse(Buffer.from('^XA^FO10,10^FDteste^FS^XZ')));
});

test('etiqueta ZPL respeita tamanho e DPI', () => {
  assert.deepStrictEqual(labelDots({ labelWidth: 100, labelHeight: 150, dpi: 203 }), { dpmm: 8, width: 800, height: 1200 });
  assert.strictEqual(labelDots({ labelWidth: 50, dpi: 300 }).width, 600);
  const z = renderZpl(layout(['ok'], 40), { labelWidth: 60, labelHeight: 40 }).toString();
  assert.ok(z.includes('^PW480') && z.includes('^LL320'));
});

test('finalidades: o sistema anuncia, o lojista escolhe a impressora, o pedido segue a rota', async () => {
  const c = wsClient(agent.port, null);
  const hello = await c.call('hello', { token, routes: { etiqueta: 'Etiquetas de envio', danfe: 'Notas fiscais (DANFE)', 'inválida!': 'x' } });
  assert.strictEqual(hello.result.state, 'ready');
  const state = (await agent.api('state')).result;
  assert.strictEqual(state.knownRoutes.etiqueta.label, 'Etiquetas de envio');
  assert.ok(!state.knownRoutes['inválida!'], 'nomes inválidos são ignorados');

  // sem configuração: cai na padrão e avisa
  let r = await c.call('print', { route: 'etiqueta', text: 'x' });
  assert.strictEqual(r.result.routedBy, 'default-fallback');

  await agent.api('routes', { route: 'etiqueta', printer: 'EasyPrint Simulador' });
  r = await c.call('print', { route: 'etiqueta', text: 'x' });
  assert.strictEqual(r.result.routedBy, 'route');
  assert.strictEqual(r.result.printer, 'EasyPrint Simulador');

  const routes = (await c.call('routes.list')).result;
  assert.deepStrictEqual(routes.find((x) => x.route === 'etiqueta'), { route: 'etiqueta', label: 'Etiquetas de envio', printer: 'EasyPrint Simulador' });

  // impressora explícita vence a rota
  r = await c.call('print', { route: 'etiqueta', printer: 'Simulador', text: 'x' });
  assert.strictEqual(r.result.routedBy, 'printer');
  c.close();
});

test('PDF inválido e grande demais são recusados com explicação', async () => {
  const c = wsClient(agent.port, null);
  await c.call('hello', { token });
  let r = await c.call('print', { pdf: Buffer.from('não é pdf').toString('base64') });
  assert.strictEqual(r.error.code, 'INVALID_DOCUMENT');
  r = await c.call('print', { pdf: 'A'.repeat(36 * 1024 * 1024) });
  assert.strictEqual(r.error.code, 'TOO_LARGE');
  c.close();
});

test('PDF de 2 páginas no Simulador, imprimindo só a página 2', { skip: !canPdf }, async () => {
  const c = wsClient(agent.port, null);
  await c.call('hello', { token });
  const r = await c.call('print', { printer: 'Simulador', jobName: 'DANFE', pdf: makePdf(2).toString('base64'), pdfOptions: { pages: '2' } });
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.strictEqual(r.result.pages, 1);
  const job = (await agent.api('jobs')).result.find((j) => j.jobName === 'DANFE');
  assert.strictEqual(job.preview[0].kind, 'image');
  assert.ok(job.preview[0].src.startsWith('data:image/png;base64,'));
  c.close();
});

test('PDF → etiqueta ZPL e cupom ESC/POS (renderização nativa do Windows)', { skip: !isWin }, async () => {
  const { Config } = require('../agent/src/config');
  process.env.EASYPRINT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-drv-'));
  const { WindowsDriver } = require('../agent/src/printing/win');
  const drv = new WindowsDriver(new Config(), () => {});
  try {
    const dots = labelDots({ labelWidth: 100, labelHeight: 150 });
    const r = await drv.renderPdf(makePdf(1), { width: dots.width });
    assert.strictEqual(r.pages[0].width, 800);
    const mono = r.pages.map((p) => monoFromPng(p.data, dots.width, { dither: false, threshold: 160 }));
    const zpl = renderZplBitmaps(mono, { labelWidth: 100, labelHeight: 150 }).toString();
    assert.ok(zpl.startsWith('^XA\n^PW800\n^LL1200\n^FO0,0^GFA,'));
    const esc = renderEscPosBitmaps(mono.map((m) => m), { autoCut: true });
    assert.ok(esc.includes(Buffer.from([0x1d, 0x76, 0x30, 0x00])));
    await assert.rejects(drv.renderPdf(Buffer.from('%PDF-1.4 lixo')), (e) => e.code === 'INVALID_DOCUMENT');
  } finally { drv.stop(); }
});

test('HTML: injeta base e tamanho de página sem quebrar o documento', () => {
  const { prepareHtml } = require('../agent/src/render/html');
  const out = prepareHtml('<p>Olá</p>', { baseUrl: 'https://loja.com/pedidos/1', pageSize: { width: 72, height: 1000 } });
  assert.ok(out.includes('<base href="https://loja.com/pedidos/1">'));
  assert.ok(out.includes('@page{size:72mm 1000mm'));
  assert.ok(!prepareHtml('<p>x</p>', { baseUrl: 'javascript:alert(1)' }).includes('<base'), 'base só http(s)');
});

test('HTML vira cupom no Simulador (Edge/Chrome headless, JS desligado)', { skip: !canHtml }, async () => {
  const c = wsClient(agent.port, null);
  await c.call('hello', { token });
  const html = '<html><body style="font-family:Arial"><h1 style="text-align:center">Comanda 12</h1><p>2x Pastel de queijo</p><script>document.body.innerHTML="HACK"</script></body></html>';
  const r = await c.call('print', { printer: 'Simulador', jobName: 'Comanda HTML', html });
  assert.ok(r.ok, JSON.stringify(r.error));
  const job = (await agent.api('jobs')).result.find((j) => j.jobName === 'Comanda HTML');
  assert.strictEqual(job.preview[0].kind, 'image');
  const { decodePng } = require('../agent/src/render/png');
  const img = decodePng(Buffer.from(job.preview[0].src.split(',')[1], 'base64'));
  assert.strictEqual(img.width, 576);
  assert.ok(img.height < 800, `espaço em branco cortado (altura ${img.height})`);
  c.close();
});

test('Linux: PDF → imagem com pdftoppm', { skip: process.platform !== 'linux' || !require('../agent/src/system').which('pdftoppm') }, async () => {
  const { Config } = require('../agent/src/config');
  process.env.EASYPRINT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-unix-'));
  const { UnixDriver } = require('../agent/src/printing/unix');
  const drv = new UnixDriver(new Config(), () => {});
  const r = await drv.renderPdf(makePdf(2), { width: 576, pages: [1] });
  assert.strictEqual(r.pageCount, 2);
  assert.strictEqual(r.pages.length, 1);
  assert.strictEqual(r.pages[0].width, 576);
  const mono = monoFromPng(r.pages[0].data, 576, { dither: false });
  assert.ok(mono.height > 100);
});
