/**
 * The smallest single change that turns one string into another: the common
 * start and end are kept, the part between them is replaced.
 *
 * That is all the review mirror needs. Typing, a paste or a replaced word is
 * one such change; when several places changed at once (a file rewritten by
 * another program), replacing the span between the first and the last change
 * is still correct, it only moves comments inside that span to its edges.
 *
 * Positions are UTF-16 code units, as in JavaScript strings, CodeMirror and
 * Yjs. A change never starts or ends between the two halves of a surrogate
 * pair, because a lone half cannot be stored.
 */

export interface TextChange {
  /** Start of the replaced range in the old text. */
  from: number;
  /** End of the replaced range in the old text. */
  to: number;
  insert: string;
}

const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

export function diffText(before: string, after: string): TextChange | null {
  if (before === after) return null;
  const limit = Math.min(before.length, after.length);
  let start = 0;
  while (start < limit && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  // Do not split a surrogate pair at the start.
  if (start > 0 && isHigh(before.charCodeAt(start - 1))) start--;

  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)) {
    endBefore--;
    endAfter--;
  }
  // Nor at the end.
  if (endBefore < before.length && isLow(before.charCodeAt(endBefore))) {
    endBefore++;
    endAfter++;
  }
  return { from: start, to: endBefore, insert: after.slice(start, endAfter) };
}

/** Applies changes given in positions of the original text, in ascending order and not overlapping. */
export function applyChanges(text: string, changes: readonly TextChange[]): string {
  let out = '';
  let at = 0;
  for (const change of changes) {
    out += text.slice(at, change.from) + change.insert;
    at = change.to;
  }
  return out + text.slice(at);
}
