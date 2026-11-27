/**
 * Everything the workspace needs for comments and suggestions: the marks for
 * the editor and the PDF, what happens when text is selected in either, and
 * the floating toolbar, composer and cards. Kept out of Workspace.tsx so the
 * workspace only wires it in.
 */
import { type ReactNode, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NeedNameError, type ResolvedThread } from '@/app/review-session';
import { reportError } from '@/app/services';
import type { WorkspaceModel } from '@/app/workspace-model';
import { forwardSearch, inverseSearch, type SyncTexMap } from '@/core/latex/synctex';
import { findInSource, findOnPage, planPlainEdit, plainOf, readableSelection } from '@/core/review/match';
import type { PdfHint, PdfRect } from '@/core/review/types';
import type { Path } from '@/core/types';
import { useTick } from '../common/ui';
import type { EditorSelection } from '../editor/CodeEditor';
import type { SourceMark } from '../editor/review-marks';
import { useStore } from '../hooks/useStore';
import type { PdfApi } from '../pdf/PdfView';
import type { SurfaceMark, SurfaceSelection } from '../pdf/pdf-surface';
import { Composer, NameDialog, Popover, SelectionBar } from './Floating';
import { ThreadCard } from './ThreadCard';

/** Where a new comment or suggestion goes. */
interface Target {
  /** The source range, when known. */
  source: { path: Path; from: number; to: number } | null;
  /** The PDF selection it was made on. */
  pdf: PdfHint | null;
  /** For a PDF selection that was found in the source: the words as the PDF shows them. */
  plain: string | null;
  /** The PDF selection was found only roughly in the source. */
  rough: boolean;
}

type Selected = { target: Target; box: DOMRect; quote: string };

interface ComposerState extends Selected {
  kind: 'comment' | 'suggest';
  initial: string;
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let index = text.indexOf('\n'); index >= 0 && index < offset; index = text.indexOf('\n', index + 1)) line++;
  return line;
}

function lineStart(text: string, line: number): number {
  let offset = 0;
  for (let current = 1; current < line; current++) {
    const next = text.indexOf('\n', offset);
    if (next < 0) return text.length;
    offset = next + 1;
  }
  return offset;
}

export interface ReviewUiInput {
  model: WorkspaceModel;
  pdfApi: RefObject<PdfApi | null>;
  /** The text file shown in the editor. */
  activePath: Path | null;
  syncMap: () => SyncTexMap | null;
  pdfVersion: number;
  hasPdf: boolean;
  /** Called when the source or the PDF should come into view on a narrow screen. */
  showPane: (pane: 'editor' | 'pdf') => void;
}

