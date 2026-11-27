import {
  ChevronDown,
  ChevronRight,
  Download,
  Ellipsis,
  File as FileIcon,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  Pencil,
  Star,
  Trash,
  Upload,
} from 'lucide-react';
import { type DragEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { notify, reportError } from '@/app/services';
import { tabKindOf, type WorkspaceModel, type WorkspaceState } from '@/app/workspace-model';
import { ancestors, basename, compareTreeOrder, dirname, extname } from '@/core/paths';
import type { FileEntry, Path } from '@/core/types';
import { Dialog, downloadBytes, Menu, type MenuItem } from '../common/ui';
import { collectDropped, type DroppedFile } from './dropped-files';

type Editing = { mode: 'rename'; path: Path } | { mode: 'new-file' | 'new-folder'; dir: Path };

const DRAG_TYPE = 'application/x-latex-editor-path';

function loadExpanded(projectId: string): Set<Path> {
  try {
    const raw = localStorage.getItem(`latex-editor:tree:${projectId}`);
    if (raw) return new Set(JSON.parse(raw) as Path[]);
  } catch {
    // Unreadable preferences are not worth an error; start with everything closed.
  }
  return new Set();
}

function iconFor(entry: FileEntry, open: boolean) {
  if (entry.kind === 'dir') return open ? <FolderOpen className="kind" size={15} /> : <Folder className="kind" size={15} />;
  const kind = tabKindOf(entry);
  if (kind === 'image') return <ImageIcon className="kind" size={15} />;
  if (kind === 'text') return <FileText className="kind" size={15} />;
  return <FileIcon className="kind" size={15} />;
}

function NameInput(props: { initial: string; depth: number; check: (name: string) => string | null; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(props.initial);
  const [touched, setTouched] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    const dot = props.initial.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : props.initial.length);
  }, [props.initial]);
  const problem = value === props.initial ? null : props.check(value.trim());
  const finish = (name: string | null): void => {
    if (settled.current) return;
    settled.current = true;
    props.onDone(name);
  };
  return (
    <>
      <div className="tree-row" style={{ paddingLeft: 8 + props.depth * 14 + 19 }}>
        <input
          ref={ref}
          value={value}
          aria-label="Name"
          aria-invalid={touched && problem !== null}
          spellCheck={false}
          onChange={(event) => {
            setValue(event.target.value);
            setTouched(true);
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Escape') finish(null);
            if (event.key === 'Enter') {
              const name = value.trim();
              if (name === props.initial || name === '') finish(null);
              else if (!props.check(name)) finish(name);
              else setTouched(true);
            }
          }}
          onBlur={() => {
            const name = value.trim();
            finish(name !== '' && name !== props.initial && !props.check(name) ? name : null);
          }}
        />
      </div>
      {touched && problem && value.trim() !== '' && <div className="tree-error">{problem}</div>}
    </>
  );
}

