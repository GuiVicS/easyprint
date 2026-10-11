'use strict';
// Decodificador PNG mínimo (8 bits, não entrelaçado) + conversão para bitmap 1 bit com dithering.
// É o formato que o canvas do navegador gera — o SDK converte qualquer imagem para isso.
const zlib = require('zlib');

function fromDataUrl(src) {
  const m = /^data:image\/png;base64,(.+)$/i.exec(String(src || ''));
  if (!m) {
    const e = new Error('A imagem precisa ser PNG em data URL (data:image/png;base64,...).');
    e.code = 'INVALID_DOCUMENT'; e.hint = 'No navegador, use: await EasyPrint.image("logo.jpg") para converter.';
    throw e;
  }
  return Buffer.from(m[1], 'base64');
}

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('Arquivo não é PNG.');
  let p = 8, width, height, depth, colorType, interlace, palette = null, trns = null;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p); const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('Tipo de cor PNG não suportado.');
  const lowDepth = depth < 8 && (colorType === 0 || colorType === 3);
  if ((depth !== 8 && !lowDepth) || interlace) throw new Error('PNG não suportado (use 8 bits, sem entrelaçamento — o SDK já converte).');
  if (width * height > 4096 * 8192) throw new Error('Imagem grande demais.');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = Math.ceil(width * channels * depth / 8);
  const bpp = Math.max(1, channels * depth / 8);
  const packed = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = packed.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[x] = v & 0xff;
    }
    prev = out;
  }
  // 1/2/4 bits -> 1 amostra de 8 bits por pixel
  let px = packed;
  if (lowDepth) {
    px = Buffer.alloc(width * height);
    const max = (1 << depth) - 1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = x * depth;
        const v = (packed[y * stride + (bit >> 3)] >> (8 - depth - (bit & 7))) & max;
        px[y * width + x] = colorType === 0 ? Math.round(v * 255 / max) : v;
      }
    }
  }
  // Converte para luminância (0 = preto, 255 = branco), fundo transparente vira branco
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    let r, g, b, a = 255;
    const o = i * channels;
    if (colorType === 0) { r = g = b = px[o]; }
    else if (colorType === 4) { r = g = b = px[o]; a = px[o + 1]; }
    else if (colorType === 2) { r = px[o]; g = px[o + 1]; b = px[o + 2]; }
    else if (colorType === 6) { r = px[o]; g = px[o + 1]; b = px[o + 2]; a = px[o + 3]; }
    else { const k = px[o]; r = palette[k * 3]; g = palette[k * 3 + 1]; b = palette[k * 3 + 2]; if (trns && k < trns.length) a = trns[k]; }
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    gray[i] = Math.round(l * a / 255 + 255 * (1 - a / 255));
  }
  return { width, height, gray };
}

function resize({ width, height, gray }, targetW) {
  if (width <= targetW) return { width, height, gray };
  const scale = targetW / width; const w = targetW; const h = Math.max(1, Math.round(height * scale));
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y / scale), y1 = Math.min(height, Math.floor((y + 1) / scale)) || y0 + 1;
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x / scale), x1 = Math.min(width, Math.floor((x + 1) / scale)) || x0 + 1;
      let sum = 0, n = 0;
      for (let yy = y0; yy < Math.max(y1, y0 + 1); yy++) for (let xx = x0; xx < Math.max(x1, x0 + 1); xx++) { sum += gray[yy * width + xx]; n++; }
      out[y * w + x] = sum / n;
    }
  }
  return { width: w, height: h, gray: out };
}

// Bitmap 1 bit (1 = ponto preto), linhas alinhadas a bytes.
// dither=true: Floyd–Steinberg (fotos/logos). dither=false: limiar puro — obrigatório para
// códigos de barras/QR de etiquetas e DANFE, que ficam ilegíveis com pontilhado.
function toMono({ width, height, gray }, { dither = true, threshold = 128 } = {}) {
  const g = Float32Array.from(gray);
  const bytesPerRow = Math.ceil(width / 8);
  const bits = Buffer.alloc(bytesPerRow * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x; const old = g[i]; const v = old < threshold ? 0 : 255; const err = old - v;
      if (v === 0) bits[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
      if (!dither) continue;
      if (x + 1 < width) g[i + 1] += err * 7 / 16;
      if (y + 1 < height) {
        if (x > 0) g[i + width - 1] += err * 3 / 16;
        g[i + width] += err * 5 / 16;
        if (x + 1 < width) g[i + width + 1] += err / 16;
      }
    }
  }
  return { width, height, bytesPerRow, bits };
}

function monoFromDataUrl(src, maxWidth, opts) {
  return toMono(resize(decodePng(fromDataUrl(src)), maxWidth), opts);
}

function monoFromPng(buf, maxWidth, opts) {
  return toMono(resize(decodePng(buf), maxWidth), opts);
}

// Remove o papel em branco no fim (HTML renderizado numa página longa de cupom)
function trimMono(img, marginRows = 16) {
  let last = -1;
  for (let y = img.height - 1; y >= 0 && last < 0; y--) {
    const row = img.bits.subarray(y * img.bytesPerRow, (y + 1) * img.bytesPerRow);
    if (row.some((b) => b !== 0)) last = y;
  }
  const height = Math.max(1, Math.min(img.height, last + 1 + marginRows));
  return { ...img, height, bits: img.bits.subarray(0, height * img.bytesPerRow) };
}

// Bitmap 1 bit -> PNG (pré-visualização do Simulador)
function encodeMonoPng(img) {
  const crcTable = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(img.width, 0); ihdr.writeUInt32BE(img.height, 4); ihdr[8] = 1; ihdr[9] = 0;
  const raw = Buffer.alloc((img.bytesPerRow + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.bytesPerRow; x++) raw[y * (img.bytesPerRow + 1) + 1 + x] = ~img.bits[y * img.bytesPerRow + x] & 0xff; // PNG: 1 = branco
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = { decodePng, resize, toMono, fromDataUrl, monoFromDataUrl, monoFromPng, trimMono, encodeMonoPng };