export function useReviewUi(input: ReviewUiInput) {
  const { model, pdfApi, activePath, syncMap, pdfVersion } = input;
  const review = model.review;
  const state = useStore(review.state);
  const workspace = useStore(model.state);
  const now = useTick(30_000);
  const [selection, setSelection] = useState<Selected | null>(null);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [popover, setPopover] = useState<{ id: string; box: DOMRect } | null>(null);
  const [askName, setAskName] = useState<{ then: () => void } | null>(null);
  const [pdfMarks, setPdfMarks] = useState<SurfaceMark[]>([]);
  const pendingScroll = useRef<string | null>(null);
  const showPane = useRef(input.showPane);
  useEffect(() => {
    showPane.current = input.showPane;
  });

  const isAuthor = state.role === 'author';
  const canEdit = !workspace.readOnly;
  const openThreads = useMemo(() => state.threads.filter((thread) => thread.status === 'open'), [state.threads]);
  const effectiveMode = isAuthor ? (workspace.readOnly ? 'edit' : state.mode) : state.mode === 'edit' ? 'comment' : state.mode;

  const withName = useCallback(
    (action: () => void): void => {
      if (review.state.get().me) action();
      else setAskName({ then: action });
    },
    [review],
  );

  // ---- marks in the editor ----------------------------------------------------------
  const sourceMarks = useMemo<SourceMark[]>(
    () =>
      openThreads
        .filter((thread) => thread.at && !thread.at.deleted && thread.at.path === activePath)
        .map((thread) => ({
          id: thread.id,
          from: thread.at!.from,
          to: thread.at!.to,
          kind: thread.kind,
          color: thread.author.color,
          replacement: thread.kind === 'suggestion' ? thread.replacement : null,
          active: thread.id === state.selected,
        })),
    [openThreads, activePath, state.selected],
  );

  // ---- marks in the PDF ----------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const api = pdfApi.current;
        if (!api || !input.hasPdf) {
          if (!cancelled) setPdfMarks([]);
          return;
        }
        const map = syncMap();
        const marks: SurfaceMark[] = [];
        for (const thread of openThreads) {
          const placed = await placeInPdf(thread, map, api, review.mirror.textOf(thread.at?.fileId ?? '') ?? null);
          if (cancelled) return;
          for (const part of placed) {
            marks.push({ id: thread.id, page: part.page, rects: part.rects, kind: thread.kind, color: thread.author.color, active: thread.id === state.selected });
          }
        }
        if (!cancelled) setPdfMarks(marks);
      })();
    }, 60);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [openThreads, state.selected, pdfVersion, syncMap, pdfApi, review, input.hasPdf]);

  // A thread chosen in the list or in one pane is shown in the others.
  useEffect(() => {
    return review.focus.on(({ id, from }) => {
      const thread = review.thread(id);
      if (!thread) return;
      if (from !== 'source' && thread.at && !thread.at.deleted) {
        const text = review.mirror.textOf(thread.at.fileId) ?? '';
        const line = lineOf(text, thread.at.from);
        void model.openFile(thread.at.path).then(() => model.reveal.emit({ path: thread.at!.path, line, range: { from: thread.at!.from, to: thread.at!.to }, keepFocus: true }));
      }
      if (from !== 'pdf' && !pdfApi.current?.scrollToMark(id)) pendingScroll.current = id;
    });
  }, [review, model, pdfApi]);
  useEffect(() => {
    const id = pendingScroll.current;
    if (id && pdfApi.current?.scrollToMark(id)) pendingScroll.current = null;
  }, [pdfMarks, pdfApi]);

  // ---- selections ---------------------------------------------------------------------------
  const onEditorSelection = useCallback(
    (selected: EditorSelection | null): void => {
      if (!selected) {
        setSelection((current) => (current?.target.pdf ? current : null));
        return;
      }
      const text = review.mirror.text(selected.path) ?? model.session.text(selected.path) ?? '';
      setSelection({
        target: { source: { path: selected.path, from: selected.from, to: selected.to }, pdf: null, plain: null, rough: false },
        box: selected.box,
        quote: text.slice(selected.from, selected.to),
      });
    },
    [review, model],
  );

  const onPdfSelection = useCallback(
    (selected: SurfaceSelection | null): void => {
      if (!selected) {
        setSelection((current) => (current?.target.pdf ? null : current));
        return;
      }
      const shown = readableSelection(selected.text);
      const pdf: PdfHint = { page: selected.page, rects: selected.rects, text: shown };
      void findSourceOf(model, syncMap(), selected).then((found) => {
        setSelection({
          target: { source: found ? { path: found.path, from: found.from, to: found.to } : null, pdf, plain: found?.plain ?? shown, rough: found ? !found.exact : false },
          box: selected.box,
          quote: shown,
        });
      });
    },
    [model, syncMap],
  );

  const clearSelections = (): void => {
    setSelection(null);
    pdfApi.current?.clearSelection();
  };

  const startComposer = (kind: 'comment' | 'suggest', selected: Selected, typed?: string): void => {
    withName(() => {
      const fromPdf = selected.target.pdf !== null;
      const initial = kind === 'comment' ? (typed ?? '') : typed !== undefined ? typed : fromPdf ? (selected.target.plain ?? selected.quote) : selected.quote;
      setComposer({ ...selected, kind, initial, quote: fromPdf ? (selected.target.plain ?? selected.quote) : selected.quote });
      setSelection(null);
    });
  };

  const onReviewType = useCallback(
    (typed: EditorSelection & { text: string }): void => {
      const text = review.mirror.text(typed.path) ?? model.session.text(typed.path) ?? '';
      let { from, to } = typed;
      const mode = effectiveMode === 'suggest' ? 'suggest' : 'comment';
      if (from === to && mode === 'comment') {
        // A comment needs words to be about: take the word at the cursor.
        while (from > 0 && /[\p{L}\p{N}]/u.test(text[from - 1] ?? '')) from--;
        while (to < text.length && /[\p{L}\p{N}]/u.test(text[to] ?? '')) to++;
        if (from === to) return;
      }
      if (from === to && typed.text === '') return;
      startComposer(mode, { target: { source: { path: typed.path, from, to }, pdf: null, plain: null, rough: false }, box: typed.box, quote: text.slice(from, to) }, typed.text);
    },
    // startComposer only uses state setters and withName.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [review, model, effectiveMode, withName],
  );

  const submit = async (draft: ComposerState, text: string, note: string): Promise<void> => {
    const { target } = draft;
    if (draft.kind === 'comment') {
      await review.comment({ path: target.source?.path ?? null, from: target.source?.from ?? 0, to: target.source?.to ?? 0, body: text, pdf: target.pdf });
      return;
    }
    if (target.pdf && target.source) {
      // Edited PDF words: make the same change in the source where that is safe.
      const source = await model.readText(target.source.path);
      const change = target.rough ? null : planPlainEdit(source, target.source, draft.quote, text);
      if (change) {
        await review.suggest({ path: target.source.path, from: change.from, to: change.to, replacement: change.insert, body: note, pdf: target.pdf });
      } else {
        await review.suggestPlain({ path: target.source.path, from: target.source.from, to: target.source.to, before: draft.quote, after: text, body: note, pdf: target.pdf });
      }
      return;
    }
    if (target.pdf) {
      await review.suggestPlain({ path: null, from: 0, to: 0, before: draft.quote, after: text, body: note, pdf: target.pdf });
      return;
    }
    if (target.source) await review.suggest({ path: target.source.path, from: target.source.from, to: target.source.to, replacement: text, body: note });
  };

  const openThread = (id: string, from: 'source' | 'pdf', box: DOMRect | null): void => {
    review.select(id, from);
    const anchor = box ?? pdfApi.current?.markBox(id) ?? null;
    if (anchor) setPopover({ id, box: anchor });
  };

  // A popover follows nothing; it closes when what it points at scrolls away.
  useEffect(() => {
    if (!popover && !selection) return;
    const onScroll = (event: Event): void => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('.rv-pop, .side')) return;
      setPopover(null);
      setSelection((current) => (current ? null : current));
    };
    document.addEventListener('scroll', onScroll, true);
    return () => document.removeEventListener('scroll', onScroll, true);
  }, [popover, selection]);

  const currentText = (thread: ResolvedThread): string | null =>
    thread.at && !thread.at.deleted ? (review.mirror.textOf(thread.at.fileId)?.slice(thread.at.from, thread.at.to) ?? null) : null;

  /** "Line 12" under its file in the list, "main.tex, line 12" on its own. */
  const whereOf = (thread: ResolvedThread, withFile: boolean): string | null => {
    if (!thread.at) return thread.pdf ? `PDF page ${thread.pdf.page}` : null;
    if (thread.at.deleted) return `${thread.at.path} (deleted)`;
    const text = review.mirror.textOf(thread.at.fileId);
    if (text === null) return withFile ? thread.at.path : null;
    const line = lineOf(text, thread.at.from);
    return withFile ? `${thread.at.path}, line ${line}` : `Line ${line}`;
  };

  const popoverThread = popover ? state.threads.find((thread) => thread.id === popover.id) : undefined;
  const sourceWhere = (target: Target): string | null => {
    if (!target.source) return target.pdf ? `PDF page ${target.pdf.page}, not found in the source` : null;
    const text = review.mirror.text(target.source.path) ?? model.session.text(target.source.path) ?? '';
    return `${target.source.path}, line ${lineOf(text, target.source.from)}`;
  };

  const overlay: ReactNode = (
    <>
      {selection && !composer && (
        <SelectionBar
          anchor={selection.box}
          primary={effectiveMode === 'suggest' ? 'suggest' : 'comment'}
          canSuggest={selection.target.source !== null || selection.target.pdf !== null}
          onComment={() => startComposer('comment', selection)}
          onSuggest={() => startComposer('suggest', selection)}
        />
      )}
      {composer && (
        <Composer
          key={`${composer.kind}:${composer.box.top}:${composer.box.left}`}
          anchor={composer.box}
          kind={composer.kind}
          quote={composer.quote}
          initial={composer.initial}
          where={sourceWhere(composer.target)}
          hint={
            composer.kind === 'suggest' && composer.target.pdf && (!composer.target.source || composer.target.rough)
              ? 'This passage could not be matched word for word in the source, so the author will make the change by hand.'
              : undefined
          }
          onCancel={() => setComposer(null)}
          onSubmit={(text, note) => {
            const draft = composer;
            setComposer(null);
            clearSelections();
            submit(draft, text, note).catch((error: unknown) => {
              if (error instanceof NeedNameError) setAskName({ then: () => void submit(draft, text, note).catch((again: unknown) => reportError(again)) });
              else reportError(error, 'The comment could not be saved');
            });
          }}
        />
      )}
      {popover && popoverThread && (
        <Popover anchor={popover.box} onClose={() => setPopover(null)}>
          <ThreadCard
            thread={popoverThread}
            review={review}
            me={state.me}
            isAuthor={isAuthor}
            canEdit={canEdit}
            currentText={currentText(popoverThread)}
            where={whereOf(popoverThread, true)}
            withName={withName}
            now={now}
          />
        </Popover>
      )}
      {askName && (
        <NameDialog
          initial={state.me?.name}
          onClose={() => setAskName(null)}
          onSave={(name) => {
            const then = askName.then;
            setAskName(null);
            review
              .setMe(name)
              .then(() => then())
              .catch((error: unknown) => reportError(error));
          }}
        />
      )}
    </>
  );

  return {
    state,
    isAuthor,
    canEdit,
    openCount: openThreads.length,
    effectiveMode,
    withName,
    currentText,
    whereOf,
    now,
    editorProps: {
      marks: sourceMarks,
      reviewMode: effectiveMode as 'edit' | 'comment' | 'suggest',
      onMarkClick: (id: string, box: DOMRect) => openThread(id, 'source', box),
      onSelection: onEditorSelection,
      onReviewType,
    },
    pdfProps: {
      marks: pdfMarks,
      onSelectText: onPdfSelection,
      onMarkClick: (id: string) => openThread(id, 'pdf', null),
    },
    overlay,
    askName: (then: () => void) => setAskName({ then }),
  };
}

