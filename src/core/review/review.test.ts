import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { projectLatex, usesGermanShorthands } from './latex-plain';
import { contextAround, escapeLatex, findInSource, findOnPage, normalizeForMatch, planPlainEdit, plainOf, readableSelection, selectionContext } from './match';
import { SourceMirror } from './mirror';
import { ReviewDoc } from './review-doc';
import { applyChanges, diffText } from './text-diff';
import type { Person } from './types';

const anna: Person = { id: 'p-anna', name: 'Anna', color: 2 };
const benni: Person = { id: 'p-benni', name: 'Benni', color: 0 };

describe('diffText', () => {
  it('finds the one changed span', () => {
    expect(diffText('the cat sat', 'the dog sat')).toEqual({ from: 4, to: 7, insert: 'dog' });
    expect(diffText('abc', 'abc')).toBeNull();
    expect(diffText('', 'new')).toEqual({ from: 0, to: 0, insert: 'new' });
    expect(diffText('gone', '')).toEqual({ from: 0, to: 4, insert: '' });
  });

  it('never splits a surrogate pair', () => {
    // Two emoji that share their high surrogate.
    const change = diffText('a😀b', 'a😁b')!;
    expect(change.from).toBe(1);
    expect(change.to).toBe(3);
    expect(applyChanges('a😀b', [change])).toBe('a😁b');
  });
});

describe('SourceMirror', () => {
  it('keeps a comment on its words while text changes around it', () => {
    const mirror = new SourceMirror();
    mirror.setText('main.tex', 'We show the results here.');
    const from = 'We show '.length;
    const anchor = mirror.anchor('main.tex', from, from + 'the results'.length)!;

    mirror.applyChanges('main.tex', [{ from: 0, to: 0, insert: 'In this chapter ' }], 'In this chapter We show the results here.');
    mirror.setText('main.tex', 'In this chapter we clearly show the results here.');
    const range = mirror.resolve(anchor)!;
    expect(mirror.text('main.tex')!.slice(range.from, range.to)).toBe('the results');

    // Text typed right after the range stays outside it.
    const text = mirror.text('main.tex')!;
    mirror.setText('main.tex', `${text.slice(0, range.to)} so far${text.slice(range.to)}`);
    const later = mirror.resolve(anchor)!;
    expect(mirror.text('main.tex')!.slice(later.from, later.to)).toBe('the results');
  });

  it('follows renames and keeps deleted files', () => {
    const mirror = new SourceMirror();
    mirror.setText('chapters/intro.tex', 'Hello world');
    const anchor = mirror.anchor('chapters/intro.tex', 6, 11)!;
    mirror.rename('chapters', 'parts');
    expect(mirror.resolve(anchor)).toMatchObject({ path: 'parts/intro.tex', from: 6, to: 11, deleted: false });
    mirror.remove(['parts']);
    expect(mirror.text('parts/intro.tex')).toBeNull();
    expect(mirror.resolve(anchor)).toMatchObject({ deleted: true });
    // Restored at the same place, it is the same file again.
    mirror.setText('parts/intro.tex', 'Hello world');
    expect(mirror.resolve(anchor)).toMatchObject({ deleted: false, from: 6, to: 11 });
  });

  it('treats a file that moved while it was closed as renamed', () => {
    const mirror = new SourceMirror();
    mirror.setText('a.tex', 'same text');
    const anchor = mirror.anchor('a.tex', 0, 4)!;
    mirror.reconcile([{ path: 'b.tex', text: 'same text' }]);
    expect(mirror.resolve(anchor)).toMatchObject({ path: 'b.tex', deleted: false });
    expect(mirror.paths()).toEqual(['b.tex']);
  });

  it('applies the editor changes exactly, and repairs itself when they do not fit', () => {
    const mirror = new SourceMirror();
    mirror.setText('x.tex', 'abc def');
    mirror.applyChanges('x.tex', [{ from: 0, to: 1, insert: 'A' }, { from: 4, to: 7, insert: 'DEF' }], 'Abc DEF');
    expect(mirror.text('x.tex')).toBe('Abc DEF');
    // Changes made on another text than the mirror holds: the result text wins.
    mirror.applyChanges('x.tex', [{ from: 0, to: 0, insert: 'zz' }], 'something else entirely');
    expect(mirror.text('x.tex')).toBe('something else entirely');
  });

  it('resolves anchors made in a copy of the document after the original was edited', () => {
    const author = new SourceMirror();
    author.setText('main.tex', 'First sentence. Second sentence.');
    const reviewer = new SourceMirror(new Y.Doc());
    Y.applyUpdate(reviewer.doc, author.encode());
    const anchor = reviewer.anchor('main.tex', 16, 31)!;
    expect(reviewer.text('main.tex')!.slice(16, 31)).toBe('Second sentence');

    author.setText('main.tex', 'A new start. First sentence. Second sentence.');
    const range = author.resolve(anchor)!;
    expect(author.text('main.tex')!.slice(range.from, range.to)).toBe('Second sentence');
  });
});

