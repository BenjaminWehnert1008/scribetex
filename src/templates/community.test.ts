import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tryNormalizePath } from '../core/paths';
import { type CommunityTemplate, loadCommunityFiles, loadCommunityTemplates, previewUrl } from './community';

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'public/templates');
const index = JSON.parse(fs.readFileSync(path.join(OUT, 'index.json'), 'utf8')) as { templates: CommunityTemplate[] };
const sources = JSON.parse(fs.readFileSync(path.join(ROOT, 'community-templates/sources.json'), 'utf8')) as {
  templates: { id: string; commit: string; packages?: string[] }[];
};
const extras = new Set(
  fs
    .readFileSync(path.join(ROOT, 'engine/extra-packages.txt'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#')),
);
const OPEN_LICENSES = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'LPPL-1.3c']);

/** Serves ./templates/... from public/templates on disk, as the site does. */
const diskFetch = async (url: string) => {
  const file = path.join(OUT, ...url.replace(/^\.\/templates\//, '').split('/').map(decodeURIComponent));
  const exists = fs.existsSync(file);
  const bytes = exists ? fs.readFileSync(file) : Buffer.alloc(0);
  return {
    ok: exists,
    status: exists ? 200 : 404,
    json: async () => JSON.parse(bytes.toString('utf8')) as unknown,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
};

describe('community templates', () => {
  it('match community-templates/sources.json (run "npm run templates" after changing it)', () => {
    expect(index.templates.map((template) => template.id)).toEqual(sources.templates.map((template) => template.id));
    for (const template of index.templates) {
      const source = sources.templates.find((candidate) => candidate.id === template.id)!;
      expect(template.source).toContain(source.commit);
      expect(template.packages).toEqual(source.packages ?? []);
    }
  });

  it('are listed by the app with their files', async () => {
    const list = await loadCommunityTemplates(diskFetch);
    expect(list.map((template) => template.id)).toEqual(index.templates.map((template) => template.id));
    // One with files in folders, to check how paths become addresses.
    const sample = list.find((template) => template.files.some((file) => file.path.includes('/'))) ?? list[0]!;
    const files = await loadCommunityFiles(sample, undefined, diskFetch);
    expect(files.map((file) => file.path)).toEqual(sample.files.map((file) => file.path));
    expect(files.every((file) => file.bytes.length > 0)).toBe(true);
  });

  for (const template of index.templates) {
    describe(template.name, () => {
      it('has an open license and carries it into the project', () => {
        expect(OPEN_LICENSES.has(template.license.spdx), template.license.spdx).toBe(true);
        expect(template.files.at(-1)!.path).toBe('TEMPLATE-LICENSE.txt');
        const notice = fs.readFileSync(path.join(OUT, template.id, 'files', 'TEMPLATE-LICENSE.txt'), 'utf8');
        expect(notice).toContain(template.source);
        expect(notice).toContain(template.author);
      });

      it('has every file it lists, under a usable name, and its main file', () => {
        for (const file of template.files) {
          expect(tryNormalizePath(file.path), file.path).toBe(file.path);
          expect(fs.statSync(path.join(OUT, template.id, 'files', file.path)).size, file.path).toBe(file.bytes);
        }
        expect(template.files.some((file) => file.path === template.main)).toBe(true);
        expect(template.main.endsWith('.tex')).toBe(true);
      });

      it('has its preview, if it names one', () => {
        if (!template.preview) return;
        expect(fs.existsSync(path.join(OUT, template.id, template.preview))).toBe(true);
        expect(previewUrl(template)).toBe(`./templates/${template.id}/${template.preview}`);
      });

      it('needs only packages that the engine build adds', () => {
        for (const name of template.packages) expect(extras.has(name), name).toBe(true);
      });
    });
  }
});
