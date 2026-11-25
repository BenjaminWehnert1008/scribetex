import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { Vault } from '../vault/vault';
import { Journal, type KeyValueStorage } from './journal';
import { ProjectSession, type Timers } from './session';

class MemoryStorage implements KeyValueStorage {
  readonly map = new Map<string, string>();
  full = false;
  get length(): number {
    return this.map.size;
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.full) throw new DOMException('full', 'QuotaExceededError');
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
}

/** Timers that only fire when the test advances the clock. */
class ManualTimers implements Timers {
  now = 0;
  #next = 1;
  readonly #pending = new Map<number, { at: number; callback: () => void }>();
  set(callback: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#pending.set(id, { at: this.now + ms, callback });
    return id;
  }
  clear(handle: unknown): void {
    this.#pending.delete(handle as number);
  }
  advance(ms: number): void {
    this.now += ms;
    for (const [id, timer] of [...this.#pending]) {
      if (timer.at <= this.now) {
        this.#pending.delete(id);
        timer.callback();
      }
    }
  }
  get pending(): number {
    return this.#pending.size;
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

let vault: Vault;
let projectId: string;
let timers: ManualTimers;
let storage: MemoryStorage;
let session: ProjectSession;

function newSession(): ProjectSession {
  return new ProjectSession(vault, projectId, { timers, journal: new Journal(storage), now: () => timers.now });
}

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  vault = await Vault.open({ name: `session-${Math.random().toString(36).slice(2)}` });
  projectId = (await vault.createProject({ name: 'Thesis' })).id;
  await vault.writeText(projectId, 'main.tex', 'one');
  timers = new ManualTimers();
  storage = new MemoryStorage();
  session = newSession();
});

describe('autosave', () => {
  it('saves shortly after typing pauses', async () => {
    await session.open('main.tex');
    session.edit('main.tex', 'one two');
    expect(session.saveState.get()).toMatchObject({ status: 'unsaved', unsavedCount: 1 });
    timers.advance(399);
    await settle();
    expect(await vault.readText(projectId, 'main.tex')).toBe('one');
    timers.advance(1);
    await settle();
    expect(await vault.readText(projectId, 'main.tex')).toBe('one two');
    expect(session.saveState.get()).toMatchObject({ status: 'saved', unsavedCount: 0, lastSavedAt: 400 });
    expect(session.isDirty('main.tex')).toBe(false);
  });

  it('saves at least every two seconds during uninterrupted typing', async () => {
    await session.open('main.tex');
    for (let i = 0; i < 19; i++) {
      session.edit('main.tex', `typing ${i}`);
      timers.advance(100); // never pauses long enough for the debounce
    }
    await settle();
    expect(await vault.readText(projectId, 'main.tex')).toBe('one');
    session.edit('main.tex', 'typing 19');
    timers.advance(100); // 2000 ms since the first unsaved keystroke
    await settle();
    expect(await vault.readText(projectId, 'main.tex')).toBe('typing 19');
  });

  it('does not lose text typed while a save is running', async () => {
    await session.open('main.tex');
    session.edit('main.tex', 'first');
    const saving = session.flush();
    session.edit('main.tex', 'second');
    await saving;
    expect(session.isDirty('main.tex')).toBe(true);
    await session.flush();
    expect(await vault.readText(projectId, 'main.tex')).toBe('second');
    expect(session.isDirty('main.tex')).toBe(false);
  });

  it('ignores an edit that changes nothing and announces what it saved', async () => {
    await session.open('main.tex');
    session.edit('main.tex', 'one');
    expect(session.saveState.get().status).toBe('saved');
    expect(timers.pending).toBe(0);
    const events: string[][] = [];
    session.saved.on((event) => events.push(event.paths));
    session.edit('main.tex', 'changed');
    await session.flush();
    expect(events).toEqual([['main.tex']]);
  });

  it('reports a failed save and keeps the text for another try', async () => {
    await session.open('main.tex');
    session.edit('main.tex', 'important');
    const original = vault.writeText.bind(vault);
    vault.writeText = async () => {
      throw new DOMException('quota', 'QuotaExceededError');
    };
    await expect(session.flush()).rejects.toThrow();
    expect(session.saveState.get()).toMatchObject({ status: 'failed', unsavedCount: 1 });
    expect(session.saveState.get().error).toMatch(/storage is full/);
    vault.writeText = original;
    await session.flush();
    expect(await vault.readText(projectId, 'main.tex')).toBe('important');
    expect(session.saveState.get()).toMatchObject({ status: 'saved', error: null });
  });

  it('follows renames and forgets deleted files', async () => {
    await vault.writeText(projectId, 'chapters/a.tex', 'a');
    await session.open('chapters/a.tex');
    session.edit('chapters/a.tex', 'a2');
    await vault.move(projectId, 'chapters', 'parts');
    session.renamed('chapters', 'parts');
    await session.flush();
    expect(await vault.readText(projectId, 'parts/a.tex')).toBe('a2');
    expect(await vault.exists(projectId, 'chapters/a.tex')).toBe(false);

    session.edit('parts/a.tex', 'a3');
    await vault.remove(projectId, 'parts');
    session.removed(['parts/a.tex']);
    await session.flush();
    expect(await vault.exists(projectId, 'parts/a.tex')).toBe(false);
    expect(session.saveState.get().status).toBe('saved');
  });
});

describe('emergency journal', () => {
  it('recovers text from a tab that died before its save finished', async () => {
    await session.open('main.tex');
    session.edit('main.tex', 'unsaved words');
    // The page is being closed: the journal is written synchronously...
    const original = vault.writeText.bind(vault);
    vault.writeText = () => new Promise(() => undefined); // ...and the async save never completes.
    session.suspend();
    expect(storage.length).toBe(1);
    vault.writeText = original;

    const next = newSession();
    expect(await next.recover()).toEqual(['main.tex']);
    expect(await vault.readText(projectId, 'main.tex')).toBe('unsaved words');
    expect(storage.length).toBe(0);
  });

  it('clears the journal when the save did finish', async () => {
    await session.open('main.tex');
    session.edit('main.tex', 'saved in time');
    session.suspend();
    await settle();
    expect(await vault.readText(projectId, 'main.tex')).toBe('saved in time');
    expect(storage.length).toBe(0);
    expect(await newSession().recover()).toEqual([]);
  });

  it('keeps both versions when the file changed after the unsaved edit', async () => {
    await session.open('main.tex');
    session.edit('main.tex', 'from the dead tab');
    const original = vault.writeText.bind(vault);
    vault.writeText = () => new Promise(() => undefined);
    session.suspend();
    vault.writeText = original;
    await vault.writeText(projectId, 'main.tex', 'changed elsewhere');

    expect(await newSession().recover()).toEqual(['main (recovered).tex']);
    expect(await vault.readText(projectId, 'main.tex')).toBe('changed elsewhere');
    expect(await vault.readText(projectId, 'main (recovered).tex')).toBe('from the dead tab');
  });

  it('survives a full or missing localStorage', async () => {
    storage.full = true;
    await session.open('main.tex');
    session.edit('main.tex', 'still saved normally');
    session.suspend();
    await settle();
    expect(await vault.readText(projectId, 'main.tex')).toBe('still saved normally');
    const bare = new ProjectSession(vault, projectId, { timers });
    expect(await bare.recover()).toEqual([]);
  });
});
