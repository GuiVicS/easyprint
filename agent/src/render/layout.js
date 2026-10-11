'use strict';
// Converte o "documento universal" do EasyPrint em linhas prontas para qualquer impressora.
//
// Documento: { blocks: Block[] }  (ou diretamente um array de blocos)
// Blocos aceitos (string solta = texto):
//   { type:'text', value, align, bold, size(1-3), underline, invert }
//   { type:'title', value }                          -> texto grande, centralizado, negrito
//   { type:'line', char }                            -> separador
//   { type:'row', left, right, bold, size }          -> duas colunas (esq. quebra linha)
//   { type:'item', qty, name, price, note }          -> item de pedido
//   { type:'total', label, value }                   -> total em destaque
//   { type:'qr', value, size }                       -> QR Code
//   { type:'barcode', value, format }                -> código de barras (CODE128 | EAN13)
//   { type:'image', src }                            -> imagem PNG (data URL)
//   { type:'feed', lines }                           -> avança papel
//   { type:'cut' } { type:'drawer' }                 -> corta papel / abre gaveta

const ALIGNS = ['left', 'center', 'right'];

class DocumentError extends Error {
  constructor(message, hint) { super(message); this.code = 'INVALID_DOCUMENT'; this.hint = hint; }
}

function normalize(doc) {
  const blocks = Array.isArray(doc) ? doc : doc && Array.isArray(doc.blocks) ? doc.blocks : null;
  if (!blocks) throw new DocumentError('O documento precisa ter uma lista "blocks".', 'Exemplo: { blocks: [ { type: "text", value: "Olá" } ] }');
  return blocks.map((b, i) => {
    if (b == null) return null;
    if (typeof b === 'string' || typeof b === 'number') return { type: 'text', value: String(b) };
    if (typeof b !== 'object') throw new DocumentError(`Bloco ${i} inválido.`);
    const type = b.type || (b.value !== undefined ? 'text' : null);
    if (!type) throw new DocumentError(`Bloco ${i} sem "type".`, 'Tipos: text, title, line, row, item, total, qr, barcode, image, feed, cut, drawer');
    return { ...b, type };
  }).filter(Boolean);
}

function wrap(text, width) {
  const out = [];
  for (const para of String(text ?? '').split(/\r?\n/)) {
    if (!para.length) { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/ +/)) {
      let w = word;
      while ([...w].length > width) { // palavra maior que a linha
        if (line) { out.push(line); line = ''; }
        out.push([...w].slice(0, width).join(''));
        w = [...w].slice(width).join('');
      }
      if (!line) line = w;
      else if ([...line].length + 1 + [...w].length <= width) line += ' ' + w;
      else { out.push(line); line = w; }
    }
    out.push(line);
  }
  return out;
}

const len = (s) => [...s].length;

function twoCols(left, right, width, fill = ' ') {
  left = String(left ?? ''); right = String(right ?? '');
  const rightLen = len(right);
  const avail = Math.max(1, width - rightLen - 1);
  const lines = wrap(left, avail);
  const last = lines.pop() || '';
  const gap = Math.max(1, width - len(last) - rightLen);
  return [...lines, last + fill.repeat(gap) + right];
}

// Retorna uma lista de "linhas" independentes de impressora.
// Cada linha: { kind:'text', text, align, bold, size, underline, invert } | { kind:'qr'|'barcode'|'image'|'feed'|'cut'|'drawer', ... }
function layout(doc, columns = 48) {
  const blocks = normalize(doc);
  const lines = [];
  const text = (t, o = {}) => lines.push({ kind: 'text', text: t, align: o.align || 'left', bold: !!o.bold, size: o.size || 1, underline: !!o.underline, invert: !!o.invert });

  for (const b of blocks) {
    switch (b.type) {
      case 'text': {
        const size = clampSize(b.size);
        const align = ALIGNS.includes(b.align) ? b.align : 'left';
        for (const l of wrap(b.value, Math.floor(columns / size))) text(l, { ...b, align, size });
        break;
      }
      case 'title':
        for (const l of wrap(b.value, Math.floor(columns / 2))) text(l, { align: 'center', bold: true, size: 2 });
        break;
      case 'line':
        text((b.char || '-').repeat(columns));
        break;
      case 'row': {
        const size = clampSize(b.size);
        for (const l of twoCols(b.left, b.right, Math.floor(columns / size))) text(l, { bold: b.bold, size });
        break;
      }
      case 'item': {
        const qty = b.qty !== undefined && b.qty !== null ? `${b.qty}x ` : '';
        for (const l of twoCols(qty + (b.name ?? ''), b.price ?? '', columns)) text(l, { bold: b.bold });
        if (b.note) for (const l of wrap(b.note, columns - 3)) text('   ' + l);
        break;
      }
      case 'total':
        for (const l of twoCols(b.label ?? 'TOTAL', b.value ?? '', Math.floor(columns / 2))) text(l, { bold: true, size: 2 });
        break;
      case 'qr':
        if (!b.value) throw new DocumentError('Bloco "qr" precisa de "value".');
        lines.push({ kind: 'qr', value: String(b.value), size: Math.min(16, Math.max(1, b.size || 6)), align: b.align || 'center' });
        break;
      case 'barcode':
        if (!b.value) throw new DocumentError('Bloco "barcode" precisa de "value".');
        lines.push({ kind: 'barcode', value: String(b.value), format: (b.format || 'CODE128').toUpperCase(), align: b.align || 'center' });
        break;
      case 'image':
        if (!b.src) throw new DocumentError('Bloco "image" precisa de "src" (PNG em data URL).', 'Use EasyPrint.image(url) no navegador para converter qualquer imagem.');
        lines.push({ kind: 'image', src: b.src, align: b.align || 'center', width: b.width });
        break;
      case 'feed':
        lines.push({ kind: 'feed', lines: Math.min(20, Math.max(1, b.lines || 1)) });
        break;
      case 'cut': lines.push({ kind: 'cut' }); break;
      case 'drawer': lines.push({ kind: 'drawer' }); break;
      default:
        throw new DocumentError(`Tipo de bloco desconhecido: "${b.type}".`, 'Tipos: text, title, line, row, item, total, qr, barcode, image, feed, cut, drawer');
    }
  }
  return lines;
}

function clampSize(s) { return Math.min(3, Math.max(1, Number(s) || 1)); }

// Texto puro (para logs, pré-visualização e impressoras de texto)
function toPlainText(lines, columns = 48) {
  const out = [];
  for (const l of lines) {
    if (l.kind === 'text') {
      const w = Math.floor(columns / l.size);
      const pad = Math.max(0, w - len(l.text));
      const t = l.align === 'center' ? ' '.repeat(Math.floor(pad / 2)) + l.text : l.align === 'right' ? ' '.repeat(pad) + l.text : l.text;
      out.push(t);
    } else if (l.kind === 'qr') out.push(`[QR: ${l.value}]`);
    else if (l.kind === 'barcode') out.push(`[${l.format}: ${l.value}]`);
    else if (l.kind === 'image') out.push('[imagem]');
    else if (l.kind === 'feed') for (let i = 0; i < l.lines; i++) out.push('');
  }
  return out.join('\n');
}

module.exports = { layout, normalize, wrap, twoCols, toPlainText, DocumentError };
