import { describe, expect, it } from 'vitest';
import { wordAround } from '../pdf/pdf-surface';
import { findWordNear } from './find-word';

describe('words between the PDF and the source', () => {
  it('picks the word under a character', () => {
    expect(wordAround('and continues with iron', 6)).toBe('continues');
    expect(wordAround('zucchini.', 8)).toBe('zucchini');
    expect(wordAround('a  b', 2)).toBeNull();
    expect(wordAround('docu-', 1)).toBe('docu');
    expect(wordAround('Straße und Brücke', 14)).toBe('Brücke');
  });

  it('finds the word on its own, on the line or next to it', () => {
    const lines = ['Ut enim ad minim', 'aliquip ex ea consequat.\\footnote{A note.}', '', '\\item firstitem pencil', 'a document here'];
    const at = (line: number) => lines[line - 1] ?? null;
    expect(findWordNear(at, 2, 'consequat')).toEqual({ line: 2, at: 14 });
    // SyncTeX said line 3; the word is one line up.
    expect(findWordNear(at, 3, 'consequat')).toEqual({ line: 2, at: 14 });
    // "\item" is a command, not the word "item"; only the line itself is searched for a part of a word.
    expect(findWordNear(at, 4, 'item')).toEqual({ line: 4, at: 1 });
    expect(findWordNear(at, 5, 'docu')).toEqual({ line: 5, at: 2 });
    expect(findWordNear(at, 1, 'nowhere')).toBeNull();
  });
});
