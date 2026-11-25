import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { zipSync, strToU8 } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';
import { Vault } from '../vault/vault';
import { exportProjectZip, importZipAsProject, readZip } from './zip';

let vault: Vault;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  vault = await Vault.open({ name: `zip-${Math.random().toString(36).slice(2)}` });
});

describe('ZIP round trip', () => {
  it('exports nested folders, empty folders and binary files, and imports them back', async () => {
    const id = (await vault.createProject({ name: 'Thesis' })).id;
    await vault.writeText(id, 'main.tex', '\\input{chapters/one/intro}');
    await vault.writeText(id, 'chapters/one/intro.tex', 'Intro with ünïcödé');
    await vault.writeFile(id, 'figures/plot.png', new Uint8Array([0, 255, 128, 7]));
    await vault.mkdir(id, 'empty/inner');
    await vault.writeText(id, 'main.aux', 'leftover');

    const zip = await exportProjectZip(vault, id);
    const copy = await importZipAsProject(vault, 'Thesis copy', zip);
    expect(copy.skipped).toEqual([]);
    expect(copy.projectId).not.toBe(id);
    const paths = (await vault.list(copy.projectId)).map((e) => `${e.kind} ${e.path}`).sort();
    expect(paths).toEqual([
      'dir chapters',
      'dir chapters/one',
      'dir empty',
      'dir empty/inner',
      'dir figures',
      'file chapters/one/intro.tex',
      'file figures/plot.png',
      'file main.tex',
    ]);
    expect(await vault.readText(copy.projectId, 'chapters/one/intro.tex')).toBe('Intro with ünïcödé');
    expect([...(await vault.readBytes(copy.projectId, 'figures/plot.png'))]).toEqual([0, 255, 128, 7]);
  });

  it('can include build leftovers and extra files such as the PDF', async () => {
    const id = (await vault.createProject({ name: 'P' })).id;
    await vault.writeText(id, 'main.tex', 'x');
    await vault.writeText(id, 'main.aux', 'aux');
    const zip = await exportProjectZip(vault, id, {
      skipBuildArtifacts: false,
      extra: [{ path: 'main.pdf', bytes: new Uint8Array([37, 80, 68, 70]) }],
    });
    expect(readZip(zip).files.map((f) => f.path).sort()).toEqual(['main.aux', 'main.pdf', 'main.tex']);
  });
});

describe('readZip', () => {
  it('strips a single top-level folder and drops system junk', () => {
    const zip = zipSync({
      'thesis/main.tex': strToU8('m'),
      'thesis/ch/a.tex': strToU8('a'),
      '__MACOSX/thesis/._main.tex': strToU8('junk'),
      'thesis/.DS_Store': strToU8('junk'),
      'thesis/.git/config': strToU8('junk'),
    });
    const contents = readZip(zip);
    expect(contents.files.map((f) => f.path).sort()).toEqual(['ch/a.tex', 'main.tex']);
    expect(contents.skipped).toEqual([]);
  });

  it('keeps the folders when there are several top-level entries', () => {
    const zip = zipSync({ 'a/x.tex': strToU8('x'), 'b/y.tex': strToU8('y'), 'main.tex': strToU8('m') });
    expect(readZip(zip).files.map((f) => f.path).sort()).toEqual(['a/x.tex', 'b/y.tex', 'main.tex']);
  });

  it('refuses names that would escape the project, and says so', () => {
    const zip = zipSync({ 'ok.tex': strToU8('ok'), '../evil.tex': strToU8('x'), 'a/../../b.tex': strToU8('x') });
    const contents = readZip(zip);
    expect(contents.files.map((f) => f.path)).toEqual(['ok.tex']);
    expect(contents.skipped.map((s) => s.name).sort()).toEqual(['../evil.tex', 'a/../../b.tex']);
  });

  it('refuses an archive that unpacks too large', () => {
    const zip = zipSync({ 'big.bin': new Uint8Array(2000) });
    expect(() => readZip(zip, { maxBytes: 1000 })).toThrow(/larger/);
  });
});
