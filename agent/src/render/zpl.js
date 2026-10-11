'use strict';
// Linhas do layout -> ZPL (impressoras de etiqueta Zebra, Elgin L42, Argox em modo ZPL)
const { monoFromDataUrl } = require('./png');

const esc = (s) => String(s).replace(/[\^~\\]/g, ' ');

// Dimensões da etiqueta em pontos (dots). 203 dpi = 8 pontos/mm; 300 dpi = 12 pontos/mm.
function labelDots(profile = {}) {
  const dpmm = Number(profile.dpi) === 300 ? 12 : 8;
  return {
    dpmm,
    width: Math.round((Number(profile.labelWidth) || 100) * dpmm),
    height: profile.labelHeight ? Math.round(Number(profile.labelHeight) * dpmm) : null,
  };
}

function renderZpl(lines, profile = {}) {
  const { dpmm, width: widthDots, height } = labelDots(profile);
  const scale = dpmm / 8;
  const out = ['^XA', '^CI28', `^PW${widthDots}`]; // ^CI28 = UTF-8 (acentos corretos)
  let y = Math.round(20 * scale);
  const just = { left: 'L', center: 'C', right: 'R' };
  for (const l of lines) {
    if (l.kind === 'text') {
      const h = Math.round(28 * l.size * scale);
      out.push(`^FO10,${y}^A0N,${h},${h}^FB${widthDots - 20},1,0,${just[l.align] || 'L'}^FD${esc(l.text)}^FS`);
      y += h + 6;
    } else if (l.kind === 'qr') {
      const mag = Math.min(10, Math.max(1, Math.round(l.size * scale)));
      out.push(`^FO${Math.max(10, Math.round(widthDots / 2 - 60 * scale))},${y}^BQN,2,${mag}^FDLA,${esc(l.value)}^FS`);
      y += 30 * mag + 20;
    } else if (l.kind === 'barcode') {
      out.push(`^FO20,${y}^BY${Math.round(2 * scale)}^BCN,${Math.round(80 * scale)},Y,N,N^FD${esc(l.value)}^FS`);
      y += Math.round(120 * scale);
    } else if (l.kind === 'image') {
      const img = monoFromDataUrl(l.src, widthDots - 20, { dither: l.dither !== false });
      out.push(`^FO10,${y}${gfa(img)}^FS`);
      y += img.height + 10;
    } else if (l.kind === 'feed') y += Math.round(30 * scale) * l.lines;
  }
  out.push(`^LL${height || y + 20}`, '^XZ');
  return Buffer.from(out.join('\n'), 'utf8');
}

function gfa(img) {
  return `^GFA,${img.bits.length},${img.bits.length},${img.bytesPerRow},${img.bits.toString('hex').toUpperCase()}`;
}

// Páginas já rasterizadas (PDF) -> uma etiqueta por página
function renderZplBitmaps(monoPages, profile = {}) {
  const { width, height } = labelDots(profile);
  const parts = monoPages.map((img) => {
    const x = Math.max(0, Math.floor((width - img.width) / 2));
    return ['^XA', `^PW${width}`, `^LL${height || img.height}`, `^FO${x},0${gfa(img)}^FS`, '^XZ'].join('\n');
  });
  return Buffer.from(parts.join('\n'), 'ascii');
}

module.exports = { renderZpl, renderZplBitmaps, labelDots };
