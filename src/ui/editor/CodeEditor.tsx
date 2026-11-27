import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, HighlightStyle, indentOnInput, indentUnit, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { type Diagnostic as EditorDiagnostic, lintGutter, setDiagnostics } from '@codemirror/lint';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { useEffect, useRef } from 'react';
import type { ProjectIndex } from '@/app/project-index';
import type { Reveal, WorkspaceModel } from '@/app/workspace-model';
import { explain } from '@/core/latex/log';
import { dirname } from '@/core/paths';
import type { Diagnostic, Path } from '@/core/types';
import type { TextChange } from '@/core/review/text-diff';
import { latexCompletions } from './completion';
import { findWordNear } from './find-word';
import { reviewMarks, setSourceMarks, type SourceMark } from './review-marks';

const highlight = HighlightStyle.define([
  { tag: tags.tagName, color: 'var(--syn-command)' },
  { tag: tags.keyword, color: 'var(--syn-keyword)' },
  { tag: tags.comment, color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: tags.special(tags.variableName), color: 'var(--syn-math)' },
  { tag: tags.number, color: 'var(--syn-math)' },
  { tag: tags.atom, color: 'var(--syn-string)' },
  { tag: tags.bracket, color: 'var(--syn-bracket)' },
]);

// Colours come from the CSS tokens, so the editor follows light and dark mode by itself.
const theme = EditorView.theme({
  '&': { color: 'var(--ink)', backgroundColor: 'var(--paper)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-content': { caretColor: 'var(--accent)', padding: '10px 0 40vh' },
  '.cm-line': { padding: '0 14px 0 6px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--accent-soft)',
  },
  '.cm-gutters': { backgroundColor: 'var(--paper)', color: 'var(--ink-faint)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px', minWidth: '34px' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--paper-hover) 40%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--ink)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--accent-soft)',
    outline: '1px solid var(--line-strong)',
  },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--accent-soft) 60%, transparent)' },
  '.cm-searchMatch': { backgroundColor: 'var(--warn-soft)', outline: '1px solid var(--warn)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--accent-soft)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--paper-raised)',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    borderRadius: '6px',
    boxShadow: 'var(--shadow)',
    fontFamily: 'var(--font-ui)',
  },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', fontSize: '12.5px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent-soft)', color: 'var(--ink)' },
  '.cm-completionDetail': { color: 'var(--ink-faint)', fontStyle: 'normal', fontFamily: 'var(--font-ui)' },
  '.cm-tooltip-lint': { padding: '2px 0' },
  '.cm-diagnostic': { whiteSpace: 'pre-wrap', maxWidth: '520px', padding: '6px 10px' },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--danger)' },
  '.cm-diagnostic-warning': { borderLeftColor: 'var(--warn)' },
  '.cm-diagnostic-info': { borderLeftColor: 'var(--info)' },
  '.cm-panels': { backgroundColor: 'var(--paper-sunk)', color: 'var(--ink)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  '.cm-panel.cm-search': { padding: '6px 10px', fontFamily: 'var(--font-ui)', fontSize: '13px' },
  '.cm-textfield': {
    backgroundColor: 'var(--paper-raised)',
    border: '1px solid var(--line-strong)',
    borderRadius: '5px',
    color: 'var(--ink)',
    fontSize: '13px',
  },
  '.cm-button': {
    backgroundImage: 'none',
    backgroundColor: 'var(--paper-raised)',
    border: '1px solid var(--line-strong)',
    borderRadius: '5px',
    color: 'var(--ink)',
    fontSize: '13px',
  },
  '.cm-panel.cm-search [name=close]': { color: 'var(--ink-soft)', fontSize: '18px' },
});

function toEditorDiagnostics(state: EditorState, diagnostics: Diagnostic[], path: Path): EditorDiagnostic[] {
  const out: EditorDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.file !== path || diagnostic.line === null) continue;
    if (diagnostic.line < 1 || diagnostic.line > state.doc.lines) continue;
    const line = state.doc.line(diagnostic.line);
    const leading = line.text.length - line.text.trimStart().length;
    const explained = explain(diagnostic);
    out.push({
      from: Math.min(line.from + leading, line.to),
      to: line.to,
      severity: diagnostic.severity,
      message: explained ? `${explained.headline}\n${explained.hint}` : diagnostic.message,
    });
  }
  return out;
}

