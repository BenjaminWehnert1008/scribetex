import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { strToU8, zipSync } from 'fflate';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { SourceMirror } from '@/core/review/mirror';
import { readReviewFile, ReviewFileError } from '@/core/review/package';
import { ReviewDoc } from '@/core/review/review-doc';
import { DocPersistence, ReviewStorage } from '@/core/review/storage';
import { applyChanges, type TextChange } from '@/core/review/text-diff';
import type { Path, ProjectId } from '@/core/types';
import { Vault } from '@/core/vault/vault';
import { openReviewFile } from './review-files';
import { type ReviewHost, ReviewSession } from './review-session';
import type { Services } from './services';

let vault: Vault;
let storage: ReviewStorage;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  vault = await Vault.open({ name: `test-${Math.random().toString(36).slice(2)}` });
  storage = await ReviewStorage.open(`review-${Math.random().toString(36).slice(2)}`);
});

/** A tab with a project open: `texts` is what its editor holds. */
interface Tab {
  session: ReviewSession;
  texts: Map<Path, string>;
  /** Types in the editor, as the editor reports it. */
  type(path: Path, change: TextChange): void;
}

async function openTab(projectId: ProjectId, options: { canWrite?: boolean; role?: 'author' | 'reviewer' } = {}): Promise<Tab> {
  const texts = new Map<Path, string>();
  for (const entry of await vault.list(projectId)) if (entry.kind === 'file') texts.set(entry.path, await vault.readText(projectId, entry.path));
  let session: ReviewSession | null = null;
  const host: ReviewHost = {
    projectId,
    vault,
    storage,
    readText: async (path) => texts.get(path) ?? vault.readText(projectId, path),
    applyEdit: async (path, change) => {
      const after = applyChanges(texts.get(path)!, [change]);
      texts.set(path, after);
      session!.trackEdit(path, [change], after);
    },
    canWrite: () => options.canWrite ?? true,
  };
  session = await ReviewSession.open(host, options.role ?? 'author');
  await session.setMe('Benni');
  return {
    session,
    texts,
    type(path, change) {
      const after = applyChanges(texts.get(path)!, [change]);
      texts.set(path, after);
      session.trackEdit(path, [change], after);
    },
  };
}

async function project(files: Record<Path, string>): Promise<ProjectId> {
  const meta = await vault.createProject({ name: 'Paper' });
  for (const [path, text] of Object.entries(files)) await vault.writeText(meta.id, path, text, { origin: 'ui' });
  return meta.id;
}

/** A suggestion on the words `words` (the first place they stand, or the `nth`). */
async function suggest(tab: Tab, path: Path, words: string, replacement: string, nth = 0): Promise<string> {
  const text = tab.texts.get(path)!;
  let from = -1;
  for (let k = 0; k <= nth; k++) from = text.indexOf(words, from + 1);
  return tab.session.suggest({ path, from, to: from + words.length, replacement });
}

