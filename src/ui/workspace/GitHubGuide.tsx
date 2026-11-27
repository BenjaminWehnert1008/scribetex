/**
 * A step-by-step guide to the GitHub backup for people who have never used
 * GitHub. The links fill in GitHub's forms as far as GitHub allows (see
 * "Creating a new repository from a URL query" and "Pre-filling fine-grained
 * personal access token details using URL parameters" in GitHub's docs), so
 * only the choices GitHub cannot take from a link are left to the person.
 */
import { ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import { APP_NAME } from '@/app/brand';
import { Dialog } from '../common/ui';

export const SUGGESTED_REPOSITORY = 'latex-backup';
export const SIGN_UP_URL = 'https://github.com/signup';
export const NEW_REPOSITORY_URL = `https://github.com/new?${new URLSearchParams({
  name: SUGGESTED_REPOSITORY,
  description: `Backups of my ${APP_NAME} projects`,
  visibility: 'private',
}).toString()}`;
/** Contents "Read and write" is the only permission the backup needs; GitHub adds "Metadata: Read-only" by itself. */
export const NEW_TOKEN_URL = `https://github.com/settings/personal-access-tokens/new?${new URLSearchParams({
  name: `${APP_NAME} backup`,
  description: `Lets ${APP_NAME} back up projects to my private backup repository.`,
  expires_in: '366',
  contents: 'write',
}).toString()}`;

function Step(props: { number: number; title: string; link?: { href: string; label: string }; children: ReactNode }) {
  return (
    <li className="guide-step">
      <span className="guide-number" aria-hidden="true">
        {props.number}
      </span>
      <div className="guide-body">
        <h3>{props.title}</h3>
        {props.children}
        {props.link && (
          <a className="btn small" href={props.link.href} target="_blank" rel="noopener noreferrer">
            {props.link.label} <ExternalLink size={13} aria-hidden="true" />
          </a>
        )}
      </div>
    </li>
  );
}

/**
 * The four steps. The last one depends on where the guide is shown: next to
 * the form in a project, or on the home screen where no project is open yet.
 */
export function GitHubGuideSteps(props: { lastStep: 'form' | 'open-project' | 'this-project' }) {
  return (
    <ol className="guide" aria-label="Steps on GitHub">
      <Step number={1} title="Create a free GitHub account" link={{ href: SIGN_UP_URL, label: 'Sign up on GitHub' }}>
        <p>
          GitHub is a website where people keep files safe, with every earlier state of them. A personal account is free. Enter your email, a
          password and a user name, then confirm the code GitHub emails you.
        </p>
        <p className="muted">Already have an account? Sign in on github.com and go on with step 2.</p>
      </Step>
      <Step number={2} title="Create a private repository" link={{ href: NEW_REPOSITORY_URL, label: 'Open the form, already filled in' }}>
        <p>
          A repository is a folder on GitHub. One is enough for all your projects; each project gets its own folder inside it. The link fills in the
          name <span className="mono">{SUGGESTED_REPOSITORY}</span> and chooses <b>Private</b>, so only you can see it.
        </p>
        <p className="muted">
          Check that <b>Private</b> is selected, then click <b>Create repository</b>. Its name is now{' '}
          <span className="mono">your-user-name/{SUGGESTED_REPOSITORY}</span>.
        </p>
      </Step>
      <Step number={3} title="Create a key for scribeTeX (a token)" link={{ href: NEW_TOKEN_URL, label: 'Open the form, already filled in' }}>
        <p>
          The token lets {APP_NAME} write into this one repository and nothing else. The link fills in a name, one year of validity and the only
          permission needed (<b>Contents: Read and write</b>). You only have to choose the repository:
        </p>
        <ol className="guide-sub">
          <li>
            Under <b>Repository access</b>, click <b>Only select repositories</b> and pick <span className="mono">{SUGGESTED_REPOSITORY}</span>.
          </li>
          <li>
            Scroll down and click <b>Generate token</b> (and once more if GitHub asks you to confirm).
          </li>
          <li>
            Copy the token. It starts with <span className="mono">github_pat_</span>, and GitHub shows it only once.
          </li>
        </ol>
      </Step>
      {props.lastStep === 'form' && (
        <Step number={4} title={`Connect it in ${APP_NAME}`}>
          <p>
            Paste the repository name and the token into the fields below and click <b>Connect and back up</b>. From then on every change is backed
            up by itself.
          </p>
        </Step>
      )}
      {props.lastStep === 'this-project' && (
        <Step number={4} title={`Connect it in ${APP_NAME}`}>
          <p>
            In <b>Saving and backup</b> on the left, click <b>Set up…</b> under "A private GitHub repository". Paste the repository name and the
            token, and click <b>Connect and back up</b>. For other projects the token is remembered.
          </p>
        </Step>
      )}
      {props.lastStep === 'open-project' && (
        <Step number={4} title={`Connect it in ${APP_NAME}`}>
          <p>
            Open a project, click <b>Saving and backup</b> on the left, then <b>Set up…</b> under "A private GitHub repository". Paste the repository
            name and the token, and click <b>Connect and back up</b>. Do this once for each project; the token is remembered.
          </p>
        </Step>
      )}
    </ol>
  );
}

/** `where` says whether a project is open behind the guide, which changes the last step. */
export function GitHubGuideDialog(props: { onClose: () => void; where?: 'home' | 'project' }) {
  return (
    <Dialog title="Set up a GitHub backup, step by step" wide onClose={props.onClose}>
      <p className="muted" style={{ marginBottom: 12 }}>
        About five minutes, no previous knowledge needed. Once a project is connected, {APP_NAME} backs it up by itself after changes, so it is safe
        even if this browser's data is cleared or the computer is lost.
      </p>
      <GitHubGuideSteps lastStep={props.where === 'project' ? 'this-project' : 'open-project'} />
      <div className="actions">
        <button className="btn primary" onClick={props.onClose}>
          Got it
        </button>
      </div>
    </Dialog>
  );
}
