import type { Hash } from './types';

const HEX: string[] = [];
for (let i = 0; i < 256; i++) HEX.push(i.toString(16).padStart(2, '0'));

/** SHA-256 of `bytes` as lowercase hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<Hash> {
  // Copy into a fresh ArrayBuffer-backed view: WebCrypto rejects SharedArrayBuffer-backed views.
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice()));
  let out = '';
  for (const byte of digest) out += HEX[byte];
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

export function encodeText(text: string): Uint8Array {
  return encoder.encode(text);
}

export function decodeText(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}
