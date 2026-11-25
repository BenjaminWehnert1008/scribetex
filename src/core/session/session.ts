/**
 * One open project: the text buffers being edited and the machinery that
 * makes sure they reach the vault.
 *
 * Saving is automatic. An edit is written to the vault a short moment after
 * typing pauses (`debounceMs`) and no later than `maxWaitMs` after the first
 * unsaved keystroke, so a long burst of typing is still saved every couple of
 * seconds. When the page is hidden or closed, unsaved text goes to the
 * synchronous journal first and is then flushed.
 */
import { sha256Hex, encodeText } from '../hash';
import { Emitter, Store } from '../store';
import type { Hash, Millis, Path, ProjectId } from '../types';
import type { Vault } from '../vault/vault';
import { Journal } from './journal';

export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'failed';

export interface SaveState {
  status: SaveStatus;
  /** Number of buffers with changes that have not reached the vault. */
  unsavedCount: number;
  lastSavedAt: Millis | null;
  /** Why the last save failed, for example because the storage is full. */
  error: string | null;
}

interface Buffer {
  text: string;
  /** Hash of the file in the vault that this buffer was loaded from or last saved as. */
  baseHash: Hash | null;
  dirty: boolean;
  /** Counts edits, so a save knows whether newer text arrived while it ran. */
  revision: number;
}

export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface SessionOptions {
  now?: () => Millis;
  timers?: Timers;
  journal?: Journal;
  debounceMs?: number;
  maxWaitMs?: number;
}

const realTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class ProjectSession {
  readonly projectId: ProjectId;
  readonly saveState = new Store<SaveState>({ status: 'saved', unsavedCount: 0, lastSavedAt: null, error: null });
  /** Fires after buffers were written to the vault. */
  readonly saved = new Emitter<{ paths: Path[] }>();
  readonly #vault: Vault;
  readonly #now: () => Millis;
  readonly #timers: Timers;
  readonly #journal: Journal;
  readonly #debounceMs: number;
  readonly #maxWaitMs: number;
  readonly #buffers = new Map<Path, Buffer>();
  #debounce: unknown = null;
  #deadline: unknown = null;
  #flushing: Promise<void> | null = null;
  #closed = false;

  constructor(vault: Vault, projectId: ProjectId, options: SessionOptions = {}) {
    this.#vault = vault;
    this.projectId = projectId;
    this.#now = options.now ?? Date.now;
    this.#timers = options.timers ?? realTimers;
    this.#journal = options.journal ?? new Journal(null);
    this.#debounceMs = options.debounceMs ?? 400;
    this.#maxWaitMs = options.maxWaitMs ?? 2000;
  }

  /**
   * Replays journal entries left by a tab that was closed before its save
   * finished. An entry is applied only when the file in the vault is still
   * the version the edit was based on; otherwise the vault already holds
   * something newer and the entry is kept as a separate recovered file.
   * Returns the paths that were written.
   */
  async recover(): Promise<Path[]> {
    const written: Path[] = [];
    for (const entry of this.#journal.entries(this.projectId)) {
      const current = await this.#vault.stat(this.projectId, entry.path);
      const currentHash = current?.hash ?? null;
      const entryHash = await sha256Hex(encodeText(entry.text));
      if (currentHash === entryHash) {
        // The save did finish before the tab died.
      } else if (currentHash === entry.baseHash) {
        await this.#vault.writeText(this.projectId, entry.path, entry.text, { origin: 'journal' });
        written.push(entry.path);
      } else {
        const dir = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';
        const name = entry.path.slice(entry.path.lastIndexOf('/') + 1);
        const dot = name.lastIndexOf('.');
        const recoveredName = dot > 0 ? `${name.slice(0, dot)} (recovered)${name.slice(dot)}` : `${name} (recovered)`;
        const unique = await this.#vault.suggestName(this.projectId, dir, recoveredName);
        const target = dir ? `${dir}/${unique}` : unique;
        await this.#vault.writeText(this.projectId, target, entry.text, { origin: 'journal' });
        written.push(target);
      }
      this.#journal.remove(this.projectId, entry.path);
    }
    return written;
  }

  /** Loads a text file into a buffer, or returns the buffer that is already open. */
  async open(path: Path): Promise<string> {
    const existing = this.#buffers.get(path);
    if (existing) return existing.text;
    const entry = await this.#vault.stat(this.projectId, path);
    const text = await this.#vault.readText(this.projectId, path);
    this.#buffers.set(path, { text, baseHash: entry?.hash ?? null, dirty: false, revision: 0 });
    return text;
  }

  isOpen(path: Path): boolean {
    return this.#buffers.has(path);
  }

  /** The current text of an open buffer, including unsaved edits. */
  text(path: Path): string | undefined {
    return this.#buffers.get(path)?.text;
  }

  isDirty(path: Path): boolean {
    return this.#buffers.get(path)?.dirty ?? false;
  }

  /** Records an edit and schedules the save. */
  edit(path: Path, text: string): void {
    if (this.#closed) return;
    const buffer = this.#buffers.get(path);
    if (!buffer) throw new Error(`${path} is not open`);
    if (buffer.text === text) return;
    buffer.text = text;
    buffer.dirty = true;
    buffer.revision += 1;
    this.#publish();
    this.#schedule();
  }

  /**
   * Replaces the content of an open buffer with what is now in the vault,
   * after the file changed from outside (folder sync, restore). Unsaved edits
   * in the buffer are kept: the caller decides how to resolve that.
   */
  async reload(path: Path): Promise<{ text: string; hadUnsavedEdits: boolean } | null> {
    const buffer = this.#buffers.get(path);
    if (!buffer) return null;
    const entry = await this.#vault.stat(this.projectId, path);
    if (!entry || entry.kind !== 'file') return null;
    if (buffer.dirty) return { text: buffer.text, hadUnsavedEdits: true };
    buffer.text = await this.#vault.readText(this.projectId, path);
    buffer.baseHash = entry.hash;
    return { text: buffer.text, hadUnsavedEdits: false };
  }

  /** Forgets a buffer after saving it. */
  async close(path: Path): Promise<void> {
    if (this.#buffers.get(path)?.dirty) await this.flush();
    this.#buffers.delete(path);
    this.#publish();
  }

  /** Follows a rename or move of an open file. */
  renamed(from: Path, to: Path): void {
    for (const [path, buffer] of [...this.#buffers]) {
      if (path === from || path.startsWith(`${from}/`)) {
        this.#buffers.delete(path);
        this.#buffers.set(to + path.slice(from.length), buffer);
        this.#journal.remove(this.projectId, path);
      }
    }
  }

  /** Drops buffers of files that were deleted. Unsaved edits to them are discarded. */
  removed(paths: Path[]): void {
    for (const path of paths) {
      this.#buffers.delete(path);
      this.#journal.remove(this.projectId, path);
    }
    this.#publish();
  }

  /** Writes every unsaved buffer to the vault now. Safe to call at any time. */
  flush(): Promise<void> {
    this.#clearTimers();
    if (this.#flushing) {
      // A save is running. Chain another pass so edits made meanwhile are covered.
      return this.#flushing.then(() => (this.#hasDirty() ? this.flush() : undefined));
    }
    if (!this.#hasDirty()) return Promise.resolve();
    this.#flushing = this.#writeDirty().finally(() => {
      this.#flushing = null;
    });
    return this.#flushing;
  }

  /**
   * Call from `pagehide` and when the page becomes hidden. Copies unsaved text
   * to the journal synchronously, then starts a normal save.
   */
  suspend(): void {
    for (const [path, buffer] of this.#buffers) {
      if (buffer.dirty) {
        this.#journal.write({ projectId: this.projectId, path, text: buffer.text, baseHash: buffer.baseHash, at: this.#now() });
      }
    }
    void this.flush().catch(() => undefined);
  }

  async dispose(): Promise<void> {
    await this.flush().catch(() => undefined);
    this.#closed = true;
    this.#clearTimers();
  }

  #hasDirty(): boolean {
    for (const buffer of this.#buffers.values()) if (buffer.dirty) return true;
    return false;
  }

  #schedule(): void {
    if (this.#debounce !== null) this.#timers.clear(this.#debounce);
    this.#debounce = this.#timers.set(() => void this.flush().catch(() => undefined), this.#debounceMs);
    this.#deadline ??= this.#timers.set(() => void this.flush().catch(() => undefined), this.#maxWaitMs);
  }

  #clearTimers(): void {
    if (this.#debounce !== null) this.#timers.clear(this.#debounce);
    if (this.#deadline !== null) this.#timers.clear(this.#deadline);
    this.#debounce = null;
    this.#deadline = null;
  }

  async #writeDirty(): Promise<void> {
    this.saveState.patch({ status: 'saving' });
    const written: Path[] = [];
    try {
      for (const [path, buffer] of [...this.#buffers]) {
        if (!buffer.dirty) continue;
        const revision = buffer.revision;
        const entry = await this.#vault.writeText(this.projectId, path, buffer.text, { origin: 'editor' });
        buffer.baseHash = entry.hash;
        // Text typed while the write was running stays unsaved.
        if (buffer.revision === revision) {
          buffer.dirty = false;
          this.#journal.remove(this.projectId, path);
        }
        written.push(path);
      }
      this.saveState.patch({ lastSavedAt: this.#now(), error: null });
    } catch (error) {
      this.saveState.set({
        status: 'failed',
        unsavedCount: this.#countDirty(),
        lastSavedAt: this.saveState.get().lastSavedAt,
        error: describeSaveError(error),
      });
      if (written.length > 0) this.saved.emit({ paths: written });
      throw error;
    }
    this.#publish();
    if (written.length > 0) this.saved.emit({ paths: written });
    if (this.#hasDirty()) this.#schedule();
  }

  #countDirty(): number {
    let count = 0;
    for (const buffer of this.#buffers.values()) if (buffer.dirty) count += 1;
    return count;
  }

  #publish(): void {
    const unsavedCount = this.#countDirty();
    const previous = this.saveState.get();
    if (previous.status === 'failed' && unsavedCount > 0) {
      this.saveState.patch({ unsavedCount });
      return;
    }
    this.saveState.patch({ status: unsavedCount > 0 ? 'unsaved' : 'saved', unsavedCount });
  }
}

export function describeSaveError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'QuotaExceededError') return 'The browser storage is full. Free space or export the project.';
  return error instanceof Error ? error.message : String(error);
}
