/**
 * ZIP export and import. A ZIP is the one backup that works in every browser
 * and needs no permission, so it is always available.
 */
import { unzipSync, zipSync, type Zippable } from 'fflate';
import { isBuildArtifact } from '../latex/deps';
import { tryNormalizePath } from '../paths';
import type { Path, ProjectId } from '../types';
import type { Vault } from '../vault/vault';

export interface ExportOptions {
  /** Leave out .aux, .log and other files the compiler regenerates. Default true. */
  skipBuildArtifacts?: boolean;
  /** Extra files to add, for example the compiled PDF. */
  extra?: { path: Path; bytes: Uint8Array }[];
}

/** Packs a project into a ZIP. Empty folders are kept. */
export async function exportProjectZip(vault: Vault, projectId: ProjectId, options: ExportOptions = {}): Promise<Uint8Array> {
  const skip = options.skipBuildArtifacts ?? true;
  const tree: Zippable = {};
  for (const entry of await vault.list(projectId)) {
    if (entry.kind === 'dir') {
      tree[`${entry.path}/`] = new Uint8Array(0);
    } else if (!(skip && isBuildArtifact(entry.path))) {
      tree[entry.path] = [await vault.readBytes(projectId, entry.path), { mtime: entry.mtime }];
    }
  }
  for (const file of options.extra ?? []) tree[file.path] = file.bytes;
  return zipSync(tree, { level: 6 });
}

export interface ImportedFile {
  path: Path;
  bytes: Uint8Array;
}

export interface ZipContents {
  files: ImportedFile[];
  dirs: Path[];
  /** Entries that were left out, with the reason. */
  skipped: { name: string; reason: string }[];
}

const JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$|\.git\/)/;

/**
 * Reads a ZIP into files and folders with safe project paths.
 *
 * A single top-level folder is stripped, because that is how most tools pack
 * a project ("thesis/main.tex" becomes "main.tex"). Entries whose names would
 * escape the project or are not valid on common systems are skipped and
 * reported, never silently renamed.
 */
export function readZip(zipBytes: Uint8Array, options: { maxBytes?: number } = {}): ZipContents {
  const maxBytes = options.maxBytes ?? 500 * 1024 * 1024;
  const raw = unzipSync(zipBytes);
  const skipped: ZipContents['skipped'] = [];
  const kept: { name: string; bytes: Uint8Array; dir: boolean }[] = [];
  let total = 0;
  for (const [name, bytes] of Object.entries(raw)) {
    if (JUNK.test(name)) continue;
    total += bytes.length;
    if (total > maxBytes) throw new Error('The ZIP is larger than this app accepts when unpacked.');
    kept.push({ name, bytes, dir: name.endsWith('/') });
  }

  const tops = new Set(kept.map((item) => item.name.split('/')[0]));
  const strip = tops.size === 1 && kept.every((item) => item.name.includes('/')) ? `${[...tops][0]}/` : '';

  const files: ImportedFile[] = [];
  const dirs: Path[] = [];
  for (const item of kept) {
    const relative = item.name.slice(strip.length).replace(/\/+$/, '');
    if (relative === '') continue;
    const path = tryNormalizePath(relative);
    if (path === null) {
      skipped.push({ name: item.name, reason: 'The name is not allowed in a project.' });
      continue;
    }
    if (item.dir) dirs.push(path);
    else files.push({ path, bytes: item.bytes });
  }
  return { files, dirs, skipped };
}

/** Creates a new project from the contents of a ZIP. An existing project is never touched. */
export async function importZipAsProject(
  vault: Vault,
  name: string,
  zipBytes: Uint8Array,
): Promise<{ projectId: ProjectId; skipped: ZipContents['skipped']; fileCount: number }> {
  const contents = readZip(zipBytes);
  const project = await vault.createProject({ name });
  for (const dir of contents.dirs) await vault.mkdir(project.id, dir, { origin: 'import' });
  await vault.writeMany(
    project.id,
    contents.files.map((file) => ({ path: file.path, bytes: file.bytes })),
    { origin: 'import' },
  );
  return { projectId: project.id, skipped: contents.skipped, fileCount: contents.files.length };
}
