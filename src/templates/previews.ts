/**
 * Pictures of the built-in templates' first pages, shown in the new-project
 * dialog. `npm run previews` (scripts/template-previews.mjs) compiles every
 * template and draws the pictures into previews/. It also writes
 * previews/previews.json, which records the version of each template that
 * its picture shows, so that a unit test notices a template that changed
 * without a new picture.
 */
import { encodeText, sha256Hex } from '../core/hash';
import { type Template, templateFileBytes } from './index';

const pictures = import.meta.glob<string>('./previews/*.jpg', { eager: true, query: '?url', import: 'default' });

/** The address of a built-in template's picture, or null for one that has none (Blank, whose page is empty). */
export function builtInPreview(id: string): string | null {
  return pictures[`./previews/${id}.jpg`] ?? null;
}

/** Identifies what a template puts into a new project: its main file and the content of every file. */
export async function templateFingerprint(template: Template): Promise<string> {
  const lines = [`main ${template.mainFile ?? ''}`];
  for (const file of template.files) lines.push(`file ${file.path} ${await sha256Hex(templateFileBytes(file))}`);
  return sha256Hex(encodeText(lines.sort().join('\n')));
}
