/**
 * Comments and suggestions in the source editor: highlighted ranges, struck
 * through text with the suggested text after it, and the keys that turn
 * typing into a suggestion while the editor is in a review mode.
 */
import { type Extension, type Range, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';

export interface SourceMark {
  id: string;
  from: number;
  to: number;
  kind: 'comment' | 'suggestion';
  /** Index into the review palette. */
  color: number;
  /** For a suggestion: the text it puts in place of the range; null when it has to be made by hand. */
  replacement: string | null;
  active: boolean;
}

export const setSourceMarks = StateEffect.define<SourceMark[]>();

class SuggestedText extends WidgetType {
  constructor(
    readonly text: string,
    readonly id: string,
    readonly color: number,
    readonly active: boolean,
  ) {
    super();
  }

  override eq(other: SuggestedText): boolean {
    return other.text === this.text && other.id === this.id && other.color === this.color && other.active === this.active;
  }

  override toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = `cm-rv-ins${this.active ? ' cm-rv-active' : ''}`;
    span.dataset.thread = this.id;
    span.style.setProperty('--rv', `var(--rv-${this.color})`);
    span.textContent = this.text;
    span.title = 'Suggested text';
    return span;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

function build(marks: readonly SourceMark[], length: number): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const mark of marks) {
    const from = Math.max(0, Math.min(mark.from, length));
    const to = Math.max(from, Math.min(mark.to, length));
    const attributes = { 'data-thread': mark.id, style: `--rv: var(--rv-${mark.color})` };
    const active = mark.active ? ' cm-rv-active' : '';
    if (mark.kind === 'comment' || mark.replacement === null) {
      if (to > from) ranges.push(Decoration.mark({ class: `cm-rv-mark cm-rv-${mark.kind === 'comment' ? 'comment' : 'plain'}${active}`, attributes }).range(from, to));
      continue;
    }
    if (to > from) ranges.push(Decoration.mark({ class: `cm-rv-mark cm-rv-del${active}`, attributes }).range(from, to));
    if (mark.replacement !== '') ranges.push(Decoration.widget({ widget: new SuggestedText(mark.replacement, mark.id, mark.color, mark.active), side: 1 }).range(to));
  }
  return Decoration.set(ranges, true);
}

const marksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = tr.docChanged ? value.map(tr.changes) : value;
    for (const effect of tr.effects) if (effect.is(setSourceMarks)) next = build(effect.value, tr.state.doc.length);
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export interface ReviewHandlers {
  /** The editor's review mode: in 'comment' and 'suggest' typing does not change the text. */
  mode(): 'edit' | 'comment' | 'suggest' | 'locked';
  /** A mark was clicked. */
  onMarkClick(id: string, box: DOMRect): void;
  /** Something was typed or pasted while in a review mode. */
  onType(view: EditorView, text: string): void;
}

/** The marks, plus the key handling of the review modes. */
export function reviewMarks(handlers: ReviewHandlers): Extension {
  return [
    marksField,
    EditorView.domEventHandlers({
      click(event) {
        if (event.button !== 0 || event.detail > 1) return false;
        const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-thread]');
        const selection = window.getSelection();
        if (!target?.dataset.thread || (selection && !selection.isCollapsed)) return false;
        handlers.onMarkClick(target.dataset.thread, target.getBoundingClientRect());
        return false;
      },
      keydown(event, view) {
        const mode = handlers.mode();
        if (mode === 'edit' || mode === 'locked') return false;
        if (event.ctrlKey || event.metaKey || event.altKey) return false;
        const printable = event.key.length === 1;
        if (!printable && event.key !== 'Enter' && event.key !== 'Backspace' && event.key !== 'Delete') return false;
        event.preventDefault();
        handlers.onType(view, printable ? event.key : '');
        return true;
      },
      paste(event, view) {
        const mode = handlers.mode();
        if (mode === 'edit' || mode === 'locked') return false;
        const text = event.clipboardData?.getData('text/plain') ?? '';
        event.preventDefault();
        handlers.onType(view, text);
        return true;
      },
    }),
  ];
}
