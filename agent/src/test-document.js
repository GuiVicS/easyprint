'use strict';
// Página de teste: verifica acentuação, colunas, negrito, tamanhos, QR e corte.
function testDocument(variant) {
  const now = new Date().toLocaleString('pt-BR');
  if (variant === 'accents') {
    return { blocks: [
      { type: 'title', value: 'Teste de acentos' },
      { type: 'line' },
      'ação café pão maçã coração',
      'ÁÉÍÓÚ ÂÊÔ ÃÕ Ç à ü ñ',
      'Nº 1 - 1ª via - 25°C',
      { type: 'line' },
      { type: 'text', value: 'Se tudo acima saiu certinho, a codificação está correta!', align: 'center' },
    ] };
  }
  return { blocks: [
    { type: 'title', value: 'EasyPrint' },
    { type: 'text', value: 'Página de teste', align: 'center' },
    { type: 'text', value: now, align: 'center' },
    { type: 'line' },
    { type: 'item', qty: 2, name: 'X-Burguer com bacon', price: 'R$ 59,80', note: 'sem cebola, ponto da carne: mal passado' },
    { type: 'item', qty: 1, name: 'Refrigerante lata', price: 'R$ 6,00' },
    { type: 'line' },
    { type: 'row', left: 'Subtotal', right: 'R$ 65,80' },
    { type: 'row', left: 'Taxa de entrega', right: 'R$ 5,00' },
    { type: 'total', label: 'TOTAL', value: 'R$ 70,80' },
    { type: 'line' },
    { type: 'text', value: 'Acentos: ação café pão maçã ÁÉÍÓÚ ÃÕ Ç', align: 'center' },
    { type: 'qr', value: 'https://github.com/easyprint', size: 6 },
    { type: 'text', value: 'Se você está lendo isto, funcionou! :)', align: 'center', bold: true },
  ] };
}

module.exports = { testDocument };
