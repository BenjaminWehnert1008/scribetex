/**
 * Runs compiles for one open project: gathers the files from the vault, hands
 * them to the engine, and turns the log into problems the UI can show.
 *
 * Requests are "latest wins": asking again while a compile runs does not start
 * a second one, it schedules exactly one more run with the newest files.
 */
import { decodeText } from '../hash';
import { detectMainFile, isBuildArtifact } from '../latex/deps';
import { parseLog } from '../latex/log';
import { parseSyncTex, type SyncTexMap } from '../latex/synctex';
import { dirname, extname } from '../paths';
import { Store } from '../store';
import type { Diagnostic, Millis, Path, ProjectId } from '../types';
import type { Vault } from '../vault/vault';
import type { CompileRequest, EngineClient } from './types';

export interface CompileState {
  phase: 'idle' | 'running';
  /** The newest PDF that compiled without a fatal error. Kept when a later compile fails. */
  pdf: Uint8Array | null;
  /** Changes whenever `pdf` is replaced, so viewers know when to reload. */
  pdfVersion: number;
  /** Outcome of the latest compile; null before the first one. */
  ok: boolean | null;
  /** One-line reason when the latest compile failed. */
  error: string | null;
  diagnostics: Diagnostic[];
  errorCount: number;
  warningCount: number;
  pages: number | null;
  log: string;
  /** SyncTeX data of the PDF in `pdf`, so it always matches the pages shown. */
  synctex: string | null;
  mainFile: Path | null;
  durationMs: number | null;
  finishedAt: Millis | null;
}

const INITIAL: CompileState = {
  phase: 'idle',
  pdf: null,
  pdfVersion: 0,
  ok: null,
  error: null,
  diagnostics: [],
  errorCount: 0,
  warningCount: 0,
  pages: null,
  log: '',
  synctex: null,
  mainFile: null,
  durationMs: null,
  finishedAt: null,
};

export const NO_MAIN_FILE =
  'This project has no main document yet. Add a .tex file that contains \\documentclass and \\begin{document}.';

/** Reads everything the engine needs out of the vault. */
export async function collectCompileRequest(
  vault: Vault,
  projectId: ProjectId,
): Promise<{ request: CompileRequest; knownPaths: Path[] } | { error: string }> {
  const project = await vault.requireProject(projectId);
  const entries = (await vault.list(projectId)).filter((entry) => entry.kind === 'file' && !isBuildArtifact(entry.path));
  const files = await Promise.all(
    entries.map(async (entry) => ({ path: entry.path, bytes: await vault.readBytes(projectId, entry.path) })),
  );
  const knownPaths = files.map((file) => file.path);

  let mainFile = project.mainFile && knownPaths.includes(project.mainFile) ? project.mainFile : null;
  if (!mainFile) {
    const sources = new Map<Path, string>();
    for (const file of files) if (extname(file.path) === '.tex') sources.set(file.path, decodeText(file.bytes));
    mainFile = detectMainFile(sources, { files: knownPaths });
  }
  if (!mainFile) return { error: NO_MAIN_FILE };
  return { request: { mainFile, files, engine: project.engine }, knownPaths };
}

export class CompileController {
  readonly state = new Store<CompileState>(INITIAL);
  readonly #vault: Vault;
  readonly #engine: EngineClient;
  readonly #projectId: ProjectId;
  readonly #now: () => Millis;
  #again = false;
  #running: Promise<void> | null = null;
  #disposed = false;
  /** How to read file names in `state.synctex`: the project as it was when that PDF was made. */
  #syncContext: { knownPaths: Path[]; workDir: Path } | null = null;
  #syncCache: { text: string; map: SyncTexMap } | null = null;

  constructor(vault: Vault, engine: EngineClient, projectId: ProjectId, options: { now?: () => Millis } = {}) {
    this.#vault = vault;
    this.#engine = engine;
    this.#projectId = projectId;
    this.#now = options.now ?? Date.now;
  }

