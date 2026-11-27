/**
 * Templates by other authors, under open licenses, listed in
 * community-templates/sources.json and copied into public/templates/ by
 * `npm run templates`. The site serves them itself, so making a project from
 * one sends nothing to another server. Each file list ends with
 * TEMPLATE-LICENSE.txt, which names the source and carries the license text.
 */
import type { Path } from '../core/types';

export interface CommunityTemplate {
  id: string;
  name: string;
  category: string;
  description: string;
  author: string;
  license: { spdx: string; name: string };
  /** The template's folder in its repository, at the pinned commit. */
  source: string;
  main: Path;
  files: { path: Path; bytes: number }[];
  /** A picture of the first page, relative to the template's folder. */
  preview: string | null;
  /** TeX Live packages beyond the base set that the template needs. */
  packages: string[];
}

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }>;

const BASE = './templates/';

const defaultFetch: Fetch = (url) => fetch(url, { cache: 'no-cache' });

function urlOf(...parts: string[]): string {
  return BASE + parts.flatMap((part) => part.split('/')).map(encodeURIComponent).join('/');
}

export function previewUrl(template: CommunityTemplate): string | null {
  return template.preview ? urlOf(template.id, template.preview) : null;
}

function isTemplate(value: unknown): value is CommunityTemplate {
  const t = value as CommunityTemplate;
  return (
    typeof t === 'object' &&
    t !== null &&
    typeof t.id === 'string' &&
    typeof t.name === 'string' &&
    typeof t.main === 'string' &&
    Array.isArray(t.files) &&
    t.files.every((file) => typeof file?.path === 'string') &&
    typeof t.license?.spdx === 'string'
  );
}

/** The list of community templates. Throws when the list cannot be read (for example offline). */
export async function loadCommunityTemplates(fetchImpl: Fetch = defaultFetch): Promise<CommunityTemplate[]> {
  const response = await fetchImpl(urlOf('index.json'));
  if (!response.ok) throw new Error(`The template list could not be loaded (${response.status}).`);
  const data = (await response.json()) as { templates?: unknown };
  if (!Array.isArray(data.templates)) throw new Error('The template list is not in the expected format.');
  return data.templates.filter(isTemplate);
}

/** Downloads every file of a template from this site. */
export async function loadCommunityFiles(
  template: CommunityTemplate,
  onProgress?: (done: number, total: number) => void,
  fetchImpl: Fetch = defaultFetch,
): Promise<{ path: Path; bytes: Uint8Array }[]> {
  const files: { path: Path; bytes: Uint8Array }[] = [];
  for (const file of template.files) {
    const response = await fetchImpl(urlOf(template.id, 'files', file.path));
    if (!response.ok) throw new Error(`${file.path} could not be loaded (${response.status}).`);
    files.push({ path: file.path, bytes: new Uint8Array(await response.arrayBuffer()) });
    onProgress?.(files.length, template.files.length);
  }
  return files;
}
