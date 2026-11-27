import { Check, CornerDownLeft, Ellipsis, Hand, RotateCcw, Trash2, X } from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';
import { initials } from '@/app/identity';
import type { ResolvedThread, ReviewSession } from '@/app/review-session';
import { reportError } from '@/app/services';
import type { Person } from '@/core/review/types';
import { formatAgo, Menu } from '../common/ui';

export function Avatar(props: { person: Person; size?: number }) {
  const size = props.size ?? 22;
  return (
    <span className="rv-avatar" style={{ width: size, height: size, fontSize: size * 0.42, ['--rv' as string]: `var(--rv-${props.person.color})` }} title={props.person.name} aria-hidden="true">
      {initials(props.person.name)}
    </span>
  );
}

function clip(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const STATUS: Record<string, string> = { resolved: 'Resolved', accepted: 'Accepted', rejected: 'Rejected' };

export interface ThreadCardProps {
  thread: ResolvedThread;
  review: ReviewSession;
  me: Person | null;
  /** The author may decide on suggestions; a reviewer only comments and suggests. */
  isAuthor: boolean;
  /** The project can be changed in this tab. */
  canEdit: boolean;
  /** The text the thread is about as the source has it now. */
  currentText: string | null;
  /** Where the thread is, such as "Line 12" or "PDF page 2". */
  where: string | null;
  selected?: boolean;
  onOpen?: () => void;
  /** Ask for a name before doing something that is signed with it. */
  withName: (action: () => void) => void;
  now: number;
}

export function ThreadCard(props: ThreadCardProps) {
  const { thread, review, me, isAuthor, canEdit } = props;
  const [reply, setReply] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const open = thread.status === 'open';
  const mine = me !== null && thread.author.id === me.id;
  const suggestion = thread.kind === 'suggestion';
  // Once decided, the card shows what was there when it was written.
  const shown = open ? (props.currentText ?? thread.quote) : thread.quote;

  const run = (action: () => void | Promise<void>): void => {
    props.withName(() => {
      setBusy(true);
      Promise.resolve()
        .then(action)
        .catch((error: unknown) => reportError(error))
        .finally(() => setBusy(false));
    });
  };

  const sendReply = (): void => {
    const text = reply.trim();
    if (!text) return;
    run(() => {
      review.reply(thread.id, text);
      setReply('');
    });
  };
  const onReplyKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      sendReply();
    }
  };

  return (
    <article
      className={`rv-card ${props.selected ? 'selected' : ''} ${open ? '' : 'closed'}`}
      style={{ ['--rv' as string]: `var(--rv-${thread.author.color})` }}
      aria-label={`${suggestion ? 'Suggestion' : 'Comment'} by ${thread.author.name}`}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('button, textarea, input, a')) return;
        props.onOpen?.();
      }}
    >
      <header className="rv-card-head">
        <Avatar person={thread.author} />
        <span className="rv-who">
          <b>{thread.author.name}</b>
          <span className="faint">
            {suggestion ? 'suggests' : 'comments'} · {formatAgo(thread.createdAt, props.now)}
          </span>
        </span>
        {!open && <span className={`rv-status ${thread.status}`}>{STATUS[thread.status]}</span>}
        {(mine || isAuthor) && (
          <button
            className="icon-btn small"
            aria-label="More actions"
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              setMenu({ x: box.right - 180, y: box.bottom + 4 });
            }}
          >
            <Ellipsis size={15} />
          </button>
        )}
      </header>

      {suggestion && thread.plain ? (
        <p className="rv-diff">
          <del>{clip(thread.plain.before, 220)}</del> <ins>{clip(thread.plain.after, 220)}</ins>
        </p>
      ) : suggestion ? (
        <p className="rv-diff mono">
          {shown && <del>{clip(shown, 220)}</del>} {thread.replacement ? <ins>{clip(thread.replacement, 220)}</ins> : <span className="faint">(delete)</span>}
        </p>
      ) : (
        shown && <blockquote className="rv-quote">{clip(shown)}</blockquote>
      )}

      {thread.body && <p className="rv-body">{thread.body}</p>}
      {open && thread.gone && <p className="rv-note">The text this is about was deleted.</p>}
      {open && !thread.gone && thread.changed && thread.at && <p className="rv-note">The text has changed since this was written.</p>}
      {open && suggestion && thread.plain && isAuthor && (
        <p className="rv-note">This was suggested on the PDF and touches LaTeX commands, so make it by hand, then mark it done.</p>
      )}
      {props.where && <p className="rv-where faint">{props.where}</p>}

      {thread.replies.length > 0 && (
        <ul className="rv-replies">
          {thread.replies.map((item) => (
            <li key={item.id}>
              <Avatar person={item.author} size={18} />
              <div>
                <span className="rv-who">
                  <b>{item.author.name}</b> <span className="faint">{formatAgo(item.at, props.now)}</span>
                </span>
                <p>{item.text}</p>
              </div>
              {me && item.author.id === me.id && (
                <button className="icon-btn small" aria-label="Delete this reply" onClick={() => review.removeReply(thread.id, item.id)}>
                  <X size={13} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="rv-actions">
        {open && suggestion && isAuthor && canEdit && thread.replacement !== null && (
          <>
            <button className="btn small primary" disabled={busy || !thread.at || thread.at.deleted} onClick={() => run(() => review.accept(thread.id))} title={thread.changed ? 'The text changed since; accepting replaces what is there now' : 'Make this change in the source'}>
              <Check size={14} /> {thread.changed ? 'Accept anyway' : 'Accept'}
            </button>
            <button className="btn small" disabled={busy} onClick={() => run(() => review.reject(thread.id))}>
              <X size={14} /> Reject
            </button>
          </>
        )}
        {open && suggestion && isAuthor && canEdit && thread.replacement === null && (
          <button className="btn small" disabled={busy} onClick={() => run(() => review.markDone(thread.id))}>
            <Hand size={14} /> Done
          </button>
        )}
        {open && !suggestion && (
          <button className="btn small" disabled={busy} onClick={() => run(() => review.resolve(thread.id))}>
            <Check size={14} /> Resolve
          </button>
        )}
        {!open && (isAuthor || mine) && (
          <button className="btn small quiet" disabled={busy} onClick={() => run(() => review.reopen(thread.id))}>
            <RotateCcw size={14} /> Reopen
          </button>
        )}
      </div>

      {open && (
        <div className="rv-reply">
          <textarea
            className="field"
            rows={1}
            placeholder="Reply"
            aria-label="Reply"
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            onKeyDown={onReplyKey}
          />
          {reply.trim() && (
            <button className="icon-btn" aria-label="Send the reply" title="Send (Ctrl+Enter)" onClick={sendReply}>
              <CornerDownLeft size={15} />
            </button>
          )}
        </div>
      )}

      {menu && (
        <Menu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            ...(thread.at && !thread.at.deleted ? [{ label: 'Show in the source and the PDF', run: () => props.onOpen?.() }] : []),
            { label: suggestion ? 'Delete this suggestion' : 'Delete this comment', icon: <Trash2 size={15} />, danger: true, separatorBefore: true, run: () => review.remove(thread.id) },
          ]}
        />
      )}
    </article>
  );
}