export interface CodeEditorProps {
  model: WorkspaceModel;
  path: Path;
  readOnly: boolean;
  /** See WorkspaceState.buffersVersion. */
  buffersVersion: number;
  diagnostics: Diagnostic[];
  /** Paths with an open tab. Editing state of other files is dropped. */
  openPaths: Path[];
  getIndex: () => ProjectIndex | null;
  onCursor?: (line: number, column: number) => void;
  /** Comments and suggestions on the file shown. */
  marks?: SourceMark[];
  /** 'comment' and 'suggest' stop typing from changing the text; it starts a comment or a suggestion instead. */
  reviewMode?: 'edit' | 'comment' | 'suggest';
  onMarkClick?: (id: string, box: DOMRect) => void;
  /** The selection changed, once the mouse is up. Null when nothing is selected. */
  onSelection?: (selection: EditorSelection | null) => void;
  /** Typing or pasting in a review mode. */
  onReviewType?: (input: EditorSelection & { text: string }) => void;
}

export interface EditorSelection {
  path: Path;
  from: number;
  to: number;
  /** Where the selection ends on screen. */
  box: DOMRect;
}

function boxAt(view: EditorView, pos: number): DOMRect {
  const coords = view.coordsAtPos(pos) ?? view.coordsAtPos(Math.max(0, pos - 1));
  if (!coords) return view.dom.getBoundingClientRect();
  return new DOMRect(coords.left, coords.top, Math.max(1, coords.right - coords.left), coords.bottom - coords.top);
}

/**
 * The source editor. One CodeMirror view is kept for the whole workspace and
 * each open file has its own editor state (text, undo history, selection),
 * which is swapped in when its tab becomes active.
 */
