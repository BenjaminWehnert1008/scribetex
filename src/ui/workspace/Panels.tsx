import { Download, Ellipsis, Pin, Plus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { ProjectIndex } from '@/app/project-index';
import { notify, reportError, type Services } from '@/app/services';
import type { WorkspaceModel, WorkspaceState } from '@/app/workspace-model';
import type { SnapshotMeta, SnapshotReason } from '@/core/types';
import { Dialog, downloadBytes, formatAgo, formatBytes, formatDateTime, Menu, useTick } from '../common/ui';

// ---- Outline ---------------------------------------------------------------

export function OutlinePanel(props: { model: WorkspaceModel; index: ProjectIndex | null }) {
  const items = props.index?.outline ?? [];
  const top = items.reduce((min, item) => Math.min(min, item.level), 9);
  return (
    <>
      <div className="side-head">
        <span className="grow">Outline</span>
      </div>
      <div className="side-scroll">
        {items.length === 0 ? (
          <p className="muted" style={{ padding: '4px 12px', fontSize: 13 }}>
            Headings such as \section appear here once the document has some.
          </p>
        ) : (
          <ul className="list">
            {items.map((item, position) => (
              <li key={`${item.file}:${item.line}:${position}`}>
                <button
                  className="list-item"
                  style={{ paddingLeft: 12 + (item.level - top) * 12 }}
                  title={`${item.file}, line ${item.line}`}
                  onClick={() => void props.model.openFile(item.file, item.line)}
                >
                  <span style={{ fontWeight: item.level <= top ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.title || `(${item.kind})`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

// ---- History ---------------------------------------------------------------

const REASONS: Record<SnapshotReason, string> = {
  manual: 'Saved by you',
  auto: 'Automatic',
  'session-start': 'Start of a session',
  'before-restore': 'Before a restore',
  'before-import': 'Before an import',
  'before-folder-pull': 'Before changes came in from the folder',
  'before-delete': 'Before something was deleted',
  'before-link': 'Before the folder link changed',
};

export function HistoryPanel(props: { model: WorkspaceModel; services: Services; readOnly: boolean }) {
  const { model, services, readOnly } = props;
  const [list, setList] = useState<SnapshotMeta[] | null>(null);
  const [naming, setNaming] = useState<{ id: string | null; label: string } | null>(null);
  const [restoring, setRestoring] = useState<SnapshotMeta | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; above: number; snapshot: SnapshotMeta } | null>(null);
  const now = useTick(30_000);

  const refresh = useCallback(() => {
    services.snapshots
      .list(model.projectId)
      .then((snapshots) => setList([...snapshots].sort((a, b) => b.createdAt - a.createdAt)))
      .catch((error: unknown) => reportError(error, 'The history could not be read'));
  }, [services, model.projectId]);

  useEffect(() => {
    refresh();
    return services.snapshots.changes.on((change) => {
      if (change.projectId === model.projectId) refresh();
    });
  }, [refresh, services, model.projectId]);

  const run = (action: Promise<unknown>, done?: string): void => {
    action
      .then(() => {
        refresh();
        if (done) notify(done);
      })
      .catch((error: unknown) => reportError(error));
  };

  return (
    <>
      <div className="side-head">
        <span className="grow">History</span>
        <button className="icon-btn" title="Save a version now" aria-label="Save a version now" onClick={() => setNaming({ id: null, label: '' })}>
          <Plus size={15} />
        </button>
      </div>
      <div className="side-scroll">
        <p className="muted" style={{ padding: '0 12px 8px', fontSize: 12.5 }}>
          A version of the whole project is kept every 10 minutes while you work, and before anything is deleted or restored. Versions live in
          this browser.
        </p>
        {list !== null && list.length === 0 && (
          <p className="muted" style={{ padding: '4px 12px', fontSize: 13 }}>
            No versions yet.
          </p>
        )}
        <ul className="list">
          {(list ?? []).map((snapshot) => (
            <li key={snapshot.id} style={{ display: 'flex', alignItems: 'center' }}>
              <button className="list-item" style={{ flex: 1, minWidth: 0 }} title="Restore this version" onClick={() => setRestoring(snapshot)}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {snapshot.pinned && <Pin size={12} />}
                  <span style={{ fontWeight: snapshot.label ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {snapshot.label ?? formatDateTime(snapshot.createdAt)}
                  </span>
                </span>
                <small>
                  {snapshot.label ? `${formatDateTime(snapshot.createdAt)}, ` : ''}
                  {formatAgo(snapshot.createdAt, now)} · {REASONS[snapshot.reason]} · {snapshot.fileCount === 1 ? '1 file' : `${snapshot.fileCount} files`}
                </small>
              </button>
              <button
                className="icon-btn"
                aria-label="More actions for this version"
                onClick={(event) => {
                  const box = event.currentTarget.getBoundingClientRect();
                  setMenu({ x: box.left, y: box.bottom + 2, above: box.top, snapshot });
                }}
              >
                <Ellipsis size={14} />
              </button>
            </li>
          ))}
        </ul>
      </div>

      {menu && (
        <Menu
          x={menu.x}
          y={menu.y}
          above={menu.above}
          onClose={() => setMenu(null)}
          items={[
            { label: 'Restore this version', disabled: readOnly, run: () => setRestoring(menu.snapshot) },
            { label: menu.snapshot.label ? 'Change the name' : 'Give it a name', run: () => setNaming({ id: menu.snapshot.id, label: menu.snapshot.label ?? '' }) },
            {
              label: menu.snapshot.pinned ? 'Allow automatic clean-up' : 'Keep forever',
              run: () => run(services.snapshots.setPinned(menu.snapshot.id, !menu.snapshot.pinned)),
            },
            { label: 'Delete this version', danger: true, separatorBefore: true, run: () => run(services.snapshots.delete(menu.snapshot.id)) },
          ]}
        />
      )}

      {naming && (
        <Dialog title={naming.id ? 'Name this version' : 'Save a version'} onClose={() => setNaming(null)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const label = naming.label.trim() || null;
              const target = naming.id;
              setNaming(null);
              if (target) run(services.snapshots.setLabel(target, label));
              else run(model.snapshotNow(label), 'Version saved.');
            }}
          >
            <label className="stack">
              Name (optional)
              <input
                className="field"
                value={naming.label}
                placeholder="For example: sent to supervisor"
                maxLength={80}
                onChange={(event) => setNaming({ ...naming, label: event.target.value })}
              />
            </label>
            <p className="muted" style={{ marginTop: 10, fontSize: 13 }}>
              Named versions are never cleaned up automatically.
            </p>
            <div className="actions">
              <button type="button" className="btn" onClick={() => setNaming(null)}>
                Cancel
              </button>
              <button type="submit" className="btn primary">
                Save
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {restoring && (
        <Dialog title="Restore this version?" onClose={() => setRestoring(null)}>
          <p>
            Every file of the project goes back to how it was on <b>{formatDateTime(restoring.createdAt)}</b>
            {restoring.label ? ` (${restoring.label})` : ''}.
          </p>
          <p className="muted">The project as it is now is saved as a version first, so you can undo this from the same list.</p>
          <div className="actions">
            <button className="btn" onClick={() => setRestoring(null)}>
              Cancel
            </button>
            <button
              className="btn primary"
              disabled={readOnly}
              onClick={() => {
                const target = restoring;
                setRestoring(null);
                run(model.restoreSnapshot(target.id), 'The version was restored.');
              }}
            >
              Restore
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}

// ---- Storage ---------------------------------------------------------------

interface BrowserStorage {
  usage: number | null;
  quota: number | null;
  persisted: boolean | null;
}

export function StoragePanel(props: { model: WorkspaceModel; state: WorkspaceState; children?: React.ReactNode }) {
  const { model, state } = props;
  const [storage, setStorage] = useState<BrowserStorage>({ usage: null, quota: null, persisted: null });
  const now = useTick(30_000);
  const project = state.project;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
      const persisted = await navigator.storage?.persisted?.().catch(() => undefined);
      if (!cancelled) setStorage({ usage: estimate?.usage ?? null, quota: estimate?.quota ?? null, persisted: persisted ?? null });
    })();
    return () => {
      cancelled = true;
    };
  }, [project.totalBytes]);

  const exportZip = (): void => {
    model
      .exportZip()
      .then(({ name, bytes }) => downloadBytes(name, bytes, 'application/zip'))
      .catch((error: unknown) => reportError(error, 'The ZIP could not be created'));
  };

  return (
    <>
      <div className="side-head">
        <span className="grow">Saving and backup</span>
      </div>
      <div className="side-scroll">
        <div className="side-pad">
          <div className="card">
            <h3>
              <span className="dot" /> In this browser
            </h3>
            <p>
              Every change is saved in this browser on this device within a second or two. Nothing is uploaded. If this browser's site data is
              cleared, this copy is gone, so keep a second copy with one of the options below.
            </p>
            <dl className="kv">
              <dt>This project</dt>
              <dd>
                {project.fileCount === 1 ? '1 file' : `${project.fileCount} files`}, {formatBytes(project.totalBytes)}
              </dd>
              {storage.usage !== null && storage.quota !== null && (
                <>
                  <dt>Browser storage</dt>
                  <dd>
                    {formatBytes(storage.usage)} used of about {formatBytes(storage.quota)}
                    <div className="meter" style={{ marginTop: 4 }}>
                      <i style={{ width: `${Math.min(100, (storage.usage / Math.max(1, storage.quota)) * 100)}%` }} />
                    </div>
                  </dd>
                </>
              )}
              {storage.persisted !== null && (
                <>
                  <dt>Protection</dt>
                  <dd>
                    {storage.persisted
                      ? 'The browser will not clear this data by itself.'
                      : 'The browser may clear this data by itself if the disk gets very full.'}
                  </dd>
                </>
              )}
            </dl>
          </div>

          {props.children}

          <div className="card">
            <h3>
              <Download size={14} /> Download a copy
            </h3>
            <p>A ZIP file with every file of the project and the current PDF. You can import it again on any computer.</p>
            <p className="muted">{project.lastExportAt ? `Last downloaded ${formatAgo(project.lastExportAt, now)}.` : 'Not downloaded yet.'}</p>
            <div className="row">
              <button className="btn small" onClick={exportZip}>
                Download ZIP
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
