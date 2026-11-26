import {
  ArrowLeft,
  CircleX,
  ClockArrowUp,
  Download,
  Ellipsis,
  Files,
  HardDrive,
  Info,
  ListTree,
  PanelBottom,
  Play,
  Sparkles,
  Square,
  TriangleAlert,
  X,
} from 'lucide-react';
import { type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildProjectIndex, type ProjectIndex } from '@/app/project-index';
import { notify, reportError, type Services } from '@/app/services';
import type { SidePanel, Tab, WorkspaceModel } from '@/app/workspace-model';
import { NO_MAIN_FILE } from '@/core/engine/compile';
import type { EngineStatus } from '@/core/engine/types';
import { outputPdfPath } from '@/core/latex/deps';
import { explain } from '@/core/latex/log';
import { basename, extname } from '@/core/paths';
import type { GitHubState } from '@/app/github-backup';
import type { FolderState } from '@/core/fsa/sync';
import type { SaveState } from '@/core/session/session';
import type { Diagnostic, Path, ProjectMeta } from '@/core/types';
import { Dialog, downloadBytes, formatAgo, formatBytes, Menu, useTick } from '../common/ui';
import { CodeEditor } from '../editor/CodeEditor';
import { useStore } from '../hooks/useStore';
import { PdfView } from '../pdf/PdfView';
import { FileTree } from './FileTree';
import { FolderCard } from './FolderCard';
import { GitHubCard } from './GitHubCard';
import { HistoryPanel, OutlinePanel, StoragePanel } from './Panels';
import { APP_NAME } from '@/app/brand';
import { AskClaude } from './AskClaude';

interface Layout {
  side: number;
  right: number;
  bottom: number;
}

const LAYOUT_KEY = 'latex-editor:layout';

function loadLayout(): Layout {
  const fallback: Layout = { side: 250, right: Math.round(window.innerWidth * 0.42), bottom: 190 };
  try {
    const stored = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null') as Partial<Layout> | null;
    if (stored && typeof stored.side === 'number' && typeof stored.right === 'number' && typeof stored.bottom === 'number') {
      return { side: stored.side, right: stored.right, bottom: stored.bottom };
    }
  } catch {
    // Fall through to the defaults.
  }
  return fallback;
}

function Gutter(props: { horizontal?: boolean; label: string; onDrag: (delta: number) => void; onDone: () => void }) {
  const last = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const position = (event: ReactPointerEvent): number => (props.horizontal ? event.clientY : event.clientX);
  return (
    <div
      className={`gutter ${props.horizontal ? 'h' : ''} ${dragging ? 'dragging' : ''}`}
      role="separator"
      aria-orientation={props.horizontal ? 'horizontal' : 'vertical'}
      aria-label={props.label}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        last.current = position(event);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (last.current === null) return;
        const now = position(event);
        props.onDrag(now - last.current);
        last.current = now;
      }}
      onPointerUp={() => {
        last.current = null;
        setDragging(false);
        props.onDone();
      }}
      onPointerCancel={() => {
        last.current = null;
        setDragging(false);
      }}
    />
  );
}

/** Says in words where the work is, as the spec asks: never just an icon. */
function saveChip(save: SaveState, project: ProjectMeta, folder: FolderState, github: GitHubState, now: number): { dot: string; text: string; title: string } {
  if (save.status === 'failed') {
    return { dot: 'red', text: `Not saved: ${save.error ?? 'unknown problem'}`, title: 'The last change could not be saved. Download a ZIP to be safe.' };
  }
  if (save.status === 'saving' || save.status === 'unsaved') return { dot: 'grey', text: 'Saving…', title: 'Changes are saved a moment after you stop typing.' };
  const name = folder.folderName ?? project.link?.folderName ?? null;
  if (name !== null) {
    switch (folder.status) {
      case 'needs-permission':
        return { dot: 'amber', text: 'Folder needs reconnecting', title: `Saved in this browser. The browser needs your permission again to write to the folder ${name}.` };
      case 'error':
        return { dot: 'red', text: 'Folder cannot be reached', title: `Saved in this browser. The folder ${name} could not be read; it may have been moved or deleted.` };
      case 'attention':
        return { dot: 'amber', text: 'Folder needs a look', title: 'Saved in this browser. Open "Saving and backup" to see what the folder needs.' };
      case 'syncing':
        return { dot: 'grey', text: `Saving to folder ${name}…`, title: 'Saved in this browser; the folder is being updated.' };
      case 'off':
        break;
      default:
        return { dot: '', text: `Saved to folder ${name}`, title: 'Saved in this browser and written to the linked folder on this computer.' };
    }
  }
  if (github.status !== 'off' && github.settings) {
    const where = `${github.settings.target.owner}/${github.settings.target.repo}`;
    if (github.status === 'failed') return { dot: 'amber', text: 'GitHub backup did not work', title: `Saved in this browser. ${github.error ?? ''}` };
    if (github.settings.lastBackupAt) {
      return {
        dot: github.behind ? 'amber' : '',
        text: `Backed up to GitHub ${formatAgo(github.settings.lastBackupAt, now)}`,
        title: `Saved in this browser and backed up to ${where}.${github.behind ? ' There are changes since that backup.' : ''}`,
      };
    }
  }
  return {
    dot: 'amber',
    text: 'Saved in this browser only',
    title: 'Saved in this browser on this device. Nothing is backed up elsewhere. Open "Saving and backup" for options.',
  };
}

