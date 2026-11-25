/**
 * The emergency journal: a synchronous last-resort copy of unsaved text.
 *
 * Writes to IndexedDB are asynchronous and a browser may kill a tab before
 * they finish. `localStorage.setItem` is synchronous, so text written there in
 * the `pagehide` handler survives. On the next start the journal is replayed
 * into the vault and cleared.
 */
import type { Hash, Millis, Path, ProjectId } from '../types';

export interface JournalEntry {
  projectId: ProjectId;
  path: Path;
  text: string;
  /** Hash of the file in the vault when the unsaved edit was made; null for a file that had none. */
  baseHash: Hash | null;
  at: Millis;
}

/** The subset of `Storage` the journal needs. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

const PREFIX = 'latex-editor:journal:';

function keyOf(projectId: ProjectId, path: Path): string {
  return `${PREFIX}${projectId}:${path}`;
}

export class Journal {
  readonly #storage: KeyValueStorage | null;

  constructor(storage: KeyValueStorage | null) {
    this.#storage = storage;
  }

  /** Stores an entry. Returns false when the storage is missing or full; never throws. */
  write(entry: JournalEntry): boolean {
    if (!this.#storage) return false;
    try {
      this.#storage.setItem(keyOf(entry.projectId, entry.path), JSON.stringify(entry));
      return true;
    } catch {
      return false;
    }
  }

  remove(projectId: ProjectId, path: Path): void {
    try {
      this.#storage?.removeItem(keyOf(projectId, path));
    } catch {
      // Nothing to do: a stale entry is checked against the vault before it is replayed.
    }
  }

  /** All entries of one project, oldest first. Unreadable entries are dropped. */
  entries(projectId: ProjectId): JournalEntry[] {
    const storage = this.#storage;
    if (!storage) return [];
    const found: JournalEntry[] = [];
    const prefix = `${PREFIX}${projectId}:`;
    try {
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (!key?.startsWith(prefix)) continue;
        const raw = storage.getItem(key);
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw) as JournalEntry;
          if (parsed.projectId === projectId && typeof parsed.path === 'string' && typeof parsed.text === 'string') {
            found.push(parsed);
          }
        } catch {
          storage.removeItem(key);
        }
      }
    } catch {
      return [];
    }
    return found.sort((a, b) => a.at - b.at);
  }
}

/** `localStorage` when the browser allows it, otherwise null. */
export function browserJournalStorage(): KeyValueStorage | null {
  try {
    const storage = globalThis.localStorage;
    const probe = `${PREFIX}probe`;
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}
