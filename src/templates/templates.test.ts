import { describe, expect, it } from 'vitest';
import { tryNormalizePath } from '../core/paths';
import { TEMPLATES, templateFileBytes } from './index';

describe('templates', () => {
  it('offers Blank first, then Thesis, Project Proposal and CV', () => {
    expect(TEMPLATES.slice(0, 4).map((template) => template.name)).toEqual(['Blank', 'Thesis', 'Project Proposal', 'CV']);
    expect(new Set(TEMPLATES.map((template) => template.id)).size).toBe(TEMPLATES.length);
  });

  for (const template of TEMPLATES) {
    describe(template.name, () => {
      const paths = new Set(template.files.map((file) => file.path));

      it('has valid, unique paths and its main file', () => {
        expect(paths.size).toBe(template.files.length);
        for (const path of [...paths, ...(template.dirs ?? [])]) expect(tryNormalizePath(path), path).toBe(path);
        if (template.mainFile) expect(paths.has(template.mainFile)).toBe(true);
      });

      it('only inputs, includes and cites files that exist', () => {
        for (const file of template.files) {
          if (!('text' in file) || !file.path.endsWith('.tex')) continue;
          const text = file.text.replace(/(^|[^\\])%.*$/gm, '$1');
          for (const match of text.matchAll(/\\(?:input|include)\{([^}]+)\}/g)) {
            expect(paths.has(`${match[1]}.tex`), `${file.path} -> ${match[1]}`).toBe(true);
          }
          for (const match of text.matchAll(/\\bibliography\{([^}]+)\}/g)) {
            expect(paths.has(`${match[1]}.bib`), `${file.path} -> ${match[1]}`).toBe(true);
          }
          for (const match of text.matchAll(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g)) {
            expect(paths.has(`images/${match[1]}.png`), `${file.path} -> ${match[1]}`).toBe(true);
          }
        }
      });

      it('cites only keys that its .bib files define', () => {
        const bib = template.files.filter((file) => file.path.endsWith('.bib') && 'text' in file).map((file) => ('text' in file ? file.text : '')).join('\n');
        const keys = new Set([...bib.matchAll(/@\w+\{([^,]+),/g)].map((match) => match[1]));
        for (const file of template.files) {
          if (!('text' in file) || !file.path.endsWith('.tex')) continue;
          const text = file.text.replace(/(^|[^\\])%.*$/gm, '$1');
          for (const match of text.matchAll(/\\cite[pt]?\{([^}]+)\}/g)) {
            for (const key of match[1]!.split(',')) expect(keys.has(key.trim()), `${file.path}: ${key}`).toBe(true);
          }
        }
      });

      it('makes real PNG pictures', () => {
        for (const file of template.files) {
          if (!file.path.endsWith('.png')) continue;
          const bytes = templateFileBytes(file);
          expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
          expect(bytes.length).toBeLessThan(20_000);
        }
      });
    });
  }
});