function engineText(status: EngineStatus): string {
  const loaded = status.downloadedBytes > 0 ? ` (${formatBytes(status.downloadedBytes)} loaded)` : '';
  switch (status.phase) {
    case 'loading':
      return `${status.detail ?? 'Loading the LaTeX engine'}${loaded}`;
    case 'compiling':
      return status.detail ?? 'Compiling';
    case 'ready':
      return 'LaTeX engine ready';
    case 'failed':
      return status.detail ?? 'The LaTeX engine could not be loaded';
    default:
      return '';
  }
}

function FilePreview(props: { model: WorkspaceModel; tab: Tab }) {
  const { model, tab } = props;
  const [url, setUrl] = useState<string | null>(null);
  const [size, setSize] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    let created: string | null = null;
    model
      .readBytes(tab.path)
      .then((bytes) => {
        if (cancelled) return;
        setSize(bytes.byteLength);
        if (tab.kind !== 'image') return;
        const type = extname(tab.path) === '.svg' ? 'image/svg+xml' : '';
        created = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
        setUrl(created);
      })
      .catch((error: unknown) => reportError(error));
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
      setUrl(null);
    };
  }, [model, tab.path, tab.kind]);
  if (tab.kind === 'image') return <div className="preview-file">{url && <img src={url} alt={basename(tab.path)} />}</div>;
  return (
    <div className="editor-empty">
      <div>
        <p>
          <b>{basename(tab.path)}</b> {size !== null && `(${formatBytes(size)})`}
        </p>
        <p style={{ marginTop: 6 }}>
          {tab.kind === 'pdf' ? 'PDF files in the project can be used as figures.' : 'This file is not text, so it cannot be edited here.'}
        </p>
        <button
          className="btn small"
          style={{ marginTop: 12 }}
          onClick={() => void model.readBytes(tab.path).then((bytes) => downloadBytes(basename(tab.path), bytes, 'application/octet-stream'))}
        >
          <Download size={14} /> Download
        </button>
      </div>
    </div>
  );
}