describe('accepting suggestions', () => {
  it('makes the same change once when two people suggested it', async () => {
    const id = await project({ 'main.tex': 'We present teh results.' });
    const tab = await openTab(id);
    const first = await suggest(tab, 'main.tex', 'teh', 'the');
    const second = await suggest(tab, 'main.tex', 'teh', 'the');
    expect(await tab.session.acceptAll()).toEqual({ accepted: 2, skipped: 0 });
    expect(tab.texts.get('main.tex')).toBe('We present the results.');
    expect(tab.session.thread(first)!.status).toBe('accepted');
    expect(tab.session.thread(second)!.status).toBe('accepted');
  });

  it('leaves a suggestion open when one accepted before it changed its words', async () => {
    const id = await project({ 'main.tex': 'the quick brown fox jumps' });
    const tab = await openTab(id);
    await suggest(tab, 'main.tex', 'quick brown', 'slow red');
    const later = await suggest(tab, 'main.tex', 'brown fox', 'grey wolf');
    expect(await tab.session.acceptAll()).toEqual({ accepted: 1, skipped: 1 });
    // One of the two was made, cleanly; the other waits for the author.
    expect(['the slow red fox jumps', 'the quick grey wolf jumps']).toContain(tab.texts.get('main.tex'));
    expect(tab.session.state.get().threads.filter((thread) => thread.status === 'open')).toHaveLength(1);
    expect(tab.session.thread(later)).not.toBeNull();
  });

  it('does not put back words the author deleted, unless asked to', async () => {
    const id = await project({ 'main.tex': 'Keep this. Drop this phrase. Keep this too.' });
    const tab = await openTab(id);
    const thread = await suggest(tab, 'main.tex', 'this phrase', 'that phrase');
    const text = tab.texts.get('main.tex')!;
    tab.type('main.tex', { from: text.indexOf('Drop'), to: text.indexOf('Keep this too'), insert: '' });
    await tab.session.verify(['main.tex']);
    await vi.waitFor(() => expect(tab.session.thread(thread)!.gone).toBe(true));
    expect(await tab.session.acceptAll()).toEqual({ accepted: 0, skipped: 0 });
    await expect(tab.session.accept(thread)).rejects.toThrow(/Accept anyway/);
    expect(tab.texts.get('main.tex')).toBe('Keep this. Keep this too.');
    await tab.session.accept(thread, { anyway: true });
    expect(tab.texts.get('main.tex')).toBe('Keep this. that phraseKeep this too.');
  });

  it('first catches up with a change that reached the file some other way', async () => {
    const id = await project({ 'main.tex': 'Intro text. The results are good.' });
    const tab = await openTab(id);
    const thread = await suggest(tab, 'main.tex', 'results', 'findings');
    // A linked folder brought in a new first sentence; the mirror did not hear of it.
    tab.texts.set('main.tex', 'A first sentence another program added. Intro text. The results are good.');
    await tab.session.accept(thread);
    expect(tab.texts.get('main.tex')).toBe('A first sentence another program added. Intro text. The findings are good.');
  });
});

describe('the mirror', () => {
  it('keeps comments on a file renamed in a linked folder, whichever change comes first', () => {
    const mirror = new SourceMirror();
    const text = 'Chapter one says hello.';
    mirror.setText('chapters/intro.tex', text);
    const anchor = mirror.anchor('chapters/intro.tex', 12, 16)!;
    // The old file goes first, then the new one appears.
    mirror.remove(['chapters/intro.tex']);
    mirror.setText('chapters/introduction.tex', text);
    expect(mirror.resolve(anchor)).toMatchObject({ path: 'chapters/introduction.tex', deleted: false, from: 12, to: 16 });
    // The new one appears first, then the old one goes.
    mirror.setText('chapters/start.tex', text);
    mirror.remove(['chapters/introduction.tex']);
    expect(mirror.resolve(anchor)).toMatchObject({ path: 'chapters/start.tex', deleted: false, from: 12, to: 16 });
    expect(mirror.paths()).toEqual(['chapters/start.tex']);
  });
});

describe('two tabs of one project', () => {
  it('a tab that only reads never replaces what the editing tab stored', async () => {
    const id = await project({ 'main.tex': 'Our method is clearly better than the old one.' });
    const editing = await openTab(id, { canWrite: true });
    const reading = await openTab(id, { canWrite: false });
    const text = editing.texts.get('main.tex')!;
    const mine = await editing.session.comment({ path: 'main.tex', from: text.indexOf('clearly better'), to: text.indexOf('clearly better') + 14, body: 'By how much?' });
    await editing.session.dispose();
    const other = await reading.session.comment({ path: 'main.tex', from: text.indexOf('method'), to: text.indexOf('method') + 6, body: 'Which one?' });
    await reading.session.dispose();

    const again = await openTab(id);
    again.type('main.tex', { from: 0, to: 0, insert: 'In short: ' });
    await again.session.verify(['main.tex']);
    const now = again.texts.get('main.tex')!;
    const at = (thread: string): string | null => {
      const found = again.session.thread(thread)?.at;
      return found ? now.slice(found.from, found.to) : null;
    };
    await vi.waitFor(() => {
      expect(at(mine)).toBe('clearly better');
      expect(at(other)).toBe('method');
    });
  });
});

