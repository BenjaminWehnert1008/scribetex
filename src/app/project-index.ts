/**
 * What the editor needs to know about the whole project: the outline, the
 * labels and citation keys for completion, and the file list.
 */
import { decodeText } from '@/core/hash';
import { scanBibKeys, scanDependencies, scanLabels, scanOutline, type OutlineItem } from '@/core/latex/deps';
import { extname } from '@/core/paths';
import type { ProjectSession } from '@/core/session/session';
import type { FileEntry, Path, ProjectId } from '@/core/types';
import type { Vault } from '@/core/vault/vault';

export interface ProjectIndex {
  outline: OutlineItem[];
  labels: { name: string; file: Path; line: number }[];
  bibKeys: { key: string; title: string | null; file: Path }[];
  files: Path[];
}

const MAX_SCAN_BYTES = 2 * 1024 * 1024;

export async function buildProjectIndex(
  vault: Vault,
  session: ProjectSession,
  projectId: ProjectId,
  entries: FileEntry[],
  mainFile: Path | null,
): Promise<ProjectIndex> {
  const files = entries.filter((entry) => entry.kind === 'file');
  const paths = files.map((entry) => entry.path);
  const sources = new Map<Path, string>();
  for (const entry of files) {
    const ext = extname(entry.path).toLowerCase();
    if (!entry.text || entry.size > MAX_SCAN_BYTES || !['.tex', '.bib', '.sty', '.cls'].includes(ext)) continue;
    // Unsaved text in an open buffer is newer than the vault.
    sources.set(entry.path, session.text(entry.path) ?? decodeText(await vault.readBytes(projectId, entry.path)));
  }

  // Walk the include tree from the main file so the outline reads in document order.
  const order: Path[] = [];
  const seen = new Set<Path>();
  const visit = (path: Path): void => {
    if (seen.has(path)) return;
    seen.add(path);
    order.push(path);
    const source = sources.get(path);
    if (source === undefined) return;
    for (const ref of scanDependencies(source, { from: path, files: paths })) {
      if (ref.resolved && ['input', 'include', 'subfile', 'import'].includes(ref.command) && sources.has(ref.resolved)) visit(ref.resolved);
    }
  };
  if (mainFile && sources.has(mainFile)) visit(mainFile);
  for (const path of [...sources.keys()].sort()) if (extname(path) === '.tex') visit(path);

  const outline: OutlineItem[] = [];
  const labels: ProjectIndex['labels'] = [];
  const bibKeys: ProjectIndex['bibKeys'] = [];
  for (const path of order) {
    const source = sources.get(path);
    if (source === undefined || extname(path) !== '.tex') continue;
    outline.push(...scanOutline(source, path));
    for (const label of scanLabels(source)) labels.push({ ...label, file: path });
  }
  for (const [path, source] of sources) {
    if (extname(path) === '.bib') for (const item of scanBibKeys(source)) bibKeys.push({ key: item.key, title: item.title, file: path });
  }
  return { outline, labels, bibKeys, files: paths };
}
