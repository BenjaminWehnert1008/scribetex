/**
 * Decides what has to happen to bring a project in the browser and its linked
 * folder on disk back in step. This file is pure: it looks at three listings
 * and returns a list of actions. Reading and writing is done by `sync.ts`.
 *
 * The three listings are the project as it is in the browser (`vault`), the
 * folder as it is on disk (`disk`), and both as they were when they last
 * agreed (`base`). Comparing each side with the base tells which side changed:
 *
 *   only the folder changed   the change is taken into the browser
 *   only the browser changed  the change is written to the folder
 *   both changed a file       both versions are kept, the folder's under a new name
 *   one deleted, one edited   the edit wins
 */
import { isBuildArtifact } from '../latex/deps';
import { ancestors, basename, dirname, joinPath, stem, uniqueName, validateName } from '../paths';
import type { EntryKind, Hash, Path } from '../types';

/** What one side holds at a path. Folders have no hash. */
export interface Stamp {
  kind: EntryKind;
  hash: Hash | null;
}

export type SyncAction =
  /** Write the browser's file to the folder, or create the folder there. */
  | { type: 'to-disk'; path: Path; kind: EntryKind }
  /** Take the folder's file into the browser, or create the folder there. */
  | { type: 'to-vault'; path: Path; kind: EntryKind }
  | { type: 'remove-disk'; path: Path; kind: EntryKind }
  | { type: 'remove-vault'; path: Path; kind: EntryKind }
  /** Both sides changed the file: the browser's stays at `path`, the folder's is kept as `copyPath`. */
  | { type: 'conflict'; path: Path; copyPath: Path }
  /** Both sides already agree; only the record of that has to be updated. */
  | { type: 'settle'; path: Path }
  /** Gone on both sides; the record is dropped. */
  | { type: 'forget'; path: Path }
  /** A file on one side and a folder on the other. Left alone and reported. */
  | { type: 'blocked'; path: Path; reason: string };

export interface SyncPlan {
  actions: SyncAction[];
  /**
   * Set when the folder is missing so many of the project's files that it
   * looks like an accident (the folder was emptied, moved or is a different
   * one). The deletions are then not part of `actions`.
   */
  guard: { missing: Path[] } | null;
}

export interface PlanInput {
  vault: ReadonlyMap<Path, Stamp>;
  disk: ReadonlyMap<Path, Stamp>;
  base: ReadonlyMap<Path, Stamp>;
  /**
   * What to do when the guard would trigger: 'ask' leaves the deletions out
   * and reports them, 'apply' deletes the files in the browser as well, and
   * 'restore' writes them back into the folder.
   */
  massDeletion?: 'ask' | 'apply' | 'restore';
}

const GUARD_MIN_FILES = 5;
const GUARD_SHARE = 0.3;

function same(a: Stamp | undefined, b: Stamp | undefined): boolean {
  if (!a || !b) return a === b;
  return a.kind === b.kind && a.hash === b.hash;
}

const depth = (path: Path): number => path.split('/').length;

