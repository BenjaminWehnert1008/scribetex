/**
 * The Siglum engine behind the `EngineClient` contract.
 *
 * Siglum runs TeX Live 2026 as WebAssembly in a worker it manages itself. All
 * of its files are served from our own origin: the runtime, the worker and a
 * static folder of LaTeX packages. Nothing is fetched from another server.
 */
import { decodeText } from '../hash';
import { Store } from '../store';
import type { TexEngine } from '../types';
import { dropFontMapNoise, isMissingBitmapFont, needsCmSuper } from './fonts';
import { indirectFiles } from './indirect';
import type { CompileOutput, CompileRequest, EngineClient, EngineLocation, EngineStatus } from './types';

/** The part of the Siglum compiler this adapter uses. */
interface SiglumLike {
  init(): Promise<void>;
  compile(
    source: string,
    options: { engine?: string; useCache?: boolean; mainFile?: string; additionalFiles?: Record<string, string | Uint8Array> },
  ): Promise<{ success: boolean; pdf?: Uint8Array; error?: string; log?: string; syncTexData?: string | null }>;
  preloadBundles(names: string[]): Promise<{ loaded: string[]; failed: string[] }>;
  /** Bundles the engine mounts for every compile, on top of the ones it picks from the source. */
  eagerBundles?: string[] | Record<string, string[]>;
  ctanFetcher?: {
    lookupPackageForFile(name: string): Promise<string | null>;
    batchFetchPackages(names: string[]): Promise<unknown>;
  };
  terminate(): void;
  unload(): void;
  bundleManager?: { bytesDownloaded?: number };
}

type SiglumResult = Awaited<ReturnType<SiglumLike['compile']>>;

const CANCELLED = Symbol('cancelled');

export interface SiglumEngineOptions extends EngineLocation {
  /** Replaces the dynamic import of the engine library. Used by tests. */
  createCompiler?: (options: Record<string, unknown>) => Promise<SiglumLike>;
  now?: () => number;
}

export class SiglumEngine implements EngineClient {
  readonly engines: readonly TexEngine[] = ['pdflatex'];
  readonly #status = new Store<EngineStatus>({ phase: 'idle', detail: null, downloadedBytes: 0 });
  readonly #options: SiglumEngineOptions;
  readonly #now: () => number;
  #compiler: SiglumLike | null = null;
  #loading: Promise<SiglumLike> | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #cancelCurrent: (() => void) | null = null;
  #cmSuperLoaded = false;
  readonly #lookedUp = new Set<string>();
  #disposed = false;

