/**
 * The long-lived objects of the app, created once per page.
 */
import { SnapshotStore } from '@/core/backup/snapshots';
import { SiglumEngine } from '@/core/engine/siglum';
import type { EngineClient } from '@/core/engine/types';
import { browserJournalStorage, Journal } from '@/core/session/journal';
import { Store } from '@/core/store';
import { Vault } from '@/core/vault/vault';

export interface Services {
  vault: Vault;
  snapshots: SnapshotStore;
  engine: EngineClient;
  journal: Journal;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
  action?: { label: string; run: () => void };
}

export const toasts = new Store<Toast[]>([]);
let toastId = 0;

export function notify(text: string, options: { kind?: Toast['kind']; action?: Toast['action']; ms?: number } = {}): void {
  const id = ++toastId;
  toasts.set((list) => [...list, { id, text, kind: options.kind ?? 'info', action: options.action }]);
  setTimeout(() => dismissToast(id), options.ms ?? (options.kind === 'error' ? 12000 : 6000));
}

export function dismissToast(id: number): void {
  toasts.set((list) => list.filter((toast) => toast.id !== id));
}

export function reportError(error: unknown, context?: string): void {
  const message = error instanceof Error ? error.message : String(error);
  notify(context ? `${context}: ${message}` : message, { kind: 'error' });
}

let services: Promise<Services> | null = null;

export function getServices(): Promise<Services> {
  services ??= (async () => {
    const vault = await Vault.open();
    const snapshots = new SnapshotStore(vault);
    const engine = new SiglumEngine({ baseUrl: new URL('./engine', document.baseURI).href });
    const journal = new Journal(browserJournalStorage());
    // Ask the browser not to clear our storage under disk pressure. Chrome
    // decides this without a prompt; the Storage panel shows the outcome.
    void navigator.storage?.persist?.().catch(() => false);
    return { vault, snapshots, engine, journal };
  })();
  return services;
}

/** What this browser can do, for the notices. */
export interface BrowserAbilities {
  folderAccess: boolean;
  safari: boolean;
  firefox: boolean;
  mobile: boolean;
}

export function detectBrowser(): BrowserAbilities {
  const ua = navigator.userAgent;
  const chromium = /Chrome\/|Chromium\/|Edg\//.test(ua);
  return {
    folderAccess: typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function',
    safari: /Safari\//.test(ua) && !chromium,
    firefox: /Firefox\//.test(ua),
    mobile: /Android|iPhone|iPad|Mobile/.test(ua),
  };
}
