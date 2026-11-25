import { Component, type ErrorInfo, type ReactNode, useEffect, useState } from 'react';
import type { ProjectId } from '@/core/types';
import { Toasts } from '@/ui/common/ui';
import { Home } from '@/ui/home/Home';
import { Workspace } from '@/ui/workspace/Workspace';
import { APP_NAME } from './brand';
import { getServices, type Services } from './services';
import { WorkspaceModel } from './workspace-model';

type Route = { name: 'home' } | { name: 'project'; id: ProjectId };

function parseRoute(hash: string): Route {
  const match = /^#\/p\/([a-z0-9]+)$/.exec(hash);
  return match ? { name: 'project', id: match[1]! } : { name: 'home' };
}

function go(route: Route): void {
  window.location.hash = route.name === 'home' ? '#/' : `#/p/${route.id}`;
}

function FullMessage(props: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="pdf-empty" style={{ height: '100%' }}>
      <div style={{ maxWidth: '52ch' }}>
        <p>
          <b>{props.title}</b>
        </p>
        {props.children && <div style={{ marginTop: 8 }}>{props.children}</div>}
        {props.action && <div style={{ marginTop: 16 }}>{props.action}</div>}
      </div>
    </div>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <FullMessage
        title="Something went wrong in the editor."
        action={
          <button className="btn primary" onClick={() => window.location.reload()}>
            Reload the page
          </button>
        }
      >
        <p>Your files are saved in this browser and are not affected. Reloading usually fixes this.</p>
        <p className="faint mono" style={{ marginTop: 8, fontSize: 12 }}>
          {this.state.error.message}
        </p>
      </FullMessage>
    );
  }
}

// Opening and closing projects is serialised, so a project that is being
// closed has released its editing lock before the next one asks for it.
let queue: Promise<unknown> = Promise.resolve();

function ProjectScreen(props: { services: Services; id: ProjectId }) {
  const { services, id } = props;
  const [model, setModel] = useState<WorkspaceModel | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let opened: WorkspaceModel | null = null;
    queue = queue
      .then(async () => {
        if (cancelled) return;
        opened = await WorkspaceModel.open(services, id);
        if (cancelled) {
          await opened.dispose();
          opened = null;
          return;
        }
        setModel(opened);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
      setModel(null);
      setError(null);
      const closing = opened;
      opened = null;
      if (closing) queue = queue.then(() => closing.dispose()).catch(() => undefined);
    };
  }, [services, id]);

  if (error) {
    return (
      <FullMessage
        title="This project could not be opened."
        action={
          <button className="btn primary" onClick={() => go({ name: 'home' })}>
            Back to all projects
          </button>
        }
      >
        <p>{error}</p>
      </FullMessage>
    );
  }
  if (!model) return <FullMessage title="Opening the project…" />;
  return <Workspace model={model} services={services} onHome={() => go({ name: 'home' })} />;
}

export function App() {
  const [services, setServices] = useState<Services | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

  useEffect(() => {
    getServices().then(setServices, (reason: unknown) => setFailure(reason instanceof Error ? reason.message : String(reason)));
    const onHash = (): void => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (failure) {
    return (
      <FullMessage title={`${APP_NAME} cannot store projects in this browser window.`}>
        <p>
          The editor keeps your projects in the browser's own storage, and this window does not allow it. This happens in some private or
          incognito windows and when site data is blocked. Open the site in a normal window and try again.
        </p>
        <p className="faint mono" style={{ marginTop: 8, fontSize: 12 }}>
          {failure}
        </p>
      </FullMessage>
    );
  }
  if (!services) return <FullMessage title="Starting…" />;

  return (
    <ErrorBoundary>
      {route.name === 'home' ? (
        <Home services={services} onOpen={(id) => go({ name: 'project', id })} />
      ) : (
        <ProjectScreen key={route.id} services={services} id={route.id} />
      )}
      <Toasts />
    </ErrorBoundary>
  );
}