function Problems(props: {
  diagnostics: Diagnostic[];
  ok: boolean | null;
  error: string | null;
  onOpen: (file: Path, line: number) => void;
  onAsk: (diagnostic: Diagnostic) => void;
}) {
  if (props.diagnostics.length === 0) {
    return <p className="all-good">{props.ok === null ? 'Problems appear here after the first compile.' : props.ok ? 'No problems found.' : (props.error ?? 'The compile failed.')}</p>;
  }
  return (
    <ul className="problems">
      {props.diagnostics.map((diagnostic, position) => {
        const explained = explain(diagnostic);
        const Icon = diagnostic.severity === 'error' ? CircleX : diagnostic.severity === 'warning' ? TriangleAlert : Info;
        return (
          <li key={position} className="problem-row">
            <button
              className="problem"
              disabled={diagnostic.file === null}
              onClick={() => diagnostic.file && props.onOpen(diagnostic.file, diagnostic.line ?? 1)}
            >
              <span className={`sev ${diagnostic.severity}`}>
                <Icon size={15} />
              </span>
              <span>
                <span className="headline">{explained?.headline ?? diagnostic.message}</span>
                {diagnostic.file && (
                  <span className="where-line">
                    {' '}
                    {diagnostic.file}
                    {diagnostic.line !== null ? `:${diagnostic.line}` : ''}
                  </span>
                )}
                {explained && <span className="hint" style={{ display: 'block' }}>{explained.hint}</span>}
                {explained && <span className="rawmsg" style={{ display: 'block' }}>{diagnostic.message}</span>}
                {diagnostic.context && <span className="rawmsg" style={{ display: 'block' }}>{diagnostic.context}</span>}
              </span>
            </button>
            <button className="btn small quiet ask" title="Ask Claude about this problem" onClick={() => props.onAsk(diagnostic)}>
              <Sparkles size={13} /> Ask Claude
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function ProjectSettings(props: { model: WorkspaceModel; project: ProjectMeta; texFiles: Path[]; detected: Path | null; onClose: () => void }) {
  const { project } = props;
  const [name, setName] = useState(project.name);
  const [mainFile, setMainFile] = useState(project.mainFile ?? '');
  const [autoCompile, setAutoCompile] = useState(project.autoCompile);
  return (
    <Dialog title="Project settings" onClose={props.onClose}>
      <form
        style={{ display: 'grid', gap: 14 }}
        onSubmit={(event) => {
          event.preventDefault();
          props.onClose();
          props.model
            .updateProject({ name: name.trim() || project.name, mainFile: mainFile === '' ? null : mainFile, autoCompile })
            .catch((error: unknown) => reportError(error));
        }}
      >
        <label className="stack">
          Name
          <input className="field" value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="stack">
          Main document
          <select className="field" value={mainFile} onChange={(event) => setMainFile(event.target.value)}>
            <option value="">Find it automatically{props.detected ? ` (now ${props.detected})` : ''}</option>
            {props.texFiles.map((path) => (
              <option key={path} value={path}>
                {path}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={autoCompile} onChange={(event) => setAutoCompile(event.target.checked)} />
          Compile automatically a moment after I stop typing
        </label>
        <p className="muted" style={{ fontSize: 13 }}>
          Documents are compiled with pdfLaTeX and BibTeX, inside this browser.
        </p>
        <div className="actions" style={{ marginTop: 4 }}>
          <button type="button" className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            Save
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export interface WorkspaceProps {
  model: WorkspaceModel;
  services: Services;
  onHome: () => void;
  /** Extra cards for the "Saving and backup" panel. */
  storageExtras?: ReactNode;
}

export function Workspace(props: WorkspaceProps) {
  const { model, services } = props;
  const state = useStore(model.state);
  const save = useStore(model.session.saveState);
  const compile = useStore(model.compile.state);
  const engine = useStore(services.engine.status);
  const folder = useStore(model.folder.state);
  const github = useStore(model.github.state);
  const now = useTick(30_000);

  const [layout, setLayout] = useState(loadLayout);
  const [pane, setPane] = useState<'files' | 'editor' | 'pdf'>('editor');
  const [cursor, setCursor] = useState<{ line: number; column: number } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [asking, setAsking] = useState<{ problem: Diagnostic | null } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [recoveredNote, setRecoveredNote] = useState(model.recovered.length > 0);
  const [index, setIndex] = useState<ProjectIndex | null>(null);
  const indexRef = useRef<ProjectIndex | null>(null);

  const mainFile = state.project.mainFile ?? compile.mainFile;
  const running = compile.phase === 'running';
  const activeTab = state.tabs.find((tab) => tab.path === state.active) ?? null;
  const openPaths = useMemo(() => state.tabs.map((tab) => tab.path), [state.tabs]);
  // The log's "Info" lines are bookkeeping of packages, not something to act on.
  const problems = useMemo(() => compile.diagnostics.filter((diagnostic) => diagnostic.severity !== 'info'), [compile.diagnostics]);

  // The editor stays mounted while a picture is shown, so undo history survives.
  const [textPath, setTextPath] = useState<Path | null>(null);
  const wantedTextPath =
    activeTab?.kind === 'text'
      ? activeTab.path
      : textPath !== null && state.tabs.some((tab) => tab.path === textPath && tab.kind === 'text')
        ? textPath
        : null;
  if (wantedTextPath !== textPath) setTextPath(wantedTextPath);

  // Outline, labels and citation keys, rebuilt a moment after files change.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      buildProjectIndex(services.vault, model.session, model.projectId, state.entries, mainFile)
        .then((built) => {
          if (cancelled) return;
          indexRef.current = built;
          setIndex(built);
        })
        .catch(() => undefined);
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [services, model, state.entries, mainFile, save.lastSavedAt]);

  const getIndex = useCallback(() => indexRef.current, []);
  const onCursor = useCallback((line: number, column: number) => setCursor({ line, column }), []);

  const persistLayout = useCallback(() => {
    setLayout((current) => {
      try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(current));
      } catch {
        // Not being able to remember pane sizes is harmless.
      }
      return current;
    });
  }, []);

  // Keys that should work wherever the focus is.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.defaultPrevented) return;
      if (event.key === 's') {
        event.preventDefault();
        void model.session.flush().catch(() => undefined);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        void model.compileNow();
      }
    };
    const onLeave = (event: BeforeUnloadEvent): void => {
      // Unsaved text is also written to the crash journal; only a failed save needs a warning.
      if (model.session.saveState.get().status === 'failed') event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', onLeave);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', onLeave);
    };
  }, [model]);

  useEffect(() => {
    document.title = `${state.project.name} · ${APP_NAME}`;
    return () => {
      document.title = `${APP_NAME} · LaTeX editor`;
    };
  }, [state.project.name]);

  const chip = saveChip(save, state.project, folder, github, now);
  const texFiles = useMemo(
    () => state.entries.filter((entry) => entry.kind === 'file' && extname(entry.path) === '.tex').map((entry) => entry.path).sort(),
    [state.entries],
  );
  const pdfName = mainFile ? basename(outputPdfPath(mainFile)) : 'document.pdf';

  const exportZip = (): void => {
    model
      .exportZip()
      .then(({ name, bytes }) => downloadBytes(name, bytes, 'application/zip'))
      .catch((error: unknown) => reportError(error, 'The ZIP could not be created'));
  };

  const rail: { id: SidePanel; label: string; icon: ReactNode }[] = [
    { id: 'files', label: 'Files', icon: <Files size={18} /> },
    { id: 'outline', label: 'Outline', icon: <ListTree size={18} /> },
    { id: 'history', label: 'History', icon: <ClockArrowUp size={18} /> },
    { id: 'storage', label: 'Saving and backup', icon: <HardDrive size={18} /> },
  ];

  const pdfEmpty = (): ReactNode => {
    if (compile.ok === false) {
      return (
        <div>
          <p>
            <b>The document did not compile.</b>
          </p>
          <p style={{ marginTop: 6 }}>{compile.error === NO_MAIN_FILE ? NO_MAIN_FILE : 'The problems are listed below the editor.'}</p>
        </div>
      );
    }
    return (
      <div>
        <p>
          <b>{running || engine.phase === 'loading' ? 'Preparing the first PDF' : 'The PDF appears here'}</b>
        </p>
        <p style={{ marginTop: 6, maxWidth: '44ch' }}>
          {running || engine.phase === 'loading'
            ? 'The first compile loads the LaTeX engine, about 50 MB. It is then kept in this browser, so later starts are quick and work offline.'
            : 'Press Compile to typeset the document.'}
        </p>
        {engineText(engine) && <p className="faint" style={{ marginTop: 10 }}>{engineText(engine)}</p>}
      </div>
    );
  };

  return (
    <div className="ws">
      <div>
        {state.readOnly && (
          <div className="banner" role="status">
            <TriangleAlert size={16} />
            <span className="grow">This project is open for editing in another tab or window. Here it can only be read.</span>
            <button className="btn small" onClick={() => void model.takeOver().catch((error: unknown) => reportError(error))}>
              Edit here instead
            </button>
          </div>
        )}
        {folder.status === 'needs-permission' && !state.readOnly && (
          <div className="banner" role="status">
            <TriangleAlert size={16} />
            <span className="grow">
              Your changes are saved in this browser. To also write them to the folder {folder.folderName}, the browser needs your permission
              again.
            </span>
            <button className="btn small" onClick={() => void model.folder.reconnect().catch((error: unknown) => reportError(error))}>
              Reconnect folder
            </button>
          </div>
        )}
        {recoveredNote && (
          <div className="banner info" role="status">
            <Info size={16} />
            <span className="grow">
              The last session ended before everything was saved. The unsaved text of {model.recovered.map((path) => basename(path)).join(', ')} was
              recovered.
            </span>
            <button className="icon-btn" aria-label="Dismiss" onClick={() => setRecoveredNote(false)}>
              <X size={15} />
            </button>
          </div>
        )}
      </div>

      <header className="topbar">
        <button className="icon-btn" title="All projects" aria-label="All projects" onClick={props.onHome}>
          <ArrowLeft size={17} />
        </button>
        <button className="title" title="Project settings" onClick={() => setSettingsOpen(true)}>
          {state.project.name}
        </button>
        <button className="save-chip" title={chip.title} onClick={() => model.setPanel('storage')}>
          <span className={`dot ${chip.dot}`} />
          <span>{chip.text}</span>
        </button>
        <span className="spacer" />
        <label className="hide-narrow muted" style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5 }}>
          <input
            type="checkbox"
            checked={state.project.autoCompile}
            onChange={(event) => void model.updateProject({ autoCompile: event.target.checked }).catch((error: unknown) => reportError(error))}
          />
          Auto
        </label>
        <button className="btn" onClick={() => setAsking({ problem: null })} title="Ask Claude about this project">
          <Sparkles size={14} />
          <span className="hide-narrow">Ask Claude</span>
        </button>
        {running ? (
          <button className="btn" onClick={() => model.compile.stop()} title="Stop the compile">
            <Square size={14} /> Stop
          </button>
        ) : (
          <button className="btn primary" onClick={() => void model.compileNow()} title="Compile (Ctrl+Enter)">
            <Play size={14} /> Compile
          </button>
        )}
        <button
          className="icon-btn"
          aria-label="More"
          title="More"
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            setMenu({ x: box.right - 200, y: box.bottom + 4 });
          }}
        >
          <Ellipsis size={17} />
        </button>
      </header>

      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div className="pane-switch" role="tablist">
          {(['files', 'editor', 'pdf'] as const).map((id) => (
            <button key={id} role="tab" aria-selected={pane === id} onClick={() => setPane(id)}>
              {id === 'files' ? 'Files' : id === 'editor' ? 'Source' : 'PDF'}
            </button>
          ))}
        </div>
        <div className="ws-body" data-pane={pane} style={{ flex: 1 }}>
          <nav className="rail" aria-label="Side panels">
            {rail.map((item) => (
              <button key={item.id} title={item.label} aria-label={item.label} aria-pressed={state.panel === item.id} onClick={() => model.setPanel(item.id)}>
                {item.icon}
              </button>
            ))}
          </nav>
          <aside className="side" style={{ width: layout.side }}>
            {state.panel === 'files' && <FileTree model={model} state={state} mainFile={mainFile} />}
            {state.panel === 'outline' && <OutlinePanel model={model} index={index} />}
            {state.panel === 'history' && <HistoryPanel model={model} services={services} readOnly={state.readOnly} />}
            {state.panel === 'storage' && (
              <StoragePanel model={model} state={state}>
                <FolderCard model={model} state={state} />
                <GitHubCard model={model} state={state} />
                {props.storageExtras}
              </StoragePanel>
            )}
          </aside>
          <Gutter
            label="Resize the side panel"
            onDrag={(delta) => setLayout((current) => ({ ...current, side: Math.max(170, Math.min(current.side + delta, 520)) }))}
            onDone={persistLayout}
          />

          <main className="center">
            <div className="tabs" role="tablist" aria-label="Open files">
              {state.tabs.map((tab) => (
                <div
                  key={tab.path}
                  className="tab"
                  role="tab"
                  tabIndex={0}
                  aria-selected={tab.path === state.active}
                  title={tab.path}
                  onClick={() => model.setActive(tab.path)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') model.setActive(tab.path);
                  }}
                  onAuxClick={(event) => {
                    if (event.button === 1) void model.closeTab(tab.path);
                  }}
                >
                  <span>{basename(tab.path)}</span>
                  {model.session.isDirty(tab.path) && save.status !== 'saved' ? <span className="unsaved" title="Being saved" /> : null}
                  <button
                    className="close"
                    aria-label={`Close ${basename(tab.path)}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      void model.closeTab(tab.path);
                    }}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
            <div className="editor-area">
              {textPath !== null && (
                <div style={{ position: 'absolute', inset: 0, visibility: activeTab?.kind === 'text' ? 'visible' : 'hidden' }}>
                  <CodeEditor
                    model={model}
                    path={textPath}
                    readOnly={state.readOnly}
                    buffersVersion={state.buffersVersion}
                    diagnostics={problems}
                    openPaths={openPaths}
                    getIndex={getIndex}
                    onCursor={onCursor}
                  />
                </div>
              )}
              {activeTab && activeTab.kind !== 'text' && (
                <div style={{ position: 'absolute', inset: 0 }}>
                  <FilePreview model={model} tab={activeTab} />
                </div>
              )}
              {!activeTab && (
                <div className="editor-empty">
                  <p>Choose a file on the left to edit it.</p>
                </div>
              )}
            </div>
            {state.bottomOpen && (
              <>
                <Gutter
                  horizontal
                  label="Resize the problems panel"
                  onDrag={(delta) => setLayout((current) => ({ ...current, bottom: Math.max(90, Math.min(current.bottom - delta, 600)) }))}
                  onDone={persistLayout}
                />
                <section className="bottom" style={{ height: layout.bottom }} aria-label="Problems and log">
                  <div className="bottom-head" role="tablist">
                    <button className="seg" role="tab" aria-selected={state.bottomTab === 'problems'} onClick={() => model.setBottom(true, 'problems')}>
                      Problems
                      {compile.errorCount > 0 && <span className="count err">{compile.errorCount}</span>}
                      {compile.warningCount > 0 && <span className="count warn">{compile.warningCount}</span>}
                    </button>
                    <button className="seg" role="tab" aria-selected={state.bottomTab === 'log'} onClick={() => model.setBottom(true, 'log')}>
                      Full log
                    </button>
                    <span className="grow" />
                    <button className="icon-btn" aria-label="Close the panel" onClick={() => model.setBottom(false)}>
                      <X size={14} />
                    </button>
                  </div>
                  {state.bottomTab === 'problems' ? (
                    <Problems
                      diagnostics={problems}
                      ok={compile.ok}
                      error={compile.error}
                      onOpen={(file, line) => void model.openFile(file, line)}
                      onAsk={(problem) => setAsking({ problem })}
                    />
                  ) : (
                    <pre className="log" tabIndex={0}>
                      {compile.log || 'The log of the last compile appears here.'}
                    </pre>
                  )}
                </section>
              </>
            )}
          </main>

          <Gutter
            label="Resize the preview"
            onDrag={(delta) => setLayout((current) => ({ ...current, right: Math.max(240, Math.min(current.right - delta, window.innerWidth - 420)) }))}
            onDone={persistLayout}
          />
          <section className="right" style={{ width: layout.right }} aria-label="Preview">
            <PdfView pdf={compile.pdf} version={compile.pdfVersion} stale={compile.ok === false} running={running} fileName={pdfName} empty={pdfEmpty()} />
          </section>
        </div>
      </div>

      <footer className="statusbar">
        <button onClick={() => model.setBottom(!state.bottomOpen || state.bottomTab !== 'problems', 'problems')} title="Show or hide the problems">
          <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
            <PanelBottom size={13} />
            {compile.errorCount === 0 && compile.warningCount === 0
              ? 'No problems'
              : `${compile.errorCount} ${compile.errorCount === 1 ? 'error' : 'errors'}, ${compile.warningCount} ${compile.warningCount === 1 ? 'warning' : 'warnings'}`}
          </span>
        </button>
        <span>
          {running
            ? 'Compiling…'
            : compile.ok === true && compile.durationMs !== null
              ? `Compiled in ${(compile.durationMs / 1000).toFixed(1)} s`
              : compile.ok === false
                ? 'The last compile failed'
                : ''}
        </span>
        <span className="spacer" />
        <span>{engineText(engine)}</span>
        {mainFile && <span title="The document that is compiled">Main: {mainFile}</span>}
        {cursor && activeTab?.kind === 'text' && (
          <span>
            Line {cursor.line}, column {cursor.column}
          </span>
        )}
      </footer>

      {menu && (
        <Menu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: 'Project settings', run: () => setSettingsOpen(true) },
            { label: 'Save a version now', run: () => void model.snapshotNow(null).then(() => notify('Version saved. You find it under History.')).catch((error: unknown) => reportError(error)) },
            { label: 'Download PDF', disabled: !compile.pdf, separatorBefore: true, run: () => compile.pdf && downloadBytes(pdfName, compile.pdf, 'application/pdf') },
            { label: 'Download project as ZIP', run: exportZip },
            { label: 'Show the full log', separatorBefore: true, run: () => model.setBottom(true, 'log') },
          ]}
        />
      )}
      {asking && (
        <AskClaude
          model={model}
          problem={asking.problem}
          problems={problems}
          folderName={folder.status === 'off' ? null : folder.folderName}
          activeFile={activeTab?.kind === 'text' ? activeTab.path : null}
          cursorLine={cursor?.line ?? null}
          onClose={() => setAsking(null)}
        />
      )}
      {settingsOpen && (
        <ProjectSettings model={model} project={state.project} texFiles={texFiles} detected={compile.mainFile} onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );
}
