#!/usr/bin/env node
/**
 * Copies the community templates listed in community-templates/sources.json,
 * each at its pinned commit, into public/templates/:
 *   index.json           what the new-project dialog lists
 *   <id>/files/...       the files a new project gets, plus TEMPLATE-LICENSE.txt
 *   <id>/preview.jpg     the first page, shown in the dialog
 *
 * Run `npm run templates` after changing sources.json and commit the result,
 * so builds need no network for templates. Needs git and network access to
 * github.com and raw.githubusercontent.com. The previews need `pdftoppm`
 * (poppler). They are made from the PDF that the template's own repository
 * ships (`previewPdf`); without one, from a local `pdflatex` run if pdflatex
 * is on the PATH. A template that gets neither has no preview.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = path.join(ROOT, 'community-templates/sources.json');
const OUT = path.join(ROOT, 'public/templates');
/** License texts for templates whose repository has no license file. */
const SPDX_TEXTS = 'https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/text';
const LICENSE_NAMES = {
  MIT: 'MIT License',
  'Apache-2.0': 'Apache License 2.0',
  'CC-BY-SA-4.0': 'Creative Commons Attribution-ShareAlike 4.0',
  'CC-BY-4.0': 'Creative Commons Attribution 4.0',
  'CC0-1.0': 'CC0 1.0 (public domain)',
  'LPPL-1.3c': 'LaTeX Project Public License 1.3c',
  'BSD-3-Clause': 'BSD 3-Clause License',
};
/** A usable file or folder name: no control characters and none of the characters that some systems reserve. */
const safePart = (part) => part !== '.' && part !== '..' && /^[^<>:"|?*\\/]+$/.test(part) && [...part].every((char) => char.charCodeAt(0) >= 32);

const run = (command, args, options = {}) => execFileSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options }).toString();
const has = (command) => {
  try {
    run('sh', ['-c', `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
};

function checkout(repo, commit, dir) {
  fs.mkdirSync(dir, { recursive: true });
  run('git', ['init', '-q'], { cwd: dir });
  run('git', ['fetch', '-q', '--depth', '1', `https://github.com/${repo}.git`, commit], { cwd: dir });
  run('git', ['checkout', '-q', 'FETCH_HEAD'], { cwd: dir });
}

/** Every file under `relative` (a file or a folder) inside `base`, as paths relative to `base`. */
function expand(base, relative) {
  const full = path.join(base, relative);
  if (!fs.existsSync(full)) throw new Error(`${relative} is not in the repository`);
  if (fs.statSync(full).isFile()) return [relative];
  return fs
    .readdirSync(full)
    .filter((name) => !name.startsWith('.'))
    .sort()
    .flatMap((name) => expand(base, path.posix.join(relative, name)));
}

async function licenseText(entry, checkoutDir) {
  if (entry.license.file) return fs.readFileSync(path.join(checkoutDir, entry.license.file), 'utf8');
  const response = await fetch(`${SPDX_TEXTS}/${entry.license.spdx}.txt`);
  if (!response.ok) throw new Error(`No license text for ${entry.license.spdx} (${response.status})`);
  return response.text();
}

function sourceUrl(entry) {
  const folder = entry.folder ? `/${entry.folder.split('/').map(encodeURIComponent).join('/')}` : '';
  return `https://github.com/${entry.repo}/tree/${entry.commit}${folder}`;
}

function noticeFor(entry, license) {
  const name = LICENSE_NAMES[entry.license.spdx] ?? entry.license.spdx;
  return [
    `This project started from the template "${entry.name}" by ${entry.author}:`,
    sourceUrl(entry),
    '',
    `The template's files are used under the ${name}, printed below.`,
    ...(entry.license.note ? [entry.license.note] : []),
    'If you share the source files of this project, keep this notice with them.',
    '',
    '-'.repeat(72),
    '',
    license.trim(),
    '',
  ].join('\n');
}

function makePreview(pdf, target) {
  const stem = target.replace(/\.jpg$/, '');
  run('pdftoppm', ['-f', '1', '-l', '1', '-singlefile', '-scale-to-x', '360', '-scale-to-y', '-1', '-jpeg', '-jpegopt', 'quality=80', pdf, stem]);
}

function compileForPreview(dir, main) {
  const stem = main.replace(/\.tex$/, '');
  const pdflatex = () => {
    try {
      run('pdflatex', ['-interaction=nonstopmode', main], { cwd: dir });
    } catch {
      // A warning-level problem still gives a PDF; a missing PDF is checked below.
    }
  };
  pdflatex();
  try {
    run('bibtex', [stem], { cwd: dir });
  } catch {
    // Not every template has a bibliography.
  }
  pdflatex();
  const pdf = path.join(dir, `${stem}.pdf`);
  return fs.existsSync(pdf) ? pdf : null;
}

async function main() {
  const { templates } = JSON.parse(fs.readFileSync(SOURCES, 'utf8'));
  const ids = new Set();
  const canPreview = has('pdftoppm');
  const canCompile = has('pdflatex');
  if (!canPreview) console.warn('pdftoppm is not installed: the templates get no previews.');

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'templates-'));
  const checkouts = new Map();
  const index = [];

  for (const entry of templates) {
    if (!/^[a-z0-9-]+$/.test(entry.id) || ids.has(entry.id)) throw new Error(`Bad or repeated id: ${entry.id}`);
    ids.add(entry.id);
    const key = `${entry.repo}@${entry.commit}`;
    if (!checkouts.has(key)) {
      const dir = path.join(work, `checkout-${checkouts.size}`);
      console.log(`fetching ${key}`);
      checkout(entry.repo, entry.commit, dir);
      checkouts.set(key, dir);
    }
    const checkoutDir = checkouts.get(key);
    const base = path.join(checkoutDir, entry.folder ?? '');
    const paths = [...new Set(entry.files.flatMap((file) => expand(base, file)))];
    if (!paths.includes(entry.main)) throw new Error(`${entry.id}: the main file ${entry.main} is not among its files`);
    for (const file of paths) {
      if (!file.split('/').every(safePart)) throw new Error(`${entry.id}: unusable file name ${file}`);
    }

    const target = path.join(OUT, entry.id, 'files');
    const files = [];
    for (const file of paths) {
      const to = path.join(target, file);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(base, file), to);
      files.push({ path: file, bytes: fs.statSync(to).size });
    }
    const notice = 'TEMPLATE-LICENSE.txt';
    if (paths.includes(notice)) throw new Error(`${entry.id}: has its own ${notice}`);
    fs.writeFileSync(path.join(target, notice), noticeFor(entry, await licenseText(entry, checkoutDir)));
    files.push({ path: notice, bytes: fs.statSync(path.join(target, notice)).size });

    let preview = null;
    if (canPreview) {
      let pdf = entry.previewPdf ? path.join(base, entry.previewPdf) : null;
      if (!pdf && canCompile) {
        const scratch = path.join(work, `compile-${entry.id}`);
        fs.cpSync(target, scratch, { recursive: true });
        pdf = compileForPreview(scratch, entry.main);
      }
      if (pdf) {
        makePreview(pdf, path.join(OUT, entry.id, 'preview.jpg'));
        preview = 'preview.jpg';
      } else {
        console.warn(`${entry.id}: no preview (no PDF in the repository, and no local compile made one)`);
      }
    }

    index.push({
      id: entry.id,
      name: entry.name,
      category: entry.category,
      description: entry.description,
      author: entry.author,
      license: { spdx: entry.license.spdx, name: LICENSE_NAMES[entry.license.spdx] ?? entry.license.spdx },
      source: sourceUrl(entry),
      main: entry.main,
      files,
      preview,
      packages: entry.packages ?? [],
    });
    console.log(`${entry.id}: ${files.length} files${preview ? ', preview' : ''}`);
  }

  fs.writeFileSync(path.join(OUT, 'index.json'), `${JSON.stringify({ templates: index }, null, 2)}\n`);
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`Wrote ${index.length} templates to public/templates/`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
