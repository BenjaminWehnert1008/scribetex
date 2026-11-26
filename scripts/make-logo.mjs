/**
 * Draws the scribeTex logo, a pixel-art typewriter with pixel lettering, and
 * writes it as three SVG files in public/:
 *   favicon.svg    the typewriter on a 16 x 16 grid, for the browser tab
 *   logo-mark.svg  the typewriter on a 24 x 24 grid, for the top bar
 *   logo.svg       the typewriter and the word "scribeTex" (README, home page)
 * The favicon, logo-mark.svg and logo.svg follow the system's dark mode on
 * their own. The app also has a light/dark switch, which an <img> cannot see,
 * so logo-mark and logo also come as fixed -light and -dark files.
 * Every pixel is one unit of the SVG's viewBox, so the files stay sharp at any
 * whole-number scale. Edit the grids below and run `npm run logo`.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// One character per pixel. "." is transparent; the others are colours below.
const COLOURS = {
  K: '#23211c', // outline
  P: '#ffffff', // paper
  L: '#8a8475', // typed lines on the paper
  R: '#3a372f', // platen roller
  G: '#17715b', // body (the app's accent green)
  H: '#3f9a7f', // highlight on the body
  D: '#0f4f40', // shade on the body and under keys
  W: '#fbf9f4', // keys and space bar
  I: '#23211c', // lettering "scribe"
  A: '#17715b', // lettering "Tex"
};

// In dark mode the outline and the lettering get lighter, so they stay visible.
const DARK = { K: '#6b665a', R: '#2a2823', I: '#ece8dd', A: '#4cc2a0' };

const MARK = [
  '........................',
  '.......KKKKKKKKKK.......',
  '.......KPPPPPPPPK.......',
  '.......KPLLLLLPPK.......',
  '.......KPPPPPPPPK.......',
  '.......KPLLLLLLPK.......',
  'KKK....KPPPPPPPPK.......',
  '..K....KPLLLPPPPK.......',
  '..KKKKKKKKKKKKKKKKKK.KK.',
  '.KRRRRRRRRRRRRRRRRRRRRK.',
  '..KK.KKKKKKKKKKKKKK.KK..',
  '...KGGGGGGGGGGGGGGGGK...',
  '..KGHHHHHHHHHHHHHHHHGK..',
  '..KGGGGGGGGDDGGGGGGGGK..',
  '.KGGGGGGGGGGGGGGGGGGGGK.',
  '.KGWGWGWGWGWGWGWGWGWGGK.',
  '.KGDGDGDGDGDGDGDGDGDGGK.',
  '.KGGWGWGWGWGWGWGWGWGGGK.',
  '.KGGDGDGDGDGDGDGDGDGGGK.',
  '.KGGGGWWWWWWWWWWWWGGGGK.',
  '.KDDDDDDDDDDDDDDDDDDDDK.',
  '..KKKKKKKKKKKKKKKKKKKK..',
  '........................',
  '........................',
];

const FAVICON = [
  '................',
  '....KKKKKKKK....',
  '....KPPPPPPK....',
  '....KPLLLLPK....',
  '....KPPPPPPK....',
  '.KKKKKKKKKKKKKK.',
  'KRRRRRRRRRRRRRRK',
  '.KKKKKKKKKKKKKK.',
  '..KGGGGGGGGGGK..',
  '.KGHHHHHHHHHHGK.',
  'KGGGGGGGGGGGGGGK',
  'KGWGWGWGWGWGWGGK',
  'KGGWGWGWGWGWGGGK',
  'KGGGWWWWWWWWGGGK',
  'KDDDDDDDDDDDDDDK',
  '.KKKKKKKKKKKKKK.',
];

// A bold pixel font, 10 pixels high, only the letters the name needs.
const GLYPHS = {
  s: ['......', '......', '......', '.#####', '##....', '##....', '.####.', '....##', '....##', '#####.'],
  c: ['......', '......', '......', '.#####', '##....', '##....', '##....', '##....', '##....', '.#####'],
  r: ['......', '......', '......', '##.###', '####..', '###...', '##....', '##....', '##....', '##....'],
  i: ['..', '##', '..', '##', '##', '##', '##', '##', '##', '##'],
  b: ['##....', '##....', '##....', '#####.', '##..##', '##..##', '##..##', '##..##', '##..##', '#####.'],
  e: ['......', '......', '......', '.####.', '##..##', '##..##', '######', '##....', '##....', '.#####'],
  T: ['######', '######', '..##..', '..##..', '..##..', '..##..', '..##..', '..##..', '..##..', '..##..'],
  x: ['......', '......', '......', '##..##', '##..##', '.####.', '..##..', '.####.', '##..##', '##..##'],
};

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

/** mode "auto" follows the system's dark mode; "light" and "dark" are fixed. */
function svg(width, height, paths, title, mode = 'auto') {
  const colour = (key) => (mode === 'dark' && key in DARK ? DARK[key] : COLOURS[key]);
  const style =
    mode === 'auto'
      ? `<style>@media (prefers-color-scheme: dark){${Object.entries(DARK).map(([key, dark]) => `.${key}{fill:${dark}}`).join('')}}</style>`
      : '';
  const body = Object.entries(paths)
    .map(([key, parts]) => `<path class="${key}" fill="${colour(key)}" d="${parts.join('')}"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges"><title>${title}</title>${style}${body}</svg>\n`;
}

/** Writes name.svg (follows the system) plus name-light.svg and name-dark.svg. */
function writeAll(name, width, height, paths) {
  write(`${name}.svg`, svg(width, height, paths, 'scribeTex'));
  for (const mode of ['light', 'dark']) write(`${name}-${mode}.svg`, svg(width, height, paths, 'scribeTex', mode));
}

function write(name, text) {
  fs.writeFileSync(fileURLToPath(new URL(`../public/${name}`, import.meta.url)), text);
}

let paths = {};
paint(FAVICON, 0, 0, paths);
write('favicon.svg', svg(16, 16, paths, 'scribeTex'));

paths = {};
paint(MARK, 0, 0, paths);
writeAll('logo-mark', 24, 24, paths);

let x = 27;
[...'scribeTex'].forEach((letter, index) => {
  const ink = index < 6 ? 'I' : 'A';
  const glyph = GLYPHS[letter].map((row) => row.replaceAll('#', ink));
  paint(glyph, x, 11, paths);
  x += glyph[0].length + 1;
});
writeAll('logo', x - 1, 24, paths);
