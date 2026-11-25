#!/usr/bin/env node
/**
 * Assembles public/engine/, the folder the compile engine is served from.
 *
 *   public/engine/runtime/         the Siglum runtime (WebAssembly program and TeX Live bundles)
 *   public/engine/siglum-worker.js the engine's worker, with one small documented patch
 *   public/engine/packages/        LaTeX packages, one archive each, built from a TeX Live tree
 *   public/engine/SOURCE.md        where the source of everything in this folder lives
 *   public/engine/manifest.json    versions, read by the app
 *
 * Nothing in public/engine is committed. The engine programs are GPL software
 * that we ship unchanged next to the app; see docs/COMPLIANCE.md.
 *
 * Environment:
 *   SIGLUM_RUNTIME_TARBALL  use this local tarball instead of downloading
 *   TEXLIVE_ROOT            build the package folder from this TeX Live tree
 *   ENGINE_PACKAGES_DIR     or copy an already built package folder
 *   ENGINE_PACKAGES_ONLY    comma separated package names, to build a subset
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public/engine');
const CACHE = process.env.ENGINE_CACHE_DIR || path.join(ROOT, '.cache/engine');
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'engine/engine.lock.json'), 'utf8'));

function log(message) {
  console.log(`[engine] ${message}`);
}

function sha256(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1 << 20);
  for (;;) {
    const read = fs.readSync(fd, buffer, 0, buffer.length, null);
    if (read === 0) break;
    hash.update(buffer.subarray(0, read));
  }
  fs.closeSync(fd);
  return hash.digest('hex');
}

function prepareRuntime() {
  const target = path.join(OUT, 'runtime');
  const stamp = path.join(target, '.prepared');
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === lock.siglum.sha256) {
    log('runtime is up to date');
    return target;
  }

  let tarball = process.env.SIGLUM_RUNTIME_TARBALL;
  if (!tarball) {
    fs.mkdirSync(CACHE, { recursive: true });
    tarball = path.join(CACHE, `siglum-runtime-v${lock.siglum.version}.tar.gz`);
    if (!fs.existsSync(tarball)) {
      log(`downloading ${lock.siglum.runtimeUrl}`);
      execFileSync('curl', ['-fL', '--retry', '4', '--retry-delay', '2', '-o', tarball + '.part', lock.siglum.runtimeUrl], {
        stdio: 'inherit',
      });
      fs.renameSync(tarball + '.part', tarball);
    }
  }

  const actual = sha256(tarball);
  if (actual !== lock.siglum.sha256) {
    throw new Error(`Runtime checksum mismatch.\n  expected ${lock.siglum.sha256}\n  actual   ${actual}\n  file     ${tarball}`);
  }

  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', target, '--exclude=._*', '--warning=no-unknown-keyword'], { stdio: 'inherit' });

  const runtime = JSON.parse(fs.readFileSync(path.join(target, 'runtime.json'), 'utf8'));
  if (runtime.releaseId !== lock.siglum.releaseId) {
    throw new Error(`Runtime release is ${runtime.releaseId}, the lock file expects ${lock.siglum.releaseId}`);
  }
  // The runtime ships its own copy of the worker; ours is served from the folder above.
  fs.rmSync(path.join(target, 'worker.js'), { force: true });
  fs.writeFileSync(stamp, lock.siglum.sha256 + '\n');
  log(`runtime ${runtime.releaseId} extracted`);
  return target;
}

/**
 * The published worker never calls makeindex although the program is linked
 * into the WebAssembly module, so \printindex would stay empty. The patch runs
 * it between the first pass and the reruns whenever the document wrote an
 * .idx file. Every anchor must match exactly once, so an engine update that
 * moves this code fails loudly here instead of silently dropping the patch.
 */
function prepareWorker() {
  const source = path.join(ROOT, 'node_modules/@siglum/engine/src/worker.js');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/@siglum/engine/package.json'), 'utf8'));
  if (pkg.version !== lock.siglum.version) {
    throw new Error(`@siglum/engine is ${pkg.version}, the lock file expects ${lock.siglum.version}`);
  }
  let code = fs.readFileSync(source, 'utf8');
  const applied = [];

  const patch = (name, find, replacement) => {
    const count = code.split(find).length - 1;
    if (count !== 1) throw new Error(`Worker patch "${name}" matched ${count} times, expected exactly 1`);
    code = code.replace(find, () => replacement);
    applied.push(name);
  };

  patch(
    'run makeindex when the document wrote an .idx file',
    `                    // Auto-rerun loop for cross-references/TOC`,
    `                    // --- added by scripts/engine-prepare.mjs: makeindex ---
                    {
                        let idxSize = 0;
                        try { idxSize = FS.stat(docBase + '.idx').size; } catch {}
                        if (idxSize > 0) {
                            const jobName = docBase.slice(docBase.lastIndexOf('/') + 1);
                            let indexBefore = null;
                            try { indexBefore = FS.readFile(docBase + '.ind', { encoding: 'utf8' }); } catch {}
                            await resetForPass(collectAuxFiles(FS));
                            workerProgress('compile', 'Building index…');
                            workerLog('Running makeindex…');
                            const mi = Module.callMainWithRedirects(['makeindex', '-q', jobName + '.idx']);
                            let indexLog = [mi.stdout, mi.stderr].filter(Boolean).join('\\n');
                            try { indexLog = FS.readFile(docBase + '.ilg', { encoding: 'utf8' }); } catch {}
                            texLog += '\\n' + indexLog;
                            if (mi.exit_code !== 0) {
                                lastExitCode = mi.exit_code;
                                throw new Error('makeindex failed: ' + (indexLog.split('\\n').find(Boolean) || 'see the full log.'));
                            }
                            let indexAfter = null;
                            try { indexAfter = FS.readFile(docBase + '.ind', { encoding: 'utf8' }); } catch {}
                            if (indexAfter === null) throw new Error('makeindex did not produce an index (.ind).');
                            workerLog('makeindex completed.');
                            if (indexAfter !== indexBefore) {
                                // The index changed, so one more TeX pass has to typeset it.
                                bibliographyPasses = Math.max(bibliographyPasses, 1);
                                maxRerunPasses = Math.max(maxRerunPasses, rerunPass + 1);
                            }
                        }
                    }
                    // --- end of addition ---

                    // Auto-rerun loop for cross-references/TOC`,
  );

  patch(
    'carry index files from one pass to the next',
    `    const auxExtensions = ['.aux', '.toc', '.lof', '.lot', '.out', '.nav', '.snm', '.bbl', '.blg', '-blx.bib'];`,
    `    const auxExtensions = ['.aux', '.toc', '.lof', '.lot', '.out', '.nav', '.snm', '.bbl', '.blg', '-blx.bib', '.idx', '.ind', '.ilg'];`,
  );

  const banner =
    `// @siglum/engine ${pkg.version} worker (MIT, Copyright (c) 2026 Siglum Project), copied from the npm package\n` +
    `// with these changes applied by scripts/engine-prepare.mjs:\n` +
    applied.map((name) => `//   - ${name}\n`).join('');
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'siglum-worker.js'), banner + code);
  fs.copyFileSync(path.join(ROOT, 'node_modules/@siglum/engine/LICENSE'), path.join(OUT, 'siglum-LICENSE.txt'));
  log(`worker written with ${applied.length} patches`);
  return applied;
}

