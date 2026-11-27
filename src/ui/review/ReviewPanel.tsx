import { Download, FileInput, MessageSquareText, PencilLine, Send } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { describeMerge, openReviewFile } from '@/app/review-files';
import type { ResolvedThread, ReviewMode } from '@/app/review-session';
import { notify, reportError, type Services } from '@/app/services';
import type { WorkspaceModel } from '@/app/workspace-model';
import { isReviewFileName, readReviewFile, REVIEW_EXTENSION } from '@/core/review/package';
import { Dialog, downloadBytes } from '../common/ui';
import { ThreadCard } from './ThreadCard';
import type { useReviewUi } from './useReviewUi';

type ReviewUi = ReturnType<typeof useReviewUi>;

export function siteUrl(): string {
  return new URL('./', document.baseURI).href;
}

/** The switch between the ways of working on the text. */
export function ModeSwitch(props: { ui: ReviewUi; model: WorkspaceModel; compact?: boolean }) {
  const { ui, model } = props;
  const modes: { id: ReviewMode; label: string; title: string }[] = ui.isAuthor
    ? [
        { id: 'edit', label: 'Editing', title: 'Type to change the text' },
        { id: 'suggest', label: 'Suggesting', title: 'What you type becomes a suggestion that can be accepted later' },
      ]
    : [
        { id: 'comment', label: 'Commenting', title: 'Select text and type to comment on it' },
        { id: 'suggest', label: 'Suggesting', title: 'Select text and type to suggest new text for it' },
      ];
  return (
    <div className={`rv-modes ${props.compact ? 'compact' : ''}`} role="radiogroup" aria-label="Review mode">
      {modes.map((mode) => (
        <button
          key={mode.id}
          role="radio"
          aria-checked={ui.effectiveMode === mode.id}
          data-mode={mode.id}
          title={mode.title}
          disabled={ui.isAuthor && !ui.canEdit && mode.id !== 'edit'}
          onClick={() => model.review.setMode(mode.id)}
        >
          {mode.id === 'suggest' ? <PencilLine size={14} /> : mode.id === 'comment' ? <MessageSquareText size={14} /> : null}
          {mode.label}
        </button>
      ))}
    </div>
  );
}

/** Reads a review file chosen or dropped in an open project. */
export async function takeReviewFile(file: File, model: WorkspaceModel, services: Services, onOpenProject: (id: string) => void): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const parsed = readReviewFile(bytes);
  if (parsed.manifest.kind === 'comments' && model.review.owns(parsed.manifest.reviewId)) {
    const summary = await model.review.mergeComments(parsed.review);
    model.setPanel('review');
    notify(describeMerge(summary));
    return;
  }
  // A file for another project, or a review copy: it is opened the way the home page opens it.
  const opened = await openReviewFile(services, bytes);
  if (opened.projectId === model.projectId) {
    notify('Reopen the project to see the new version of this review copy.', { action: { label: 'Reopen', run: () => window.location.reload() } });
    return;
  }
  const text = opened.kind === 'comments' ? `${describeMerge(opened.summary)} They are in another project.` : `The review copy from ${opened.from} is ready.`;
  notify(text, { action: { label: 'Open it', run: () => onOpenProject(opened.projectId) }, ms: 12000 });
}

