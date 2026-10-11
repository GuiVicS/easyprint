'use strict';
// Linhas do layout -> bytes ESC/POS (Epson, Elgin, Bematech em modo ESC/POS, Daruma, Tanca, Knup...)
const { encode, TABLES } = require('./codepages');
const { monoFromDataUrl } = require('./png');

const ESC = 0x1b, GS = 0x1d, LF = 0x0a;
const ALIGN = { left: 0, center: 1, right: 2 };

function renderEscPos(lines, profile = {}) {
  const codepage = profile.codepage || 'cp860';
  const dots = profile.paperWidth === 58 ? 384 : 576;
  const out = [];
  const push = (...bytes) => out.push(Buffer.from(bytes.flat()));

  push(ESC, 0x40); // inicializa
  const cp = TABLES[codepage];
  if (cp && cp.escposId !== null) push(ESC, 0x74, cp.escposId);

  let state = { align: -1, bold: -1, size: -1, underline: -1, invert: -1 };
  const setAlign = (a) => { const v = ALIGN[a] ?? 0; if (state.align !== v) { push(ESC, 0x61, v); state.align = v; } };

  for (const l of lines) {
    switch (l.kind) {
      case 'text': {
        setAlign(l.align);
        const bold = l.bold ? 1 : 0; if (state.bold !== bold) { push(ESC, 0x45, bold); state.bold = bold; }
        const size = ((l.size - 1) << 4) | (l.size - 1); if (state.size !== size) { push(GS, 0x21, size); state.size = size; }
        const ul = l.underline ? 1 : 0; if (state.underline !== ul) { push(ESC, 0x2d, ul); state.underline = ul; }
        const inv = l.invert ? 1 : 0; if (state.invert !== inv) { push(GS, 0x42, inv); state.invert = inv; }
        out.push(encode(l.text, codepage)); push(LF);
        break;
      }
      case 'qr': {
        setAlign(l.align);
        const data = Buffer.from(l.value, 'utf8');
        const n = data.length + 3;
        push(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00);            // modelo 2
        push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, l.size);                // tamanho do módulo
        push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31);                  // correção M
        push(GS, 0x28, 0x6b, n & 0xff, n >> 8, 0x31, 0x50, 0x30); out.push(data); // armazena
        push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30);                  // imprime
        push(LF);
        break;
      }
      case 'barcode': {
        setAlign(l.align);
        push(GS, 0x68, 80, GS, 0x77, 2, GS, 0x48, 2); // altura, largura, texto abaixo
        if (l.format === 'EAN13') {
          const d = l.value.replace(/\D/g, '').slice(0, 13);
          push(GS, 0x6b, 67, d.length); out.push(Buffer.from(d, 'ascii'));
        } else {
          const d = Buffer.from('{B' + l.value, 'ascii');
          push(GS, 0x6b, 73, d.length); out.push(d);
        }
        push(LF);
        break;
      }
      case 'image': {
        setAlign(l.align);
        const img = monoFromDataUrl(l.src, Math.min(dots, l.width || dots));
        // GS v 0 em faixas de até 255 linhas (compatível com impressoras com buffer pequeno)
        for (let y = 0; y < img.height; y += 255) {
          const h = Math.min(255, img.height - y);
          push(GS, 0x76, 0x30, 0, img.bytesPerRow & 0xff, img.bytesPerRow >> 8, h & 0xff, h >> 8);
          out.push(img.bits.subarray(y * img.bytesPerRow, (y + h) * img.bytesPerRow));
        }
        push(LF);
        break;
      }
      case 'feed': push(ESC, 0x64, l.lines); break;
      case 'cut': push(GS, 0x56, 0x42, 0x00); break;          // avança e corta parcial
      case 'drawer': push(ESC, 0x70, 0x00, 0x19, 0xfa); break; // pulso gaveta pino 2
    }
  }
  return Buffer.concat(out);
}

// Páginas já rasterizadas (PDF) -> raster ESC/POS, com corte entre páginas
function renderEscPosBitmaps(monoPages, profile = {}) {
  const out = [Buffer.from([ESC, 0x40, ESC, 0x61, 1])];
  for (const img of monoPages) {
    for (let y = 0; y < img.height; y += 255) {
      const h = Math.min(255, img.height - y);
      out.push(Buffer.from([GS, 0x76, 0x30, 0, img.bytesPerRow & 0xff, img.bytesPerRow >> 8, h & 0xff, h >> 8]));
      out.push(img.bits.subarray(y * img.bytesPerRow, (y + h) * img.bytesPerRow));
    }
    out.push(Buffer.from([ESC, 0x64, 3]));
    if (profile.autoCut !== false) out.push(Buffer.from([GS, 0x56, 0x42, 0x00]));
  }
  return Buffer.concat(out);
}

const paperDots = (profile = {}) => (profile.paperWidth === 58 ? 384 : 576);

module.exports = { renderEscPos, renderEscPosBitmaps, paperDots };
