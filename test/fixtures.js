'use strict';
// Gera PDFs mínimos válidos para os testes (sem dependências).
function makePdf(pages = 1, { width = 283, height = 425 } = {}) { // 100x150 mm em pontos
  const objs = [];
  const kids = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let n = 4;
  for (let i = 0; i < pages; i++) {
    const content = `BT /F1 28 Tf 20 ${height - 60} Td (Etiqueta ${i + 1}) Tj ET\n10 10 ${width - 20} 40 re f\n`;
    const contentId = n++; const pageId = n++;
    objs[contentId] = `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`;
    objs[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents ${contentId} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
    kids.push(`${pageId} 0 R`);
  }
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < objs.length; i++) { offsets[i] = Buffer.byteLength(out); out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n` + offsets.slice(1).map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

module.exports = { makePdf };