describe('ReviewDoc', () => {
  it('adds threads, replies and decisions, and merges review files without duplicates', () => {
    const mine = new ReviewDoc();
    const id = mine.add({ kind: 'comment', anchor: null, path: 'main.tex', quote: 'results', replacement: null, plain: null, body: 'Which ones?', author: benni, pdf: null });
    expect(mine.threads()).toHaveLength(1);

    const theirs = new ReviewDoc(new Y.Doc());
    Y.applyUpdate(theirs.doc, mine.encode());
    theirs.reply(id, anna, 'The ones in table 2.');
    theirs.add({ kind: 'suggestion', anchor: null, path: 'main.tex', quote: 'teh', replacement: 'the', plain: null, body: '', author: anna, pdf: null });
    mine.setStatus(id, 'resolved', benni);

    const summary = mine.merge(theirs.encode());
    expect(summary).toMatchObject({ threads: 1, replies: 1, decided: 0 });
    expect(summary.people).toEqual(['Anna']);
    const thread = mine.get(id)!;
    expect(thread.status).toBe('resolved');
    expect(thread.replies.map((reply) => reply.text)).toEqual(['The ones in table 2.']);

    // The same file again changes nothing.
    expect(mine.merge(theirs.encode())).toMatchObject({ threads: 0, replies: 0, decided: 0 });
    expect(mine.threads()).toHaveLength(2);
  });

  it('keeps one review id once made', () => {
    const doc = new ReviewDoc();
    expect(doc.hasReviewId()).toBe(false);
    const id = doc.reviewId();
    expect(doc.reviewId()).toBe(id);
    const copy = new ReviewDoc(new Y.Doc());
    Y.applyUpdate(copy.doc, doc.encode());
    expect(copy.reviewId()).toBe(id);
  });
});

describe('projectLatex', () => {
  const plain = (source: string): string => projectLatex(source).text.trim();

  it('reads text the way the PDF shows it', () => {
    expect(plain('This is \\emph{very} important.')).toBe('This is very important.');
    expect(plain('See \\cite{knuth} and Figure~\\ref{fig:a}.')).toBe('See and Figure .');
    expect(plain('\\section{Introduction}\\label{sec:intro} Text')).toBe('Introduction Text');
    expect(plain('Gr\\"o\\ss e and na\\"\\i ve')).toBe('Größe and naïve');
    // babel's shorthands only where the document uses them: in English "also" is a word in quotes.
    expect(projectLatex('f"ur die "Ubung', 0, { german: true }).text).toBe('für die Übung');
    expect(plain('He said "also" twice')).toBe('He said "also" twice');
    expect(usesGermanShorthands('Gr"o"se und f"ur')).toBe(true);
    expect(usesGermanShorthands('\\usepackage[ngerman]{babel}')).toBe(true);
    expect(usesGermanShorthands('He said "also" twice')).toBe(false);
    expect(plain('100\\% sure % a comment\nnext')).toBe('100% sure next');
    expect(plain('pages 1--5 --- really')).toBe('pages 1–5 — really');
    expect(plain('``quoted\'\'')).toBe('“quoted”');
    expect(plain('the value $\\alpha$ is small')).toBe('the value is small');
    expect(plain('\\textcolor{red}{warning} sign')).toBe('warning sign');
    expect(plain('\\begin{equation}x=1\\end{equation} after')).toBe('after');
    // Inline maths keeps what the PDF shows as plain letters and digits.
    expect(plain('a $p$-value below $0.01$, and $x\\,y^{2}$')).toBe('a p-value below 0.01, and xy2');
    expect(plain('then \\(n + 1\\) steps')).toBe('then n + 1 steps');
  });

  it('knows which source characters each character came from', () => {
    const source = 'An \\emph{odd} word';
    const projection = projectLatex(source);
    const at = projection.text.indexOf('odd');
    expect(source.slice(projection.start[at]!, projection.end[at + 2]!)).toBe('odd');
  });
});

