import { ExternalLink, FileText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NEW_IDEA_URL } from '@/app/brand';
import { reportError, type Services } from '@/app/services';
import type { ProjectId } from '@/core/types';
import { TEMPLATES, templateFileBytes } from '@/templates';
import { type CommunityTemplate, loadCommunityFiles, loadCommunityTemplates, previewUrl } from '@/templates/community';
import { builtInPreview } from '@/templates/previews';
import { Dialog } from '../common/ui';

type Source = 'built-in' | 'community';
const ALL = 'All';

/** The community list, loaded once per page and shared by every dialog. */
let communityList: Promise<CommunityTemplate[]> | null = null;

function useCommunityTemplates(wanted: boolean): CommunityTemplate[] | Error | null {
  const [state, setState] = useState<CommunityTemplate[] | Error | null>(null);
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    communityList ??= loadCommunityTemplates();
    communityList.then(
      (list) => live && setState(list),
      (error: unknown) => {
        communityList = null; // try again next time
        if (live) setState(error instanceof Error ? error : new Error(String(error)));
      },
    );
    return () => {
      live = false;
    };
  }, [wanted]);
  return state;
}

function CommunityPicker(props: {
  templates: CommunityTemplate[] | Error | null;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const [category, setCategory] = useState(ALL);
  const { templates } = props;
  if (templates === null) return <p className="muted">Loading the templates…</p>;
  if (templates instanceof Error) {
    return <p className="muted">The community templates could not be loaded. Check the connection and open this dialog again.</p>;
  }
  const categories = [ALL, ...new Set(templates.map((template) => template.category))];
  const shown = category === ALL ? templates : templates.filter((template) => template.category === category);
  const chosen = templates.find((template) => template.id === props.selected);
  return (
    <>
      <div className="chips" role="group" aria-label="Kind of template">
        {categories.map((name) => (
          <button type="button" key={name} className="chip" aria-pressed={name === category} onClick={() => setCategory(name)}>
            {name}
          </button>
        ))}
      </div>
      <div className="template-grid">
        {shown.map((template) => {
          const url = previewUrl(template);
          return (
            <button
              type="button"
              key={template.id}
              className="template"
              aria-pressed={template.id === props.selected}
              onClick={() => props.onSelect(template.id)}
            >
              <span className="template-preview" aria-hidden="true">
                {url ? <img src={url} alt="" loading="lazy" /> : <FileText size={28} />}
              </span>
              <b>{template.name}</b>
              <span>
                {template.author} · {template.license.spdx}
              </span>
            </button>
          );
        })}
      </div>
      {chosen && (
        <p className="template-detail">
          {chosen.description}. By {chosen.author}, under the {chosen.license.name}.{' '}
          <a href={chosen.source} target="_blank" rel="noopener noreferrer">
            Source <ExternalLink size={12} aria-hidden="true" />
          </a>
          <br />
          <span className="muted">The project gets the license and the source in TEMPLATE-LICENSE.txt.</span>
        </p>
      )}
      <p className="muted fine">
        Templates by other authors, under open licenses, each tested with this editor's compiler.{' '}
        <a href={NEW_IDEA_URL} target="_blank" rel="noopener noreferrer">
          Suggest one
        </a>
      </p>
    </>
  );
}

export function NewProjectDialog(props: { services: Services; onClose: () => void; onCreated: (id: ProjectId) => void }) {
  const [name, setName] = useState('');
  const [source, setSource] = useState<Source>('built-in');
  const [templateId, setTemplateId] = useState(TEMPLATES[0]!.id);
  const [communityId, setCommunityId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const community = useCommunityTemplates(source === 'community');
  const chosenBuiltIn = TEMPLATES.find((template) => template.id === templateId) ?? TEMPLATES[0]!;
  const chosenCommunity = Array.isArray(community) ? community.find((template) => template.id === communityId) : undefined;

  const createBuiltIn = async (): Promise<ProjectId> => {
    const template = chosenBuiltIn;
    const { vault } = props.services;
    const project = await vault.createProject({ name: name.trim() || 'Untitled project', mainFile: template.mainFile });
    for (const dir of template.dirs ?? []) await vault.mkdir(project.id, dir, { origin: 'import' });
    await vault.writeMany(
      project.id,
      template.files.map((file) => ({ path: file.path, bytes: templateFileBytes(file) })),
      { origin: 'import' },
    );
    return project.id;
  };

  const createFromCommunity = async (template: CommunityTemplate): Promise<ProjectId> => {
    // Everything is downloaded first, so a failed download leaves no half-made project behind.
    const files = await loadCommunityFiles(template, (done, total) => setBusy(`Loading the template: ${done} of ${total} files`));
    const { vault } = props.services;
    const project = await vault.createProject({ name: name.trim() || template.name, mainFile: template.main });
    await vault.writeMany(project.id, files, { origin: 'import' });
    return project.id;
  };

  const canCreate = source === 'built-in' || chosenCommunity !== undefined;

  return (
    <Dialog title="New project" onClose={busy ? undefined : props.onClose} wide>
      <form
        style={{ display: 'grid', gap: 14 }}
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || !canCreate) return;
          setBusy('Creating the project…');
          const created = source === 'community' && chosenCommunity ? createFromCommunity(chosenCommunity) : createBuiltIn();
          created.then(props.onCreated, (error: unknown) => {
            setBusy(null);
            reportError(error, 'The project could not be created');
          });
        }}
      >
        <label className="stack">
          Name
          <input className="field" value={name} maxLength={120} placeholder="For example: Thesis" autoFocus onChange={(event) => setName(event.target.value)} />
        </label>
        <div>
          <div className="segmented" role="group" aria-label="Start from">
            <button type="button" aria-pressed={source === 'built-in'} onClick={() => setSource('built-in')}>
              Built in
            </button>
            <button type="button" aria-pressed={source === 'community'} onClick={() => setSource('community')}>
              From the community
            </button>
          </div>
          {source === 'built-in' ? (
            <>
              <div className="template-grid">
                {TEMPLATES.map((template) => {
                  const url = builtInPreview(template.id);
                  return (
                    <button
                      type="button"
                      key={template.id}
                      className="template"
                      title={template.description}
                      aria-pressed={template.id === templateId}
                      onClick={() => setTemplateId(template.id)}
                    >
                      <span className="template-preview" aria-hidden="true">
                        {url ? <img src={url} alt="" /> : <span className="empty-page" />}
                      </span>
                      <b>{template.name}</b>
                    </button>
                  );
                })}
              </div>
              <p className="template-detail">{chosenBuiltIn.description}.</p>
            </>
          ) : (
            <CommunityPicker templates={community} selected={communityId} onSelect={setCommunityId} />
          )}
        </div>
        <div className="actions" style={{ marginTop: 0 }}>
          {busy && (
            <span className="muted fine" role="status" style={{ marginRight: 'auto', alignSelf: 'center' }}>
              {busy}
            </span>
          )}
          <button type="button" className="btn" disabled={busy !== null} onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy !== null || !canCreate}>
            Create project
          </button>
        </div>
      </form>
    </Dialog>
  );
}