export function planSync(input: PlanInput): SyncPlan {
  const { vault, disk, base } = input;
  const byPath = new Map<Path, SyncAction>();
  const taken = new Set<Path>([...vault.keys(), ...disk.keys()]);

  for (const path of new Set([...vault.keys(), ...disk.keys(), ...base.keys()])) {
    const v = vault.get(path);
    const d = disk.get(path);
    const b = base.get(path);

    if (same(v, d)) {
      if (!v) byPath.set(path, { type: 'forget', path });
      else if (!same(v, b)) byPath.set(path, { type: 'settle', path });
      continue;
    }
    if (v && d && v.kind !== d.kind) {
      byPath.set(path, {
        type: 'blocked',
        path,
        reason: `"${path}" is a ${v.kind === 'dir' ? 'folder' : 'file'} in the project and a ${d.kind === 'dir' ? 'folder' : 'file'} on disk. Rename one of them.`,
      });
      continue;
    }

    const vaultChanged = !same(v, b);
    const diskChanged = !same(d, b);
    if (diskChanged && !vaultChanged) {
      byPath.set(path, d ? { type: 'to-vault', path, kind: d.kind } : { type: 'remove-vault', path, kind: v!.kind });
    } else if (vaultChanged && !diskChanged) {
      byPath.set(path, v ? { type: 'to-disk', path, kind: v.kind } : { type: 'remove-disk', path, kind: d!.kind });
    } else if (!v) {
      // Deleted here, edited there (or new there): the content wins.
      byPath.set(path, { type: 'to-vault', path, kind: d!.kind });
    } else if (!d) {
      byPath.set(path, { type: 'to-disk', path, kind: v.kind });
    } else {
      const siblings = [...taken].filter((other) => dirname(other) === dirname(path)).map((other) => basename(other));
      // The extension is taken from the name itself, so its spelling is kept.
      const name = uniqueName(siblings, `${stem(path)} (folder copy)${basename(path).slice(stem(path).length)}`);
      const copyPath = joinPath(dirname(path), name);
      taken.add(copyPath);
      byPath.set(path, { type: 'conflict', path, copyPath });
    }
  }

  // The accident guard, before anything depends on the deletions.
  const vaultFiles = [...vault.values()].filter((stamp) => stamp.kind === 'file').length;
  const missing = [...byPath.values()].filter((action) => action.type === 'remove-vault' && action.kind === 'file').map((action) => action.path);
  const diskFiles = [...disk.values()].filter((stamp) => stamp.kind === 'file').length;
  const looksAccidental =
    missing.length > 0 && ((missing.length >= GUARD_MIN_FILES && missing.length > vaultFiles * GUARD_SHARE) || (diskFiles === 0 && missing.length === vaultFiles));
  let guard: SyncPlan['guard'] = null;
  if (looksAccidental && input.massDeletion !== 'apply') {
    for (const action of [...byPath.values()]) {
      if (action.type !== 'remove-vault') continue;
      if (input.massDeletion === 'restore') byPath.set(action.path, { type: 'to-disk', path: action.path, kind: action.kind });
      else byPath.delete(action.path);
    }
    if (input.massDeletion !== 'restore') guard = { missing: missing.sort() };
  }

  // A folder must not be removed while something inside it is kept.
  for (const action of [...byPath.values()]) {
    const survives =
      action.type === 'to-disk' || action.type === 'to-vault' || action.type === 'conflict' || action.type === 'settle' || action.type === 'blocked';
    if (!survives) continue;
    for (const parent of ancestors(action.path)) {
      const planned = byPath.get(parent);
      if (planned?.type === 'remove-vault') byPath.set(parent, { type: 'to-disk', path: parent, kind: 'dir' });
      else if (planned?.type === 'remove-disk') byPath.set(parent, { type: 'to-vault', path: parent, kind: 'dir' });
    }
  }
  // Files that are simply unchanged on both sides keep their folders too.
  for (const path of vault.keys()) {
    if (byPath.has(path) || !disk.has(path)) continue;
    for (const parent of ancestors(path)) {
      const planned = byPath.get(parent);
      if (planned?.type === 'remove-vault') byPath.set(parent, { type: 'to-disk', path: parent, kind: 'dir' });
      else if (planned?.type === 'remove-disk') byPath.set(parent, { type: 'to-vault', path: parent, kind: 'dir' });
    }
  }

  // Create outer folders first, delete inner entries first.
  const removal = (action: SyncAction): boolean => action.type === 'remove-disk' || action.type === 'remove-vault' || action.type === 'forget';
  const actions = [...byPath.values()].sort((a, b) => {
    if (removal(a) !== removal(b)) return removal(a) ? 1 : -1;
    const order = removal(a) ? depth(b.path) - depth(a.path) : depth(a.path) - depth(b.path);
    return order || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  });
  return { actions, guard };
}

// ---- what is left out of the folder sync ------------------------------------

const IGNORED_FOLDERS = new Set(['.git', '.svn', '.hg', 'node_modules', '__MACOSX', '.idea', '.vscode', '.Trash', '$RECYCLE.BIN', 'System Volume Information']);
const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.directory']);

/**
 * Why an entry found on disk is not taken into the project, or null when it
 * is. `known` says whether the project already contains the path; a file that
 * the user deliberately added is never ignored for being a build file.
 */
export function ignoreReason(path: Path, kind: EntryKind, known: boolean): 'system' | 'temporary' | 'build' | 'name' | null {
  const segments = path.split('/');
  const name = segments.at(-1)!;
  if (segments.some((segment, index) => (index < segments.length - 1 || kind === 'dir') && IGNORED_FOLDERS.has(segment))) return 'system';
  if (kind === 'file') {
    if (IGNORED_FILES.has(name)) return 'system';
    // Editors and browsers park half-written files under such names.
    if (/^~\$|^\.~lock\.|^\._|~$|\.sw[po]$|\.tmp$|\.crswap$|\.crdownload$|\.part$/.test(name)) return 'temporary';
    if (!known && isBuildArtifact(path)) return 'build';
  }
  if (segments.some((segment) => validateName(segment) !== null)) return 'name';
  return null;
}