describe('matching the PDF and the source', () => {
  const source = [
    '\\section{Results}',
    'The measured values were \\emph{significantly} higher than expected,',
    'which suggests that the interesting effect described by \\citet{smith} is real.',
    '',
    'A second paragraph about something else.',
  ].join('\n');

  it('normalizes ligatures, dashes and space', () => {
    expect(normalizeForMatch('Eﬃcient  –  “ok”').text).toBe('efficient - "ok"');
    expect(readableSelection('inter-\nesting ef-\nfect')).toBe('interesting effect');
  });

  it('finds a PDF selection in the source, through commands and line breaks', () => {
    const found = findInSource(source, 'values were significantly higher')!;
    expect(source.slice(found.from, found.to)).toBe('values were \\emph{significantly} higher');
    expect(found.exact).toBe(true);

    const hyphenated = findInSource(source, 'the inter-\nesting effect')!;
    expect(source.slice(hyphenated.from, hyphenated.to)).toBe('the interesting effect');

    // A citation prints as something the source does not contain.
    const cited = findInSource(source, 'effect described by Smith (2020) is real')!;
    expect(source.slice(cited.from, cited.to)).toBe('effect described by \\citet{smith} is real');
    expect(cited.exact).toBe(false);
  });

  it('turns an edit of plain words into a source change', () => {
    const range = findInSource(source, 'The measured values were significantly higher')!;
    const before = 'The measured values were significantly higher';
    const change = planPlainEdit(source, range, before, 'The measured values were clearly higher')!;
    expect(change).not.toBeNull();
    const after = applyChanges(source, [change]);
    expect(after).toContain('The measured values were \\emph{clearly} higher');

    const typo = planPlainEdit(source, range, before, 'The measured values are significantly higher')!;
    expect(applyChanges(source, [typo])).toContain('The measured values are \\emph{significantly}');

    // A change across the end of a command cannot be made without knowing LaTeX.
    const comma = planPlainEdit(source, range, before, 'The measured values were significantly, much higher')!;
    expect(applyChanges(source, [comma])).toContain('\\emph{significantly}, much higher');
    const plural = planPlainEdit(source, range, before, 'The measured values were significantlys higher')!;
    expect(applyChanges(source, [plural])).toContain('\\emph{significantlys} higher');
    expect(planPlainEdit(source, range, before, 'The measured valueswere significantlyhigher')).toBeNull();
  });

  it('suggests whole words, also inside inline maths', () => {
    const text = 'The signal was two times higher, with a $p$-value below $0.01$.';
    const range = findInSource(text, 'signal was two times higher')!;
    const words = planPlainEdit(text, range, 'signal was two times higher', 'signal was twice as high')!;
    expect(text.slice(words.from, words.to)).toBe('two times higher');
    expect(words.insert).toBe('twice as high');

    const math = findInSource(text, 'with a p-value below 0.01.')!;
    expect(math.exact).toBe(true);
    const number = planPlainEdit(text, math, 'with a p-value below 0.01.', 'with a p-value below 0.05.')!;
    expect(text.slice(number.from, number.to)).toBe('0.01');
    expect(applyChanges(text, [number])).toContain('below $0.05$.');
    // A sign that LaTeX only knows in text cannot go into maths.
    expect(planPlainEdit(text, math, 'with a p-value below 0.01.', 'with a p-value below 0^01.')).toBeNull();
  });

  it('escapes what LaTeX would read as commands', () => {
    expect(escapeLatex('50% & more_')).toBe('50\\% \\& more\\_');
    expect(plainOf('50\\% \\& more\\_')).toBe('50% & more_');
  });

  it('marks the words of a source passage on a PDF page', () => {
    const items = [
      { str: 'The measured values were significantly', left: 72, top: 100, right: 300, bottom: 110 },
      { str: 'higher than expected, which sug-', left: 72, top: 112, right: 280, bottom: 122 },
      { str: 'gests that the interesting effect', left: 72, top: 124, right: 260, bottom: 134 },
    ];
    const boxes = findOnPage(items, 'which suggests that the')!;
    expect(boxes).toHaveLength(2);
    expect(boxes[0]!.top).toBe(112);
    expect(boxes[1]!.top).toBe(124);
    expect(findOnPage(items, 'nothing like this')).toBeNull();

    // Maths often comes in pieces that touch: "0", ".", "01." in a row.
    const pieces = [
      { str: 'with a', left: 117.8, top: 352, right: 148.1, bottom: 363 },
      { str: ' ', left: 148.1, top: 352, right: 151.7, bottom: 363 },
      { str: 'p', left: 151.8, top: 352, right: 157.3, bottom: 363 },
      { str: '-value below 0', left: 157.3, top: 352, right: 225.5, bottom: 363 },
      { str: '.', left: 225.4, top: 352, right: 228.4, bottom: 363 },
      { str: '01.', left: 228.5, top: 352, right: 242.4, bottom: 363 },
    ];
    const number = findOnPage(pieces, '0.01')!;
    expect(number).toHaveLength(1);
    expect(number[0]!.left).toBeGreaterThan(220);
    expect(findOnPage(pieces, 'a p-value below')).not.toBeNull();
  });
});

