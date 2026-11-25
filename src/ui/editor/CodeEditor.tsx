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
import { latexCompletions } from './completion';

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
  const tools = useRef<{ makeState: (text: string) => EditorState; jump: (reveal: Reveal) => void } | null>(null);
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  const { model, path, buffersVersion, readOnly, diagnostics, openPaths } = props;

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
      EditorView.contentAttributes.of({ 'aria-label': 'LaTeX source', spellcheck: 'true' }),
      EditorView.updateListener.of((update) => {
        const current = shown.current;
        if (!current) return;
        if (update.docChanged) latest.current.model.edit(current.path, update.state.doc.toString());
        if (update.selectionSet || update.docChanged) {
          const head = update.state.selection.main.head;
          const line = update.state.doc.lineAt(head);
          latest.current.onCursor?.(line.number, head - line.from + 1);
        }
      }),
    ];

    const view = new EditorView({ parent: host, state: EditorState.create({ doc: '', extensions }) });
    viewRef.current = view;
    const cache = states.current;
    const jump = (reveal: Reveal): void => {
      const lineNumber = Math.max(1, Math.min(reveal.line, view.state.doc.lines));
      const line = view.state.doc.line(lineNumber);
      view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
      view.focus();
    };
    // Every file's state is built from the same extension list.
    tools.current = { makeState: (text) => EditorState.create({ doc: text, extensions }), jump };
    const offReveal = model.reveal.on((reveal) => {
      if (shown.current?.path === reveal.path) jump(reveal);
      else pendingReveal.current = reveal;
    });

    return () => {
      offReveal();
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
    view.dispatch({
      effects: readOnlyCompartment.current.reconfigure(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
    });
    view.dispatch(setDiagnostics(view.state, toEditorDiagnostics(view.state, diagnostics, path)));
    const reveal = pendingReveal.current;
    if (reveal && reveal.path === path) {
      pendingReveal.current = null;
      helpers.jump(reveal);
    }
  }, [model, path, buffersVersion, readOnly, diagnostics]);

  // Forget the editing state of files whose tab was closed.
  useEffect(() => {
    const open = new Set(openPaths);
    for (const key of [...states.current.keys()]) if (!open.has(key)) states.current.delete(key);
  }, [openPaths]);

  return <div className="editor-host" ref={hostRef} />;
}
