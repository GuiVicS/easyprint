'use strict';
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { encode } = require('../agent/src/render/codepages');
const { layout, wrap, twoCols, toPlainText } = require('../agent/src/render/layout');
const { renderEscPos } = require('../agent/src/render/escpos');
const { renderZpl } = require('../agent/src/render/zpl');
const { decodePng, monoFromDataUrl } = require('../agent/src/render/png');
const { guessProfile } = require('../agent/src/printing');

test('CP860 codifica acentos do português', () => {
  assert.deepStrictEqual([...encode('ção', 'cp860')], [0x87, 0x84, 0x6f]);
  assert.deepStrictEqual([...encode('ÁÉÍÓÚ', 'cp860')], [0x86, 0x90, 0x8b, 0x9f, 0x96]);
});

test('CP850 usa tabela diferente para ã/õ', () => {
  assert.deepStrictEqual([...encode('ãõ', 'cp850')], [0xc6, 0xe4]);
});

test('modo ascii remove acentos e troca símbolos', () => {
  assert.strictEqual(encode('Ação “ok” — 10€', 'ascii').toString('latin1'), 'Acao "ok" - 10EUR');
});

test('caracteres sem equivalente viram "?"', () => {
  assert.strictEqual(encode('😀', 'cp860').toString('latin1'), '?');
});

test('wrap quebra por palavras e corta palavras longas', () => {
  assert.deepStrictEqual(wrap('um dois tres quatro', 8), ['um dois', 'tres', 'quatro']);
  assert.deepStrictEqual(wrap('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
});

test('twoCols alinha valor à direita na largura exata', () => {
  const [l] = twoCols('Subtotal', 'R$ 10,00', 32);
  assert.strictEqual(l.length, 32);
  assert.ok(l.endsWith('R$ 10,00'));
});

test('item com observação gera linha indentada', () => {
  const lines = layout([{ type: 'item', qty: 2, name: 'X-Burguer', price: 'R$ 30,00', note: 'sem cebola' }], 32);
  assert.strictEqual(lines.length, 2);
  assert.ok(lines[0].text.startsWith('2x X-Burguer'));
  assert.strictEqual(lines[1].text, '   sem cebola');
});

test('título usa metade das colunas (fonte dupla)', () => {
  const lines = layout([{ type: 'title', value: 'A'.repeat(30) }], 48);
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].size, 2);
});

test('documento inválido gera erro didático', () => {
  assert.throws(() => layout({}), (e) => e.code === 'INVALID_DOCUMENT' && /blocks/.test(e.message));
  assert.throws(() => layout([{ type: 'foo' }]), /desconhecido/);
});

test('ESC/POS: init, codepage, negrito, QR e corte', () => {
  const lines = layout([{ type: 'text', value: 'Olá', bold: true }, { type: 'qr', value: 'abc' }, { type: 'cut' }], 48);
  const b = renderEscPos(lines, { codepage: 'cp860', paperWidth: 80 });
  const hex = b.toString('hex');
  assert.ok(hex.startsWith('1b40' + '1b7403'), 'init + ESC t 3');
  assert.ok(hex.includes('1b4501'), 'negrito ligado');
  assert.ok(hex.includes('4f6ca00a'), '"Olá" em CP860 + LF');
  assert.ok(hex.includes('1d286b0600315030616263'), 'QR armazenado');
  assert.ok(hex.endsWith('1d564200'), 'corte parcial');
});

function makePng(w, h, pixel) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b, a] = pixel(x, y); const o = y * (w * 4 + 1) + 1 + x * 4;
    raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data])) >>> 0);
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('PNG: decodifica RGBA e transparência vira branco', () => {
  const png = makePng(4, 2, (x) => (x < 2 ? [0, 0, 0, 255] : [0, 0, 0, 0]));
  const { width, height, gray } = decodePng(png);
  assert.strictEqual(width, 4); assert.strictEqual(height, 2);
  assert.deepStrictEqual([...gray.slice(0, 4)], [0, 0, 255, 255]);
});

test('PNG: converte para bitmap 1 bit e redimensiona', () => {
  const png = makePng(16, 4, (x) => (x < 8 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  const mono = monoFromDataUrl('data:image/png;base64,' + png.toString('base64'), 8);
  assert.strictEqual(mono.width, 8); assert.strictEqual(mono.height, 2);
  assert.strictEqual(mono.bits[0], 0xf0);
});

test('imagem no ESC/POS usa GS v 0', () => {
  const png = makePng(8, 8, () => [0, 0, 0, 255]);
  const b = renderEscPos(layout([{ type: 'image', src: 'data:image/png;base64,' + png.toString('base64') }], 48), {});
  assert.ok(b.toString('hex').includes('1d7630000100' + '0800'));
});

test('ZPL usa UTF-8 (^CI28) e escapa caracteres de controle', () => {
  const z = renderZpl(layout([{ type: 'text', value: 'Ação ^XZ' }], 48)).toString('utf8');
  assert.ok(z.startsWith('^XA\n^CI28'));
  assert.ok(z.includes('^FDAção  XZ^FS'));
  assert.ok(z.trim().endsWith('^XZ'));
});

test('texto puro centraliza conforme colunas', () => {
  const t = toPlainText(layout([{ type: 'text', value: 'ab', align: 'center' }], 10), 10);
  assert.strictEqual(t, '    ab');
});

test('detecção automática do tipo de impressora', () => {
  assert.strictEqual(guessProfile({ name: 'EPSON TM-T20X Receipt', driver: 'EPSON TM-T20X' }).mode, 'escpos');
  assert.strictEqual(guessProfile({ name: 'ELGIN i9(USB)', driver: 'ELGIN i9' }).mode, 'escpos');
  assert.strictEqual(guessProfile({ name: 'MP-4200 TH', driver: 'Bematech MP-4200 TH' }).mode, 'escpos');
  assert.strictEqual(guessProfile({ name: 'POS-58', driver: 'POS-58' }).paperWidth, 58);
  assert.strictEqual(guessProfile({ name: 'ZDesigner ZD220-203dpi ZPL', driver: 'ZDesigner' }).mode, 'zpl');
  assert.strictEqual(guessProfile({ name: 'HP LaserJet Pro M404', driver: 'HP Universal' }).mode, 'office');
});
