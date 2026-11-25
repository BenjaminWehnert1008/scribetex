import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { decodeText, encodeText } from '../hash';
import { Store } from '../store';
import { Vault } from '../vault/vault';
import { collectCompileRequest, CompileController, NO_MAIN_FILE } from './compile';
import type { CompileOutput, CompileRequest, EngineClient, EngineStatus } from './types';

const DOC = '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n';

class FakeEngine implements EngineClient {
  readonly status = new Store<EngineStatus>({ phase: 'ready', detail: null, downloadedBytes: 0 });
  readonly engines = ['pdflatex'] as const;
  requests: CompileRequest[] = [];
  next: (request: CompileRequest) => Partial<CompileOutput> = () => ({ ok: true, pdf: encodeText('%PDF-1') });
  /** When set, compiles wait until `release()` is called. */
  gate: Promise<void> | null = null;
  release: () => void = () => undefined;
  cancelled = 0;

  hold(): void {
    this.gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  async warmUp(): Promise<void> {}

  async compile(request: CompileRequest): Promise<CompileOutput> {
    this.requests.push(request);
    if (this.gate) await this.gate;
    return { ok: false, pdf: null, log: '', error: null, synctex: null, durationMs: 5, cancelled: false, ...this.next(request) };
  }

  cancel(): void {
    this.cancelled += 1;
  }

  dispose(): void {}
}

let vault: Vault;
let engine: FakeEngine;
let projectId: string;

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  vault = await Vault.open({ name: `compile-${Math.random().toString(36).slice(2)}` });
  engine = new FakeEngine();
  projectId = (await vault.createProject({ name: 'Paper' })).id;
});

describe('collectCompileRequest', () => {
  it('sends every source file, finds the main file, and leaves build leftovers out', async () => {
    await vault.writeText(projectId, 'paper.tex', '\\documentclass{article}\\begin{document}\\input{sections/a}\\end{document}');
    await vault.writeText(projectId, 'sections/a.tex', 'A');
    await vault.writeFile(projectId, 'figures/plot.png', new Uint8Array([137, 80, 78, 71]));
    await vault.writeText(projectId, 'paper.aux', 'old');
    await vault.writeText(projectId, 'paper.log', 'old');

    const input = await collectCompileRequest(vault, projectId);
    if ('error' in input) throw new Error(input.error);
    expect(input.request.mainFile).toBe('paper.tex');
    expect(input.request.files.map((f) => f.path).sort()).toEqual(['figures/plot.png', 'paper.tex', 'sections/a.tex']);
    expect(decodeText(input.request.files.find((f) => f.path === 'sections/a.tex')!.bytes)).toBe('A');
  });

  it('honours the main file chosen in the project settings', async () => {
    await vault.writeText(projectId, 'a.tex', DOC);
    await vault.writeText(projectId, 'b/other.tex', DOC);
    await vault.updateProject(projectId, { mainFile: 'b/other.tex' });
    const input = await collectCompileRequest(vault, projectId);
    expect('request' in input && input.request.mainFile).toBe('b/other.tex');
  });

  it('falls back to detection when the chosen main file was deleted', async () => {
    await vault.writeText(projectId, 'main.tex', DOC);
    await vault.updateProject(projectId, { mainFile: 'gone.tex' });
    const input = await collectCompileRequest(vault, projectId);
    expect('request' in input && input.request.mainFile).toBe('main.tex');
  });

  it('explains when there is nothing to compile', async () => {
    await vault.writeText(projectId, 'notes.tex', 'just notes');
    expect(await collectCompileRequest(vault, projectId)).toEqual({ error: NO_MAIN_FILE });
  });
});

describe('CompileController', () => {
  it('publishes the PDF and the problems from the log', async () => {
    await vault.writeText(projectId, 'main.tex', DOC);
    engine.next = () => ({
      ok: true,
      pdf: encodeText('%PDF-new'),
      log: "(./main.tex\nLaTeX Warning: Reference `x' on page 1 undefined on input line 3.\n\nOutput written on main.pdf (2 pages, 100 bytes).\n",
    });
    const controller = new CompileController(vault, engine, projectId, { now: () => 42 });
    await controller.request();
    const state = controller.state.get();
    expect(state.ok).toBe(true);
    expect(decodeText(state.pdf!)).toBe('%PDF-new');
    expect(state.pdfVersion).toBe(1);
    expect(state.pages).toBe(2);
    expect(state.warningCount).toBe(1);
    expect(state.diagnostics[0]).toMatchObject({ severity: 'warning', file: 'main.tex', line: 3 });
    expect(state.finishedAt).toBe(42);
    expect(state.phase).toBe('idle');
  });

  it('keeps the last good PDF when a later compile fails', async () => {
    await vault.writeText(projectId, 'main.tex', DOC);
    const controller = new CompileController(vault, engine, projectId);
    await controller.request();
    engine.next = () => ({ ok: false, error: 'x', log: '(./main.tex\n! Undefined control sequence.\nl.3 \\oops\n' });
    await controller.request();
    const state = controller.state.get();
    expect(state.ok).toBe(false);
    expect(state.pdf).not.toBeNull();
    expect(state.pdfVersion).toBe(1);
    expect(state.errorCount).toBe(1);
    expect(state.diagnostics[0]).toMatchObject({ severity: 'error', file: 'main.tex', line: 3 });
  });

  it('never reports a failure with an empty problem list', async () => {
    await vault.writeText(projectId, 'main.tex', DOC);
    engine.next = () => ({ ok: false, error: 'Could not load the BibTeX styles bundle.', log: '' });
    const controller = new CompileController(vault, engine, projectId);
    await controller.request();
    expect(controller.state.get().diagnostics).toEqual([
      expect.objectContaining({ severity: 'error', message: 'Could not load the BibTeX styles bundle.' }),
    ]);
    expect(controller.state.get().errorCount).toBe(1);
  });

  it('runs exactly one more compile when asked again while busy, with the newest files', async () => {
    await vault.writeText(projectId, 'main.tex', DOC);
    engine.hold();
    const controller = new CompileController(vault, engine, projectId);
    const first = controller.request();
    await vault.writeText(projectId, 'main.tex', DOC.replace('Hello', 'Second'));
    void controller.request();
    await vault.writeText(projectId, 'main.tex', DOC.replace('Hello', 'Third'));
    void controller.request();
    expect(controller.state.get().phase).toBe('running');
    engine.release();
    await first;
    expect(engine.requests).toHaveLength(2);
    expect(decodeText(engine.requests[1]!.files[0]!.bytes)).toContain('Third');
    expect(controller.state.get().phase).toBe('idle');
  });

  it('reports a project without a main document as a problem, without calling the engine', async () => {
    const controller = new CompileController(vault, engine, projectId);
    await controller.request();
    expect(engine.requests).toHaveLength(0);
    expect(controller.state.get()).toMatchObject({ ok: false, error: NO_MAIN_FILE, errorCount: 1 });
  });

  it('stop cancels the engine and leaves the previous result in place', async () => {
    await vault.writeText(projectId, 'main.tex', DOC);
    const controller = new CompileController(vault, engine, projectId);
    await controller.request();
    engine.hold();
    engine.next = () => ({ cancelled: true, error: 'Compile stopped.' });
    const pending = controller.request();
    controller.stop();
    engine.release();
    await pending;
    expect(engine.cancelled).toBe(1);
    expect(controller.state.get()).toMatchObject({ ok: true, pdfVersion: 1, phase: 'idle' });
  });
});