export function CodeEditor(props: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const states = useRef(new Map<Path, EditorState>());
  const shown = useRef<{ path: Path; version: number } | null>(null);
  const pendingReveal = useRef<Reveal | null>(null);
  const readOnlyCompartment = useRef(new Compartment());
  const pointerDown = useRef(false);
  const lastSelection = useRef<string>('');
  const reportSelection = (view: EditorView): void => {
    const current = shown.current;
    const { from, to } = view.state.selection.main;
    const key = current && from !== to ? `${current.path}:${from}:${to}` : '';
    if (key === lastSelection.current) return;
    lastSelection.current = key;
    latest.current.onSelection?.(current && from !== to ? { path: current.path, from, to, box: boxAt(view, to) } : null);
  };
  const tools = useRef<{ makeState: (text: string) => EditorState; jump: (reveal: Reveal) => void } | null>(null);
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  const { model, path, buffersVersion, readOnly, diagnostics, openPaths, marks, reviewMode = 'edit' } = props;

  // The view itself, created once per workspace.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const readOnlyExtension = readOnlyCompartment.current;

    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      history(),
      drawSelection(),
      indentOnInput(),
      indentUnit.of('  '),
      EditorState.tabSize.of(2),
      bracketMatching(),
      closeBrackets(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      lintGutter(),
      EditorView.lineWrapping,
      StreamLanguage.define(stex),
      syntaxHighlighting(highlight),
      theme,
      autocompletion({
        override: [
          latexCompletions({
            index: () => latest.current.getIndex(),
            workDir: () => dirname(latest.current.model.mainFile() ?? ''),
          }),
        ],
        icons: false,
      }),
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            void latest.current.model.session.flush().catch(() => undefined);
            return true;
          },
        },
        {
          key: 'Mod-Enter',
          preventDefault: true,
          run: () => {
            void latest.current.model.compileNow();
            return true;
          },
        },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...completionKeymap,
        indentWithTab,
      ]),
      readOnlyExtension.of([]),
      reviewMarks({
        mode: () => (latest.current.readOnly ? 'locked' : (latest.current.reviewMode ?? 'edit')),
        onMarkClick: (id, box) => latest.current.onMarkClick?.(id, box),
        onType: (view, text) => {
          const current = shown.current;
          if (!current) return;
          const { from, to } = view.state.selection.main;
          latest.current.onReviewType?.({ path: current.path, from, to, box: boxAt(view, to), text });
        },
      }),
      EditorView.contentAttributes.of({ 'aria-label': 'LaTeX source', spellcheck: 'true' }),
      EditorView.updateListener.of((update) => {
        const current = shown.current;
        if (!current) return;
        if (update.docChanged) {
          const changes: TextChange[] = [];
          update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => changes.push({ from: fromA, to: toA, insert: inserted.toString() }));
          latest.current.model.edit(current.path, update.state.doc.toString(), changes);
        }
        if (update.selectionSet || update.docChanged) {
          const head = update.state.selection.main.head;
          const line = update.state.doc.lineAt(head);
          latest.current.onCursor?.(line.number, head - line.from + 1);
        }
        if (update.selectionSet && !pointerDown.current) reportSelection(update.view);
      }),
      EditorView.domEventHandlers({
        mousedown: () => {
          pointerDown.current = true;
          const up = (): void => {
            pointerDown.current = false;
            window.removeEventListener('mouseup', up);
            // The selection is final once the button is up.
            requestAnimationFrame(() => {
              if (viewRef.current) reportSelection(viewRef.current);
            });
          };
          window.addEventListener('mouseup', up);
          return false;
        },
      }),
    ];

    const view = new EditorView({ parent: host, state: EditorState.create({ doc: '', extensions }) });
    viewRef.current = view;
    const cache = states.current;
    const jump = (reveal: Reveal): void => {
      const doc = view.state.doc;
      if (reveal.range) {
        const from = Math.min(reveal.range.from, doc.length);
        // Selecting the range would open the comment toolbar; the cursor goes to its start, and the range is marked anyway.
        view.dispatch({ selection: { anchor: from }, effects: EditorView.scrollIntoView(from, { y: 'center' }) });
        if (!reveal.keepFocus) view.focus();
        return;
      }
      const lineNumber = Math.max(1, Math.min(reveal.line, doc.lines));
      const found = reveal.word ? findWordNear((number) => (number >= 1 && number <= doc.lines ? doc.line(number).text : null), lineNumber, reveal.word) : null;
      const line = doc.line(found?.line ?? lineNumber);
      const selection = found ? { anchor: line.from + found.at, head: line.from + found.at + reveal.word!.length } : { anchor: line.from };
      view.dispatch({ selection, effects: EditorView.scrollIntoView(selection.anchor, { y: 'center' }) });
      if (!reveal.keepFocus) view.focus();
    };
    // Changes the model makes to text the editor holds, such as an accepted suggestion, go through the editor.
    model.setEditorBridge({
      apply: (target, change) => {
        if (shown.current?.path === target) {
          view.dispatch({ changes: change, userEvent: 'input.review' });
          return true;
        }
        const cached = cache.get(target);
        if (!cached) return false;
        const next = cached.update({ changes: change, userEvent: 'input.review' }).state;
        cache.set(target, next);
        latest.current.model.edit(target, next.doc.toString(), [change]);
        return true;
      },
    });
    // Every file's state is built from the same extension list.
    tools.current = { makeState: (text) => EditorState.create({ doc: text, extensions }), jump };
    const offReveal = model.reveal.on((reveal) => {
      if (shown.current?.path === reveal.path) jump(reveal);
      else pendingReveal.current = reveal;
    });

    return () => {
      offReveal();
      model.setEditorBridge(null);
      view.destroy();
      viewRef.current = null;
      tools.current = null;
      shown.current = null;
      cache.clear();
    };
  }, [model]);

  // Swap in the state of the active file.
  useEffect(() => {
    const view = viewRef.current;
    const helpers = tools.current;
    if (!view || !helpers) return;
    const cache = states.current;
    const previous = shown.current;
    if (previous && previous.version !== buffersVersion) {
      // Files were replaced underneath the editor (restore, folder sync): start from the new text.
      cache.clear();
    } else if (previous && previous.path !== path) {
      cache.set(previous.path, view.state);
    }
    if (!previous || previous.path !== path || previous.version !== buffersVersion) {
      const state = cache.get(path) ?? helpers.makeState(model.session.text(path) ?? '');
      cache.delete(path);
      shown.current = null; // setState must not be reported as an edit
      view.setState(state);
      shown.current = { path, version: buffersVersion };
      const head = state.selection.main.head;
      const line = state.doc.lineAt(head);
      latest.current.onCursor?.(line.number, head - line.from + 1);
    }
    // In a review mode the text can be selected and the cursor moved, but typing makes a comment or a suggestion.
    view.dispatch({
      effects: readOnlyCompartment.current.reconfigure(
        readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : reviewMode !== 'edit' ? [EditorState.readOnly.of(true)] : [],
      ),
    });
    view.dispatch(setDiagnostics(view.state, toEditorDiagnostics(view.state, diagnostics, path)));
    const reveal = pendingReveal.current;
    if (reveal && reveal.path === path) {
      pendingReveal.current = null;
      helpers.jump(reveal);
    }
  }, [model, path, buffersVersion, readOnly, diagnostics, reviewMode]);

  // Comments and suggestions of the file shown.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !shown.current) return;
    view.dispatch({ effects: setSourceMarks.of(marks ?? []) });
  }, [marks, path, buffersVersion]);

  // Forget the editing state of files whose tab was closed.
  useEffect(() => {
    const open = new Set(openPaths);
    for (const key of [...states.current.keys()]) if (!open.has(key)) states.current.delete(key);
  }, [openPaths]);

  return <div className="editor-host" ref={hostRef} />;
}

