/**
 * Who is writing comments in this browser: a name the person chooses and a
 * colour that marks their comments. Kept in this browser, for all projects.
 */
import type { Person } from '@/core/review/types';
import type { Vault } from '@/core/vault/vault';

const KEY = 'review:me';
/** Number of colours in the review palette (see review.css). */
export const PALETTE_SIZE = 8;

function newPersonId(): string {
  const random = crypto.getRandomValues(new Uint32Array(3));
  return `p${[...random].map((part) => part.toString(36)).join('')}`;
}

function colorFor(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % PALETTE_SIZE;
}

export async function loadMe(vault: Vault): Promise<Person | null> {
  const stored = await vault.getSetting<Person | null>(KEY, null);
  return stored && typeof stored.name === 'string' && stored.name.trim() !== '' ? stored : null;
}

/** Saves the name; the id and colour stay once chosen, so earlier comments keep pointing at the same person. */
export async function saveMe(vault: Vault, name: string, color?: number): Promise<Person> {
  const existing = await vault.getSetting<Person | null>(KEY, null);
  const id = existing?.id ?? newPersonId();
  const person: Person = { id, name: name.trim().slice(0, 60), color: color ?? existing?.color ?? colorFor(id) };
  await vault.setSetting(KEY, person);
  return person;
}

/** The first letters of a name, for a small round badge. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = [...parts[0]!][0] ?? '';
  const last = parts.length > 1 ? ([...parts.at(-1)!][0] ?? '') : '';
  return (first + last).toUpperCase();
}
