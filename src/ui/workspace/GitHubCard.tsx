import { GitBranch } from 'lucide-react';
import { useState } from 'react';
import { notify, reportError } from '@/app/services';
import { safeFileName, type WorkspaceModel, type WorkspaceState } from '@/app/workspace-model';
import { Dialog, formatAgo, useTick } from '../common/ui';
import { useStore } from '../hooks/useStore';

export const NEW_REPOSITORY_URL = 'https://github.com/new';
export const NEW_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

/** The steps a user follows on github.com before connecting; shared with the restore dialog. */
export function TokenSteps() {
  return (
    <ol style={{ margin: '0 0 4px', paddingLeft: 20, display: 'grid', gap: 8 }}>
      <li>
        <a href={NEW_REPOSITORY_URL} target="_blank" rel="noreferrer">
          Create a private repository
        </a>{' '}
        on GitHub, for example "latex-backup". One repository can hold all your projects, each in its own folder.
      </li>
      <li>
        <a href={NEW_TOKEN_URL} target="_blank" rel="noreferrer">
          Create a fine-grained token
        </a>
        . Under "Repository access" choose "Only select repositories" and pick that repository. Under "Permissions" set "Contents" to "Read and
        write".
      </li>
      <li>Fill in the fields below.</li>
    </ol>
  );
}

function ConnectDialog(props: { model: WorkspaceModel; projectName: string; hasToken: boolean; onClose: () => void }) {
  const [repository, setRepository] = useState('');
  const [folder, setFolder] = useState(safeFileName(props.projectName));
  const [token, setToken] = useState('');
  const [reuse, setReuse] = useState(props.hasToken);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog title="Back up to a private GitHub repository" wide onClose={busy ? undefined : props.onClose}>
      <TokenSteps />
      <form
        style={{ display: 'grid', gap: 12, marginTop: 12 }}
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          props.model.github
            .connect(reuse ? null : token, repository, folder)
            .then(() => {
              notify('The project is backed up to GitHub.');
              props.onClose();
            })
            .catch((reason: unknown) => {
              setBusy(false);
              setError(reason instanceof Error ? reason.message : String(reason));
            });
        }}
      >
        <label className="stack">
          Repository
          <input className="field mono" value={repository} placeholder="your-name/latex-backup" required spellCheck={false} onChange={(event) => setRepository(event.target.value)} />
        </label>
        <label className="stack">
          Folder inside the repository for this project
          <input className="field mono" value={folder} spellCheck={false} onChange={(event) => setFolder(event.target.value)} />
        </label>
        {props.hasToken && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={reuse} onChange={(event) => setReuse(event.target.checked)} />
            Use the token that is already stored in this browser
          </label>
        )}
        {!reuse && (
          <label className="stack">
            Token
            <input className="field mono" type="password" value={token} placeholder="github_pat_…" required autoComplete="off" spellCheck={false} onChange={(event) => setToken(event.target.value)} />
          </label>
        )}
        <p className="muted" style={{ fontSize: 13 }}>
          The token is stored in this browser only and is sent to api.github.com and nowhere else. It is not part of ZIP downloads or of the
          backup. Anyone who can use this browser profile could use it, so give it access to the backup repository only.
        </p>
        {error && (
          <p role="alert" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}
        <div className="actions" style={{ marginTop: 0 }}>
          <button type="button" className="btn" disabled={busy} onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Connecting…' : 'Connect and back up'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function GitHubCard(props: { model: WorkspaceModel; state: WorkspaceState }) {
  const { model, state } = props;
  const github = useStore(model.github.state);
  const now = useTick(20_000);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [forgetToken, setForgetToken] = useState(false);
  const settings = github.settings;

  if (github.status === 'off' || !settings) {
    return (
      <div className="card">
        <h3>
          <GitBranch size={14} /> A private GitHub repository
        </h3>
        <p>
          Keep a copy of this project in a private repository of your own. Each backup is one commit, so earlier states stay available on
          GitHub. The files go straight from this browser to GitHub.
        </p>
        <div className="row">
          <button className="btn small" disabled={state.readOnly} onClick={() => setConnecting(true)}>
            Set up…
          </button>
        </div>
        {connecting && <ConnectDialog model={model} projectName={state.project.name} hasToken={github.hasToken} onClose={() => setConnecting(false)} />}
      </div>
    );
  }

  const where = `${settings.target.owner}/${settings.target.repo}${settings.target.folder ? `, folder ${settings.target.folder}` : ''}`;
  return (
    <div className="card">
      <h3>
        <span className={`dot ${github.status === 'failed' ? 'red' : github.behind ? 'amber' : ''}`} /> GitHub backup
      </h3>
      <p>
        Backs up to <span className="mono">{where}</span>.
      </p>
      <p className="muted">
        {github.status === 'running'
          ? 'Backing up now…'
          : settings.lastBackupAt
            ? `Last backup ${formatAgo(settings.lastBackupAt, now)}${github.behind ? '; there are newer changes' : ''}.`
            : 'No backup yet.'}{' '}
        {settings.lastCommitUrl && (
          <a href={settings.lastCommitUrl} target="_blank" rel="noreferrer">
            View on GitHub
          </a>
        )}
      </p>
      {!settings.isPrivate && (
        <div className="notice-card warn" style={{ margin: 0 }}>
          <b>This repository is public.</b> Everyone can read what is backed up to it. Make it private in the repository's settings on GitHub.
        </div>
      )}
      {github.error && (
        <p role="alert" style={{ color: github.status === 'failed' ? 'var(--danger)' : undefined }}>
          {github.status === 'failed' ? 'The last backup did not work. ' : ''}
          {github.error}
        </p>
      )}
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={settings.auto} onChange={(event) => void model.github.setAuto(event.target.checked).catch((error: unknown) => reportError(error))} />
        Back up by itself after changes, at most every 5 minutes
      </label>
      <div className="row">
        <button
          className="btn small"
          disabled={github.status === 'running'}
          onClick={() =>
            void model.session
              .flush()
              .then(() => model.github.backupNow())
              .then((result) => notify(result?.changed ? 'Backed up to GitHub.' : 'GitHub already has this state of the project.'))
              .catch((error: unknown) => reportError(error, 'The backup did not work'))
          }
        >
          Back up now
        </button>
        <button className="btn small" onClick={() => setDisconnecting(true)}>
          Disconnect
        </button>
      </div>
      {disconnecting && (
        <Dialog title="Stop backing up to GitHub?" onClose={() => setDisconnecting(false)}>
          <p>
            This project will no longer be backed up to <span className="mono">{where}</span>. What is already on GitHub stays there.
          </p>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
            <input type="checkbox" checked={forgetToken} onChange={(event) => setForgetToken(event.target.checked)} />
            Also remove the token from this browser (stops the backup of other projects too)
          </label>
          <div className="actions">
            <button className="btn" onClick={() => setDisconnecting(false)}>
              Cancel
            </button>
            <button
              className="btn primary"
              onClick={() => {
                setDisconnecting(false);
                void model.github.disconnect({ forgetToken }).catch((error: unknown) => reportError(error));
              }}
            >
              Disconnect
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