  /** Asks for a compile of the current files. Resolves when no compile is pending any more. */
  request(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    this.#running = this.#loop().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  /** Stops the running compile and drops a queued one. */
  stop(): void {
    this.#again = false;
    this.#engine.cancel();
  }

  dispose(): void {
    this.#disposed = true;
    this.stop();
  }

  /** How the file names in the SyncTeX data of the PDF on screen are to be read. */
  syncContext(): { knownPaths: Path[]; workDir: Path } | null {
    return this.#syncContext ? { knownPaths: [...this.#syncContext.knownPaths], workDir: this.#syncContext.workDir } : null;
  }

  /**
   * Shows a PDF that was made elsewhere, as a review copy brings one, instead
   * of compiling. Nothing is compiled afterwards unless asked.
   */
  showOutput(output: { pdf: Uint8Array | null; synctex: string | null; mainFile: Path | null; knownPaths: Path[]; workDir: Path }): void {
    this.#syncContext = { knownPaths: output.knownPaths, workDir: output.workDir };
    const previous = this.state.get();
    this.state.set({
      ...INITIAL,
      pdf: output.pdf,
      pdfVersion: previous.pdfVersion + 1,
      ok: output.pdf ? true : null,
      synctex: output.synctex,
      mainFile: output.mainFile,
      finishedAt: this.#now(),
    });
  }

  /** The SyncTeX data of the PDF on screen, read on first use. Null when the engine wrote none. */
  syncMap(): SyncTexMap | null {
    const text = this.state.get().synctex;
    if (!text || !this.#syncContext) return null;
    if (this.#syncCache?.text !== text) this.#syncCache = { text, map: parseSyncTex(text, this.#syncContext) };
    return this.#syncCache.map;
  }

  async #loop(): Promise<void> {
    do {
      this.#again = false;
      await this.#runOnce();
    } while (this.#again && !this.#disposed);
  }

  async #runOnce(): Promise<void> {
    this.state.patch({ phase: 'running' });
    let input: Awaited<ReturnType<typeof collectCompileRequest>>;
    try {
      input = await collectCompileRequest(this.#vault, this.#projectId);
    } catch (error) {
      input = { error: error instanceof Error ? error.message : String(error) };
    }
    if (this.#disposed) return;

    if ('error' in input) {
      this.state.patch({
        phase: 'idle',
        ok: false,
        error: input.error,
        diagnostics: [engineProblem(input.error)],
        errorCount: 1,
        warningCount: 0,
        pages: null,
        log: '',
        mainFile: null,
        durationMs: 0,
        finishedAt: this.#now(),
      });
      return;
    }

    const { request, knownPaths } = input;
    const output = await this.#engine.compile(request);
    if (this.#disposed) return;
    if (output.cancelled) {
      this.state.patch({ phase: 'idle' });
      return;
    }

    const summary = parseLog(output.log, { knownPaths, workDir: dirname(request.mainFile) });
    const diagnostics = [...summary.diagnostics];
    // The engine can fail without TeX writing an error line, for example when
    // a package could not be loaded. Never show "failed" with an empty list.
    if (!output.ok && summary.errorCount === 0) diagnostics.unshift(engineProblem(output.error ?? 'The compile failed.'));

    const previous = this.state.get();
    if (output.pdf) this.#syncContext = { knownPaths, workDir: dirname(request.mainFile) };
    this.state.set({
      phase: 'idle',
      pdf: output.pdf ?? previous.pdf,
      pdfVersion: output.pdf ? previous.pdfVersion + 1 : previous.pdfVersion,
      ok: output.ok,
      error: output.ok ? null : (output.error ?? 'The compile failed.'),
      diagnostics,
      errorCount: diagnostics.filter((item) => item.severity === 'error').length,
      warningCount: diagnostics.filter((item) => item.severity === 'warning').length,
      pages: summary.pages,
      log: output.log,
      synctex: output.pdf ? output.synctex : previous.synctex,
      mainFile: request.mainFile,
      durationMs: output.durationMs,
      finishedAt: this.#now(),
    });
  }
}

function engineProblem(message: string): Diagnostic {
  return { severity: 'error', message, file: null, line: null, context: null, raw: message };
}