/** Finds the source of a PDF selection: SyncTeX names the lines, the words narrow it down. */
async function findSourceOf(model: WorkspaceModel, map: SyncTexMap | null, selected: SurfaceSelection): Promise<{ path: Path; from: number; to: number; exact: boolean; plain: string } | null> {
  if (!map) return null;
  const start = inverseSearch(map, selected.start.page, selected.start.x, selected.start.y);
  const end = inverseSearch(map, selected.end.page, selected.end.x, selected.end.y);
  const spot = start ?? end;
  if (!spot) return null;
  const path = spot.file;
  let text: string;
  try {
    text = await model.readText(path);
  } catch {
    return null;
  }
  const first = Math.max(1, Math.min(spot.line, end && end.file === path ? end.line : spot.line) - 3);
  const last = Math.max(spot.line, end && end.file === path ? end.line : spot.line) + 3;
  const window = { from: lineStart(text, first), to: lineStart(text, last + 1) };
  const near = lineStart(text, spot.line);
  const found = findInSource(text, selected.text, { window, near }) ?? findInSource(text, selected.text, { near });
  return found ? { path, ...found } : null;
}

/** Where a thread shows in the PDF: the words it is about on the lines SyncTeX names, or where it was made. */
async function placeInPdf(thread: ResolvedThread, map: SyncTexMap | null, api: PdfApi, fileText: string | null): Promise<{ page: number; rects: PdfRect[] }[]> {
  if (thread.at && !thread.at.deleted && map && fileText !== null) {
    const firstLine = lineOf(fileText, thread.at.from);
    const lastLine = Math.min(lineOf(fileText, thread.at.to), firstLine + 40);
    const byPage = new Map<number, PdfRect[]>();
    for (let line = firstLine; line <= lastLine; line++) {
      const spot = forwardSearch(map, thread.at.path, line);
      if (!spot) continue;
      const rects = byPage.get(spot.page) ?? [];
      for (const rect of spot.rects) if (!rects.some((known) => Math.abs(known.top - rect.top) < 0.5 && Math.abs(known.left - rect.left) < 0.5)) rects.push(rect);
      byPage.set(spot.page, rects);
    }
    if (byPage.size > 0) {
      const words = plainOf(fileText.slice(thread.at.from, thread.at.to));
      const placed: { page: number; rects: PdfRect[] }[] = [];
      for (const [page, lines] of byPage) {
        const found = words.length >= 2 ? findOnPage(await api.pageText(page), words, lines) : null;
        placed.push({ page, rects: found ?? lines });
        // The words are on one page; once found there, the other pages are only SyncTeX's guess.
        if (found) return [{ page, rects: found }];
      }
      return placed;
    }
  }
  if (thread.pdf) return [{ page: thread.pdf.page, rects: thread.pdf.rects }];
  return [];
}
