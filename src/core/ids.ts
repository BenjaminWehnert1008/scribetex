const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * A sortable, URL-safe identifier: a base-36 timestamp followed by random
 * characters. Collisions are practically impossible within one browser profile.
 */
export function newId(now: number = Date.now()): string {
  const random = crypto.getRandomValues(new Uint8Array(10));
  let suffix = '';
  for (const byte of random) suffix += ALPHABET[byte % ALPHABET.length];
  return now.toString(36).padStart(9, '0') + suffix;
}
