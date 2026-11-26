# scribeTex

<img src="public/logo.svg" alt="scribeTex" width="340">

A LaTeX editor that runs entirely in the browser: a file tree with real
folders, an editor, and a PDF preview, compiled on your own computer by a
WebAssembly build of TeX Live. There is no server and no account. The site is
plain static files and is published with GitHub Pages.

The name is set in
`src/app/brand.ts` and in the title of `index.html`. The pixel-art logo and
favicon are drawn by `scripts/make-logo.mjs` (`npm run logo`).

## What it does

- Projects with nested folders, drag and drop, upload of files and whole folders.
- An editor with LaTeX highlighting, completion of commands, environments,
  labels, citation keys and file names, an outline, and problems that jump to
  the right line of the right file.
- pdfLaTeX with BibTeX and makeindex, compiled in the browser, with a PDF
  preview next to the source. Compiling on every change can be switched on.
- Saving that is built so that work is not lost. See the next section.
- **Ask Claude**, from the top bar or next to any problem. See below.

## Where the work is saved

Nothing leaves the computer unless the user connects a backup themselves. The
app says so on the first visit, and the save indicator in the top bar always
names where the current project is.

| Layer | What it protects against |
| --- | --- |
| Browser storage (IndexedDB), written 0.4 s after typing stops | closing the tab, a reload |
| A small journal of unsaved keystrokes | a crash in the middle of typing |
| Versions (automatic and named) | deleting or overwriting the wrong thing |
| **Linked folder** on disk (Chrome and Edge on a computer) | clearing the browser's site data; lets other tools (git, a cloud drive's sync app) see the files |
| **GitHub backup** to a private repository | losing the computer |
| ZIP download and import | everything else, and moving between browsers |

A linked folder is kept in step in both directions. When a file was changed in
the browser and on disk at the same time, both versions are kept. When a folder
suddenly misses many files, nothing is deleted before the user has decided.

Firefox and Safari cannot write to a folder. The app works there and explains
that projects then live inside the browser only, with ZIP and GitHub as the
ways out.

To put a project into Google Drive, Dropbox or OneDrive, link it to a folder
inside that service's folder on the computer. Its sync app does the rest.

### GitHub backup

The backup talks to `api.github.com` straight from the browser, with a token
the user creates and that is stored in that browser only. To set it up:

1. Create a **private** repository for backups. Several projects can share one;
   each gets its own folder.
2. Create a fine-grained personal access token at
   <https://github.com/settings/personal-access-tokens/new>, limited to that one
   repository, with the permission **Contents: Read and write**.
3. In a project, open **Saving and backup**, choose **Set up…** under GitHub,
   and paste the repository name and the token.

Each backup is one commit. "Restore from GitHub" on the start page brings a
project back on another computer.

## Ask Claude

scribeTex has no assistant of its own and never talks to Claude itself. The
**Ask Claude** button opens the Claude desktop app with a question already
written in: the person's question, the problem with its file, line and log,
and what the engine can and cannot do. The person sends it there, with their
own Claude plan. (Other apps may not sign in with a Claude subscription, so a
chat inside scribeTex would need a pay-per-use API key instead.)

- When the project is linked to a folder, the app opens on that folder
  (`claude://cowork/new?folder=…`), and Claude can read and change the files.
  Browsers do not reveal a folder's full path, so the person pastes it once per
  project; it is kept in that browser only. scribeTex notices the changes in
  the folder within a second (Chrome's `FileSystemObserver`; elsewhere at the
  next check, at most 20 s later) and compiles again.
- Without a folder, the question includes the file being edited, around the
  line in question (`claude://claude.ai/new?q=…`).
- Without the desktop app, "Use claude.ai in the browser" copies the question
  and opens claude.ai.

The links are described in
[Open Claude Desktop with a link](https://support.claude.com/en/articles/14729294).
The app fills in the message but does not send it, and keeps about 14,000
characters, so scribeTex keeps questions under 12,000.

## Limits

- pdfLaTeX only. BibTeX and makeindex are there; biber is not, so biblatex
  needs `backend=bibtex`. Nothing that runs other programs works (minted, svg).
- Hyphenation is built in for English only. Text in other languages compiles,
  with a warning from babel, but words are not broken at line ends.
- The first compile downloads the engine, tens of megabytes. After that the
  browser has it cached. A document that uses T1 encoding without a font
  package (such as `lmodern`) loads another 60 MB of fonts once.
- The LaTeX packages are the ones built into the site. The list is the base
  tree plus `engine/extra-packages.txt`.

## Working on it

Node 22.13 or newer.

```sh
npm ci
npm run engine:prepare   # downloads the engine into public/engine (about 300 MB)
npm run dev              # http://localhost:5173
```

`engine:prepare` without further settings gives an engine that knows only the
packages inside its own bundles. For the full set, point it at a TeX Live tree:

```sh
TEXLIVE_ROOT=/path/to/texlive npm run engine:prepare
```

Checks:

```sh
npm run check   # types, lint, unit tests
npm run e2e     # browser tests against a production build
```

The browser tests that compile a document are skipped when the engine has not
been prepared.

### Layout of the code

| Folder | Content |
| --- | --- |
| `src/core` | Everything without a user interface: storage, saving, folder sync, GitHub backup, the compile queue, the log parser. Unit tested. |
| `src/app` | Wires the core to one open project. |
| `src/ui` | The React screens. |
| `engine`, `scripts` | How `public/engine` is assembled. |
| `e2e` | Browser tests. |

## Publishing

1. In the repository, set **Settings > Pages > Source** to **GitHub Actions**.
2. Push to `main`. The workflow in `.github/workflows/pages.yml` checks, builds,
   runs the browser tests against the build and publishes it.

The build uses relative addresses, so it works under
`https://<user>.github.io/<repository>/` and under a domain of its own without
any setting.

Hosting it somewhere else: the engine fetches its `*.data.gz` files and unpacks
them itself. The server must send them as they are, **without**
`Content-Encoding: gzip`. GitHub Pages does. A server that adds that header
makes every compile fail.

## Licences

The editor's own code is under the MIT licence, see `LICENSE`. The engine and
the LaTeX packages are other people's free software, published unchanged next
to the editor under their own licences. `docs/COMPLIANCE.md` has the details,
and the site itself serves them under `licenses/` and `engine/SOURCE.md`.

This project was written from scratch. It contains no code from other LaTeX
editors.
