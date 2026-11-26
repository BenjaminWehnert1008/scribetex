/**
 * Finds `word` on `line` or, failing that, on the lines just around it.
 * SyncTeX can be one line off, for example for the word just before a
 * footnote or a display formula; the word the PDF showed settles it.
 */
export function findWordNear(lineText: (line: number) => string | null, line: number, word: string): { line: number; at: number } | null {
  for (const offset of [0, -1, 1, -2, 2]) {
    const text = lineText(line + offset);
    if (text === null) continue;
    const at = wholeWord(text, word);
    if (at >= 0) return { line: line + offset, at };
  }
  const text = lineText(line);
  const at = text === null ? -1 : text.indexOf(word);
  return at >= 0 ? { line, at } : null;
}

function wholeWord(text: string, word: string): number {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}\\\\])${escaped}(?![\\p{L}\\p{N}])`, 'u').exec(text)?.index ?? -1;
}
