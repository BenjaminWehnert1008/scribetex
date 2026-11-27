/**
 * Comments and suggestions on a project. No runtime code.
 */
import type { Millis, Path } from '../types';
import type { Anchor } from './mirror';

/** Someone who comments. The colour is an index into the review palette. */
export interface Person {
  id: string;
  name: string;
  color: number;
}

export type ThreadKind = 'comment' | 'suggestion';

/** Comments are open or resolved; suggestions are open, accepted or rejected. */
export type ThreadStatus = 'open' | 'resolved' | 'accepted' | 'rejected';

/** A rectangle on a PDF page, in PDF points from the page's top left corner. */
export interface PdfRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Where something was marked in the PDF the reviewer looked at. */
export interface PdfHint {
  page: number;
  rects: PdfRect[];
  /** The text as the PDF showed it. */
  text: string;
}

export interface Reply {
  id: string;
  author: Person;
  text: string;
  at: Millis;
}

export interface Thread {
  id: string;
  kind: ThreadKind;
  /** The source range; null when a PDF selection could not be matched to the source. */
  anchor: Anchor | null;
  /** The file it was made on, for showing it when the anchor cannot be resolved. */
  path: Path | null;
  /** The source text of the range when the thread was made. */
  quote: string;
  /** For a suggestion: the source text that should replace the range. */
  replacement: string | null;
  /**
   * For a suggestion made on the PDF that could not be turned into a source
   * change, because the words run through LaTeX commands: the change as plain
   * text. The author makes it by hand.
   */
  plain: { before: string; after: string } | null;
  /** What the comment says; for a suggestion, an optional note. */
  body: string;
  author: Person;
  createdAt: Millis;
  status: ThreadStatus;
  statusBy: Person | null;
  statusAt: Millis | null;
  /** Set when the thread was made on the PDF. */
  pdf: PdfHint | null;
  replies: Reply[];
}

export type NewThread = Pick<Thread, 'kind' | 'anchor' | 'path' | 'quote' | 'replacement' | 'plain' | 'body' | 'author' | 'pdf'>;
