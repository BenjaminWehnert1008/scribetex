import { describe, expect, it } from 'vitest';
import { ignoreReason, planSync, type Stamp, type SyncAction } from './plan';

const file = (hash: string): Stamp => ({ kind: 'file', hash });
const dir: Stamp = { kind: 'dir', hash: null };
const side = (entries: Record<string, Stamp>): Map<string, Stamp> => new Map(Object.entries(entries));
const short = (actions: SyncAction[]): string[] => actions.map((action) => `${action.type} ${action.path}${action.type === 'conflict' ? ` -> ${action.copyPath}` : ''}`);

describe('planSync', () => {
  it('does nothing when both sides match the last agreed state', () => {
    const state = { 'main.tex': file('a'), figures: dir, 'figures/plot.pdf': file('p') };
    expect(planSync({ vault: side(state), disk: side(state), base: side(state) })).toEqual({ actions: [], guard: null });
  });

  it('writes a file to the folder when only the browser changed it', () => {
    const plan = planSync({ vault: side({ 'main.tex': file('new') }), disk: side({ 'main.tex': file('old') }), base: side({ 'main.tex': file('old') }) });
    expect(short(plan.actions)).toEqual(['to-disk main.tex']);
  });

  it('takes a file from the folder when only the folder changed it', () => {
    const plan = planSync({ vault: side({ 'main.tex': file('old') }), disk: side({ 'main.tex': file('new') }), base: side({ 'main.tex': file('old') }) });
    expect(short(plan.actions)).toEqual(['to-vault main.tex']);
  });

  it('keeps both versions when both sides changed the same file', () => {
    const plan = planSync({ vault: side({ 'ch/intro.tex': file('mine') }), disk: side({ 'ch/intro.tex': file('theirs') }), base: side({ 'ch/intro.tex': file('old') }) });
    expect(short(plan.actions)).toEqual(['conflict ch/intro.tex -> ch/intro (folder copy).tex']);
  });

  it('picks a free name for the second conflict copy', () => {
    const plan = planSync({
      vault: side({ 'a.tex': file('mine'), 'a (folder copy).tex': file('earlier') }),
      disk: side({ 'a.tex': file('theirs'), 'a (folder copy).tex': file('earlier') }),
      base: side({ 'a.tex': file('old'), 'a (folder copy).tex': file('earlier') }),
    });
    expect(short(plan.actions)).toEqual(['conflict a.tex -> a (folder copy) (2).tex']);
  });

  it('only records agreement when both sides made the same change', () => {
    const plan = planSync({ vault: side({ 'a.tex': file('same') }), disk: side({ 'a.tex': file('same') }), base: side({ 'a.tex': file('old') }) });
    expect(short(plan.actions)).toEqual(['settle a.tex']);
  });

  it('copies new files in both directions and creates folders first', () => {
    const plan = planSync({
      vault: side({ notes: dir, 'notes/todo.txt': file('t') }),
      disk: side({ figures: dir, 'figures/deep': dir, 'figures/deep/plot.png': file('p') }),
      base: side({}),
    });
    expect(short(plan.actions)).toEqual([
      'to-vault figures',
      'to-disk notes',
      'to-vault figures/deep',
      'to-disk notes/todo.txt',
      'to-vault figures/deep/plot.png',
    ]);
  });

  it('deletes on the other side, inner entries before their folder', () => {
    const before = { old: dir, 'old/a.tex': file('a'), 'keep.tex': file('k'), 'gone.tex': file('g') };
    const plan = planSync({
      vault: side({ 'keep.tex': file('k'), 'gone.tex': file('g') }),
      disk: side({ old: dir, 'old/a.tex': file('a'), 'keep.tex': file('k') }),
      base: side(before),
    });
    expect(short(plan.actions)).toEqual(['remove-disk old/a.tex', 'remove-vault gone.tex', 'remove-disk old']);
  });

  it('lets an edit win over a deletion, and keeps the folder it lives in', () => {
    const before = { ch: dir, 'ch/a.tex': file('a'), 'ch/b.tex': file('b') };
    const plan = planSync({
      // The folder was deleted on disk while b.tex was edited in the browser.
      vault: side({ ch: dir, 'ch/a.tex': file('a'), 'ch/b.tex': file('b2') }),
      disk: side({}),
      base: side(before),
    });
    expect(short(plan.actions)).toEqual(['to-disk ch', 'to-disk ch/b.tex', 'remove-vault ch/a.tex']);
  });

  it('takes an edited file back into the browser after it was deleted there', () => {
    const plan = planSync({ vault: side({}), disk: side({ 'a.tex': file('edited') }), base: side({ 'a.tex': file('old') }) });
    expect(short(plan.actions)).toEqual(['to-vault a.tex']);
  });

  it('drops the record of something that is gone on both sides', () => {
    const plan = planSync({ vault: side({}), disk: side({}), base: side({ 'a.tex': file('a') }) });
    expect(short(plan.actions)).toEqual(['forget a.tex']);
  });

  it('reports a file that is a folder on the other side instead of guessing', () => {
    const plan = planSync({ vault: side({ data: file('d') }), disk: side({ data: dir }), base: side({}) });
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ type: 'blocked', path: 'data' });
  });

  describe('when the folder has lost most of the project', () => {
    const names = ['a.tex', 'b.tex', 'c.tex', 'd.tex', 'e.tex', 'f.tex'];
    const all = Object.fromEntries(names.map((name) => [name, file(name)]));

    it('does not delete in the browser, and says which files are missing', () => {
      const plan = planSync({ vault: side(all), disk: side({ 'a.tex': file('a.tex') }), base: side(all) });
      expect(plan.actions).toEqual([]);
      expect(plan.guard).toEqual({ missing: ['b.tex', 'c.tex', 'd.tex', 'e.tex', 'f.tex'] });
    });

    it('guards an emptied folder even for a small project', () => {
      const two = { 'a.tex': file('a'), 'b.bib': file('b') };
      const plan = planSync({ vault: side(two), disk: side({}), base: side(two) });
      expect(plan.guard?.missing).toEqual(['a.tex', 'b.bib']);
      expect(plan.actions).toEqual([]);
    });

    it('still copies other changes while it waits for an answer', () => {
      const plan = planSync({ vault: side({ ...all, 'new.tex': file('n') }), disk: side({}), base: side(all) });
      expect(short(plan.actions)).toEqual(['to-disk new.tex']);
      expect(plan.guard?.missing).toHaveLength(6);
    });

    it('deletes in the browser once that was confirmed', () => {
      const plan = planSync({ vault: side(all), disk: side({ 'a.tex': file('a.tex') }), base: side(all), massDeletion: 'apply' });
      expect(plan.guard).toBeNull();
      expect(short(plan.actions)).toEqual(['remove-vault b.tex', 'remove-vault c.tex', 'remove-vault d.tex', 'remove-vault e.tex', 'remove-vault f.tex']);
    });

    it('writes the files back when the user asks for that', () => {
      const plan = planSync({ vault: side(all), disk: side({ 'a.tex': file('a.tex') }), base: side(all), massDeletion: 'restore' });
      expect(plan.guard).toBeNull();
      expect(short(plan.actions)).toEqual(['to-disk b.tex', 'to-disk c.tex', 'to-disk d.tex', 'to-disk e.tex', 'to-disk f.tex']);
    });

    it('treats a few deleted files in a large project as intended', () => {
      const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}.tex`, file(`h${i}`)]));
      const disk = { ...many };
      delete disk['f0.tex'];
      delete disk['f1.tex'];
      const plan = planSync({ vault: side(many), disk: side(disk), base: side(many) });
      expect(plan.guard).toBeNull();
      expect(short(plan.actions)).toEqual(['remove-vault f0.tex', 'remove-vault f1.tex']);
    });
  });
});

describe('ignoreReason', () => {
  it('leaves version control and system files out', () => {
    expect(ignoreReason('.git', 'dir', false)).toBe('system');
    expect(ignoreReason('.git/config', 'file', false)).toBe('system');
    expect(ignoreReason('figures/.DS_Store', 'file', false)).toBe('system');
    expect(ignoreReason('node_modules/x/index.js', 'file', false)).toBe('system');
  });

  it('leaves half-written and lock files out', () => {
    expect(ignoreReason('main.tex.crswap', 'file', false)).toBe('temporary');
    expect(ignoreReason('~$thesis.docx', 'file', false)).toBe('temporary');
    expect(ignoreReason('.main.tex.swp', 'file', false)).toBe('temporary');
    expect(ignoreReason('main.tex~', 'file', false)).toBe('temporary');
  });

  it('leaves build files out unless the project already tracks them', () => {
    expect(ignoreReason('main.aux', 'file', false)).toBe('build');
    expect(ignoreReason('out/main.synctex.gz', 'file', false)).toBe('build');
    expect(ignoreReason('main.bbl', 'file', true)).toBeNull();
  });

  it('leaves out names the project cannot hold', () => {
    expect(ignoreReason('what?.tex', 'file', false)).toBe('name');
    expect(ignoreReason('aux/notes.tex', 'file', false)).toBe('name');
  });

  it('accepts ordinary project files, also inside a folder called git', () => {
    expect(ignoreReason('main.tex', 'file', false)).toBeNull();
    expect(ignoreReason('figures/plot one.png', 'file', false)).toBeNull();
    expect(ignoreReason('git/notes.tex', 'file', false)).toBeNull();
    expect(ignoreReason('chapters', 'dir', false)).toBeNull();
  });
});
