'use strict';
// Tabelas de caracteres das impressoras térmicas. Cobrem português, espanhol e símbolos comuns.
// Lição do QZ Tray 2.3.0 (issue #1519): nunca depender da codificação padrão do sistema.

const LATIN = 'áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑªº°';

const TABLES = {
  // CP860 — Português (recomendada para impressoras ESC/POS no Brasil)
  cp860: {
    escposId: 3,
    map: {
      'á': 0xA0, 'à': 0x85, 'â': 0x83, 'ã': 0x84, 'é': 0x82, 'è': 0x8A, 'ê': 0x88, 'í': 0xA1, 'ì': 0x8D,
      'ó': 0xA2, 'ò': 0x95, 'ô': 0x93, 'õ': 0x94, 'ú': 0xA3, 'ù': 0x97, 'ü': 0x81, 'ç': 0x87, 'ñ': 0xA4,
      'Á': 0x86, 'À': 0x91, 'Â': 0x8F, 'Ã': 0x8E, 'É': 0x90, 'È': 0x92, 'Ê': 0x89, 'Í': 0x8B, 'Ì': 0x98,
      'Ó': 0x9F, 'Ò': 0xA9, 'Ô': 0x8C, 'Õ': 0x99, 'Ú': 0x96, 'Ù': 0x9D, 'Ü': 0x9A, 'Ç': 0x80, 'Ñ': 0xA5,
      'ª': 0xA6, 'º': 0xA7, '°': 0xF8,
    },
  },
  // CP850 — Multilíngue Latin-1 (muitas Bematech/Elgin vêm nela)
  cp850: {
    escposId: 2,
    map: {
      'á': 0xA0, 'à': 0x85, 'â': 0x83, 'ã': 0xC6, 'ä': 0x84, 'é': 0x82, 'è': 0x8A, 'ê': 0x88, 'ë': 0x89,
      'í': 0xA1, 'ì': 0x8D, 'î': 0x8C, 'ï': 0x8B, 'ó': 0xA2, 'ò': 0x95, 'ô': 0x93, 'õ': 0xE4, 'ö': 0x94,
      'ú': 0xA3, 'ù': 0x97, 'û': 0x96, 'ü': 0x81, 'ç': 0x87, 'ñ': 0xA4,
      'Á': 0xB5, 'À': 0xB7, 'Â': 0xB6, 'Ã': 0xC7, 'Ä': 0x8E, 'É': 0x90, 'È': 0xD4, 'Ê': 0xD2, 'Ë': 0xD3,
      'Í': 0xD6, 'Ì': 0xDE, 'Î': 0xD7, 'Ï': 0xD8, 'Ó': 0xE0, 'Ò': 0xE3, 'Ô': 0xE2, 'Õ': 0xE5, 'Ö': 0x99,
      'Ú': 0xE9, 'Ù': 0xEB, 'Û': 0xEA, 'Ü': 0x9A, 'Ç': 0x80, 'Ñ': 0xA5, 'ª': 0xA6, 'º': 0xA7, '°': 0xF8,
    },
  },
  // Windows-1252 (Epson "WPC1252")
  cp1252: { escposId: 16, map: null },
  // Sem acentos — funciona em qualquer impressora
  ascii: { escposId: null, map: {} },
};

const REPLACEMENTS = {
  '“': '"', '”': '"', '‘': "'", '’': "'", '–': '-', '—': '-', '…': '...', '•': '*', '€': 'EUR',
  ' ': ' ', '\t': '    ',
};

function stripAccents(ch) {
  return ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function encode(text, codepage = 'cp860') {
  const table = TABLES[codepage] || TABLES.cp860;
  const out = [];
  for (let ch of String(text)) {
    if (REPLACEMENTS[ch]) ch = REPLACEMENTS[ch];
    for (const c of ch) {
      const code = c.codePointAt(0);
      if (code < 0x80) { out.push(code); continue; }
      if (codepage === 'cp1252' && code <= 0xFF) { out.push(code); continue; }
      if (table.map && table.map[c] !== undefined) { out.push(table.map[c]); continue; }
      const plain = stripAccents(c);
      if (plain.length && plain.codePointAt(0) < 0x80) out.push(plain.codePointAt(0));
      else out.push(0x3F); // '?'
    }
  }
  return Buffer.from(out);
}

module.exports = { encode, TABLES, LATIN, stripAccents, CODEPAGES: Object.keys(TABLES) };
