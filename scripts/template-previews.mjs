#!/usr/bin/env node
/**
 * Draws the pictures that the new-project dialog shows for the built-in
 * templates (src/templates/): the first page of each, compiled with a local
 * pdflatex and drawn with pdftoppm (poppler), into
 *   src/templates/previews/<id>.jpg
 *   src/templates/previews/previews.json   the version of each template that its picture shows
 *
 * Run `npm run previews` after changing a built-in template and commit the
 * result: a unit test fails while a picture is older than its template.
 * Builds need neither pdflatex nor poppler. A template whose document has no
 * pages (Blank) gets no picture, and the dialog shows an empty page for it.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src/templates/previews');

const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

/** The end of a log, where TeX reports what went wrong. */
const tail = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'latin1').split('\n').slice(-25).join('\n') : '(no log)');

/**
 * Compiles a project as the editor does: pdflatex, BibTeX when there is a
 * bibliography, and pdflatex twice more for the references and contents.
 * Returns the PDF, or null for a document without pages.
 */
function compile(dir, main) {
  const stem = main.replace(/\.tex$/, '');
  const pdflatex = () => {
    try {
      run('pdflatex', ['-interaction=nonstopmode', '-halt-on-error', main], dir);
    } catch {
      throw new Error(`${main} did not compile:\n${tail(path.join(dir, `${stem}.log`))}`);
    }
  };
  pdflatex();
  const aux = path.join(dir, `${stem}.aux`);
  if (fs.existsSync(aux) && fs.readFileSync(aux, 'latin1').includes('\\bibdata{')) {
    try {
      run('bibtex', [stem], dir);
    } catch {
      throw new Error(`BibTeX failed for ${main}:\n${tail(path.join(dir, `${stem}.blg`))}`);
    }
  }
  pdflatex();
  pdflatex();
  const pdf = path.join(dir, `${stem}.pdf`);
  return fs.existsSync(pdf) ? pdf : null;
}

async function main() {
  for (const tool of ['pdflatex', 'bibtex', 'pdftoppm']) {
    try {
      run('sh', ['-c', `command -v ${tool}`], ROOT);
    } catch {
      throw new Error(`${tool} is not on the PATH. The previews need TeX Live (or TinyTeX) and poppler.`);
    }
  }
  const { module: registry } = await runnerImport(path.join(ROOT, 'src/templates/index.ts'));
  const { module: previews } = await runnerImport(path.join(ROOT, 'src/templates/previews.ts'));

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'template-previews-'));
  const manifest = {};
  try {
    for (const template of registry.TEMPLATES) {
      const dir = path.join(work, template.id);
      for (const folder of template.dirs ?? []) fs.mkdirSync(path.join(dir, folder), { recursive: true });
      for (const file of template.files) {
        fs.mkdirSync(path.dirname(path.join(dir, file.path)), { recursive: true });
        fs.writeFileSync(path.join(dir, file.path), registry.templateFileBytes(file));
      }
      const pdf = template.mainFile ? compile(dir, template.mainFile) : null;
      if (pdf) {
        const stem = path.join(OUT, template.id);
        run('pdftoppm', ['-f', '1', '-l', '1', '-singlefile', '-scale-to-x', '360', '-scale-to-y', '-1', '-jpeg', '-jpegopt', 'quality=80', pdf, stem], dir);
      }
      manifest[template.id] = { fingerprint: await previews.templateFingerprint(template), picture: pdf !== null };
      console.log(`${template.id}: ${pdf ? 'picture of the first page' : 'no pages, so no picture'}`);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(OUT, 'previews.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote the previews of ${Object.keys(manifest).length} templates to src/templates/previews/`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