/** The source after a planned change. */
function applied(source: string, change: { from: number; to: number; insert: string } | null): string | null {
  return change ? source.slice(0, change.from) + change.insert + source.slice(change.to) : null;
}

/** A PDF selection's plain text and the change a reviewer made to it, carried out on the source. */
function suggestOn(source: string, selection: string, after: string): string | null {
  const range = findInSource(source, selection);
  if (!range) throw new Error(`"${selection}" not found`);
  return applied(source, planPlainEdit(source, range, range.plain, after));
}

describe('finding the words a reviewer meant', () => {
  it('tells apart the same words by the words around them on the page', () => {
    const text = 'We first describe the method in detail. Then we test the method on real data and compare it with older work.';
    const line = { str: text, left: 0, top: 100, right: 1000, bottom: 110 };
    // The selection starts at the second "the method", about halfway along the line.
    const context = selectionContext([line], 'the method', { x: 500, y: 105 })!;
    expect(context.before.endsWith('then we test')).toBe(true);
    expect(context.after.startsWith('on real data')).toBe(true);
    const found = findInSource(text, 'the method', { near: 0, context })!;
    expect(found.from).toBe(text.lastIndexOf('the method'));
    expect(applied(text, planPlainEdit(text, found, 'the method', 'the new method'))).toBe(
      'We first describe the method in detail. Then we test the new method on real data and compare it with older work.',
    );
  });

  it('prefers the line SyncTeX names when the words around do not tell', () => {
    const text = 'We trained the model.\nAfter a long and careful search we tuned the model again.';
    const lineTwo = text.indexOf('\n') + 1;
    const found = findInSource(text, 'the model', { near: lineTwo, prefer: { from: lineTwo, to: text.length } })!;
    expect(found.from).toBe(text.lastIndexOf('the model'));
  });

  it('marks whole words on the page, at the place the source means', () => {
    const str = 'This is what the data shows: the data is clear and the metadata is too.';
    const items = [{ str, left: 0, top: 100, right: 1000, bottom: 110 }];
    const [first] = findOnPage(items, 'is')!;
    // Not the end of "This".
    expect(first!.left).toBeGreaterThan(40);
    expect(first!.left).toBeLessThan(120);
    const source = 'This is what the data shows: the data is clear and the metadata is too.';
    const at = source.indexOf('is clear');
    const [second] = findOnPage(items, 'is', undefined, contextAround(source, at, at + 2))!;
    expect(second!.left).toBeGreaterThan(450);
    expect(second!.right).toBeLessThan(620);
  });

  it('keeps added words outside inline maths', () => {
    const text = 'Then the value $x$ is small for all $n$ we tried.';
    expect(suggestOn(text, 'the value x is small for all n we tried', 'the value of x is small for all n we tried')).toBe('Then the value of $x$ is small for all $n$ we tried.');
    expect(suggestOn(text, 'the value x is small for all n we tried', 'the value x is small for all integers n we tried')).toBe('Then the value $x$ is small for all integers $n$ we tried.');
    const p = 'We found a $p$-value below $0.01$.';
    expect(suggestOn(p, 'a p-value below 0.01.', 'a p-value below 0.01, which is significant.')).toBe('We found a $p$-value below $0.01$, which is significant.');
    expect(suggestOn(p, 'a p-value below 0.01.', 'a small p-value below 0.01.')).toBe('We found a small $p$-value below $0.01$.');
    // Numbers inside a formula can still change; anything else there is made by hand.
    expect(suggestOn(p, 'a p-value below 0.01.', 'a p-value below 0.05.')).toBe('We found a $p$-value below $0.05$.');
    expect(suggestOn('then \\(n + 1\\) steps', 'then n + 1 steps', 'then n^2 + 1 steps')).toBeNull();
  });

  it('adds words after a command that prints a symbol, not into its name', () => {
    expect(suggestOn('This is the Hamilton\\textendash{}Jacobi equation.', 'the Hamilton–Jacobi equation', 'the Hamilton–Bellman–Jacobi equation')).toBe(
      'This is the Hamilton\\textendash{}Bellman–Jacobi equation.',
    );
    expect(suggestOn('From 1990\\textendash{}2000 on', 'From 1990–2000 on', 'From 1990–early 2000 on')).toBe('From 1990\\textendash{}early 2000 on');
    // TeX swallows the space after \\LaTeX, so the PDF reads "LaTeXis"; adding the space needs {}.
    expect(suggestOn('We use \\LaTeX is fun.', 'We use LaTeXis fun.', 'We use LaTeX is fun.')).toBe('We use \\LaTeX {} is fun.');
  });

  it('never joins two paragraphs', () => {
    const text = 'We ran all the tests on the cluster. They all passed.\n\nNext, we discuss the limits of the method.';
    expect(suggestOn(text, 'cluster. They all passed. Next, we', 'cluster. Next, we')).toBe('We ran all the tests on the cluster. \n\nNext, we discuss the limits of the method.');
    expect(suggestOn('The results are good.\n\nNext we discuss them.', 'are good. Next we', 'are great. Then we')).toBeNull();
  });

  it('reads accents that a PDF without T1 fonts shows apart from their letters', () => {
    expect(normalizeForMatch('Gr\u00a8oße f\u00a8ur').text).toBe(normalizeForMatch('Größe für').text);
    expect(readableSelection('Gr\u00a8oße f\u00a8ur')).toBe('Größe für');
    const text = 'Die Gr\\"o\\ss e der Stichprobe war f\\"ur die Studie zu klein.';
    const found = findInSource(text, 'Gr\u00a8oße der Stichprobe war f\u00a8ur die')!;
    expect(text.slice(found.from, found.to)).toBe('Gr\\"o\\ss e der Stichprobe war f\\"ur die');
  });

  it('reads \\@, \\verb and listings as the PDF prints them', () => {
    expect(plainOf('etc.\\@ and so on')).toBe('etc. and so on');
    expect(plainOf('type \\verb|50%| and $x$ here')).toBe('type 50% and x here');
    expect(plainOf('before\n\\begin{verbatim}\nx = $1 % 2\n\\end{verbatim}\nafter $y$')).toBe('before x = $1 % 2 after y');
  });
});

