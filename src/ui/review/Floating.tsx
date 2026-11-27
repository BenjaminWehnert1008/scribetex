/**
 * The small floating parts of review: the toolbar over a selection, the box
 * for a new comment or suggestion, and a card shown next to a mark.
 */
import { MessageSquarePlus, PencilLine } from 'lucide-react';
import { type CSSProperties, type KeyboardEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Dialog } from '../common/ui';

/** Places a floating element next to `anchor`, below it if there is room, and inside the window. */
function usePlacement(anchor: DOMRect, gap = 8): { ref: React.RefObject<HTMLDivElement | null>; style: CSSProperties } {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ left: anchor.left, top: anchor.bottom + gap, visibility: 'hidden' });
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const width = box.width;
    const height = box.height;
    let left = anchor.left + anchor.width / 2 - width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    let top = anchor.bottom + gap;
    if (top + height > window.innerHeight - 8) top = anchor.top - height - gap;
    top = Math.max(8, top);
    setStyle({ left, top });
  }, [anchor.left, anchor.top, anchor.right, anchor.bottom, anchor.width, gap]);
  return { ref, style };
}

export function SelectionBar(props: { anchor: DOMRect; primary: 'comment' | 'suggest'; onComment: () => void; onSuggest: () => void; canSuggest: boolean }) {
  const { ref, style } = usePlacement(props.anchor, 6);
  return (
    <div className="rv-selbar" ref={ref} style={style} role="toolbar" aria-label="Comment on the selection" onMouseDown={(event) => event.preventDefault()}>
      <button className={props.primary === 'comment' ? 'on' : ''} onClick={props.onComment}>
        <MessageSquarePlus size={15} /> Comment
      </button>
      {props.canSuggest && (
        <button className={props.primary === 'suggest' ? 'on' : ''} onClick={props.onSuggest}>
          <PencilLine size={15} /> Suggest a change
        </button>
      )}
    </div>
  );
}

export interface ComposerProps {
  anchor: DOMRect;
  kind: 'comment' | 'suggest';
  /** The text the comment or suggestion is about. */
  quote: string;
  /** Prefilled: the replacement for a suggestion, the start of a comment. */
  initial: string;
  /** Says where it will be attached, such as "main.tex, line 12". */
  where: string | null;
  /** Shown below the field, for example that a PDF selection was not found in the source. */
  hint?: ReactNode;
  onSubmit: (text: string, note: string) => void;
  onCancel: () => void;
}

export function Composer(props: ComposerProps) {
  const { ref, style } = usePlacement(props.anchor);
  const [text, setText] = useState(props.initial);
  const [note, setNote] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  const suggest = props.kind === 'suggest';
  const { onCancel } = props;

  useEffect(() => {
    const element = field.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const unchanged = suggest && text === props.quote;
  const empty = !suggest && text.trim() === '';
  const submit = (): void => {
    if (unchanged || empty) return;
    props.onSubmit(suggest ? text : text.trim(), note.trim());
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>): void => {
    // Enter sends, as in a chat; Shift+Enter makes a new line.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="rv-pop rv-composer" ref={ref} style={style} role="dialog" aria-label={suggest ? 'Suggest a change' : 'New comment'}>
      {props.quote && (
        <p className="rv-composer-quote">
          {suggest ? (props.quote ? 'Replace' : 'Insert') : 'On'} <q>{props.quote.length > 140 ? `${props.quote.slice(0, 139)}…` : props.quote}</q>
          {suggest && props.quote ? ' with:' : ''}
        </p>
      )}
      {!props.quote && suggest && <p className="rv-composer-quote">Insert at the cursor:</p>}
      <textarea
        ref={field}
        className={`field ${suggest ? 'mono' : ''}`}
        rows={suggest ? Math.min(6, Math.max(2, Math.ceil(text.length / 38))) : 3}
        aria-label={suggest ? 'Suggested text' : 'Comment'}
        placeholder={suggest ? 'The new text. Leave it empty to suggest deleting.' : 'Add a comment'}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKey}
      />
      {suggest && (
        <input className="field" aria-label="Note" placeholder="Why? (optional)" value={note} onChange={(event) => setNote(event.target.value)} onKeyDown={onKey} />
      )}
      {props.hint && <p className="rv-note">{props.hint}</p>}
      <div className="rv-composer-foot">
        <span className="faint">{props.where}</span>
        <span className="grow" />
        <button className="btn small" onClick={props.onCancel}>
          Cancel
        </button>
        <button className="btn small primary" disabled={unchanged || empty} onClick={submit}>
          {suggest ? (text === '' ? 'Suggest deleting' : 'Suggest') : 'Comment'}
        </button>
      </div>
    </div>
  );
}

/** A thread card floating next to its mark. */
export function Popover(props: { anchor: DOMRect; onClose: () => void; children: ReactNode }) {
  const { ref, style } = usePlacement(props.anchor);
  const { onClose } = props;
  useEffect(() => {
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (ref.current?.contains(target)) return;
      // A menu of the card lives outside it.
      if ((target as HTMLElement).closest?.('.menu')) return;
      onClose();
    };
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, ref]);
  return (
    <div className="rv-pop rv-popover" ref={ref} style={style}>
      {props.children}
    </div>
  );
}

export function NameDialog(props: { initial?: string; onSave: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState(props.initial ?? '');
  return (
    <Dialog title="Your name" onClose={props.onClose}>
      <form
        style={{ display: 'grid', gap: 12 }}
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) props.onSave(name.trim());
        }}
      >
        <p className="muted">It is shown next to your comments and suggestions, so the others know who wrote them. It stays in this browser.</p>
        <label className="stack">
          Name
          <input className="field" autoFocus value={name} maxLength={60} placeholder="For example Anna Schmidt" onChange={(event) => setName(event.target.value)} />
        </label>
        <div className="actions">
          <button type="button" className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!name.trim()}>
            Continue
          </button>
        </div>
      </form>
    </Dialog>
  );
}
