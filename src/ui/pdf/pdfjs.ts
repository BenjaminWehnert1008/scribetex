/**
 * Loads pdf.js, which draws the PDF preview.
 *
 * pdf.js comes in two builds. The modern one calls the newest JavaScript
 * features without checking that the browser has them. Where one is missing,
 * the preview stays empty or its fonts break: Safari, for example, has
 * Map.prototype.getOrInsertComputed only since version 26.2. The legacy build
 * brings its own copies of these features, so a browser that lacks any of
 * them gets the legacy build instead.
 */
import type * as PdfjsModule from 'pdfjs-dist';
import modernWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import legacyWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

export type Pdfjs = typeof PdfjsModule;

/**
 * The features that the modern build uses without checking, each under the
 * name of the core-js module that the legacy build brings in its place.
 * pdfjs.test.ts compares this list with the legacy build, so an update of
 * pdf.js that needs one more feature makes that test fail.
 */
export const MODERN_FEATURES: Readonly<Record<string, string>> = {
  'es.iterator.constructor': 'Iterator',
  'es.iterator.drop': 'Iterator.prototype.drop',
  'es.iterator.every': 'Iterator.prototype.every',
  'es.iterator.filter': 'Iterator.prototype.filter',
  'es.iterator.find': 'Iterator.prototype.find',
  'es.iterator.flat-map': 'Iterator.prototype.flatMap',
  'es.iterator.for-each': 'Iterator.prototype.forEach',
  'es.iterator.map': 'Iterator.prototype.map',
  'es.iterator.some': 'Iterator.prototype.some',
  'es.iterator.take': 'Iterator.prototype.take',
  'es.iterator.to-array': 'Iterator.prototype.toArray',
  'es.map.get-or-insert': 'Map.prototype.getOrInsert',
  'es.map.get-or-insert-computed': 'Map.prototype.getOrInsertComputed',
  'es.math.sum-precise': 'Math.sumPrecise',
  'es.promise.try': 'Promise.try',
  'es.set.difference.v2': 'Set.prototype.difference',
  'es.set.intersection.v2': 'Set.prototype.intersection',
  'es.set.is-disjoint-from.v2': 'Set.prototype.isDisjointFrom',
  'es.set.is-subset-of.v2': 'Set.prototype.isSubsetOf',
  'es.set.is-superset-of.v2': 'Set.prototype.isSupersetOf',
  'es.set.symmetric-difference.v2': 'Set.prototype.symmetricDifference',
  'es.set.union.v2': 'Set.prototype.union',
  'es.uint8-array.from-base64': 'Uint8Array.fromBase64',
  'es.uint8-array.set-from-base64': 'Uint8Array.prototype.setFromBase64',
  'es.uint8-array.set-from-hex': 'Uint8Array.prototype.setFromHex',
  'es.uint8-array.to-base64': 'Uint8Array.prototype.toBase64',
  'es.uint8-array.to-hex': 'Uint8Array.prototype.toHex',
  'es.weak-map.get-or-insert': 'WeakMap.prototype.getOrInsert',
  'es.weak-map.get-or-insert-computed': 'WeakMap.prototype.getOrInsertComputed',
  'web.url.parse': 'URL.parse',
};

/** The features of MODERN_FEATURES that `scope` lacks, such as "Math.sumPrecise". Empty in an up-to-date browser. */
export function missingFeatures(scope: object = globalThis): string[] {
  return Object.values(MODERN_FEATURES).filter((name) => {
    const value = name.split('.').reduce<unknown>((owner, key) => (owner == null ? undefined : (owner as Record<string, unknown>)[key]), scope);
    return typeof value !== 'function';
  });
}

/** True in a browser that lacks some of the newest JavaScript features, so that the preview uses the legacy build. */
export function browserIsBehind(): boolean {
  return missingFeatures().length > 0;
}

let pdfjsPromise: Promise<Pdfjs> | null = null;

export function loadPdfjs(): Promise<Pdfjs> {
  pdfjsPromise ??= (async () => {
    const legacy = browserIsBehind();
    const pdfjs: Pdfjs = legacy ? await import('pdfjs-dist/legacy/build/pdf.mjs') : await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = legacy ? legacyWorkerUrl : modernWorkerUrl;
    return pdfjs;
  })();
  return pdfjsPromise;
}