export function ReviewPanel(props: { model: WorkspaceModel; services: Services; ui: ReviewUi; onOpenProject: (id: string) => void }) {
  const { model, services, ui } = props;
  const { state } = ui;
  const [filter, setFilter] = useState<'open' | 'done'>('open');
  const [sending, setSending] = useState(false);
  const [sendingBack, setSendingBack] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const open = state.threads.filter((thread) => thread.status === 'open');
  const done = state.threads.filter((thread) => thread.status !== 'open');
  const shown = filter === 'open' ? open : done;
  const groups = useMemo(() => {
    const byFile = new Map<string, ResolvedThread[]>();
    for (const thread of shown) {
      const key = thread.at ? thread.at.path : 'On the PDF only';
      byFile.set(key, [...(byFile.get(key) ?? []), thread]);
    }
    return [...byFile];
  }, [shown]);

  // The chosen thread is scrolled into view in the list.
  useEffect(() => {
    if (!state.selected) return;
    const card = list.current?.querySelector<HTMLElement>(`[data-card="${CSS.escape(state.selected)}"]`);
    card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [state.selected]);

  const suggestionsReady = open.filter((thread) => thread.kind === 'suggestion' && thread.replacement !== null && thread.at && !thread.at.deleted && !thread.changed).length;

  return (
    <>
      <div className="side-head">
        <span className="grow">Review</span>
        {open.length > 0 && <span className="rv-count">{open.length} open</span>}
      </div>
      <div className="side-scroll rv-panel" ref={list}>
        <div className="rv-panel-top">
          <ModeSwitch ui={ui} model={model} />
          <p className="faint rv-help">
            {ui.effectiveMode === 'suggest'
              ? 'Select text in the source or the PDF and type: it becomes a suggestion, and the text stays as it is until it is accepted.'
              : ui.effectiveMode === 'comment'
                ? 'Select words in the PDF or the source, then choose Comment or Suggest a change.'
                : 'Select words in the source or the PDF to comment on them.'}
          </p>
          <div className="rv-panel-actions">
            {ui.isAuthor ? (
              <>
                <button className="btn small" onClick={() => ui.withName(() => setSending(true))} disabled={!ui.canEdit}>
                  <Send size={14} /> Send for review
                </button>
                <button className="btn small" onClick={() => fileInput.current?.click()}>
                  <FileInput size={14} /> Add comments from a file
                </button>
              </>
            ) : (
              <button className="btn small primary" onClick={() => ui.withName(() => setSendingBack(true))}>
                <Send size={14} /> Send comments back
              </button>
            )}
            <input
              ref={fileInput}
              type="file"
              accept={REVIEW_EXTENSION}
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) takeReviewFile(file, model, services, props.onOpenProject).catch((error: unknown) => reportError(error, 'The review file could not be read'));
              }}
            />
          </div>
        </div>

        <div className="rv-filter" role="tablist">
          <button role="tab" aria-selected={filter === 'open'} onClick={() => setFilter('open')}>
            Open {open.length > 0 && <span className="rv-count">{open.length}</span>}
          </button>
          <button role="tab" aria-selected={filter === 'done'} onClick={() => setFilter('done')}>
            Done {done.length > 0 && <span className="rv-count">{done.length}</span>}
          </button>
          <span className="grow" />
          {filter === 'open' && ui.isAuthor && ui.canEdit && suggestionsReady > 1 && (
            <button
              className="btn small quiet"
              onClick={() =>
                ui.withName(() => {
                  model.review
                    .acceptAll()
                    .then((count) => notify(count === 1 ? '1 suggestion accepted.' : `${count} suggestions accepted.`))
                    .catch((error: unknown) => reportError(error));
                })
              }
            >
              Accept all {suggestionsReady}
            </button>
          )}
        </div>

        {shown.length === 0 ? (
          <p className="muted rv-empty">
            {filter === 'open'
              ? state.threads.length === 0
                ? ui.isAuthor
                  ? 'No comments yet. Select words in the source or the PDF to comment on them, or send a review copy to your supervisor.'
                  : 'No comments yet. Select words in the PDF or the source to comment on them or suggest a change.'
                : 'Nothing open. Everything has been resolved, accepted or rejected.'
              : 'Resolved comments and decided suggestions appear here.'}
          </p>
        ) : (
          groups.map(([file, threads]) => (
            <section key={file} className="rv-group">
              <h3 className="rv-group-head">{file}</h3>
              {threads.map((thread) => (
                <div key={thread.id} data-card={thread.id}>
                  <ThreadCard
                    thread={thread}
                    review={model.review}
                    me={state.me}
                    isAuthor={ui.isAuthor}
                    canEdit={ui.canEdit}
                    currentText={ui.currentText(thread)}
                    where={ui.whereOf(thread, false)}
                    selected={state.selected === thread.id}
                    onOpen={() => model.review.select(thread.id, 'panel')}
                    withName={ui.withName}
                    now={ui.now}
                  />
                </div>
              ))}
            </section>
          ))
        )}
      </div>
      {sending && <SendForReviewDialog model={model} onClose={() => setSending(false)} />}
      {sendingBack && <SendBackDialog model={model} count={state.threads.filter((thread) => thread.author.id === state.me?.id).length} onClose={() => setSendingBack(false)} />}
    </>
  );
}

