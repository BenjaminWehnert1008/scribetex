/**
 * Placeholder pictures for the templates, drawn in code and written as PNG,
 * so the repository carries no image files and the templates have something
 * for \includegraphics to show. Every pixel here is our own.
 */
import { zlibSync } from 'fflate';

type Rgb = readonly [number, number, number];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encodes an RGB picture as PNG. `pixel` returns the colour at (x, y). */
export function encodePng(width: number, height: number, pixel: (x: number, y: number) => Rgb): Uint8Array {
  const raw = new Uint8Array(height * (width * 3 + 1));
  let i = 0;
  for (let y = 0; y < height; y++) {
    raw[i++] = 0; // no filter
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[i++] = r;
      raw[i++] = g;
      raw[i++] = b;
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlibSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

const PAPER: Rgb = [238, 243, 241];
const FRAME: Rgb = [23, 113, 91];
const HILL_BACK: Rgb = [137, 190, 172];
const HILL_FRONT: Rgb = [63, 154, 127];
const SUN: Rgb = [242, 190, 84];

/** A framed landscape (sun and two hills), the usual "picture goes here" sign. */
export function exampleFigure(): Uint8Array {
  const width = 600;
  const height = 360;
  return encodePng(width, height, (x, y) => {
    if (x < 4 || y < 4 || x >= width - 4 || y >= height - 4) return FRAME;
    if ((x - 430) ** 2 + (y - 100) ** 2 < 42 ** 2) return SUN;
    if (y > 300 - 0.55 * Math.max(0, 170 - Math.abs(x - 380))) return HILL_FRONT;
    if (y > 300 - 0.8 * Math.max(0, 200 - Math.abs(x - 190))) return HILL_BACK;
    return PAPER;
  });
}

/** A head-and-shoulders outline, to be replaced by a photo in the CV. */
export function photoPlaceholder(): Uint8Array {
  const width = 240;
  const height = 300;
  const figure: Rgb = [159, 179, 173];
  return encodePng(width, height, (x, y) => {
    if ((x - 120) ** 2 + (y - 120) ** 2 < 58 ** 2) return figure;
    if (y > 200 && ((x - 120) / 105) ** 2 + ((y - 300) / 100) ** 2 < 1) return figure;
    return [227, 232, 230];
  });
}