  constructor(options: SiglumEngineOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => performance.now());
  }

  get status(): Store<EngineStatus> {
    return this.#status;
  }

  async warmUp(): Promise<void> {
    await this.#load();
  }

  compile(request: CompileRequest): Promise<CompileOutput> {
    const run = this.#queue.then(() => this.#compileNow(request));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  cancel(): void {
    if (!this.#cancelCurrent) return;
    this.#cancelCurrent();
    // Terminating the worker is the only way to stop TeX. The compiler object
    // starts a fresh worker on its next init().
    this.#compiler?.terminate();
  }

  dispose(): void {
    this.#disposed = true;
    this.cancel();
    this.#compiler?.unload();
    this.#compiler = null;
    this.#loading = null;
  }

  #load(): Promise<SiglumLike> {
    if (this.#disposed) return Promise.reject(new Error('The engine was shut down.'));
    if (this.#compiler) return Promise.resolve(this.#compiler);
    this.#loading ??= this.#create().catch((error: unknown) => {
      this.#loading = null;
      this.#status.patch({ phase: 'failed', detail: messageOf(error) });
      throw error;
    });
    return this.#loading;
  }

  async #create(): Promise<SiglumLike> {
    this.#status.patch({ phase: 'loading', detail: 'Loading the LaTeX engine' });
    const base = this.#options.baseUrl.replace(/\/+$/, '');
    const runtime = `${base}/runtime`;
    const options = {
      workerUrl: `${base}/siglum-worker.js`,
      wasmUrl: `${runtime}/wasm/busytex.wasm`,
      jsUrl: `${runtime}/wasm/busytex.js`,
      bundlesUrl: runtime,
      xzwasmUrl: `${runtime}/xzwasm.js`,
      ctanProxyUrl: `${base}/packages`,
      enableDocCache: false,
      onProgress: (stage: string, detail: string) => {
        if (this.#status.get().phase !== 'ready') this.#status.patch({ detail: detail || stage });
      },
    };
    const compiler = this.#options.createCompiler
      ? await this.#options.createCompiler(options)
      : await importSiglum(options);
    await compiler.init();
    this.#compiler = compiler;
    this.#status.patch({ phase: 'ready', detail: null });
    return compiler;
  }

  async #compileNow(request: CompileRequest): Promise<CompileOutput> {
    const started = this.#now();
    const finish = (partial: Partial<CompileOutput>): CompileOutput => ({
      ok: false,
      pdf: null,
      log: '',
      error: null,
      synctex: null,
      cancelled: false,
      ...partial,
      durationMs: Math.round(this.#now() - started),
    });

    const main = request.files.find((file) => file.path === request.mainFile);
    if (!main) return finish({ error: `The main file ${request.mainFile} is not part of the project.` });
    if (!this.engines.includes(request.engine)) {
      return finish({ error: `${request.engine} is not available in this build. Switch the project to pdfLaTeX.` });
    }

    const cancelled = new Promise<typeof CANCELLED>((resolve) => {
      this.#cancelCurrent = () => resolve(CANCELLED);
    });

    try {
      const loaded = await Promise.race([this.#load(), cancelled]);
      if (loaded === CANCELLED) return finish({ cancelled: true, error: 'Compile stopped.' });
      const compiler = loaded;

      const source = decodeText(main.bytes);
      const additionalFiles: Record<string, Uint8Array> = {};
      for (const file of request.files) if (file.path !== request.mainFile) additionalFiles[file.path] = file.bytes;
      const compileOnce = (): Promise<SiglumResult> =>
        compiler.compile(source, { engine: request.engine, useCache: false, mainFile: request.mainFile, additionalFiles });

      if (!this.#cmSuperLoaded && needsCmSuper(source)) await this.#loadCmSuper(compiler);
      const sources = [source];
      for (const file of request.files) if (file.path !== request.mainFile && /\.(tex|ltx|sty|cls)$/i.test(file.path)) sources.push(decodeText(file.bytes));
      await this.#fetchIndirect(compiler, sources);

      this.#status.patch({ phase: 'compiling', detail: 'Compiling' });
      let result = await Promise.race([compileOnce(), cancelled]);
      if (result !== CANCELLED && !result.success && !this.#cmSuperLoaded && isMissingBitmapFont(`${result.error ?? ''}\n${result.log ?? ''}`)) {
        // The fonts were asked for in a file other than the main one. Load them and try once more.
        await this.#loadCmSuper(compiler);
        this.#status.patch({ phase: 'compiling', detail: 'Compiling' });
        result = await Promise.race([compileOnce(), cancelled]);
      }
      if (result === CANCELLED) {
        this.#status.patch({ phase: 'ready', detail: null });
        return finish({ cancelled: true, error: 'Compile stopped.' });
      }

      this.#status.patch({
        phase: 'ready',
        detail: null,
        downloadedBytes: compiler.bundleManager?.bytesDownloaded ?? this.#status.get().downloadedBytes,
      });
      return finish({
        ok: result.success,
        pdf: result.success && result.pdf ? result.pdf : null,
        log: dropFontMapNoise(result.log ?? ''),
        error: result.success ? null : (result.error ?? 'The compile failed.'),
        synctex: result.syncTexData ?? null,
      });
    } catch (error) {
      if (this.#status.get().phase !== 'failed') this.#status.patch({ phase: 'ready', detail: null });
      return finish({ error: messageOf(error) });
    } finally {
      this.#cancelCurrent = null;
    }
  }

  /** Fetches the packages of files the document needs without naming them, see `indirectFiles`. */
  async #fetchIndirect(compiler: SiglumLike, sources: string[]): Promise<void> {
    const fetcher = compiler.ctanFetcher;
    if (!fetcher) return;
    const packages = new Set<string>();
    for (const text of sources) {
      for (const file of indirectFiles(text)) {
        // Asked once per session: a name that leads nowhere stays that way.
        if (this.#lookedUp.has(file)) continue;
        this.#lookedUp.add(file);
        const name = await fetcher.lookupPackageForFile(file).catch(() => null);
        if (name) packages.add(name);
      }
    }
    if (packages.size === 0) return;
    this.#status.patch({ phase: 'loading', detail: `Loading ${[...packages].sort().join(', ')}` });
    // A package that this site does not have is not an error here: TeX reports what is missing.
    await fetcher.batchFetchPackages([...packages]).catch(() => undefined);
  }

  async #loadCmSuper(compiler: SiglumLike): Promise<void> {
    this.#status.patch({ phase: 'loading', detail: 'Loading T1 fonts (about 60 MB, once)' });
    const outcome = await compiler.preloadBundles(['cm-super']);
    this.#cmSuperLoaded = outcome.loaded.includes('cm-super');
    // Downloading is not enough: the engine only mounts the bundle, and adds
    // its fonts to the font map, when it is told to use it for the compile.
    if (this.#cmSuperLoaded) compiler.eagerBundles = ['cm-super'];
  }
}

async function importSiglum(options: Record<string, unknown>): Promise<SiglumLike> {
  const { SiglumCompiler } = await import('@siglum/engine');
  return new SiglumCompiler(options) as unknown as SiglumLike;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
