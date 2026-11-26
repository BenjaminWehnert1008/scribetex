import { Bug, Code, Ellipsis, FileArchive, FolderOpen, GitBranch, Lightbulb, Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  APP_NAME,
  APP_TAGLINE,
  AUTHOR_GITHUB,
  AUTHOR_LINKEDIN,
  AUTHOR_NAME,
  NEW_BUG_URL,
  NEW_IDEA_URL,
  REPO_URL,
} from '@/app/brand';
import { canPickFolder, pickFolder } from '@/app/pick-folder';
import { detectBrowser, notify, reportError, type Services } from '@/app/services';
import { safeFileName } from '@/app/workspace-model';
import { exportProjectZip, importZipAsProject } from '@/core/backup/zip';
import type { DirHandle } from '@/core/fsa/disk';
import { FolderSync } from '@/core/fsa/sync';
import { encodeText } from '@/core/hash';
import type { ProjectId, ProjectMeta } from '@/core/types';
import { TEMPLATES } from '@/templates';
import { Dialog, downloadBytes, formatAgo, formatBytes, Menu, useTick } from '../common/ui';
import { markNoticeSeen, noticeSeen, StorageNoticeDialog, StorageNoticeText } from './notices';
import { RestoreDialog } from './RestoreDialog';

function NewProjectDialog(props: { services: Services; onClose: () => void; onCreated: (id: ProjectId) => void }) {
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState(TEMPLATES[0]!.id);
  const [busy, setBusy] = useState(false);

  const create = async (): Promise<void> => {
    const template = TEMPLATES.find((candidate) => candidate.id === templateId) ?? TEMPLATES[0]!;
    const { vault } = props.services;
    const project = await vault.createProject({ name: name.trim() || 'Untitled project', mainFile: template.mainFile });
    for (const dir of template.dirs ?? []) await vault.mkdir(project.id, dir, { origin: 'import' });
    await vault.writeMany(
      project.id,
      template.files.map((file) => ({ path: file.path, bytes: encodeText(file.text) })),
      { origin: 'import' },
    );
    props.onCreated(project.id);
  };

  return (
    <Dialog title="New project" onClose={busy ? undefined : props.onClose}>
      <form
        style={{ display: 'grid', gap: 14 }}
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          create().catch((error: unknown) => {
            setBusy(false);
            reportError(error, 'The project could not be created');
          });
        }}
      >
        <label className="stack">
          Name
          <input className="field" value={name} maxLength={120} placeholder="For example: Thesis" autoFocus onChange={(event) => setName(event.target.value)} />
        </label>
        <div>
          <span className="muted" style={{ fontSize: 13 }}>
            Start from
          </span>
          <div className="template-grid">
            {TEMPLATES.map((template) => (
              <button type="button" key={template.id} className="template" aria-pressed={template.id === templateId} onClick={() => setTemplateId(template.id)}>
                <b>{template.name}</b>
                <span>{template.description}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="actions" style={{ marginTop: 0 }}>
          <button type="button" className="btn" disabled={busy} onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            Create project
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function Home(props: { services: Services; onOpen: (id: ProjectId) => void }) {
  const { services } = props;
  const [browser] = useState(detectBrowser);
  const [projects, setProjects] = useState<ProjectMeta[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState(() => !noticeSeen());
  const [menu, setMenu] = useState<{ x: number; y: number; project: ProjectMeta } | null>(null);
  const [deleting, setDeleting] = useState<ProjectMeta | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [opening, setOpening] = useState(false);
  const zipInput = useRef<HTMLInputElement>(null);
  const now = useTick(30_000);

  const refresh = useCallback(() => {
    services.vault
      .listProjects()
      .then((list) => setProjects([...list].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)))
      .catch((error: unknown) => reportError(error, 'The projects could not be read'));
  }, [services]);

  useEffect(() => {
    refresh();
    return services.vault.changes.on((change) => {
      if (change.type === 'project') refresh();
    });
  }, [refresh, services]);

  useEffect(() => {
    document.title = `${APP_NAME} · LaTeX editor`;
  }, []);

  const exportZip = (project: ProjectMeta): void => {
    exportProjectZip(services.vault, project.id)
      .then(async (bytes) => {
        downloadBytes(`${safeFileName(project.name)}.zip`, bytes, 'application/zip');
        await services.vault.updateProject(project.id, { lastExportAt: Date.now() });
      })
      .catch((error: unknown) => reportError(error, 'The ZIP could not be created'));
  };

  const importZip = async (file: File): Promise<void> => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const name = file.name.replace(/\.zip$/i, '') || 'Imported project';
    const result = await importZipAsProject(services.vault, name, bytes);
    if (result.skipped.length > 0) notify(`${result.skipped.length} entries of the ZIP were left out because of their names.`);
    props.onOpen(result.projectId);
  };

  /** Opens a folder from disk as a project. The folder stays the place where its files live. */
  const openFolder = async (): Promise<void> => {
    const root = await pickFolder();
    if (!root) return;
    for (const project of await services.vault.listProjects()) {
      if (!project.link) continue;
      const linked = (await services.vault.loadHandle(project.id)) as unknown as DirHandle | null;
      if (linked && (await linked.isSameEntry?.(root))) {
        props.onOpen(project.id);
        return;
      }
    }
    const project = await services.vault.createProject({ name: root.name });
    try {
      const sync = await FolderSync.open(services.vault, project.id);
      await sync.link(root);
      await sync.dispose();
    } catch (error) {
      await services.vault.deleteProject(project.id).catch(() => undefined);
      throw error;
    }
    props.onOpen(project.id);
  };

  return (
    <div className="home">
      <div className="home-inner">
        <h1 className="brand">
          <img src="./logo.svg" alt={APP_NAME} width={255} height={72} />
        </h1>
        <p className="home-lead">{APP_TAGLINE}</p>

        {!browser.folderAccess && (
          <div className="notice-card warn" role="note">
            <StorageNoticeText browser={browser} />
          </div>
        )}

        <div className="home-actions">
          <button className="btn primary" onClick={() => setCreating(true)}>
            <Plus size={15} /> New project
          </button>
          {canPickFolder() && (
            <button
              className="btn"
              disabled={opening}
              title="Use a folder on this computer as a project. Its files stay where they are."
              onClick={() => {
                setOpening(true);
                openFolder()
                  .catch((error: unknown) => reportError(error, 'The folder could not be opened'))
                  .finally(() => setOpening(false));
              }}
            >
              <FolderOpen size={15} /> Open a folder
            </button>
          )}
          <button className="btn" onClick={() => zipInput.current?.click()}>
            <FileArchive size={15} /> Import a ZIP
          </button>
          <button className="btn" onClick={() => setRestoring(true)}>
            <GitBranch size={15} /> Restore from GitHub
          </button>
          <input
            ref={zipInput}
            type="file"
            accept=".zip,application/zip"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) importZip(file).catch((error: unknown) => reportError(error, 'The ZIP could not be imported'));
            }}
          />
        </div>

        {projects !== null && projects.length === 0 && (
          <div className="empty">
            <p>
              <b>No projects yet.</b>
            </p>
            <p style={{ marginTop: 4 }}>Create one from a template, or import a ZIP from Overleaf or another editor.</p>
          </div>
        )}

        <ul className="project-list">
          {(projects ?? []).map((project) => (
            <li key={project.id} className="project-row">
              <button className="project-open" onClick={() => props.onOpen(project.id)}>
                <span className="project-name">{project.name}</span>
                <span className="project-meta">
                  {project.fileCount === 1 ? '1 file' : `${project.fileCount} files`}, {formatBytes(project.totalBytes)} · opened{' '}
                  {formatAgo(project.lastOpenedAt, now)}
                </span>
              </button>
              <span className="where" title={project.link ? 'Also written to a folder on this computer' : 'Kept in this browser only'}>
                <span className={`dot ${project.link ? '' : 'amber'}`} />
                {project.link ? `Folder ${project.link.folderName}` : 'This browser only'}
              </span>
              <button
                className="icon-btn"
                aria-label={`Actions for ${project.name}`}
                onClick={(event) => {
                  const box = event.currentTarget.getBoundingClientRect();
                  setMenu({ x: box.right - 190, y: box.bottom + 4, project });
                }}
              >
                <Ellipsis size={16} />
              </button>
            </li>
          ))}
        </ul>

        <section className="about" aria-labelledby="about-title">
          <h2 id="about-title">The idea</h2>
          <p>
            {APP_NAME} is a free, open-source LaTeX editor for people who want to write without an account, a subscription or a
            server. Projects can have real folders, they are saved as you type, and they can live in a folder on your own computer.
            The PDF is compiled right here in your browser.
          </p>
          <p>
            It is meant to be a community-driven tool, shaped by the people who use it. If something breaks, feels clumsy or is
            missing, please open an issue on GitHub. Every report helps, and so does code.
          </p>
          <div className="about-actions">
            <a className="btn" href={NEW_BUG_URL} target="_blank" rel="noopener noreferrer">
              <Bug size={15} /> Report a bug
            </a>
            <a className="btn" href={NEW_IDEA_URL} target="_blank" rel="noopener noreferrer">
              <Lightbulb size={15} /> Suggest an improvement
            </a>
            <a className="btn" href={REPO_URL} target="_blank" rel="noopener noreferrer">
              <Code size={15} /> Source on GitHub
            </a>
          </div>
        </section>

        <div className="home-foot">
          <button onClick={() => setNotice(true)}>Where is my work saved?</button>
          <span>Documents are compiled in this browser with pdfLaTeX.</span>
          <a href="./licenses/THIRD-PARTY-NOTICES.txt" target="_blank" rel="noreferrer">
            Open-source licences
          </a>
        </div>
        <p className="home-by">
          Developed by {AUTHOR_NAME} ·{' '}
          <a href={AUTHOR_GITHUB} target="_blank" rel="noopener noreferrer">
            GitHub
          </a>{' '}
          ·{' '}
          <a href={AUTHOR_LINKEDIN} target="_blank" rel="noopener noreferrer">
            LinkedIn
          </a>
        </p>
      </div>

      {restoring && (
        <RestoreDialog
          services={services}
          onClose={() => setRestoring(false)}
          onRestored={(id) => {
            setRestoring(false);
            props.onOpen(id);
          }}
        />
      )}
      {creating && (
        <NewProjectDialog
          services={services}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            props.onOpen(id);
          }}
        />
      )}
      {notice && (
        <StorageNoticeDialog
          browser={browser}
          onClose={() => {
            markNoticeSeen();
            setNotice(false);
          }}
        />
      )}
      {menu && (
        <Menu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: 'Open', run: () => props.onOpen(menu.project.id) },
            { label: 'Download as ZIP', run: () => exportZip(menu.project) },
            { label: 'Delete', danger: true, separatorBefore: true, run: () => setDeleting(menu.project) },
          ]}
        />
      )}
      {deleting && (
        <Dialog title="Delete this project?" onClose={() => setDeleting(null)}>
          <p>
            <b>{deleting.name}</b> and its saved versions will be removed from this browser. This cannot be undone.
          </p>
          <p className="muted">
            {deleting.link
              ? `The folder ${deleting.link.folderName} on your disk is not touched.`
              : 'This project exists only in this browser. Download a ZIP first if you might need it again.'}
          </p>
          <div className="actions">
            <button className="btn" onClick={() => exportZip(deleting)}>
              Download ZIP
            </button>
            <button className="btn" onClick={() => setDeleting(null)}>
              Cancel
            </button>
            <button
              className="btn danger"
              onClick={() => {
                const target = deleting;
                setDeleting(null);
                services.vault.deleteProject(target.id).catch((error: unknown) => reportError(error, 'The project could not be deleted'));
              }}
            >
              Delete project
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