function preparePackages(runtimeDir) {
  const target = path.join(OUT, 'packages');
  if (process.env.TEXLIVE_ROOT) {
    const args = [path.join(ROOT, 'engine/build_packages.py'), process.env.TEXLIVE_ROOT, target, runtimeDir];
    if (process.env.ENGINE_PACKAGES_ONLY) args.push('--only', process.env.ENGINE_PACKAGES_ONLY);
    execFileSync('python3', args, { stdio: 'inherit' });
  } else if (process.env.ENGINE_PACKAGES_DIR) {
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(process.env.ENGINE_PACKAGES_DIR, target, { recursive: true });
    log(`packages copied from ${process.env.ENGINE_PACKAGES_DIR}`);
  } else if (fs.existsSync(path.join(target, 'index.json'))) {
    log('packages are already in place');
  } else {
    log('WARNING: no TEXLIVE_ROOT or ENGINE_PACKAGES_DIR given. Only packages inside the runtime bundles will compile.');
    fs.mkdirSync(path.join(target, 'bundles'), { recursive: true });
    for (const name of ['file-to-package.json', 'font-name-to-package.json']) {
      fs.copyFileSync(path.join(runtimeDir, name), path.join(target, 'bundles', name));
    }
    fs.writeFileSync(path.join(target, 'index.json'), '[]\n');
  }
  const index = JSON.parse(fs.readFileSync(path.join(target, 'index.json'), 'utf8'));
  return index.length;
}

function writeNotes(patches, packageCount) {
  const manifest = {
    engine: '@siglum/engine',
    version: lock.siglum.version,
    releaseId: lock.siglum.releaseId,
    texLiveYear: lock.texlive.year,
    packages: packageCount,
    preparedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  fs.writeFileSync(
    path.join(OUT, 'SOURCE.md'),
    `# Source of the files in this folder

The files here are free software from other projects. They are served unchanged
next to the editor and are not covered by the editor's own MIT licence.

## runtime/

The Siglum runtime, release \`${lock.siglum.releaseId}\`, engine version ${lock.siglum.version}:
pdfTeX, XeTeX, LuaTeX, BibTeX, makeindex and their libraries from TeX Live ${lock.texlive.year},
compiled to WebAssembly, together with LaTeX packages and fonts.

- Downloaded from: ${lock.siglum.runtimeUrl}
- SHA-256 of that archive: \`${lock.siglum.sha256}\`
- Source of the engine wrapper (MIT): ${lock.siglum.source}
- Source and build scripts of the WebAssembly programs: ${lock.siglum.compilerSource}
- Exact TeX Live package revisions: \`runtime/texlive-packages.lock.json\`

The programs carry their own licences: pdfTeX and LuaTeX are under the GNU
General Public License, version 2 or later; kpathsea is under the GNU Lesser
General Public License, version 2.1 or later; the bundled libraries each have
their own licence. These programs come with ABSOLUTELY NO WARRANTY.
The licence texts are served under \`licenses/\` at the root of this site.

## siglum-worker.js

The worker from the npm package \`@siglum/engine\` ${lock.siglum.version} (MIT, see \`siglum-LICENSE.txt\`),
with these changes:

${patches.map((name) => `- ${name}`).join('\n')}

The exact changes are in \`scripts/engine-prepare.mjs\` in the editor's repository.

## packages/

One archive per TeX Live package, with the package's files unchanged.
\`packages/MANIFEST.tsv\` lists every package with its TeX Live revision, its
licence as recorded in the TeX Catalogue, and its CTAN page, where the source
of each package can be downloaded.
`,
  );
}

const runtimeDir = prepareRuntime();
const patches = prepareWorker();
const packageCount = preparePackages(runtimeDir);
writeNotes(patches, packageCount);
log(`done: ${packageCount} packages, output in ${path.relative(ROOT, OUT)}`);
