/**
 * Reads what a user dropped onto the page, including whole folders, into
 * memory. `collectDropped` must be called synchronously from the drop event;
 * browsers empty the DataTransfer as soon as the handler returns.
 */
export interface DroppedFile {
  /** File name, or a relative path when it came out of a dropped folder. */
  name: string;
  bytes: Uint8Array;
}

export interface DroppedResult {
  files: DroppedFile[];
  /** Why something was left out, in sentences for the user. */
  notes: string[];
}

const SKIP_NAMES = new Set(['.git', 'node_modules', '.DS_Store', 'Thumbs.db', '__MACOSX']);
const MAX_FILES = 2000;
const MAX_TOTAL_BYTES = 300 * 1024 * 1024;

type Entry = FileSystemEntry;

function readAll(directory: FileSystemDirectoryEntry): Promise<Entry[]> {
  const reader = directory.createReader();
  const all: Entry[] = [];
  return new Promise((resolve, reject) => {
    const next = (): void =>
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(all);
        else {
          all.push(...batch);
          next();
        }
      }, reject);
    next();
  });
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

export function collectDropped(transfer: DataTransfer): () => Promise<DroppedResult> {
  const entries: Entry[] = [];
  const loose: File[] = [];
  for (const item of Array.from(transfer.items)) {
    if (item.kind !== 'file') continue;
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
    if (entry) entries.push(entry);
    else {
      const file = item.getAsFile();
      if (file) loose.push(file);
    }
  }

  return async () => {
    const files: DroppedFile[] = [];
    const notes: string[] = [];
    let total = 0;
    let truncated = false;

    const add = async (name: string, file: File): Promise<void> => {
      if (files.length >= MAX_FILES || total + file.size > MAX_TOTAL_BYTES) {
        truncated = true;
        return;
      }
      total += file.size;
      files.push({ name, bytes: new Uint8Array(await file.arrayBuffer()) });
    };

    const walk = async (entry: Entry, prefix: string): Promise<void> => {
      if (truncated || SKIP_NAMES.has(entry.name)) return;
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isFile) await add(name, await fileOf(entry as FileSystemFileEntry));
      else if (entry.isDirectory) {
        for (const child of await readAll(entry as FileSystemDirectoryEntry)) await walk(child, name);
      }
    };

    for (const entry of entries) await walk(entry, '');
    for (const file of loose) await add(file.name, file);
    if (truncated) notes.push(`Only the first ${files.length} files were added, because the drop was very large.`);
    return { files, notes };
  };
}
