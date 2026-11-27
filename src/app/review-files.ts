/**
 * Opening review files outside a project: a review copy becomes (or updates)
 * a project to comment on, and a comments file goes into the project it
 * belongs to.
 */
import { type CommentsFile, readReviewFile, type ReviewCopy, ReviewFileError } from '@/core/review/package';
import { type MergeSummary, ReviewDoc } from '@/core/review/review-doc';
import type { ProjectId, ProjectMeta } from '@/core/types';
import * as Y from 'yjs';
import type { Services } from './services';

export type OpenedReviewFile =
  | { kind: 'copy'; projectId: ProjectId; updated: boolean; from: string }
  | { kind: 'comments'; projectId: ProjectId; summary: MergeSummary };

export async function openReviewFile(services: Services, bytes: Uint8Array): Promise<OpenedReviewFile> {
  const file = readReviewFile(bytes);
  return file.manifest.kind === 'review-copy' ? openCopy(services, file as ReviewCopy) : importComments(services, file as CommentsFile);
}

async function openCopy(services: Services, copy: ReviewCopy): Promise<OpenedReviewFile> {
  const { vault, reviews } = services;
  const { manifest } = copy;
  const known = await vault.getSetting<ProjectId | null>(`review:copy:${manifest.reviewId}`, null);
  const existing = known ? await vault.getProject(known) : undefined;
  const now = Date.now();
  const meta = {
    reviewId: manifest.reviewId,
    from: manifest.from,
    project: manifest.project,
    sentAt: manifest.createdAt,
    receivedAt: now,
  };

  let project: ProjectMeta;
  if (existing?.reviewCopy) {
    project = existing;
  } else {
    project = await vault.createProject({ name: `${manifest.project} (review)`, mainFile: manifest.mainFile });
    await vault.setSetting(`review:copy:${manifest.reviewId}`, project.id);
  }

  // The files as the author sent them, replacing an older version.
  const keep = new Set(copy.files.map((file) => file.path));
  for (const entry of await vault.list(project.id)) {
    if (entry.kind === 'file' && !keep.has(entry.path)) await vault.remove(project.id, entry.path, { origin: 'import' }).catch(() => undefined);
  }
  for (const file of copy.files) await vault.writeText(project.id, file.path, file.text, { origin: 'import' });
  await vault.updateProject(project.id, { reviewCopy: meta, mainFile: manifest.mainFile, autoCompile: false });

  // Stored updates merge when the project is opened, so appending is enough.
  await reviews.append(project.id, 'mirror', copy.mirror);
  await reviews.append(project.id, 'review', copy.review);
  await reviews.putCopy({
    projectId: project.id,
    pdf: copy.pdf,
    synctex: copy.synctex,
    knownPaths: manifest.knownPaths,
    workDir: manifest.workDir,
    mainFile: manifest.mainFile,
  });
  return { kind: 'copy', projectId: project.id, updated: Boolean(existing?.reviewCopy), from: manifest.from.name };
}

/** The project in this browser that a review id belongs to: the author's own first, else a review copy. */
export async function findReviewProject(services: Services, reviewId: string): Promise<ProjectId | null> {
  const { vault, reviews } = services;
  for (const key of [`review:authored:${reviewId}`, `review:copy:${reviewId}`]) {
    const id = await vault.getSetting<ProjectId | null>(key, null);
    if (id && (await vault.getProject(id))) return id;
  }
  // Made in another browser of the same person, perhaps: look into every project's comments.
  for (const project of await vault.listProjects()) {
    const stored = await reviews.load(project.id, 'review');
    if (!stored) continue;
    const doc = new ReviewDoc(new Y.Doc());
    Y.applyUpdate(doc.doc, stored);
    if (doc.hasReviewId() && doc.reviewId() === reviewId) return project.id;
  }
  return null;
}

async function importComments(services: Services, file: CommentsFile): Promise<OpenedReviewFile> {
  const projectId = await findReviewProject(services, file.manifest.reviewId);
  if (!projectId) {
    throw new ReviewFileError(
      `These comments from ${file.manifest.from.name} belong to "${file.manifest.project}", which is not in this browser. Open the browser you sent the review copy from, or restore the project here first.`,
    );
  }
  const doc = new ReviewDoc(new Y.Doc());
  const stored = await services.reviews.load(projectId, 'review');
  if (stored) Y.applyUpdate(doc.doc, stored);
  const summary = doc.merge(file.review);
  await services.reviews.append(projectId, 'review', file.review);
  return { kind: 'comments', projectId, summary };
}

/** "3 comments and 1 suggestion from Anna" and the like. */
export function describeMerge(summary: MergeSummary): string {
  const parts: string[] = [];
  if (summary.threads > 0) parts.push(summary.threads === 1 ? '1 new comment or suggestion' : `${summary.threads} new comments and suggestions`);
  if (summary.replies > 0) parts.push(summary.replies === 1 ? '1 reply' : `${summary.replies} replies`);
  if (summary.decided > 0) parts.push(summary.decided === 1 ? '1 decision' : `${summary.decided} decisions`);
  if (parts.length === 0) return 'Nothing new: everything in this file was already here.';
  const who = summary.people.length > 0 ? ` from ${summary.people.join(', ')}` : '';
  return `${parts.join(', ')}${who} added.`;
}
