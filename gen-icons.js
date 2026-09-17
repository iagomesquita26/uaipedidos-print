'use strict';
/*
 * gen-icons.js
 * Gera os ícones do programa (PNG) sem nenhuma dependência externa, usando só o
 * zlib embutido no Node. Desenha um ícone de impressora com um cupom saindo,
 * nas cores da marca. Roda com:  node gen-icons.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const LARANJA = [255, 50, 0];
const BRANCO = [255, 255, 255];

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function chunk(tipo, dados) {
  const t = Buffer.from(tipo, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(dados.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, dados])), 0);
  return Buffer.concat([len, t, dados, crc]);
}
function escreverPng(arquivo, w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const linhas = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    linhas[y * (w * 4 + 1)] = 0;
    rgba.copy(linhas, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(linhas, { level: 9 });
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(arquivo, png);
}

function novaCanvas(s) { return { s, buf: Buffer.alloc(s * s * 4, 0) }; }
function px(cv, x, y, cor, a = 255) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= cv.s || y >= cv.s) return;
  const i = (y * cv.s + x) * 4;
  const ia = a / 255, dst = cv.buf;
  const bg = dst[i + 3] / 255;
  const outA = ia + bg * (1 - ia);
  for (let k = 0; k < 3; k++) dst[i + k] = Math.round((cor[k] * ia + dst[i + k] * bg * (1 - ia)) / (outA || 1));
  dst[i + 3] = Math.round(outA * 255);
}
// Retângulo com cantos arredondados, com leve suavização de borda.
function roundRect(cv, x0, y0, x1, y1, r, cor) {
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
      let d = 0;
      const cx = x < x0 + r ? x0 + r : (x > x1 - r ? x1 - r : x);
      const cy = y < y0 + r ? y0 + r : (y > y1 - r ? y1 - r : y);
      d = Math.hypot(x - cx, y - cy);
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) {
        const a = r > 0 ? Math.max(0, Math.min(1, r - d + 0.5)) : 1;
        if (d <= r || r === 0) px(cv, x, y, cor, 255);
        else if (a > 0) px(cv, x, y, cor, Math.round(a * 255));
      }
    }
  }
}
function circulo(cv, cx, cy, r, cor) {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= r) px(cv, x, y, cor, 255);
      else if (d <= r + 1) px(cv, x, y, cor, Math.round((r + 1 - d) * 255));
    }
}

function desenharImpressora(s) {
  const cv = novaCanvas(s);
  const u = v => v * s;
  // fundo laranja arredondado
  roundRect(cv, u(0.03), u(0.03), u(0.97), u(0.97), u(0.22), LARANJA);
  // cupom saindo (atras do corpo)
  roundRect(cv, u(0.34), u(0.60), u(0.66), u(0.87), u(0.02), BRANCO);
  // linhas do cupom (laranja)
  roundRect(cv, u(0.385), u(0.665), u(0.615), u(0.685), 0, LARANJA);
  roundRect(cv, u(0.385), u(0.715), u(0.615), u(0.735), 0, LARANJA);
  roundRect(cv, u(0.385), u(0.765), u(0.575), u(0.785), 0, LARANJA);
  // papel entrando (atras do corpo, topo)
  roundRect(cv, u(0.335), u(0.24), u(0.665), u(0.42), u(0.02), BRANCO);
  // corpo da impressora (branco)
  roundRect(cv, u(0.22), u(0.40), u(0.78), u(0.64), u(0.06), BRANCO);
  // fenda de saida (laranja)
  roundRect(cv, u(0.30), u(0.52), u(0.70), u(0.55), u(0.01), LARANJA);
  // botao (laranja)
  circulo(cv, u(0.705), u(0.455), u(0.022), LARANJA);
  return cv;
}

function gerar(arquivo, s) {
  const dir = path.dirname(arquivo);
  fs.mkdirSync(dir, { recursive: true });
  const cv = desenharImpressora(s);
  escreverPng(arquivo, s, s, cv.buf);
  console.log('gerado:', arquivo, s + 'x' + s);
}

const raiz = __dirname;
gerar(path.join(raiz, 'build', 'icon.png'), 1024);
gerar(path.join(raiz, 'assets', 'tray.png'), 32);
gerar(path.join(raiz, 'assets', 'tray@2x.png'), 64);
gerar(path.join(raiz, 'assets', 'icon.png'), 512);
console.log('pronto');
