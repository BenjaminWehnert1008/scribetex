/**
 * Keeps two tabs from editing the same project at once. Two tabs with their
 * own unsaved buffers would overwrite each other's files, so only the tab that
 * holds the lock may edit; the other one opens the project read-only and can
 * take the lock over.
 *
 * Built on the Web Locks API, which releases a lock automatically when its
 * tab closes or crashes. Without that API the lock is always granted.
 */
import type { ProjectId } from '../types';

export interface ProjectLock {
  /** False when another tab holds the project. */
  readonly held: boolean;
  /** Calls back when another tab takes the lock away from this one. */
  onLost(callback: () => void): void;
  release(): void;
}

interface LocksLike {
  request(
    name: string,
    options: { mode?: 'exclusive'; ifAvailable?: boolean; steal?: boolean },
    callback: (lock: unknown) => Promise<unknown>,
  ): Promise<unknown>;
}

export async function acquireProjectLock(
  projectId: ProjectId,
  options: { steal?: boolean; locks?: LocksLike | null } = {},
): Promise<ProjectLock> {
  const locks = options.locks === undefined ? ((globalThis.navigator as { locks?: LocksLike } | undefined)?.locks ?? null) : options.locks;
  let lost: (() => void) | null = null;
  let release: () => void = () => undefined;
  if (!locks) return { held: true, onLost: () => undefined, release };

  const held = await new Promise<boolean>((resolve) => {
    locks
      .request(
        `latex-editor:project:${projectId}`,
        options.steal ? { mode: 'exclusive', steal: true } : { mode: 'exclusive', ifAvailable: true },
        (lock) => {
          if (lock === null) {
            resolve(false);
            return Promise.resolve();
          }
          resolve(true);
          // The lock is held for as long as this promise is pending.
          return new Promise<void>((done) => {
            release = done;
          });
        },
      )
      .catch(() => {
        // Rejects with AbortError when another tab steals the lock.
        resolve(false);
        lost?.();
      });
  });

  return {
    held,
    onLost: (callback) => {
      lost = callback;
    },
    release: () => release(),
  };
}
