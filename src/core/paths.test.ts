import { describe, expect, it } from 'vitest';
import {
  PathError,
  ancestors,
  basename,
  compareTreeOrder,
  dirname,
  extname,
  foldCase,
  guessContentKind,
  isTextContent,
  isWithin,
  joinPath,
  normalizePath,
  rebase,
  stem,
  tryNormalizePath,
  uniqueName,
  validateName,
} from './paths';

describe('validateName', () => {
  it('accepts ordinary names', () => {
    for (const name of ['main.tex', 'Kapitel 1', 'größe.tex', '.gitignore', 'a.b.c', 'refs_2026-11.bib']) {
      expect(validateName(name)).toBeNull();
    }
  });

  it('rejects names that break on some operating system', () => {
    for (const name of ['', '.', '..', 'a/b', 'a\\b', 'a:b', 'what?.tex', 'star*.tex', 'CON', 'nul.tex', 'LPT1', 'end.', 'end ', ' start', 'tab\there']) {
      expect(validateName(name), JSON.stringify(name)).not.toBeNull();
    }
    expect(validateName('x'.repeat(256))).not.toBeNull();
  });
});

describe('normalizePath', () => {
  it('normalizes separators and redundant segments', () => {
    expect(normalizePath('./chapters//intro.tex')).toBe('chapters/intro.tex');
    expect(normalizePath('chapters\\methods\\setup.tex')).toBe('chapters/methods/setup.tex');
    expect(normalizePath('/a/./b/')).toBe('a/b');
    expect(normalizePath('')).toBe('');
  });

  it('normalizes Unicode to NFC', () => {
    const decomposed = 'größe.tex';
    expect(normalizePath(decomposed)).toBe('größe.tex');
  });

  it('refuses to leave the project', () => {
    expect(() => normalizePath('../secret')).toThrow(PathError);
    expect(() => normalizePath('a/../../b')).toThrow(PathError);
    expect(tryNormalizePath('a/../b')).toBeNull();
  });

  it('refuses invalid segment names', () => {
    expect(() => normalizePath('figures/plot?.png')).toThrow(PathError);
    expect(tryNormalizePath('ok/fine.tex')).toBe('ok/fine.tex');
  });
});

describe('path parts', () => {
  it('splits paths', () => {
    expect(dirname('a/b/c.tex')).toBe('a/b');
    expect(dirname('c.tex')).toBe('');
    expect(basename('a/b/c.tex')).toBe('c.tex');
    expect(extname('a/b/Plot.PNG')).toBe('.png');
    expect(extname('a/.gitignore')).toBe('');
    expect(extname('Makefile')).toBe('');
    expect(stem('a/archive.tar.gz')).toBe('archive.tar');
    expect(stem('.gitignore')).toBe('.gitignore');
    expect(ancestors('a/b/c.tex')).toEqual(['a', 'a/b']);
    expect(ancestors('c.tex')).toEqual([]);
    expect(joinPath('a', '', 'b/c.tex')).toBe('a/b/c.tex');
    expect(joinPath('', 'c.tex')).toBe('c.tex');
  });

  it('tests containment', () => {
    expect(isWithin('a/b/c.tex', 'a')).toBe(true);
    expect(isWithin('a', 'a')).toBe(true);
    expect(isWithin('ab/c.tex', 'a')).toBe(false);
    expect(isWithin('anything', '')).toBe(true);
  });

  it('rebases paths for folder moves', () => {
    expect(rebase('a/b/c.tex', 'a', 'x/y')).toBe('x/y/b/c.tex');
    expect(rebase('a', 'a', 'z')).toBe('z');
    expect(rebase('a/b.tex', '', 'root')).toBe('root/a/b.tex');
    expect(rebase('a/b.tex', 'a', '')).toBe('b.tex');
    expect(() => rebase('q/b.tex', 'a', 'x')).toThrow(PathError);
  });
});

describe('uniqueName', () => {
  it('keeps free names and numbers taken ones, ignoring case', () => {
    expect(uniqueName(['a.png'], 'b.png')).toBe('b.png');
    expect(uniqueName(['Plot.png'], 'plot.png')).toBe('plot (2).png');
    expect(uniqueName(['plot.png', 'plot (2).png'], 'plot.png')).toBe('plot (3).png');
    expect(uniqueName(['notes'], 'notes')).toBe('notes (2)');
    expect(uniqueName(['.env'], '.env')).toBe('.env (2)');
  });
});

describe('compareTreeOrder', () => {
  it('lists folders first and sorts names naturally', () => {
    const entries = [
      { path: 'main.tex', kind: 'file' as const },
      { path: 'chapters', kind: 'dir' as const },
      { path: 'chapters/10-end.tex', kind: 'file' as const },
      { path: 'chapters/2-methods.tex', kind: 'file' as const },
      { path: 'chapters/sub', kind: 'dir' as const },
      { path: 'chapters/sub/deep.tex', kind: 'file' as const },
      { path: 'Appendix.tex', kind: 'file' as const },
      { path: 'figures', kind: 'dir' as const },
    ];
    const sorted = [...entries].sort(compareTreeOrder).map((e) => e.path);
    expect(sorted).toEqual([
      'chapters',
      'chapters/sub',
      'chapters/sub/deep.tex',
      'chapters/2-methods.tex',
      'chapters/10-end.tex',
      'figures',
      'Appendix.tex',
      'main.tex',
    ]);
  });
});

describe('content kind', () => {
  it('classifies by extension', () => {
    expect(guessContentKind('a/main.tex')).toBe('text');
    expect(guessContentKind('refs.BIB')).toBe('text');
    expect(guessContentKind('fig/plot.png')).toBe('binary');
    expect(guessContentKind('.gitignore')).toBe('text');
    expect(guessContentKind('data.xyz')).toBe('unknown');
  });

  it('sniffs bytes for everything that is not known binary', () => {
    const enc = new TextEncoder();
    expect(isTextContent('data.xyz', enc.encode('Größe = 3'))).toBe(true);
    expect(isTextContent('data.xyz', new Uint8Array([0x66, 0x00, 0x67]))).toBe(false);
    expect(isTextContent('latin1.tex', new Uint8Array([0x47, 0x72, 0xf6, 0xdf, 0x65]))).toBe(false);
    expect(isTextContent('plot.png', enc.encode('not really a png'))).toBe(false);
    expect(isTextContent('empty.tex', new Uint8Array())).toBe(true);
  });

  it('folds case for collision checks', () => {
    expect(foldCase('Figures/Plot.PNG')).toBe('figures/plot.png');
  });
});
