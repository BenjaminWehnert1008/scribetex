import PIXELS from '@/app/logo-pixels.json';

/*
 * Pixel art drawn from src/app/logo-pixels.json: the logo on the home page,
 * the mark in the top bar and the typewriter that types while the first PDF
 * is being made. A picture is a grid of strings, one character per pixel and
 * "." for transparent; it becomes one SVG path per colour, with every pixel
 * one unit of the viewBox.
 */

/** The typewriter on its 24 x 24 grid. */
export const MARK: readonly string[] = PIXELS.mark;

/** The first row of the roller's outline; paper below it is hidden by the roller. */
export const ROLLER = MARK.findIndex((row) => row.includes('R')) - 1;
/** The top edge of the sheet of paper in the mark. */
export const PAPER_TOP = MARK.findIndex((row) => row.includes('P')) - 1;
/** The sheet's outline columns. */
export const PAPER_LEFT = MARK[PAPER_TOP + 1].indexOf('K');
export const PAPER_RIGHT = MARK[PAPER_TOP + 1].lastIndexOf('K');

/** The typewriter without its sheet of paper. */
export const BODY: readonly string[] = MARK.map((row, y) =>
  y >= PAPER_TOP && y < ROLLER ? row.slice(0, PAPER_LEFT) + '.'.repeat(PAPER_RIGHT - PAPER_LEFT + 1) + row.slice(PAPER_RIGHT + 1) : row,
);

/**
 * Colours that change with the mode or the colour scheme come from CSS (the
 * --logo-* tokens in tokens.css): the outline, roller and lettering, the
 * typewriter's body, its keys and the typed lines, and E, the light grey of
 * folds inside a pile of paper. Only the paper itself stays the same white.
 */
const THEMED = new Set([...Object.keys(PIXELS.dark), 'G', 'H', 'D', 'L', 'W', 'E']);
/** The floor under the typewriter that types while the first PDF is made follows the page's lines. */
const SCENE: Record<string, string> = { F: 'var(--line-strong)' };

export function pixelFill(key: string): string {
  if (THEMED.has(key)) return `var(--logo-${key})`;
  return SCENE[key] ?? PIXELS.colours[key as keyof typeof PIXELS.colours];
}

/** Adds one rectangle per run of same-coloured pixels in a row. */
export function paintPixels(grid: readonly string[], left: number, top: number, paths: Map<string, string[]>): void {
  grid.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      const key = row[x];
      let end = x;
      while (end < row.length && row[end] === key) end++;
      if (key !== '.') {
        if (!paths.has(key)) paths.set(key, []);
        paths.get(key)!.push(`M${left + x} ${top + y}h${end - x}v1h-${end - x}z`);
      }
      x = end;
    }
  });
}

/** One [colour key, path] pair per colour. */
export type PixelParts = [string, string][];

export function pixelPaths(grid: readonly string[], left = 0, top = 0): PixelParts {
  const paths = new Map<string, string[]>();
  paintPixels(grid, left, top, paths);
  return toParts(paths);
}

export function toParts(paths: Map<string, string[]>): PixelParts {
  return [...paths].map(([key, parts]) => [key, parts.join('')]);
}

export function PixelPaths(props: { parts: PixelParts }) {
  return props.parts.map(([key, d]) => <path key={key} d={d} style={{ fill: pixelFill(key) }} />);
}

export function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
