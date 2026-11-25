/**
 * The contract between the app and whatever compiles LaTeX. Everything outside
 * `core/engine` depends on this file only, so the engine can be replaced.
 */
import type { ReadonlyStore } from '../store';
import type { CompileFile, Path, TexEngine } from '../types';

export interface CompileRequest {
  /** Project path of the root document. TeX runs in this file's folder. */
  mainFile: Path;
  /** Every source file of the project, the main file included. */
  files: CompileFile[];
  engine: TexEngine;
}

export interface CompileOutput {
  ok: boolean;
  /** The PDF, when one was produced. */
  pdf: Uint8Array | null;
  /** The TeX log, possibly empty when the engine failed before TeX ran. */
  log: string;
  /** A one-line reason when `ok` is false. */
  error: string | null;
  /** Uncompressed SyncTeX data for source and PDF navigation, when available. */
  synctex: string | null;
  durationMs: number;
  /** True when the compile was stopped by `cancel()`. */
  cancelled: boolean;
}

export type EnginePhase = 'idle' | 'loading' | 'ready' | 'compiling' | 'failed';

export interface EngineStatus {
  phase: EnginePhase;
  /** Short progress text such as "Loading fonts", for the status bar. */
  detail: string | null;
  /** Bytes downloaded for engine files in this session. */
  downloadedBytes: number;
}

export interface EngineClient {
  readonly status: ReadonlyStore<EngineStatus>;
  /** Engines that this client can run. */
  readonly engines: readonly TexEngine[];
  /** Starts loading the engine so that the first compile is faster. */
  warmUp(): Promise<void>;
  /** Compiles one request. Only one compile runs at a time. */
  compile(request: CompileRequest): Promise<CompileOutput>;
  /** Stops a running compile. The pending `compile` resolves as cancelled. */
  cancel(): void;
  dispose(): void;
}

/** Where the engine files are served from, relative to the page. */
export interface EngineLocation {
  /** Base URL of the engine folder, without a trailing slash. */
  baseUrl: string;
}
