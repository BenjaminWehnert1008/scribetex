# Licences and clean-room rules

This file says what the published site consists of, under which licences, and
which rules keep it that way.

## What is published

| Part | Where on the site | Licence | Source |
| --- | --- | --- | --- |
| The editor | `index.html`, `assets/` | MIT (`LICENSE`) | this repository |
| npm packages bundled into the editor (React, CodeMirror, pdf.js, IBM Plex fonts and others) | inside `assets/` | MIT, ISC, Apache-2.0, OFL-1.1 | listed with their full licence texts in `licenses/THIRD-PARTY-NOTICES.txt`, generated from `package-lock.json` by `scripts/gen-notices.mjs` on every build |
| The engine worker | `engine/siglum-worker.js` | MIT | npm package `@siglum/engine`, with the small changes written out and explained in `scripts/engine-prepare.mjs` |
| The TeX programs as WebAssembly (pdfTeX, BibTeX, makeindex and libraries) | `engine/runtime/` | GPL-2.0-or-later, LGPL-2.1-or-later and others | downloaded unchanged from the Siglum release named in `engine/engine.lock.json`, checksum verified |
| LaTeX packages and fonts | `engine/runtime/`, `engine/packages/` | mostly LPPL, each package its own | TeX Live; every package with revision, licence and CTAN address in `engine/packages/MANIFEST.tsv` |
| Community templates | `templates/` | each its own open licence (MIT, Apache-2.0, CC BY-SA 4.0 at the moment) | copied unchanged from the authors' GitHub repositories at the commits in `community-templates/sources.json`; every template carries its source and licence text in `TEMPLATE-LICENSE.txt`, which also goes into each project made from it |

## Why the editor can be MIT next to a GPL engine

The editor and the engine are separate programs. The engine runs in its own
worker and is given files and returns a PDF and a log; the editor does not link
against it or contain any of its code. Publishing both on one site is
"mere aggregation" in the sense of the GPL.

What the GPL does ask of whoever publishes the binaries is met like this:

- The binaries are served unchanged, in their own folder.
- `engine/SOURCE.md` on the site names the exact release, its checksum, and
  where the corresponding source and build scripts are.
- The licence texts are on the site under `licenses/`.
- The site states that the programs come without warranty.

When the engine is updated: change `engine/engine.lock.json` (version, release
id, address, checksum), run `npm run engine:prepare`, and check that
`public/engine/SOURCE.md` still describes what is there. The script stops if
the checksum or the release id do not match.

## Dependencies that are not allowed

Anything under the AGPL, or under a licence that would put conditions on the
editor's own code. Two that look tempting and are ruled out for that reason:
`codemirror-lang-latex` and `texlyre-busytex`. The notices file names the
licence of every bundled package; a new one outside MIT, ISC, BSD, Apache-2.0
and OFL needs a decision before it is added.

## Clean-room rules

The idea for this editor came from looking at existing ones as a user. The
code did not.

- No code, styles, icons, wording or assets are taken from any other LaTeX
  editor. For TeXbrain in particular, only its README, licence file and
  package manifest were read, to learn what it is built from and what it
  cannot do. Its `src/` and `static/` folders were never opened.
- Nothing is taken from OpenAI's Prism: not its name, its look, its labels or
  its assets. A three-part layout of files, source and preview is common to
  LaTeX editors and is not anybody's property; the design here is our own.
- The lists of LaTeX commands and environments used for completion
  (`src/ui/editor/latex-data.ts`) were written for this project.
- The built-in project templates are our own text. The community templates
  are other authors' work, taken from their own repositories under their
  licences, never from another editor's gallery. `community-templates/README.md`
  says which licences qualify.

Anyone contributing is asked to keep to the same rules.

## Tokens and private data

The GitHub backup stores the user's token in the browser's own storage for
this site and sends it to `api.github.com` only. It is never written into a
project, a ZIP export, a linked folder or a backup. The site's content
security policy allows connections to its own address and to
`api.github.com`, nothing else.
