import { describe, expect, it } from 'vitest';
import article from './fixtures/article.synctex?raw';
import report from './fixtures/report.synctex?raw';
import { forwardSearch, inverseSearch, parseSyncTex } from './synctex';

// Both fixtures were written by the app's own engine. Word positions are
// the centres of the words as pdftotext reports them for the same PDFs.
//
// article: main.tex at the project root, \input{sub/chap} from a subfolder.
// report: thesis/main.tex in a subfolder, with \input{parts/second} and \include{parts/third}.
const articleMap = parseSyncTex(article, { knownPaths: ['main.tex', 'sub/chap.tex', 'notes.txt'] });
const reportMap = parseSyncTex(report, {
  knownPaths: ['notes.txt', 'thesis/main.tex', 'thesis/parts/second.tex', 'thesis/parts/third.tex'],
  workDir: 'thesis',
});

const centre = (xMin: number, yMin: number, xMax: number, yMax: number): [number, number] => [(xMin + xMax) / 2, (yMin + yMax) / 2];

describe('parseSyncTex', () => {
  it('maps the engine file names to project files and leaves out everything else', () => {
    const files = [...articleMap.files.values()].filter((path) => path !== null);
    expect(files.sort()).toEqual(['main.tex', 'sub/chap.tex']);
    const nested = [...reportMap.files.values()].filter((path) => path !== null);
    expect([...new Set(nested)].sort()).toEqual(['thesis/main.tex', 'thesis/parts/second.tex', 'thesis/parts/third.tex']);
    expect(reportMap.pages.map((page) => page.number)).toEqual([1, 2, 3]);
  });

  it('reads files with Windows line ends and ignores lines it does not know', () => {
    const map = parseSyncTex(article.replace(/\n/g, '\r\n').replace('Content:', 'Content:\r\nnonsense here'), { knownPaths: ['main.tex', 'sub/chap.tex'] });
    expect(inverseSearch(map, 1, ...centre(133.768, 267.68, 158.39, 276.53))).toEqual({ file: 'sub/chap.tex', line: 2 });
  });
});

describe('inverseSearch', () => {
  it.each([
    ['a heading', 1, centre(157.98, 124.81, 200.43, 137.55), 'main.tex', 3],
    ['the first word of a paragraph', 1, centre(133.77, 149.67, 163.43, 158.52), 'main.tex', 4],
    ['the first word of a source line inside a printed line', 1, centre(374.88, 149.67, 417.77, 158.52), 'main.tex', 5],
    ['the last word of a paragraph', 1, centre(294.7, 173.58, 332.61, 182.43), 'main.tex', 7],
    ['a word of a file in a subfolder', 1, centre(133.77, 267.68, 158.39, 276.53), 'sub/chap.tex', 2],
    ['an item of a list', 1, centre(210.2, 307.53, 235.77, 316.38), 'sub/chap.tex', 6],
    ['the text after the input', 1, centre(329.42, 327.46, 368.22, 336.3), 'main.tex', 16],
  ] as const)('finds %s', (_name, page, [x, y], file, line) => {
    expect(inverseSearch(articleMap, page, x, y)).toEqual({ file, line });
  });

  it.each([
    ['text of the main file in a subfolder', 2, centre(133.77, 304.19, 161.61, 313.04), 'thesis/main.tex', 7],
    ['a table cell', 2, centre(258.4, 350.36, 286.9, 359.21), 'thesis/main.tex', 15],
    ['another table row', 2, centre(258.4, 362.32, 305.06, 371.16), 'thesis/main.tex', 16],
    ['a footnote', 2, centre(252.55, 667.2, 272.33, 674.28), 'thesis/main.tex', 10],
    ['an \\input file', 2, centre(133.77, 450.5, 154.25, 459.35), 'thesis/parts/second.tex', 2],
    ['a source line that starts inside a printed line', 2, centre(415.57, 450.5, 452.37, 459.35), 'thesis/parts/second.tex', 3],
    ['an \\include file on its own page', 3, centre(423.46, 304.19, 477.48, 313.04), 'thesis/parts/third.tex', 3],
  ] as const)('finds %s when the main file is in a subfolder', (_name, page, [x, y], file, line) => {
    expect(inverseSearch(reportMap, page, x, y)).toEqual({ file, line });
  });

  it('takes the nearest line for a point between lines, and nothing far from any text', () => {
    expect(inverseSearch(articleMap, 1, 150, 166)).toMatchObject({ file: 'main.tex' });
    expect(inverseSearch(articleMap, 1, 300, 560)).toBeNull();
    expect(inverseSearch(articleMap, 9, 150, 160)).toBeNull();
  });
});

describe('forwardSearch', () => {
  it('finds the printed line of a source line in a subfolder', () => {
    const spot = forwardSearch(articleMap, 'sub/chap.tex', 2);
    expect(spot?.page).toBe(1);
    // "and continues with iron nickel …" is split over two printed lines.
    expect(spot?.rects.length).toBe(2);
    for (const rect of spot!.rects) expect(rect.right - rect.left).toBeGreaterThan(300);
    expect(spot!.rects.some((rect) => rect.top < 272 && rect.bottom > 272)).toBe(true);
  });

  it('moves on to the next line that printed something', () => {
    // Line 4 is \begin{itemize}; the first item is on line 5.
    const spot = forwardSearch(articleMap, 'sub/chap.tex', 4);
    // Not the paragraph before it, which TeX ended when it read that line.
    expect(spot?.rects.every((rect) => rect.top > 280)).toBe(true);
    expect(spot?.rects.some((rect) => rect.top < 292 && rect.bottom > 292 && rect.left > 150)).toBe(true);
  });

  it('finds the page of a file that starts a new page', () => {
    expect(forwardSearch(reportMap, 'thesis/parts/third.tex', 2)?.page).toBe(3);
    expect(forwardSearch(reportMap, 'thesis/parts/second.tex', 3)?.page).toBe(2);
    // \chapter also ends the table of contents on page 1; its heading is on page 2.
    expect(forwardSearch(reportMap, 'thesis/main.tex', 6)?.page).toBe(2);
  });

  it('gives nothing for a file that is not in the PDF', () => {
    expect(forwardSearch(articleMap, 'notes.txt', 1)).toBeNull();
  });

  it('round-trips: the marked line leads back to the same source line', () => {
    for (const [file, line] of [['thesis/main.tex', 8], ['thesis/parts/second.tex', 2], ['thesis/parts/third.tex', 4]] as const) {
      const spot = forwardSearch(reportMap, file, line)!;
      const rect = spot.rects[0]!;
      const back = inverseSearch(reportMap, spot.page, rect.left + 20, (rect.top + rect.bottom) / 2);
      expect(back?.file).toBe(file);
    }
  });
});
