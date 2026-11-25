import { FolderSync as FolderIcon } from 'lucide-react';
import { useState } from 'react';
import { canPickFolder, pickFolder } from '@/app/pick-folder';
import { notify, reportError } from '@/app/services';
import type { WorkspaceModel, WorkspaceState } from '@/app/workspace-model';
import { type DirHandle, isFolderEmpty } from '@/core/fsa/disk';
import type { FolderState } from '@/core/fsa/sync';
import { Dialog, formatAgo, useTick } from '../common/ui';
import { useStore } from '../hooks/useStore';

/** One line that says how the folder link is doing. */
export function folderSummary(folder: FolderState, now: number): { dot: string; text: string } {
  const name = folder.folderName ?? 'folder';
  switch (folder.status) {
    case 'needs-permission':
      return { dot: 'amber', text: `The browser needs your permission again to use the folder ${name}.` };
    case 'error':
      return { dot: 'red', text: `The folder ${name} cannot be reached.` };
    case 'attention':
      return { dot: 'amber', text: `The folder ${name} needs a look.` };
    case 'syncing':
      return { dot: 'grey', text: `Comparing with the folder ${name}…` };
    case 'synced':
      return { dot: '', text: `In step with the folder ${name}${folder.lastSyncAt ? `, checked ${formatAgo(folder.lastSyncAt, now)}` : ''}.` };
    default:
      return { dot: 'grey', text: 'Not linked to a folder.' };
  }
}

export function FolderCard(props: { model: WorkspaceModel; state: WorkspaceState }) {
  const { model, state } = props;
  const folder = useStore(model.folder.state);
  const now = useTick(20_000);
  const [busy, setBusy] = useState(false);
  const [merge, setMerge] = useState<DirHandle | null>(null);
  const [unlinking, setUnlinking] = useState(false);
  const supported = canPickFolder();
  const link = state.project.link;

  const run = (action: Promise<unknown>, done?: string): void => {
    setBusy(true);
    action
      .then(() => {
        if (done) notify(done);
      })
      .catch((error: unknown) => reportError(error))
      .finally(() => setBusy(false));
  };

  const choose = async (): Promise<void> => {
    const root = await pickFolder();
    if (!root) return;
    const hasFiles = state.entries.some((entry) => entry.kind === 'file');
    if (hasFiles && !(await isFolderEmpty(root))) {
      setMerge(root);
      return;
    }
    await model.linkFolder(root);
    notify(`Linked to the folder ${root.name}.`);
  };

  if (folder.status === 'off') {
    return (
      <div className="card">
        <h3>
          <FolderIcon size={14} /> A folder on this computer
        </h3>
        {supported ? (
          <>
            <p>
              Link this project to a folder on your disk. Every change is then also written there as ordinary files, in the same folders as
              here, and changes made in the folder by other programs are picked up.
            </p>
            <p className="muted">
              This is also the way to use Google Drive, Dropbox or OneDrive: choose a folder inside the folder that their desktop app keeps in
              step.
            </p>
            <div className="row">
              <button className="btn small primary" disabled={busy || state.readOnly} onClick={() => run(choose())}>
                Link a folder…
              </button>
            </div>
          </>
        ) : (
          <p>
            Saving to a folder on your disk needs Chrome or Edge on a computer. In this browser, download a ZIP when you finish a session, or
            use the GitHub backup.
          </p>
        )}
        {merge && (
          <Dialog title="This folder already has files" onClose={() => setMerge(null)}>
            <p>
              The project and the folder <b>{merge.name}</b> will be combined. Files that exist on one side only are copied to the other. Where
              a file with the same name differs, both versions are kept: the folder's version gets "(folder copy)" added to its name.
            </p>
            <p className="muted">Nothing is deleted on either side, and a version of the project is saved first.</p>
            <div className="actions">
              <button className="btn" onClick={() => setMerge(null)}>
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  const root = merge;
                  setMerge(null);
                  run(model.linkFolder(root), `Linked to the folder ${root.name}.`);
                }}
              >
                Link and combine
              </button>
            </div>
          </Dialog>
        )}
      </div>
    );
  }

  const summary = folderSummary(folder, now);
  return (
    <div className="card">
      <h3>
        <span className={`dot ${summary.dot}`} /> Folder {folder.folderName}
      </h3>
      <p>{summary.text}</p>

      {folder.status === 'needs-permission' && (
        <>
          <p className="muted">
            Browsers ask again after a restart. Until you allow it, changes stay in this browser
            {folder.waiting > 0 ? ` (${folder.waiting} waiting)` : ''}. Choosing "Allow on every visit" in the browser's question makes this
            step unnecessary.
          </p>
          <div className="row">
            <button className="btn small primary" disabled={busy} onClick={() => run(model.folder.reconnect().then((ok) => (ok ? notify('The folder is connected again.') : undefined)))}>
              Reconnect folder
            </button>
          </div>
        </>
      )}

      {folder.missing && (
        <div className="notice-card warn" style={{ margin: 0 }}>
          <p>
            <b>
              {folder.missing.length === 1 ? 'One file of this project is' : `${folder.missing.length} files of this project are`} no longer in the
              folder.
            </b>{' '}
            Nothing was deleted here. This happens when the folder was emptied, moved or replaced.
          </p>
          <p className="muted mono" style={{ fontSize: 12, marginTop: 4 }}>
            {folder.missing.slice(0, 6).join(', ')}
            {folder.missing.length > 6 ? ` and ${folder.missing.length - 6} more` : ''}
          </p>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn small primary" disabled={busy} onClick={() => run(model.syncFolder({ massDeletion: 'restore' }), 'The files were written back into the folder.')}>
              Put them back into the folder
            </button>
            <button className="btn small danger" disabled={busy} onClick={() => run(model.syncFolder({ massDeletion: 'apply' }), 'The files were deleted here too. A version was saved first.')}>
              Delete them here too
            </button>
          </div>
        </div>
      )}

      {folder.problems.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
          {folder.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}

      {folder.conflicts.length > 0 && (
        <div>
          <p>A file had changed both here and in the folder. The folder's version was kept under a new name:</p>
          <ul className="list" style={{ marginTop: 4 }}>
            {folder.conflicts.map((path) => (
              <li key={path}>
                <button className="list-item mono" style={{ padding: '3px 0', fontSize: 12 }} onClick={() => void model.openFile(path)}>
                  {path}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {link && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={link.writePdf}
            disabled={state.readOnly}
            onChange={(event) => run(model.updateProject({ link: { ...link, writePdf: event.target.checked } }).then(() => model.syncFolder()))}
          />
          Also write the compiled PDF into the folder
        </label>
      )}
      <div className="row">
        <button className="btn small" disabled={busy || state.readOnly || folder.status === 'needs-permission'} onClick={() => run(model.syncFolder())}>
          Compare now
        </button>
        <button className="btn small" disabled={busy || state.readOnly} onClick={() => setUnlinking(true)}>
          Unlink
        </button>
      </div>

      {unlinking && (
        <Dialog title="Unlink this folder?" onClose={() => setUnlinking(false)}>
          <p>
            The project stays in this browser and the files stay in the folder <b>{folder.folderName}</b>. They are just no longer kept in step.
          </p>
          <div className="actions">
            <button className="btn" onClick={() => setUnlinking(false)}>
              Cancel
            </button>
            <button
              className="btn primary"
              onClick={() => {
                setUnlinking(false);
                run(model.unlinkFolder(), 'The folder is no longer linked.');
              }}
            >
              Unlink
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