export function SendForReviewDialog(props: { model: WorkspaceModel; onClose: () => void }) {
  const { model } = props;
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const project = model.state.get().project.name;
  const url = siteUrl();
  const message = `Hello,\n\nhere is a review copy of "${project}". To read it and add comments or suggestions, open ${url} and drop the attached file onto the page (or choose "Open a review file"). You do not need an account or any knowledge of LaTeX: select words in the PDF and choose Comment or Suggest a change.\n\nWhen you are done, click "Send comments back" and send me the file it gives you.\n\nThank you!`;
  const download = (): void => {
    setBusy(true);
    model
      .reviewCopy(url)
      .then(({ name, bytes, compiled }) => {
        downloadBytes(name, bytes, 'application/octet-stream');
        setDone(name);
        if (!compiled) notify('The newest version did not compile, so the review copy has the last PDF that did.', { kind: 'error' });
      })
      .catch((error: unknown) => reportError(error, 'The review copy could not be made'))
      .finally(() => setBusy(false));
  };
  return (
    <Dialog title="Send for review" onClose={props.onClose}>
      <p>Your supervisor or a colleague can comment on the PDF and suggest changes, without an account and without knowing LaTeX.</p>
      <ol className="rv-steps">
        <li>
          <b>Download a review copy.</b> It holds the PDF, the text of your project and the comments so far. Pictures are not included: the PDF shows them.
          <div style={{ marginTop: 8 }}>
            <button className="btn primary" disabled={busy} onClick={download}>
              <Download size={15} /> {busy ? 'Compiling and packing…' : done ? 'Download again' : 'Download review copy'}
            </button>
          </div>
          {done && <p className="faint" style={{ marginTop: 6 }}>Saved as {done}.</p>}
        </li>
        <li>
          <b>Send it</b>, by email for example, with a short note:
          <textarea className="field rv-message" readOnly value={message} rows={6} onFocus={(event) => event.currentTarget.select()} />
          <button
            className="btn small"
            onClick={() =>
              void navigator.clipboard
                .writeText(message)
                .then(() => notify('The message is copied.'))
                .catch(() => notify('Select the text and copy it.'))
            }
          >
            Copy the message
          </button>
        </li>
        <li>
          <b>When their comments come back</b>, drop the file they send you onto this page, or choose "Add comments from a file" in the Review panel. Each comment appears where it was made, in the source and in the PDF.
        </li>
      </ol>
      <div className="actions">
        <button className="btn" onClick={props.onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}

export function SendBackDialog(props: { model: WorkspaceModel; count: number; onClose: () => void }) {
  const { model } = props;
  const copy = model.state.get().reviewCopy;
  const [done, setDone] = useState<string | null>(null);
  return (
    <Dialog title="Send your comments back" onClose={props.onClose}>
      <p>
        Download a file with your {props.count === 1 ? 'comment' : `${props.count} comments and suggestions`} and send it to {copy?.from.name ?? 'the author'}, by email for example.
        They drop it into their project and see every comment where you made it.
      </p>
      <p className="muted">Your comments also stay in this browser, so you can go on and send them again later.</p>
      {done && <p className="faint">Saved as {done}.</p>}
      <div className="actions">
        <button className="btn" onClick={props.onClose}>
          Close
        </button>
        <button
          className="btn primary"
          onClick={() =>
            model
              .commentsFile(siteUrl())
              .then(({ name, bytes }) => {
                downloadBytes(name, bytes, 'application/octet-stream');
                setDone(name);
              })
              .catch((error: unknown) => reportError(error, 'The file could not be made'))
          }
        >
          <Download size={15} /> Download comments
        </button>
      </div>
    </Dialog>
  );
}

export { isReviewFileName };
