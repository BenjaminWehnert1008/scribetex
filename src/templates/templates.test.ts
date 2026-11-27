import { unzlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { tryNormalizePath } from '../core/paths';
import { TEMPLATES, templateFileBytes } from './index';

/** Whether a picture made by encodePng (8-bit RGB, no filters, one IDAT chunk right after IHDR) has only shades of grey. */
function isGrey(png: Uint8Array): boolean {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = view.getUint32(16);
  // 8 bytes of signature and 25 of IHDR, then the IDAT chunk: length, type, data.
  if (String.fromCharCode(...png.subarray(37, 41)) !== 'IDAT') throw new Error('not a picture from encodePng');
  const raw = unzlibSync(png.subarray(41, 41 + view.getUint32(33)));
  const stride = width * 3 + 1;
  for (let row = 0; row < raw.length; row += stride) {
    for (let i = row + 1; i < row + stride; i += 3) if (raw[i] !== raw[i + 1] || raw[i] !== raw[i + 2]) return false;
  }
  return true;
}

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

      // Only the CV has colour accents; the other templates print in black and grey.
      if (template.id !== 'cv') {
        it('is black and white', () => {
          for (const file of template.files) {
            if ('text' in file && file.path.endsWith('.tex')) {
              const text = file.text.replace(/(^|[^\\])%.*$/gm, '$1');
              expect(text, file.path).not.toMatch(/\\definecolor|\\usecolortheme|(link|cite|url)color=/);
              for (const match of text.matchAll(/\\colorlet\{\w+\}\{([^}]+)\}/g)) expect(match[1], file.path).toMatch(/^(black|gr[ae]y)(!\d+)?$/);
              for (const match of text.matchAll(/\\setbeamercolor\{[^}]+\}\{([^}]+)\}/g)) expect(match[1], file.path).toMatch(/^fg=black$/);
            }
            if (file.path.endsWith('.png')) expect(isGrey(templateFileBytes(file)), file.path).toBe(true);
          }
        });
      }

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
