import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MODERN_FEATURES, missingFeatures } from './pdfjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * core-js modules in the legacy build that only correct small mistakes of
 * older engines in features that every browser able to run the app has. They
 * do not decide which build a browser needs.
 */
const CORRECTIONS = ['es.array.includes', 'es.array.push', 'es.json.parse', 'es.json.stringify', 'es.typed-array.with', 'web.dom-exception.stack', 'web.self'];

/** The core-js modules that the legacy build of pdf.js brings along, in its main part and in its worker. */
function legacyPolyfills(): string[] {
  const names = new Set<string>();
  for (const file of ['pdf.mjs', 'pdf.worker.mjs']) {
    const code = fs.readFileSync(path.join(root, 'node_modules/pdfjs-dist/legacy/build', file), 'utf8');
    for (const match of code.matchAll(/core-js\/modules\/([a-z0-9.-]+)\.js/g)) names.add(match[1]!);
  }
  return [...names].sort();
}

/** A browser with every feature of the list, as plain functions. */
function upToDateBrowser(): Record<string, unknown> {
  const scope: Record<string, unknown> = {};
  for (const name of Object.values(MODERN_FEATURES)) {
    const keys = name.split('.');
    let owner = scope;
    for (const key of keys.slice(0, -1)) owner = (owner[key] ??= function stub() {}) as Record<string, unknown>;
    owner[keys.at(-1)!] ??= function stub() {};
  }
  return scope;
}

describe('the choice between the modern and the legacy build of pdf.js', () => {
  it('knows every feature that the legacy build brings its own copy of', () => {
    const polyfills = legacyPolyfills();
    expect(polyfills.length).toBeGreaterThan(10);
    // A new name here means that an update of pdf.js uses one more new feature: add it to MODERN_FEATURES in pdfjs.ts.
    expect(polyfills.filter((name) => !CORRECTIONS.includes(name))).toEqual(Object.keys(MODERN_FEATURES).sort());
  });

  it('finds nothing missing in a browser that has every feature', () => {
    expect(missingFeatures(upToDateBrowser())).toEqual([]);
  });

  it('names what an older browser lacks', () => {
    const older = upToDateBrowser();
    delete (older.Map as { prototype: Record<string, unknown> }).prototype.getOrInsertComputed;
    delete older.Iterator;
    expect(missingFeatures(older)).toEqual([
      'Iterator',
      'Iterator.prototype.drop',
      'Iterator.prototype.every',
      'Iterator.prototype.filter',
      'Iterator.prototype.find',
      'Iterator.prototype.flatMap',
      'Iterator.prototype.forEach',
      'Iterator.prototype.map',
      'Iterator.prototype.some',
      'Iterator.prototype.take',
      'Iterator.prototype.toArray',
      'Map.prototype.getOrInsertComputed',
    ]);
    expect(missingFeatures({})).toHaveLength(Object.keys(MODERN_FEATURES).length);
  });
});
