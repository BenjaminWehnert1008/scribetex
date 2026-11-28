/** Turns a Word file into a new project in the vault. Nothing leaves the browser. */
import type { ProjectId } from '../types';
import type { Vault } from '../vault/vault';
import { convertDocx, type ConvertedProject, type ConvertOptions } from './convert';

export { DocxError, type ConvertedProject, type ImportSummary } from './convert';

/** Larger files are almost always full of pictures; this keeps the tab responsive. */
export const MAX_DOCX_BYTES = 200 * 1024 * 1024;

export async function importDocxAsProject(
  vault: Vault,
  bytes: Uint8Array,
  options: ConvertOptions = {},
): Promise<{ projectId: ProjectId; result: ConvertedProject }> {
  // Everything is converted first, so a file that cannot be read leaves no half-made project behind.
  const result = await convertDocx(bytes, options);
  const project = await vault.createProject({ name: result.name, mainFile: result.mainFile });
  try {
    for (const dir of result.dirs) await vault.mkdir(project.id, dir, { origin: 'import' });
    await vault.writeMany(project.id, result.files, { origin: 'import' });
  } catch (error) {
    await vault.deleteProject(project.id).catch(() => undefined);
    throw error;
  }
  return { projectId: project.id, result };
}
