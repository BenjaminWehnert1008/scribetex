# Community templates

The new-project dialog has a tab "From the community" with templates by other
authors. They are listed in `sources.json`, each pinned to a commit of its
repository, and copied into `public/templates/` by

```sh
npm run templates
```

which needs `git` and network access, and `pdftoppm` for the preview
pictures. Commit what it writes. The site serves the copies itself, so
starting a project from one sends nothing to another server.

## What a template needs to be listed

- **An open license that allows passing it on and changing it:** MIT, BSD,
  Apache-2.0, CC0, CC BY, CC BY-SA or LPPL. Not: no license at all,
  non-commercial (NC) or no-derivatives (ND) licenses, which rules out most of
  LaTeXTemplates.com and much of the Overleaf gallery.
- **It compiles here:** pdfLaTeX and BibTeX, no biber, no shell escape, no
  XeLaTeX or LuaLaTeX (so no `fontspec`). Packages outside the base set go into
  `packages` in `sources.json` and into `engine/extra-packages.txt`. The browser
  tests compile every template; a template whose packages the local engine
  lacks is skipped locally and tested on GitHub.
- **No personal data and no third-party logos.** A real person's CV or a
  university crest does not belong in a template.
- **Copied unchanged.** If a template needs a change to work here, prefer
  another template.

Each project made from a template gets `TEMPLATE-LICENSE.txt` with the source,
the commit and the license text.

## Fields in `sources.json`

| Field | Meaning |
| --- | --- |
| `id` | Folder name under `public/templates/`, lower case with dashes |
| `name`, `category`, `description`, `author` | Shown in the dialog |
| `repo`, `commit` | GitHub repository and the commit to copy from |
| `folder` | The template's folder inside the repository, if not the top |
| `main` | The file to compile, relative to `folder` |
| `files` | Files and folders to copy, relative to `folder` |
| `license` | `spdx`: the license identifier; `file`: the license file in the repository (otherwise the text comes from the SPDX license list); `note`: one more sentence for TEMPLATE-LICENSE.txt |
| `previewPdf` | A PDF in the repository to take the preview picture from |
| `packages` | TeX Live packages that the template needs beyond the base set |
