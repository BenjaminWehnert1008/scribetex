/**
 * Draws the scribeTeX logo, a pixel-art typewriter with pixel lettering, and
 * writes it as three SVG files in public/:
 *   favicon.svg    the typewriter on a 16 x 16 grid, for the browser tab
 *   favicon-32.png and apple-touch-icon.png, the same as PNG for browsers
 *                  that skip SVG icons (Safari) and for phone home screens
 *   logo-mark.svg  the typewriter on a 24 x 24 grid, on its own (the app's top
 *                  bar draws it inline: PixelMark in src/ui/home/PixelLogo.tsx)
 *   logo.svg       the typewriter and the word "scribeTeX" (README, home page)
 * The favicon, logo-mark.svg and logo.svg follow the system's dark mode on
 * their own. Inside the app the logo is drawn inline from the same pixel data
 * (src/ui/home/PixelLogo.tsx), so it also follows the app's mode switch and
 * colour scheme; its colours are the --logo-* tokens in src/styles/tokens.css,
 * whose green values must stay those of logo-pixels.json.
 * Every pixel is one unit of the SVG's viewBox, so the files stay sharp at any
 * whole-number scale. Edit the grids in src/app/logo-pixels.json and run `npm run logo`; the
 * home page draws its typing animation from the same file.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const DATA = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../src/app/logo-pixels.json', import.meta.url)), 'utf8'));
const COLOURS = DATA.colours;
// In dark mode the outline and the lettering get lighter, so they stay visible.
const DARK = DATA.dark;
const MARK = DATA.mark;
const FAVICON = DATA.favicon;
const GLYPHS = DATA.glyphs;

/** Adds one rectangle per run of same-coloured pixels in a row. */
function paint(grid, left, top, paths) {
  grid.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      const colour = row[x];
      let end = x;
      while (end < row.length && row[end] === colour) end++;
      if (colour !== '.') (paths[colour] ??= []).push(`M${left + x} ${top + y}h${end - x}v1h-${end - x}z`);
      x = end;
    }
  });
}

/** An SVG that follows the system's dark mode. */
function svg(width, height, paths, title) {
  const style = `<style>@media (prefers-color-scheme: dark){${Object.entries(DARK).map(([key, dark]) => `.${key}{fill:${dark}}`).join('')}}</style>`;
  const body = Object.entries(paths)
    .map(([key, parts]) => `<path class="${key}" fill="${COLOURS[key]}" d="${parts.join('')}"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges"><title>${title}</title>${style}${body}</svg>\n`;
}


function write(name, text) {
  fs.writeFileSync(fileURLToPath(new URL(`../public/${name}`, import.meta.url)), text);
}

/** A PNG of a grid, each pixel scale x scale, on an optional background, with a margin. */
function png(grid, scale, background = null, margin = 0) {
  const size = (grid.length + margin * 2) * scale;
  const rgba = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).concat(255);
  const fill = background ? rgba(background) : [0, 0, 0, 0];
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = [0];
    for (let x = 0; x < size; x++) {
      const gx = Math.floor(x / scale) - margin;
      const gy = Math.floor(y / scale) - margin;
      const key = grid[gy]?.[gx];
      row.push(...(key && key !== '.' ? rgba(COLOURS[key]) : fill));
    }
    rows.push(Buffer.from(row));
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function writeBinary(name, bytes) {
  fs.writeFileSync(fileURLToPath(new URL(`../public/${name}`, import.meta.url)), bytes);
}

let paths = {};
paint(FAVICON, 0, 0, paths);
write('favicon.svg', svg(16, 16, paths, 'scribeTeX'));
writeBinary('favicon-32.png', png(FAVICON, 2));
// 24 grid + 3 pixels margin = 30, at 6 = 180 px, on paper (iOS adds no transparency).
writeBinary('apple-touch-icon.png', png(MARK, 6, '#fbf9f4', 3));

paths = {};
paint(MARK, 0, 0, paths);
write('logo-mark.svg', svg(24, 24, paths, 'scribeTeX'));

let x = DATA.text.left;
[...'scribeTeX'].forEach((letter, index) => {
  const ink = index < 6 ? 'I' : 'A';
  const glyph = GLYPHS[letter].map((row) => row.replaceAll('#', ink));
  paint(glyph, x, DATA.text.top, paths);
  x += glyph[0].length + DATA.text.gap;
});
write('logo.svg', svg(x - DATA.text.gap, 24, paths, 'scribeTeX'));