describe('storing', () => {
  it('stores an update again after a failed write, so later ones are never stored without it', async () => {
    {
      const id = 'project-1' as ProjectId;
      const doc = new ReviewDoc();
      const persistence = new DocPersistence(storage, id, 'review', doc.doc, { retryMs: 20 });
      const append = storage.append.bind(storage);
      let fail = true;
      vi.spyOn(storage, 'append').mockImplementation(async (...args) => {
        if (fail) {
          fail = false;
          throw new DOMException('Full', 'QuotaExceededError');
        }
        return append(...args);
      });
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const author = { id: 'p1', name: 'Anna', color: 1 };
      for (const body of ['first', 'second', 'third']) {
        doc.add({ kind: 'comment', anchor: null, path: null, quote: '', replacement: null, plain: null, body, author, pdf: null });
        await persistence.flush();
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
      await persistence.flush();
      const loaded = new ReviewDoc();
      Y.applyUpdate(loaded.doc, (await storage.load(id, 'review'))!);
      expect(loaded.threads().map((thread) => thread.body)).toEqual(['first', 'second', 'third']);
      vi.restoreAllMocks();
    }
  });
});

describe('review files from someone else', () => {
  const zip = (manifest: unknown): Uint8Array =>
    zipSync({ 'scribetex-review.json': strToU8(JSON.stringify(manifest)), 'review.ydoc': new ReviewDoc().encode(), 'mirror.ydoc': Y.encodeStateAsUpdate(new Y.Doc()) });
  const base = { format: 'scribetex-review', version: 1, kind: 'review-copy', reviewId: 'r1', project: 'Paper', createdAt: 1, mainFile: 'main.tex', workDir: '', knownPaths: [] };

  it('reads odd manifests safely', () => {
    expect(readReviewFile(zip({ ...base, from: undefined })).manifest.from).toEqual({ id: 'unknown', name: 'Someone', color: 0 });
    expect(readReviewFile(zip({ ...base, from: { id: 'x', name: { first: 'A' }, color: 3 } })).manifest.from.name).toBe('Someone');
    expect(readReviewFile(zip({ ...base, from: { id: 'x', name: 'Eve', color: '0); background: url(https://example.com/' } })).manifest.from.color).toBe(0);
    expect(readReviewFile(zip({ ...base, project: { title: 'Paper' }, from: { id: 'x', name: 'Eve', color: 1 } })).manifest.project).toBe('Untitled');
    expect(() => readReviewFile(zip({ ...base, kind: 'other' }))).toThrow(ReviewFileError);
  });

  it('shows odd comments as text', () => {
    const doc = new Y.Doc();
    const map = new Y.Map<unknown>();
    doc.getMap('threads').set('t1', map);
    map.set('kind', 'comment');
    map.set('body', 42);
    map.set('quote', { evil: true });
    map.set('author', { id: 'x', name: 'Eve', color: 99 });
    const replies = new Y.Array<unknown>();
    map.set('replies', replies);
    replies.push([{ id: 'c1', text: 'ok', author: 'nobody', at: 'soon' }, 'junk']);
    const review = new ReviewDoc(doc);
    const [thread] = review.threads();
    expect(thread).toMatchObject({ body: '', quote: '', author: { name: 'Eve', color: 0 } });
    expect(thread!.replies).toEqual([{ id: 'c1', text: 'ok', author: { id: 'unknown', name: 'Someone', color: 0 }, at: 0 }]);
  });

  it('does not open an older review copy over a newer one', async () => {
    const id = await project({ 'main.tex': 'The method works well. The results are good.' });
    const author = await openTab(id);
    const make = async () => (await author.session.reviewCopy({ projectName: 'Paper', pdf: null, synctex: null, mainFile: 'main.tex', knownPaths: ['main.tex'], workDir: '', siteUrl: 'https://example.com/' })).bytes;
    const older = await make();
    await new Promise((resolve) => setTimeout(resolve, 5));
    author.type('main.tex', { from: 0, to: 0, insert: 'In this paper we propose a new method. ' });
    const newer = await make();
    const services = { vault, reviews: storage } as unknown as Services;
    const opened = await openReviewFile(services, newer);
    expect(opened.kind).toBe('copy');
    await expect(openReviewFile(services, older)).rejects.toThrow(/older review copy/);
    if (opened.kind !== 'copy') throw new Error('not a copy');
    expect(await vault.readText(opened.projectId, 'main.tex')).toBe('In this paper we propose a new method. The method works well. The results are good.');
  });
});
