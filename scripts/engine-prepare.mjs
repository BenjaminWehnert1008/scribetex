#!/usr/bin/env node
/**
 * Assembles public/engine/, the folder the compile engine is served from.
 *
 *   public/engine/runtime/         the Siglum runtime (WebAssembly program and TeX Live bundles)
 *   public/engine/siglum-worker.js the engine's worker, with the patches in prepareWorker() below
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
 * Code added to the worker in front of handleCompile(): precompiled preambles
 * and the BibTeX shortcut. It runs inside the worker, so it uses the worker's
 * own globals (docBase, getOrCreateModule, VirtualFileSystem, workerLog, ...).
 * It contains no backticks and no "${", so it can sit in String.raw as is.
 */
const PREAMBLE_FORMATS = String.raw`// --- added by scripts/engine-prepare.mjs: precompiled preambles and BibTeX reuse ---
//
// After a successful compile the worker dumps the preamble (the source up to
// \begin{document}) into a pdfTeX format while it is idle. A later pass loads
// that format and starts at \begin{document}, but only when the preamble text,
// every project file the preamble read, the project's list of files, the
// auxiliary files the pass starts with and the mounted packages are all the
// same as when the format was made.
//
// A format does not keep everything a preamble does. LaTeX leaves a few nodes
// on the first page (a \write and a colour push); they are read with
// \showlists and replayed in front of \begin{document}. Other things are lost:
// \pdfinfo, files the preamble keeps open for writing (\makeindex), colour
// stacks, font map lines. So every new format is checked once: a pass with it
// must write exactly the same PDF, .aux and other files as the normal pass of
// the compile it was made after. Only then is it used. Otherwise the document
// compiles the normal way, as before.
//
// The preamble runs with the clock pinned to SOURCE_DATE_EPOCH, so a preamble
// that stores the date or time (\the\year in an \edef, say) makes a format that
// fails the check instead of one that would keep an old date.
//
// Two smaller savings live here too. Packages that a compile had to fetch
// because a class or package loaded one the compiler did not list are mounted
// from the start of the next compile with the same preamble. And while the
// worker waits, it mounts the packages of the last compile into a new module
// for the next one.

const preambleFormats = new Map(); // main file -> { status: 'queued' | 'trusted' | 'failed', ... }
const lastBibtexRuns = new Map(); // main file -> { inputs, bbl } of the last BibTeX run
const fetchedBundles = new Map(); // main file -> { preamble, bundles: Map name -> { data, meta } }
let queuedCompiles = 0; // compile requests that arrived and have not started yet
let extraTexEnvironment = null; // added to the environment of the next module created
const PREAMBLE_END = 'SIGLUM-PREAMBLE-END';

function bytesOf(content) {
    if (content instanceof Uint8Array) return content;
    if (typeof content === 'string') return new TextEncoder().encode(content);
    if (content instanceof ArrayBuffer) return new Uint8Array(content);
    if (ArrayBuffer.isView(content)) return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    return new Uint8Array(0);
}

function readFileOrNull(FS, path) {
    try { return FS.readFile(path); } catch { return null; }
}

function readTextOrNull(FS, path) {
    try { return FS.readFile(path, { encoding: 'utf8' }); } catch { return null; }
}

function sameBytes(a, b) {
    if (a === null || b === null) return a === b;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

// SHA-256 of the parts, each with its length in front; a missing file (null) differs from every content.
async function digestOf(parts) {
    const encoder = new TextEncoder();
    const chunks = [];
    let total = 0;
    for (const part of parts) {
        const bytes = part === null || part === undefined ? new Uint8Array(0) : bytesOf(part);
        const head = encoder.encode(part === null || part === undefined ? 'null;' : bytes.length + ':');
        chunks.push(head, bytes);
        total += head.length + bytes.length;
    }
    const all = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
    return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function resolveFsPath(cwd, path) {
    const parts = [];
    for (const part of ((path.startsWith('/') ? '' : cwd + '/') + path).split('/')) {
        if (part === '' || part === '.') continue;
        if (part === '..') parts.pop();
        else parts.push(part);
    }
    return '/' + parts.join('/');
}

// The files a pass opened, from the list pdfTeX's -recorder option writes (<job>.fls).
function readRecorder(FS, base) {
    const text = readTextOrNull(FS, base + '.fls');
    if (text === null) return null;
    let pwd = '/';
    const entries = [];
    for (const raw of text.split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (line.startsWith('PWD ')) pwd = line.slice(4);
        else if (line.startsWith('INPUT ')) entries.push({ output: false, path: resolveFsPath(pwd, line.slice(6)) });
        else if (line.startsWith('OUTPUT ')) entries.push({ output: true, path: resolveFsPath(pwd, line.slice(7)) });
    }
    return entries;
}

// The files a pass wrote, with their bytes, other than its log, file list and SyncTeX data.
function passOutputs(FS, base) {
    const entries = readRecorder(FS, base);
    if (entries === null) return null;
    const own = new Set(['.log', '.fls', '.synctex', '.synctex.gz'].map((ext) => base + ext));
    const outputs = new Map();
    for (const entry of entries) {
        if (entry.output && !own.has(entry.path)) outputs.set(entry.path, readFileOrNull(FS, entry.path));
    }
    return outputs;
}

// Everything BibTeX reads: the \citation, \bibdata, \bibstyle and \@input
// lines of every .aux file (labels and page numbers in them change with most
// edits, and BibTeX ignores them), and every .bib and .bst file outside the
// TeX tree. Files inside the tree come with the packages, which are named.
async function bibtexInputsOf(FS, projectFiles, bundleDataMap) {
    try {
        const paths = new Set();
        for (const path of snapshotWorkTree(FS)) if (/\.(aux|bib|bst)$/i.test(path)) paths.add(path);
        for (const path of projectFiles.keys()) if (/\.(bib|bst)$/i.test(path) && !path.startsWith('/texlive/')) paths.add(path);
        const parts = ['bibtex inputs 1', [...bundleDataMap.keys()].sort().join(',')];
        for (const path of [...paths].sort()) {
            let bytes = readFileOrNull(FS, path);
            if (bytes !== null && /\.aux$/i.test(path)) {
                const lines = new TextDecoder().decode(bytes).match(/\\(?:citation|bibdata|bibstyle|@input)\{[^\n]*/g);
                bytes = lines ? lines.join('\n') : '';
            }
            parts.push(path, bytes);
        }
        return await digestOf(parts);
    } catch (error) {
        workerLog('BibTeX inputs not compared: ' + error.message);
        return null;
    }
}

// The source up to the first \begin{document} that is not in a comment, and the rest.
function splitPreamble(source) {
    let start = 0;
    while (start < source.length) {
        let end = source.indexOf('\n', start);
        if (end === -1) end = source.length;
        let code = end;
        for (let i = start; i < end; i++) {
            const c = source.charCodeAt(i);
            if (c === 92) i++; // a backslash escapes the next character, \% among them
            else if (c === 37) { code = i; break; } // % starts a comment
        }
        const at = source.slice(start, code).indexOf('\\begin{document}');
        if (at !== -1) {
            const preamble = source.slice(0, start + at);
            return /\\documentclass\b/.test(preamble) ? { preamble, body: source.slice(start + at) } : null;
        }
        start = end + 1;
    }
    return null;
}

// What a pass with the format reads: a comment line for each line of the
// preamble, so line numbers stay the same, with the replayed nodes on the last.
function formatBody(split, replay) {
    const lines = split.preamble.split('\n').length - 1;
    return lines === 0 ? replay + split.body : '%\n'.repeat(lines - 1) + replay + '%\n' + split.body;
}

// The nodes LaTeX left on the main vertical list during the preamble, as
// \showlists printed them, as commands that make the same nodes again. null
// when the list holds anything else, or TeX was not back in vertical mode.
function replayOfShowlists(text) {
    const lines = text.split('\n');
    let i = lines.findIndex((line) => line.startsWith('### '));
    if (i === -1 || lines[i] !== '### vertical mode entered at line 0') return null;
    let replay = '';
    for (i++; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('! OK')) return replay;
        if (line === '' || line === '### current page:' || line === '### recent contributions:') continue;
        if (line === '\\write-{}') { replay += '\\write-1{}'; continue; }
        const color = /^\\pdfcolorstack (\d+) (push|set) \{([0-9. a-zA-Z]*)\}$/.exec(line);
        if (color) { replay += '\\pdfcolorstack' + color[1] + ' ' + color[2] + '{' + color[3] + '}'; continue; }
        const pop = /^\\pdfcolorstack (\d+) pop$/.exec(line);
        if (pop) { replay += '\\pdfcolorstack' + pop[1] + ' pop'; continue; }
        const depth = /^prevdepth (-?[0-9.]+|ignored)$/.exec(line);
        if (depth) { if (depth[1] !== 'ignored') replay += '\\prevdepth=' + depth[1] + 'pt'; continue; }
        return null;
    }
    return null;
}

// The log of a pass with the format, with the preamble's part of the log (from
// the run that made the format) put back where a normal pass writes it.
function spliceFormatLog(log, record) {
    if (!record.preambleLog) return log;
    const at = log.indexOf('\nLaTeX2e <');
    if (at === -1) return log;
    const rest = log.slice(at + 1).split('\n');
    const pre = record.preambleLog.split('\n');
    let same = 0; // the lines \everyjob printed, which both logs start with
    while (same < rest.length && same < pre.length && rest[same] === pre[same]) same++;
    return log.slice(0, at + 1) + record.preambleLog + '\n' + rest.slice(same).join('\n');
}

// A log without its first line (which names the format), without the memory
// statistics at the end, and without spaces and line breaks: TeX breaks lines
// by column, and the column differs where the preamble's part is put back.
function logBody(log) {
    const end = log.indexOf("\nHere is how much of TeX's memory you used:");
    return (end === -1 ? log : log.slice(0, end)).replace(/^[^\n]*\n/, '').replace(/\s+/g, '');
}

// SyncTeX data with every file named instead of numbered. A pass with the
// format numbers only the files it opens itself, so the same file has another
// number; the byte counts ("!" lines) and the closing statistics change with
// the numbers. A box the preamble filled keeps the numbers of the run that
// made the format, which then name other files, and the data differs.
function synctexBody(text) {
    if (text === null) return null;
    const names = new Map();
    const lines = [];
    for (const line of text.split('\n')) {
        const input = /^Input:(\d+):(.*)$/.exec(line);
        if (input) { names.set(input[1], input[2]); continue; }
        if (line.startsWith('!')) continue;
        if (line.startsWith('Postamble:')) break;
        lines.push(line.replace(/^([a-zA-Z$[(])(\d+),/, (all, kind, tag) => kind + (names.has(tag) ? names.get(tag) : '?' + tag) + ','));
    }
    return lines.join('\n');
}

// Mounts the packages the last compile with this preamble had to fetch, so
// that the first pass starts with the packages its last retry had. Returns how
// many were added.
function mountFetchedBundles(split, bundleDataMap, bundleMetaMap, deferredBundles) {
    const entry = split ? fetchedBundles.get(docBase) : null;
    if (!entry || entry.preamble !== split.preamble) return 0;
    let added = 0;
    for (const [name, bundle] of entry.bundles) {
        if (bundleDataMap.has(name)) continue;
        bundleDataMap.set(name, bundle.data);
        if (bundle.meta) bundleMetaMap.set(name, bundle.meta);
        deferredBundles.delete(name); // as a retry does when it loads a deferred bundle
        added++;
    }
    return added;
}

// The packages the first pass had that the compiler did not ask for. Packages
// fetched later, for BibTeX, are not among them.
function rememberFetchedBundles(split, requested, firstPass) {
    fetchedBundles.delete(docBase);
    if (!split) return;
    const bundles = new Map();
    for (const [name, data] of firstPass.bundles) {
        if (!requested.has(name)) bundles.set(name, { data, meta: firstPass.bundleMeta.get(name) || null });
    }
    if (bundles.size === 0) return;
    fetchedBundles.set(docBase, { preamble: split.preamble, bundles });
    while (fetchedBundles.size > 4) fetchedBundles.delete(fetchedBundles.keys().next().value);
}

// What the preamble could see besides its own text: the mounted packages and
// fetched package files, the project's file list and which auxiliary files the
// pass starts with. null when an older package version replaces a newer one.
function preambleEnvironment(bundleDataMap, deferredBundles, ctanFiles, auxFiles, tlVersions) {
    if (tlVersions.size > 0) return null;
    const tree = [];
    const project = [];
    for (const path of ctanFiles.keys()) (path.startsWith('/texlive/') ? tree : project).push(path);
    return JSON.stringify([
        [...bundleDataMap.keys()].sort(), [...deferredBundles].sort(),
        tree.sort(), project.sort(), Object.keys(auxFiles || {}).sort(),
    ]);
}

// Whether this pass can load a checked format for its preamble, and whether a format should be made.
async function preambleFormatState(FS, split, environment) {
    if (!split || environment === null) return { record: null, build: false };
    const record = preambleFormats.get(docBase);
    if (!record || record.preamble !== split.preamble || record.environment !== environment) return { record: null, build: true };
    if (record.status === 'queued') return { record: null, build: false };
    for (const [path, digest] of record.inputs) {
        if (await digestOf([readFileOrNull(FS, path)]) !== digest) return { record: null, build: true };
    }
    if (record.status === 'trusted') return { record, build: false };
    return { record: null, build: record.failures < 2 };
}

function rememberPreambleFormat(key, record) {
    preambleFormats.delete(key);
    preambleFormats.set(key, record);
    while (preambleFormats.size > 3) preambleFormats.delete(preambleFormats.keys().next().value);
}

// A fresh module with the files of the pass the job was made from.
async function mountPreambleJob(job, auxFiles) {
    const Module = await getOrCreateModule();
    const FS = Module.FS;
    resetFS(FS);
    const vfs = new VirtualFileSystem(FS, { onLog: workerLog, lazyEnabled: job.lazy, fetchedFilesCache: globalFetchedFilesCache });
    if (job.lazy) vfs.patchForLazyLoading();
    for (const [name, data] of job.bundles) vfs.mountBundle(name, data, fileManifest, job.bundleMeta.get(name) || null);
    for (const name of job.deferred) if (!job.bundles.has(name)) vfs.mountDeferredBundle(name, fileManifest, null);
    if (job.ctanFiles.size > 0) vfs.mountCtanFiles(job.ctanFiles, { forceOverride: false });
    FS.mkdirTree(job.workingDirectory);
    FS.chdir(job.workingDirectory);
    restoreAuxFiles(FS, auxFiles);
    finalizeVfsCached(vfs, job.finalizeSig);
    return { Module, FS };
}

// Queues the making of a format behind any compile that is already waiting.
function schedulePreambleFormat(job) {
    // The first compile of a document starts without auxiliary files, and the
    // second one with them, so a format made now would not fit the next pass.
    if (!job.auxIn || Object.keys(job.auxIn).length === 0) return;
    const previous = preambleFormats.get(job.docBase);
    const sameDocument = previous && previous.preamble === job.split.preamble && previous.environment === job.environment;
    job.failures = sameDocument ? previous.failures || 0 : 0;
    job.record = { status: 'queued', preamble: job.split.preamble, environment: job.environment, inputs: [], failures: job.failures };
    rememberPreambleFormat(job.docBase, job.record);
    operationQueue = operationQueue.then(() => buildPreambleFormat(job)).catch((error) => {
        if (preambleFormats.get(job.docBase) === job.record) preambleFormats.delete(job.docBase);
        workerLog('Preamble format not made: ' + error.message);
    });
}

// A new module with the packages of the last compile already mounted, made
// while the worker waits. The next compile takes it when it needs exactly the
// same packages; otherwise getOrCreateModule() hands it out like any unused one.
let premounted = null;

function takePremountedModule(bundleDataMap, deferredBundles, lazy) {
    const ready = premounted;
    premounted = null;
    if (!ready || ready.Module !== globalModule || globalModuleUsed || ready.lazy !== Boolean(lazy)) return null;
    if (ready.bundles.size !== bundleDataMap.size || ready.deferred.size !== deferredBundles.size) return null;
    for (const [name, data] of bundleDataMap) if (ready.bundles.get(name) !== data) return null;
    for (const name of deferredBundles) if (!ready.deferred.has(name)) return null;
    globalModuleUsed = true;
    return ready;
}

function schedulePremount(spec) {
    operationQueue = operationQueue.then(() => premountModule(spec)).catch((error) => {
        premounted = null;
        workerLog('Module not mounted in advance: ' + error.message);
    });
}

async function premountModule(spec) {
    premounted = null;
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (queuedCompiles > 0) return;
    globalModuleUsed = true; // replace the module of the last pass
    const Module = await getOrCreateModule();
    const FS = Module.FS;
    resetFS(FS);
    const vfs = new VirtualFileSystem(FS, { lazyEnabled: spec.lazy, fetchedFilesCache: globalFetchedFilesCache });
    if (spec.lazy) vfs.patchForLazyLoading();
    for (const [name, data] of spec.bundles) vfs.mountBundle(name, data, fileManifest, spec.bundleMeta.get(name) || null);
    for (const name of spec.deferred) if (!spec.bundles.has(name)) vfs.mountDeferredBundle(name, fileManifest, null);
    vfs.onLog = workerLog;
    globalModuleUsed = false;
    premounted = { Module, vfs, bundles: spec.bundles, deferred: spec.deferred, lazy: spec.lazy };
}

// Makes the format of a preamble and checks it against the normal pass it was made after.
async function buildPreambleFormat(job) {
    const owns = () => preambleFormats.get(job.docBase) === job.record;
    const fail = (reason, inputs) => {
        if (owns()) {
            rememberPreambleFormat(job.docBase, {
                status: 'failed', preamble: job.record.preamble, environment: job.environment,
                inputs: inputs || [], failures: job.failures + 1,
            });
        }
        workerLog('Preamble format not used: ' + reason);
    };
    // A compile that arrives within a moment of the last one goes first; it
    // queues a new format of its own when it is done.
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (queuedCompiles > 0 || !owns()) {
        if (owns()) preambleFormats.delete(job.docBase);
        return;
    }
    const started = performance.now();
    const previousDocBase = docBase;
    docBase = job.docBase;
    try {
        // 1. Run the preamble in -ini mode, show what it left on the main
        //    vertical list, and dump it. The module is a new one, so the pinned
        //    clock applies.
        globalModuleUsed = true;
        extraTexEnvironment = { FORCE_SOURCE_DATE: '1' };
        let pass;
        try { pass = await mountPreambleJob(job, job.auxIn); } finally { extraTexEnvironment = null; }
        if (!pass.Module.ENV || pass.Module.ENV.FORCE_SOURCE_DATE !== '1') return fail('the clock could not be pinned');
        const jobName = job.docBase.slice(job.docBase.lastIndexOf('/') + 1);
        // The group keeps the \showbox... settings out of the format.
        pass.FS.writeFile(job.sourcePath, job.split.preamble + '\n\\immediate\\write-1{' + PREAMBLE_END + '}' +
            '\\begingroup\\showboxdepth=10000 \\showboxbreadth=100000 \\showlists\\endgroup\n\\dump\n');
        pass.Module.callMainWithRedirects([
            'pdflatex', '-ini', '-jobname=' + jobName, '-interaction=nonstopmode', '-no-shell-escape',
            '-synctex=-1', '-recorder', '&/texlive/texmf-dist/texmf-var/web2c/pdftex/pdflatex', job.sourcePath,
        ]);
        const iniLog = readTextOrNull(pass.FS, job.docBase + '.log') || '';
        const fmtData = readFileOrNull(pass.FS, job.docBase + '.fmt');
        // Files outside the TeX tree that the preamble read before writing
        // them: they must be the same whenever the format is used. Files it
        // wrote go with the format, as the compiler's formats already did.
        const inputs = [];
        const written = new Set();
        for (const entry of readRecorder(pass.FS, job.docBase) || []) {
            if (entry.output) { written.add(entry.path); continue; }
            if (entry.path.startsWith('/texlive/') || entry.path === job.sourcePath || written.has(entry.path)) continue;
            if (inputs.some(([path]) => path === entry.path)) continue;
            inputs.push([entry.path, await digestOf([readFileOrNull(pass.FS, entry.path)])]);
        }
        const own = new Set(['.fmt', '.log', '.fls', '.pdf', '.synctex', '.synctex.gz'].map((ext) => job.docBase + ext));
        const sideEffectFiles = {};
        for (const path of written) {
            const data = own.has(path) ? null : readFileOrNull(pass.FS, path);
            if (data !== null) sideEffectFiles[path] = data;
        }
        if (fmtData === null) return fail('the preamble could not be dumped', inputs);
        const error = iniLog.split('\n').find((line) => line.startsWith('! ') && line !== '! OK.');
        if (error) return fail('the preamble stopped with ' + error, inputs);
        const end = iniLog.indexOf('\n' + PREAMBLE_END);
        const replay = end === -1 ? null : replayOfShowlists(iniLog.slice(end + 1));
        if (replay === null) return fail('the preamble left something on the first page that cannot be replayed', inputs);
        const start = iniLog.indexOf('\nLaTeX2e <');
        const preambleLog = start !== -1 && start < end ? iniLog.slice(start + 1, end) : null;

        // 2. One pass with the format, on the files of the normal pass. It must
        //    write the same files with the same bytes.
        pass = await mountPreambleJob(job, job.auxIn);
        restoreSideEffectFiles(pass.FS, sideEffectFiles);
        pass.FS.writeFile('/custom.fmt', fmtData);
        pass.FS.writeFile(job.sourcePath, formatBody(job.split, replay));
        const check = pass.Module.callMainWithRedirects([
            'pdflatex', '--no-shell-escape', '--interaction=nonstopmode', '--file-line-error', '--halt-on-error',
            '--synctex=-1', '--recorder', '--fmt=/custom.fmt', job.sourcePath,
        ]);
        if (check.exit_code !== 0) return fail('a pass with it failed', inputs);
        const outputs = passOutputs(pass.FS, job.docBase);
        if (outputs === null) return fail('a pass with it wrote no file list', inputs);
        for (const path of new Set([...job.outputs.keys(), ...outputs.keys()])) {
            if (!job.outputs.has(path)) return fail('a pass with it also wrote ' + path, inputs);
            if (!sameBytes(job.outputs.get(path), readFileOrNull(pass.FS, path))) return fail('a pass with it wrote a different ' + path, inputs);
        }
        if (job.synctex !== null && synctexBody(readTextOrNull(pass.FS, job.docBase + '.synctex')) !== job.synctex) {
            return fail('a pass with it wrote different SyncTeX data', inputs);
        }
        const checkLog = spliceFormatLog(readTextOrNull(pass.FS, job.docBase + '.log') || '', { preambleLog });
        if (logBody(checkLog) !== logBody(job.log)) return fail('a pass with it wrote a different log', inputs);
        if (!owns()) return;
        rememberPreambleFormat(job.docBase, {
            status: 'trusted', preamble: job.record.preamble, environment: job.environment, inputs,
            fmtData, sideEffectFiles, replay, preambleLog, failures: 0,
        });
        workerLog('Preamble format ready: ' + (fmtData.byteLength / 1048576).toFixed(1) + ' MB, made and checked in ' +
            (performance.now() - started).toFixed(0) + ' ms');
    } finally {
        docBase = previousDocBase;
    }
}
// --- end of addition ---

`;

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

  // Each TeX pass starts a fresh WebAssembly module and sets up the font map
  // and file list again (about 350 ms). The worker can replay that work from a
  // cache, but only when no fetched or project files are mounted, so in
  // practice never. The set-up only depends on which files sit in the TeX tree,
  // on font map files and on fonts, so the key below names exactly those and
  // leaves out the project's .tex, .bib and image files.
  patch(
    'reuse the font map work when only project files change',
    `    const computeFinalizeSig = () =>
        (accumulatedCtanFiles.size === 0 && packageTLVersions.size === 0)
            ? 'b:' + [...bundleDataMap.keys()].sort().join(',') +
              '|d:' + [...deferredBundles].sort().join(',')
            : null;`,
    `    // --- changed by scripts/engine-prepare.mjs: key on what finalize() reads ---
    const computeFinalizeSig = () => {
        if (packageTLVersions.size !== 0) return null;
        const files = [];
        for (const [path, content] of accumulatedCtanFiles) {
            const lower = path.toLowerCase();
            const fontMap = lower.endsWith('.map');
            if (!fontMap && !path.startsWith('/texlive/') && !/\\.(pfb|enc|otf|ttf|ttc)$/.test(lower)) continue;
            let key = path;
            if (fontMap) {
                const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
                let hash = 5381 >>> 0;
                for (let i = 0; i < bytes.length; i++) hash = ((hash * 33) ^ bytes[i]) >>> 0;
                key += '#' + bytes.length + ':' + hash;
            }
            files.push(key);
        }
        return 'b:' + [...bundleDataMap.keys()].sort().join(',') +
            '|d:' + [...deferredBundles].sort().join(',') +
            '|f:' + files.sort().join(',');
    };
    // --- end of change ---`,
  );

  // The cache above keeps the font map and file list of each set of packages.
  // A long session can try many sets, so only the latest few are kept.
  patch(
    'keep the font map cache small',
    `    vfs.finalize();
    if (signature) {
        globalFinalizeCache.set(signature, vfs.captureFinalizeOutput());
    }`,
    `    vfs.finalize();
    if (signature) {
        globalFinalizeCache.set(signature, vfs.captureFinalizeOutput());
        // --- added by scripts/engine-prepare.mjs ---
        while (globalFinalizeCache.size > 4) globalFinalizeCache.delete(globalFinalizeCache.keys().next().value);
    }`,
  );

  // The merged font map lists most fonts several times (5,654 entries, 4,594
  // of them repeats). pdfTeX uses the first entry and writes a warning for
  // every later one, close to a megabyte of log per pass. Keeping only the
  // first entry per font gives pdfTeX the same fonts without the warnings.
  patch(
    'drop repeated font map entries',
    `    finalize() {
        this.processFontMaps();
        this.rewritePdftexMapPaths();`,
    `    // --- added by scripts/engine-prepare.mjs ---
    dedupePdftexMap() {
        const PDFTEX_MAP_PATH = '/texlive/texmf-dist/texmf-var/fonts/map/pdftex/updmap/pdftex.map';
        let text;
        try { text = new TextDecoder().decode(this.FS.readFile(PDFTEX_MAP_PATH)); } catch { return; }
        const seen = new Set();
        const kept = [];
        let dropped = 0;
        for (const line of text.split('\\n')) {
            const entry = line.replace(/^[ \\t]+/, '');
            // Empty lines and comments, as pdfTeX's map reader sees them.
            if (entry === '' || '%#;*'.includes(entry[0])) { kept.push(line); continue; }
            const font = entry.split(/[ \\t]/, 1)[0];
            if (seen.has(font)) { dropped++; continue; }
            seen.add(font);
            kept.push(line);
        }
        if (dropped > 0) {
            this.FS.writeFile(PDFTEX_MAP_PATH, kept.join('\\n'));
            this.onLog(\`Dropped \${dropped} repeated font map entries\`);
        }
    }
    // --- end of addition ---

    finalize() {
        this.processFontMaps();
        this.rewritePdftexMapPaths();
        this.dedupePdftexMap();`,
  );

  // After BibTeX the worker always ran TeX twice more. When the bibliography
  // BibTeX wrote is the one the first pass already read (restored from the
  // previous compile), those passes change nothing. Only a new bibliography
  // needs a pass to typeset it; whether a further pass is needed for the
  // citation labels is then decided by the log and the aux files, as for any
  // other cross-reference.
  patch(
    'rerun after BibTeX only when the bibliography changed',
    `                        workerLog('BibTeX completed.');
                        bibliographyPasses = 2;
                        maxRerunPasses = Math.max(maxRerunPasses, rerunPass + 2);`,
    `                        workerLog('BibTeX completed.');
                        // --- changed by scripts/engine-prepare.mjs ---
                        const bblAfter = FS.readFile(docBase + '.bbl', { encoding: 'utf8' });
                        if (bibtexInputs !== null) lastBibtexRuns.set(docBase, { inputs: bibtexInputs, bbl: bblAfter });
                        if (bblAfter === firstAux['.bbl']) {
                            workerLog('Bibliography unchanged.');
                        } else {
                            bibliographyPasses = 1;
                            maxRerunPasses = Math.max(maxRerunPasses, rerunPass + 2);
                        }
                        // --- end of change ---`,
  );

  // The worker finds missing fonts in the log with patterns that expect an
  // error to start with "!" and to sit on one line. It compiles with
  // --file-line-error, which starts errors with "file:line:" instead, and TeX
  // breaks log lines after 79 characters, so "Font ... not loadable: Metric
  // (TFM) file not found" was never recognised and no font was ever fetched.
  patch(
    'recognise missing fonts in the log',
    `function extractAllMissingFiles(logContent, alreadyFetched) {`,
    `function extractAllMissingFiles(logContent, alreadyFetched) {
    // --- added by scripts/engine-prepare.mjs ---
    logContent = String(logContent || '')
        .replace(/^(.{79})\\n/gm, '$1')
        .replace(/^[^\\n]*?:\\d+: (?=LaTeX Error:|Font )/gm, '! ');
    // --- end of addition ---`,
  );

  // A font's metrics, outlines and encoding can sit in different packages.
  // The font map sends Palatino small capitals (metrics pplrc8r, from
  // palatino) to the outline file fplrc8a.pfb, which is in fpl, and the newpx
  // fonts to encoding files such as ntx-ec-tlf.enc, which are in newtx. pdfTeX
  // opens these files only when it writes the PDF, and then stops with "cannot
  // open Type 1 font file for reading" or "cannot open encoding file for
  // reading". No pattern knew those messages, so the package was never
  // fetched. An outline is looked up by its name without ".pfb" (the font
  // names in the file index), an encoding file by its full name.
  patch(
    'fetch the package of a missing font outline or encoding file',
    `        /! Font ([a-z0-9-]+) at [0-9]+ not found/g,`,
    `        /! Font ([a-z0-9-]+) at [0-9]+ not found/g,
        // --- added by scripts/engine-prepare.mjs ---
        /!pdfTeX error:.*\\(file ([a-z0-9_-]+)\\.pfb\\): cannot open Type 1 font file/g,
        /!pdfTeX error:.*\\(file ([a-z0-9_.-]+\\.enc)\\): cannot open encoding file/g,
        // --- end of addition ---`,
  );

  // TeX looks up every file through kpathsea. The worker's search paths ended
  // in "//" without the "!!" that TeX Live's own texmf.cnf puts in front of its
  // trees, so every lookup of a file that does not exist walked the whole TeX
  // tree on the WebAssembly file system: each \IfFileExists for an optional
  // .cfg or .ldf file (LaTeX tests with \pdffilesize, which searches with
  // must_exist) opened about 7,000 folders. The Thesis template made over a
  // million such calls per compile, and they were most of its 3.3 seconds.
  // The worker writes an ls-R listing of every file it mounts under
  // /texlive/texmf-dist before each pass, so "!!" (look only in ls-R) finds
  // every file that is there. Project files are still found on disk through
  // ".", the first entry of each path.
  patch(
    'look up TeX files in the file list instead of searching every folder',
    `    ENV['TEXMF'] = '/texlive/texmf-dist';`,
    `    // --- changed by scripts/engine-prepare.mjs: "!!" = search ls-R only ---
    ENV['TEXMF'] = '!!/texlive/texmf-dist';`,
  );
  patch(
    'look up input files, BibTeX databases and styles in the file list only',
    `    ENV['BIBINPUTS'] = '.:/texlive/texmf-dist/bibtex/bib//:';
    ENV['BSTINPUTS'] = '.:/texlive/texmf-dist/bibtex/bst//:';
    ENV['TEXINPUTS'] = '.:/texlive/texmf-dist/tex/latex//:/texlive/texmf-dist/tex/generic//:/texlive/texmf-dist/tex//:';`,
    `    // --- changed by scripts/engine-prepare.mjs: "!!" = search ls-R only ---
    ENV['BIBINPUTS'] = '.:!!/texlive/texmf-dist/bibtex/bib//:';
    ENV['BSTINPUTS'] = '.:!!/texlive/texmf-dist/bibtex/bst//:';
    ENV['TEXINPUTS'] = '.:!!/texlive/texmf-dist/tex/latex//:!!/texlive/texmf-dist/tex/generic//:!!/texlive/texmf-dist/tex//:';`,
  );

  // Every pass mounts about 5,000 files into a new file system, and each file
  // looked up its folder from the root (FS.lookupPath), which was most of the
  // 85 ms a mount took. The folder's node is the same for all its files.
  patch(
    'mount files with one folder lookup per folder',
    `    mountLazy(path, bundleName, start, end, trackFontMaps = true) {
        this._ensureDirectory(path);
        const dirPath = path.substring(0, path.lastIndexOf('/'));
        const fileName = path.substring(path.lastIndexOf('/') + 1);
        try {
            const parentNode = this.FS.lookupPath(dirPath).node;`,
    `    // --- added by scripts/engine-prepare.mjs ---
    _parentNode(dirPath) {
        if (!this._parentNodes) this._parentNodes = new Map();
        let node = this._parentNodes.get(dirPath);
        if (!node) {
            node = this.FS.lookupPath(dirPath).node;
            this._parentNodes.set(dirPath, node);
        }
        return node;
    }
    // --- end of addition ---

    mountLazy(path, bundleName, start, end, trackFontMaps = true) {
        this._ensureDirectory(path);
        const dirPath = path.substring(0, path.lastIndexOf('/'));
        const fileName = path.substring(path.lastIndexOf('/') + 1);
        try {
            const parentNode = this._parentNode(dirPath); // --- changed by scripts/engine-prepare.mjs ---`,
  );
  patch(
    'mount deferred files with one folder lookup per folder',
    `    _mountDeferredFile(path, bundleName, start, end) {
        this._ensureDirectory(path);
        const dirPath = path.substring(0, path.lastIndexOf('/'));
        const fileName = path.substring(path.lastIndexOf('/') + 1);
        try {
            const parentNode = this.FS.lookupPath(dirPath).node;`,
    `    _mountDeferredFile(path, bundleName, start, end) {
        this._ensureDirectory(path);
        const dirPath = path.substring(0, path.lastIndexOf('/'));
        const fileName = path.substring(path.lastIndexOf('/') + 1);
        try {
            const parentNode = this._parentNode(dirPath); // --- changed by scripts/engine-prepare.mjs ---`,
  );

  // Each compile started by making a new WebAssembly module (about 17 ms) and
  // mounting the packages into it (about 85 ms). Both only depend on the set of
  // packages, which rarely changes between compiles, so the worker now does
  // this right after a compile, while it waits, and the next compile takes the
  // ready module when it needs the same packages.
  patch(
    'mount the packages for the next compile while idle',
    `            Module = await getOrCreateModule();
            FS = Module.FS;
            const _pModuleEnd = performance.now();

            // Reset filesystem for clean compilation
            resetFS(FS);
            const _pResetEnd = performance.now();

            // Create VFS with unified mount handling
            let vfs = new VirtualFileSystem(FS, {`,
    `            // --- changed by scripts/engine-prepare.mjs: take the module mounted while idle ---
            const ready = retryCount === 0 ? takePremountedModule(bundleDataMap, deferredBundles, options.enableLazyFS) : null;
            Module = ready ? ready.Module : await getOrCreateModule();
            FS = Module.FS;
            const _pModuleEnd = performance.now();

            // Reset filesystem for clean compilation
            if (!ready) resetFS(FS);
            const _pResetEnd = performance.now();

            // Create VFS with unified mount handling
            let vfs = ready ? ready.vfs : new VirtualFileSystem(FS, {`,
  );
  patch(
    'mount the packages for the next compile while idle: skip the mount',
    `            // Mount all bundles (regular and deferred)
            workerProgress('mount', 'Mounting files...');
            for (const [bundleName, data] of bundleDataMap) {`,
    `            // Mount all bundles (regular and deferred)
            if (ready) workerLog('Using the module mounted in advance'); // --- added by scripts/engine-prepare.mjs ---
            else workerProgress('mount', 'Mounting files...');
            if (!ready) for (const [bundleName, data] of bundleDataMap) {`,
  );
  patch(
    'mount the packages for the next compile while idle: skip the deferred mount',
    `            // Mount deferred bundles (file markers without data - loaded on demand)
            for (const bundleName of deferredBundles) {`,
    `            // Mount deferred bundles (file markers without data - loaded on demand)
            if (!ready) for (const bundleName of deferredBundles) { // --- changed by scripts/engine-prepare.mjs ---`,
  );

  // A pass spends most of its time in the preamble: the Thesis template loads
  // its packages for about 450 ms and typesets its pages in 200 ms. The worker
  // already knew how to load a precompiled preamble (a pdfTeX format), but only
  // the compiler made one, for single-file projects, without checking it. Now
  // the worker makes the format itself while it is idle after a compile, checks
  // it, and later passes load it and start at \begin{document}. See the
  // comment at the top of PREAMBLE_FORMATS for the rules.
  patch(
    'precompile the preamble and skip BibTeX: shared code',
    `async function handleCompile(request) {`,
    PREAMBLE_FORMATS + `async function handleCompile(request) {`,
  );
  patch(
    'precompile the preamble: the worker makes its own formats',
    `    const { id, source, engine, options, bundleData, bundleNames, bundlesUrl, ctanFiles, cachedFormat, cachedAuxFiles, deferredBundleNames, mainFile } = request;`,
    `    // --- changed by scripts/engine-prepare.mjs: formats come from preambleFormats, not the request ---
    queuedCompiles = Math.max(0, queuedCompiles - 1);
    const { id, source, engine, options, bundleData, bundleNames, bundlesUrl, ctanFiles, cachedAuxFiles, deferredBundleNames, mainFile } = request;
    let cachedFormat = null;
    let formatJob = null;
    let firstPass = null; // the packages the first pass that worked had
    // --- end of change ---`,
  );

  // Beamer loads hyperref, amssymb and other packages that the compiler does
  // not know it needs. The worker fetched each one after a pass stopped at the
  // missing file, about 0.8 s per package, and the next compile started without
  // them again: the Slides template stopped four times on every compile.
  patch(
    'mount the packages the last compile of the preamble had to fetch',
    `    const deferredBundles = new Set(effectiveDeferredBundles);
`,
    `    const deferredBundles = new Set(effectiveDeferredBundles);

    // --- added by scripts/engine-prepare.mjs ---
    const requestedBundles = new Set(bundleDataMap.keys());
    const sourceSplit = splitPreamble(source);
    const fetchedBefore = mountFetchedBundles(sourceSplit, bundleDataMap, bundleMetaMap, deferredBundles);
    if (fetchedBefore > 0) workerLog('Mounting ' + fetchedBefore + ' packages the last compile of this preamble had to fetch');
    // --- end of addition ---
`,
  );
  patch(
    'precompile the preamble: count compiles that wait',
    `        case 'compile':
            // Queue compile operations to prevent concurrent execution
`,
    `        case 'compile':
            // Queue compile operations to prevent concurrent execution
            queuedCompiles++; // --- added by scripts/engine-prepare.mjs ---
`,
  );
  patch(
    'precompile the preamble: settings for one module',
    `    ENV['SOURCE_DATE_EPOCH'] = '1577836800'; // 2020-01-01T00:00:00Z — fixed reference
`,
    `    ENV['SOURCE_DATE_EPOCH'] = '1577836800'; // 2020-01-01T00:00:00Z — fixed reference
    if (extraTexEnvironment) Object.assign(ENV, extraTexEnvironment); // --- added by scripts/engine-prepare.mjs ---
`,
  );
  patch(
    'precompile the preamble: look for a checked format',
    `            // Prepare document source
            let docSource = source;
`,
    `            // --- added by scripts/engine-prepare.mjs: load the preamble from a checked format ---
            const texSource = engine === 'pdflatex' ? injectMicrotypeWorkaround(source) : source;
            const texSplit = engine === 'pdflatex' ? splitPreamble(injectKernelCompatShim(texSource)) : null;
            const preambleEnv = preambleEnvironment(bundleDataMap, deferredBundles, accumulatedCtanFiles, cachedAuxFiles, packageTLVersions);
            let formatState = { record: null, build: false };
            try { formatState = await preambleFormatState(FS, texSplit, preambleEnv); }
            catch (error) { workerLog('Preamble format not looked up: ' + error.message); }
            cachedFormat = formatState.record;
            if (cachedFormat) workerLog('Using the checked format of the preamble');
            // --- end of addition ---

            // Prepare document source
            let docSource = source;
`,
  );
  patch(
    'precompile the preamble: replay what the preamble left on the first page',
    String.raw`                    const beginDocIdx = source.indexOf('\\begin{document}');
                    if (beginDocIdx !== -1) {
                        // Pad stripped preamble with comment lines so TeX line numbers
                        // stay aligned with the editor (no offset correction needed)
                        let n = 0;
                        for (let i = 0; i < beginDocIdx; i++) if (source.charCodeAt(i) === 10) n++;
                        docSource = '%\n'.repeat(n) + source.substring(beginDocIdx);
                    }`,
    `                    // --- changed by scripts/engine-prepare.mjs ---
                    docSource = formatBody(texSplit, cachedFormat.replay);
                    // --- end of change ---`,
  );
  patch(
    'precompile the preamble: one microtype workaround per pass',
    `            if (engine === 'pdflatex' && !cachedFormat) {
                docSource = injectMicrotypeWorkaround(docSource);
            }`,
    `            if (engine === 'pdflatex' && !cachedFormat) {
                docSource = texSource; // --- changed by scripts/engine-prepare.mjs: injected above ---
            }`,
  );
  patch(
    'precompile the preamble: list the files each first pass writes',
    `                result = Module.callMainWithRedirects([
                    'pdflatex', '--no-shell-escape', '--interaction=nonstopmode',
                    '--file-line-error', '--halt-on-error', '--synctex=-1', '--fmt=' + fmtPath, sourcePath
                ]);`,
    `                result = Module.callMainWithRedirects([
                    'pdflatex', '--no-shell-escape', '--interaction=nonstopmode',
                    '--file-line-error', '--halt-on-error', '--synctex=-1',
                    '--recorder', // --- added by scripts/engine-prepare.mjs: the check of a new format reads the .fls ---
                    '--fmt=' + fmtPath, sourcePath
                ]);`,
  );
  patch(
    'precompile the preamble: keep what the normal pass wrote',
    `                    pdfData = FS.readFile(docBase + '.pdf');
                    compileSuccess = true;
                    workerLog('Compilation successful!');
`,
    `                    pdfData = FS.readFile(docBase + '.pdf');
                    compileSuccess = true;
                    workerLog('Compilation successful!');
                    // --- added by scripts/engine-prepare.mjs ---
                    firstPass = { bundles: new Map(bundleDataMap), bundleMeta: new Map(bundleMetaMap), deferred: new Set(deferredBundles) };
                    if (formatState.build && !cachedFormat) {
                        const outputs = passOutputs(FS, docBase);
                        if (outputs !== null) formatJob = {
                            docBase, sourcePath, workingDirectory, split: texSplit, environment: preambleEnv,
                            finalizeSig: computeFinalizeSig(), bundles: firstPass.bundles,
                            bundleMeta: firstPass.bundleMeta, deferred: firstPass.deferred,
                            ctanFiles: new Map(accumulatedCtanFiles), auxIn: cachedAuxFiles,
                            lazy: Boolean(options.enableLazyFS), outputs, log: texLog,
                            synctex: synctexBody(readTextOrNull(FS, docBase + '.synctex')),
                        };
                    }
                    // --- end of addition ---
`,
  );
  patch(
    'skip BibTeX when the citations and bibliography files did not change',
    String.raw`                    const firstAux = collectAuxFiles(FS);
                    const bibliographyAux = Object.values(firstAux).join('\n');
                    if (/\\bibdata\{/.test(bibliographyAux) && /\\bibstyle\{/.test(bibliographyAux)) {`,
    String.raw`                    const firstAux = collectAuxFiles(FS);
                    const bibliographyAux = Object.values(firstAux).join('\n');
                    // --- changed by scripts/engine-prepare.mjs ---
                    const needsBibtex = /\\bibdata\{/.test(bibliographyAux) && /\\bibstyle\{/.test(bibliographyAux);
                    const bibtexInputs = needsBibtex ? await bibtexInputsOf(FS, accumulatedCtanFiles, bundleDataMap) : null;
                    const lastBibtexRun = bibtexInputs !== null ? lastBibtexRuns.get(docBase) : undefined;
                    if (lastBibtexRun && lastBibtexRun.inputs === bibtexInputs && lastBibtexRun.bbl === firstAux['.bbl']) {
                        workerLog('BibTeX skipped: the citations and bibliography files did not change.');
                    } else if (needsBibtex) {
                    // --- end of change ---`,
  );
  patch(
    'precompile the preamble: put the preamble back into the log',
    `    const auxFiles = compileSuccess ? collectAuxFiles(FS) : null;
`,
    `    if (cachedFormat) texLog = spliceFormatLog(texLog, cachedFormat); // --- added by scripts/engine-prepare.mjs ---
    const auxFiles = compileSuccess ? collectAuxFiles(FS) : null;
`,
  );
  patch(
    'precompile the preamble: make the format once the PDF is sent',
    `        log: texLog,
    }, pdfData ? [pdfData.buffer] : []);
}
`,
    `        log: texLog,
    }, pdfData ? [pdfData.buffer] : []);

    // --- added by scripts/engine-prepare.mjs ---
    if (firstPass) rememberFetchedBundles(sourceSplit, requestedBundles, firstPass);
    if (formatJob && compileSuccess) schedulePreambleFormat(formatJob);
    if (firstPass) schedulePremount({ ...firstPass, lazy: Boolean(options.enableLazyFS) });
    // --- end of addition ---
}
`,
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
  // The patches add code, so make sure the result still parses.
  execFileSync(process.execPath, ['--check', path.join(OUT, 'siglum-worker.js')], { stdio: 'inherit' });
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

/**
 * TeX names a missing font by its metric file ("ptmr7t" for Times), and the
 * engine looks that name up in file-to-package.json, which only lists macro
 * files such as "helvet.sty". So Times, Helvetica, Courier and other font
 * packages failed to load although they are hosted. The runtime's font index
 * knows which package has which font; its entries for hosted packages are
 * added to the file index.
 */
function addFontNames(runtimeDir) {
  const indexFile = path.join(OUT, 'packages/bundles/file-to-package.json');
  const hosted = new Set(JSON.parse(fs.readFileSync(path.join(OUT, 'packages/index.json'), 'utf8')).map((item) => item.name));
  const files = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  const fonts = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'font-file-to-package.json'), 'utf8'));
  let added = 0;
  for (const [font, name] of Object.entries(fonts)) {
    if (hosted.has(name) && !Object.hasOwn(files, font)) {
      files[font] = name;
      added++;
    }
  }
  if (added > 0) fs.writeFileSync(indexFile, JSON.stringify(files));
  log(`${added} font names added to the package index`);
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
addFontNames(runtimeDir);
writeNotes(patches, packageCount);
log(`done: ${packageCount} packages, output in ${path.relative(ROOT, OUT)}`);