export function FileTree(props: { model: WorkspaceModel; state: WorkspaceState; mainFile: Path | null }) {
  const { model, state, mainFile } = props;
  const [expanded, setExpanded] = useState(() => {
    const stored = loadExpanded(model.projectId);
    // On first open, show the folders that lead to the active file and the top level.
    if (stored.size === 0) for (const entry of state.entries) if (entry.kind === 'dir' && !entry.path.includes('/')) stored.add(entry.path);
    return stored;
  });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; above: number; items: MenuItem[] } | null>(null);
  const [dropTarget, setDropTarget] = useState<Path | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<FileEntry | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const uploadDir = useRef<Path>('');
  const readOnly = state.readOnly;

  useEffect(() => {
    try {
      localStorage.setItem(`latex-editor:tree:${model.projectId}`, JSON.stringify([...expanded]));
    } catch {
      // Storage may be full or blocked; the tree still works for this visit.
    }
  }, [expanded, model.projectId]);

  // When another file becomes active, open the folders that lead to it, so it is visible in the tree.
  const [shownActive, setShownActive] = useState<Path | null>(null);
  if (state.active !== shownActive) {
    setShownActive(state.active);
    const needed = state.active ? ancestors(state.active) : [];
    if (!needed.every((dir) => expanded.has(dir))) setExpanded(new Set([...expanded, ...needed]));
  }

  const rows = useMemo(() => {
    const sorted = [...state.entries].sort(compareTreeOrder);
    return sorted.filter((entry) => ancestors(entry.path).every((dir) => expanded.has(dir)));
  }, [state.entries, expanded]);

  const run = (action: Promise<unknown>): void => {
    action.catch((error: unknown) => reportError(error));
  };

  const toggle = (path: Path): void =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const startCreate = (mode: 'new-file' | 'new-folder', dir: Path): void => {
    if (dir !== '') setExpanded((current) => new Set([...current, dir, ...ancestors(dir)]));
    setEditing({ mode, dir });
  };

  const addFiles = (dir: Path, files: DroppedFile[], notes: string[] = []): void => {
    if (files.length === 0) return;
    run(
      model.upload(dir, files).then(({ written, skipped }) => {
        if (dir !== '') setExpanded((current) => new Set([...current, dir, ...ancestors(dir)]));
        const parts = [written.length === 1 ? `Added ${basename(written[0]!)}.` : `Added ${written.length} files.`];
        if (skipped.length > 0) parts.push(`${skipped.length} could not be added because of their names.`);
        notify([...parts, ...notes].join(' '));
      }),
    );
  };

  const download = (entry: FileEntry): void => {
    run(model.readBytes(entry.path).then((bytes) => downloadBytes(basename(entry.path), bytes, 'application/octet-stream')));
  };

  const menuItems = (path: Path | null): MenuItem[] => {
    const entry = path === null ? null : model.entry(path);
    const dir = entry ? (entry.kind === 'dir' ? entry.path : dirname(entry.path)) : '';
    const items: MenuItem[] = [
      { label: 'New file', icon: <FilePlus size={15} />, disabled: readOnly, run: () => startCreate('new-file', dir) },
      { label: 'New folder', icon: <FolderPlus size={15} />, disabled: readOnly, run: () => startCreate('new-folder', dir) },
      {
        label: 'Upload files',
        icon: <Upload size={15} />,
        disabled: readOnly,
        run: () => {
          uploadDir.current = dir;
          uploadInput.current?.click();
        },
      },
    ];
    if (!entry) return items;
    items.push({ label: 'Rename', icon: <Pencil size={15} />, disabled: readOnly, separatorBefore: true, run: () => setEditing({ mode: 'rename', path: entry.path }) });
    if (entry.kind === 'file') {
      if (extname(entry.path) === '.tex') {
        items.push({
          label: entry.path === state.project.mainFile ? 'Main document (chosen)' : 'Set as main document',
          icon: <Star size={15} />,
          disabled: readOnly || entry.path === state.project.mainFile,
          run: () => run(model.updateProject({ mainFile: entry.path })),
        });
      }
      items.push({ label: 'Download', icon: <Download size={15} />, run: () => download(entry) });
    }
    items.push({ label: 'Delete', icon: <Trash size={15} />, danger: true, disabled: readOnly, separatorBefore: true, run: () => setConfirmDelete(entry) });
    return items;
  };

  const dropDirOf = (entry: FileEntry | null): Path => (entry ? (entry.kind === 'dir' ? entry.path : dirname(entry.path)) : '');

  const onDragOver = (event: DragEvent, entry: FileEntry | null): void => {
    if (readOnly) return;
    const types = event.dataTransfer.types;
    if (!types.includes(DRAG_TYPE) && !types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = types.includes(DRAG_TYPE) ? 'move' : 'copy';
    setDropTarget(dropDirOf(entry));
  };

  const onDrop = (event: DragEvent, entry: FileEntry | null): void => {
    if (readOnly) return;
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(null);
    const dir = dropDirOf(entry);
    const moved = event.dataTransfer.getData(DRAG_TYPE);
    if (moved) {
      if (dirname(moved) !== dir && moved !== dir) run(model.move(moved, dir));
      return;
    }
    const read = collectDropped(event.dataTransfer);
    run(read().then(({ files, notes }) => addFiles(dir, files, notes)));
  };

  const onRowKey = (event: KeyboardEvent, entry: FileEntry): void => {
    const row = event.currentTarget as HTMLElement;
    const move = (delta: 1 | -1): void => {
      const all = Array.from(row.closest('.tree')?.querySelectorAll<HTMLElement>('[data-row]') ?? []);
      all[all.indexOf(row) + delta]?.focus();
    };
    switch (event.key) {
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (entry.kind === 'dir') toggle(entry.path);
        else run(model.openFile(entry.path));
        break;
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        break;
      case 'ArrowRight':
        if (entry.kind === 'dir' && !expanded.has(entry.path)) toggle(entry.path);
        break;
      case 'ArrowLeft':
        if (entry.kind === 'dir' && expanded.has(entry.path)) toggle(entry.path);
        break;
      case 'F2':
        if (!readOnly) setEditing({ mode: 'rename', path: entry.path });
        break;
      case 'Delete':
        if (!readOnly) setConfirmDelete(entry);
        break;
      default:
    }
  };

  const createRow = (dir: Path, depth: number) =>
    editing && editing.mode !== 'rename' && editing.dir === dir ? (
      <li key="__new">
        <NameInput
          initial=""
          depth={depth}
          check={(name) => model.nameProblem(dir, name)}
          onDone={(name) => {
            const mode = editing.mode;
            setEditing(null);
            if (name === null) return;
            run(mode === 'new-file' ? model.createFile(dir, name) : model.createFolder(dir, name).then((path) => setExpanded((current) => new Set([...current, path]))));
          }}
        />
      </li>
    ) : null;

  const insideCount = (entry: FileEntry): number => state.entries.filter((other) => other.kind === 'file' && other.path.startsWith(`${entry.path}/`)).length;

  return (
    <>
      <div className="side-head">
        <span className="grow">Files</span>
        <button className="icon-btn" title="New file" aria-label="New file" disabled={readOnly} onClick={() => startCreate('new-file', '')}>
          <FilePlus size={15} />
        </button>
        <button className="icon-btn" title="New folder" aria-label="New folder" disabled={readOnly} onClick={() => startCreate('new-folder', '')}>
          <FolderPlus size={15} />
        </button>
        <button
          className="icon-btn"
          title="Upload files"
          aria-label="Upload files"
          disabled={readOnly}
          onClick={() => {
            uploadDir.current = '';
            uploadInput.current?.click();
          }}
        >
          <Upload size={15} />
        </button>
      </div>
      <div
        className="side-scroll"
        style={{ display: 'flex', flexDirection: 'column', outline: dropTarget === '' ? '2px solid var(--accent)' : undefined, outlineOffset: -2 }}
        onDragOver={(event) => onDragOver(event, null)}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null);
        }}
        onDrop={(event) => onDrop(event, null)}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY, above: event.clientY, items: menuItems(null) });
        }}
      >
        <ul className="tree" role="tree" aria-label="Project files">
          {createRow('', 0)}
          {rows.map((entry) => {
            const depth = entry.path.split('/').length - 1;
            const open = entry.kind === 'dir' && expanded.has(entry.path);
            if (editing?.mode === 'rename' && editing.path === entry.path) {
              return (
                <li key={entry.path}>
                  <NameInput
                    initial={basename(entry.path)}
                    depth={depth}
                    check={(name) => model.nameProblem(dirname(entry.path), name, entry.path)}
                    onDone={(name) => {
                      setEditing(null);
                      if (name !== null) run(model.rename(entry.path, name));
                    }}
                  />
                </li>
              );
            }
            return (
              <li key={entry.path} role="none">
                <div
                  className={`tree-row ${dropTarget !== null && dropTarget !== '' && dropTarget === entry.path ? 'drop' : ''}`}
                  role="treeitem"
                  aria-label={basename(entry.path)}
                  data-row
                  tabIndex={0}
                  aria-selected={state.active === entry.path}
                  aria-expanded={entry.kind === 'dir' ? open : undefined}
                  title={entry.path}
                  style={{ paddingLeft: 8 + depth * 14 }}
                  draggable={!readOnly}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(DRAG_TYPE, entry.path);
                    event.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragOver={(event) => onDragOver(event, entry)}
                  onDrop={(event) => onDrop(event, entry)}
                  onClick={() => (entry.kind === 'dir' ? toggle(entry.path) : run(model.openFile(entry.path)))}
                  onKeyDown={(event) => onRowKey(event, entry)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setMenu({ x: event.clientX, y: event.clientY, above: event.clientY, items: menuItems(entry.path) });
                  }}
                >
                  <span className="twist">{entry.kind === 'dir' ? open ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}</span>
                  {iconFor(entry, open)}
                  <span className="name">{basename(entry.path)}</span>
                  {entry.path === mainFile && (
                    <span className="main-mark" title="The document that is compiled">
                      main
                    </span>
                  )}
                  <button
                    className="icon-btn row-more"
                    aria-label={`Actions for ${basename(entry.path)}`}
                    tabIndex={-1}
                    onClick={(event) => {
                      event.stopPropagation();
                      const box = event.currentTarget.getBoundingClientRect();
                      setMenu({ x: box.left, y: box.bottom + 2, above: box.top, items: menuItems(entry.path) });
                    }}
                  >
                    <Ellipsis size={14} />
                  </button>
                </div>
                {open && <ul className="tree" role="group">{createRow(entry.path, depth + 1)}</ul>}
              </li>
            );
          })}
        </ul>
        {state.entries.length === 0 && !editing && (
          <p className="muted" style={{ padding: '10px 12px', fontSize: 13 }}>
            This project is empty. Create a file, or drop files and folders here.
          </p>
        )}
        <div className="tree-root-drop" />
      </div>
      <input
        ref={uploadInput}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          const picked = Array.from(event.target.files ?? []);
          event.target.value = '';
          run(
            Promise.all(picked.map(async (file) => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }))).then((files) =>
              addFiles(uploadDir.current, files),
            ),
          );
        }}
      />
      {menu && <Menu x={menu.x} y={menu.y} above={menu.above} items={menu.items} onClose={() => setMenu(null)} />}
      {confirmDelete && (
        <Dialog title={confirmDelete.kind === 'dir' ? 'Delete this folder?' : 'Delete this file?'} onClose={() => setConfirmDelete(null)}>
          <p>
            <b>{confirmDelete.path}</b>
            {confirmDelete.kind === 'dir' && insideCount(confirmDelete) > 0
              ? ` and the ${insideCount(confirmDelete) === 1 ? 'file' : `${insideCount(confirmDelete)} files`} inside it will be deleted.`
              : ' will be deleted.'}
          </p>
          <p className="muted">A version of the project is saved first, so you can bring it back from History.</p>
          <div className="actions">
            <button className="btn" onClick={() => setConfirmDelete(null)}>
              Cancel
            </button>
            <button
              className="btn danger"
              onClick={() => {
                const target = confirmDelete;
                setConfirmDelete(null);
                run(model.remove(target.path));
              }}
            >
              Delete
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
