import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { FakeGitHub } from '../src/core/github/fake-github';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engineReady = fs.existsSync(path.join(root, 'dist/engine/runtime/runtime.json'));

async function start(page: Page): Promise<void> {
  await page.goto('./');
  const notice = page.getByRole('dialog', { name: 'Where your work is saved' });
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: 'I understand' }).click();
}

async function createProject(page: Page, name: string, template: string): Promise<void> {
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Name').fill(name);
  await page.locator('button.template', { hasText: template }).click();
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.locator('.topbar .title')).toHaveText(name);
}

async function typeInEditor(page: Page, text: string): Promise<void> {
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(text);
}

const tree = (page: Page) => page.getByRole('tree', { name: 'Project files' });
const row = (page: Page, name: string) => tree(page).getByRole('treeitem', { name, exact: true });
const panel = (page: Page, name: string) => page.getByRole('navigation', { name: 'Side panels' }).getByRole('button', { name, exact: true });

test('tells a new visitor where the work is saved', async ({ page }) => {
  await page.goto('./');
  const notice = page.getByRole('dialog', { name: 'Where your work is saved' });
  await expect(notice).toContainText('Your work stays on this computer.');
  await expect(notice).toContainText('nothing is backed up to a cloud unless you connect one yourself');
  await notice.getByRole('button', { name: 'I understand' }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'New project' })).toBeVisible();
  await expect(notice).toBeHidden();
  await page.getByRole('button', { name: 'Where is my work saved?' }).click();
  await expect(notice).toBeVisible();
});

test('keeps nested folders and text across a reload', async ({ page }) => {
  await start(page);
  await createProject(page, 'Nested', 'Report');
  await expect(row(page, 'chapters')).toBeVisible();
  await expect(row(page, 'introduction.tex')).toBeVisible();

  // A folder inside a folder, with a file in it.
  await row(page, 'chapters').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New folder' }).click();
  await page.getByLabel('Name', { exact: true }).fill('drafts');
  await page.keyboard.press('Enter');
  await row(page, 'drafts').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New file' }).click();
  await page.getByLabel('Name', { exact: true }).fill('notes.tex');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: 'notes.tex' })).toBeVisible();

  await typeInEditor(page, 'Remember the folder structure.');
  await expect(page.locator('.save-chip')).toHaveText('Saved in this browser only');

  await page.reload();
  await expect(page.locator('.topbar .title')).toHaveText('Nested');
  await expect(row(page, 'drafts')).toBeVisible();
  await row(page, 'notes.tex').click();
  await expect(page.locator('.cm-content')).toContainText('Remember the folder structure.');
});

test('recovers text that was typed just before the tab closed', async ({ page, context }) => {
  await start(page);
  await createProject(page, 'Crash', 'Blank');
  await expect(page.locator('.cm-content')).toBeVisible();
  await typeInEditor(page, 'typed in the last moment');
  // Close at once, before the autosave delay has passed.
  await page.close({ runBeforeUnload: false });
  const again = await context.newPage();
  await again.goto('./');
  await again.locator('.project-open', { hasText: 'Crash' }).click();
  await expect(again.locator('.cm-content')).toContainText('typed in the last moment');
});

test('renames, deletes and restores from history', async ({ page }) => {
  await start(page);
  await createProject(page, 'Versions', 'Article');
  await row(page, 'references.bib').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await page.getByLabel('Name', { exact: true }).fill('library.bib');
  await page.keyboard.press('Enter');
  await expect(row(page, 'library.bib')).toBeVisible();

  await row(page, 'library.bib').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(row(page, 'library.bib')).toHaveCount(0);

  await panel(page, 'History').click();
  await page.locator('.list-item', { hasText: 'Before something was deleted' }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Restore' }).click();
  await panel(page, 'Files').click();
  await expect(row(page, 'library.bib')).toBeVisible();
});

test('exports a ZIP and imports it as a new project', async ({ page }) => {
  await start(page);
  await createProject(page, 'Roundtrip', 'Report');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Download project as ZIP' }).click();
  const file = await (await download).path();
  expect(fs.statSync(file).size).toBeGreaterThan(500);

  await page.getByRole('button', { name: 'All projects' }).click();
  await page.locator('input[type=file][accept*=zip]').setInputFiles({ name: 'Copy of roundtrip.zip', mimeType: 'application/zip', buffer: fs.readFileSync(file) });
  await expect(page.locator('.topbar .title')).toHaveText('Copy of roundtrip');
  await expect(row(page, 'chapters')).toBeVisible();
  await expect(row(page, 'methods.tex')).toBeVisible();
});

test('opens a project read-only in a second tab until it is taken over', async ({ page, context }) => {
  await start(page);
  await createProject(page, 'Two tabs', 'Blank');
  const second = await context.newPage();
  await second.goto(page.url());
  await expect(second.getByText('open for editing in another tab')).toBeVisible();
  await second.getByRole('button', { name: 'Edit here instead' }).click();
  await expect(second.getByText('open for editing in another tab')).toBeHidden();
  await expect(page.getByText('open for editing in another tab')).toBeVisible();
});

test('links a project to a folder and keeps both in step', async ({ playwright, baseURL }, testInfo) => {
  // A profile on disk, like the one people use. In the private profile that Playwright gives a test
  // by default, Chromium 153 exits as soon as a page reads a stored folder handle back from IndexedDB.
  const context = await playwright.chromium.launchPersistentContext(testInfo.outputPath('profile'), { baseURL });
  const page = context.pages()[0] ?? (await context.newPage());
  try {
    await linkedFolderSteps(page);
  } finally {
    await context.close();
  }
});

async function linkedFolderSteps(page: Page): Promise<void> {
  // The folder dialog cannot be driven from a test, so it hands out a folder of the browser's private file system.
  await page.addInitScript(() => {
    (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () =>
      (await navigator.storage.getDirectory()).getDirectoryHandle('picked-folder', { create: true });
  });
  const onDisk = () =>
    page.evaluate(async () => {
      const out: Record<string, string> = {};
      const walk = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
        for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
          if (handle.kind === 'directory') await walk(handle as FileSystemDirectoryHandle, `${prefix}${name}/`);
          else out[`${prefix}${name}`] = await (await (handle as FileSystemFileHandle).getFile()).text();
        }
      };
      await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle('picked-folder'), '');
      return out;
    });

  await start(page);
  await createProject(page, 'Linked', 'Report');
  await panel(page, 'Saving and backup').click();
  await page.getByRole('button', { name: 'Link a folder…' }).click();
  await expect(page.locator('.save-chip')).toHaveText('Saved to folder picked-folder');
  expect(Object.keys(await onDisk()).sort()).toEqual(['chapters/conclusion.tex', 'chapters/introduction.tex', 'chapters/methods.tex', 'main.tex', 'references.bib']);

  // An edit in the editor reaches the folder.
  await typeInEditor(page, '% written in the editor');
  await expect.poll(async () => (await onDisk())['main.tex']).toContain('% written in the editor');

  // A change made in the folder reaches the project.
  await page.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked-folder');
    const dir = await (await root.getDirectoryHandle('chapters')).getDirectoryHandle('extra', { create: true });
    const writable = await (await dir.getFileHandle('from-disk.tex', { create: true })).createWritable();
    await writable.write('made outside the editor');
    await writable.close();
  });
  await page.getByRole('button', { name: 'Compare now' }).click();
  await panel(page, 'Files').click();
  await row(page, 'extra').click();
  await row(page, 'from-disk.tex').click();
  await expect(page.locator('.cm-content')).toContainText('made outside the editor');

  // After a reload the link is still there.
  await page.reload();
  await expect(page.locator('.save-chip')).toHaveText('Saved to folder picked-folder');

  // Another program edits a file in the folder, as Claude does when it works on it. The editor shows the change
  // well before the next timed check (20 s), because the browser reports changes in the folder.
  await row(page, 'main.tex').click();
  await expect(page.locator('.cm-content')).toContainText('% written in the editor');
  await page.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked-folder');
    const file = await root.getFileHandle('main.tex');
    const text = await (await file.getFile()).text();
    const writable = await file.createWritable();
    await writable.write(text.replace('% written in the editor', '% changed by another program'));
    await writable.close();
  });
  await expect(page.locator('.cm-content')).toContainText('% changed by another program', { timeout: 8_000 });

  // "Ask Claude" opens the Claude app on the folder, once it knows where the folder is.
  await page.getByRole('button', { name: 'Ask Claude', exact: true }).click();
  const ask = page.getByRole('dialog', { name: 'Ask Claude' });
  await ask.getByLabel('Your question').fill('Make the title shorter');
  await ask.getByLabel('Where the folder "picked-folder" is on this computer').fill('"C:\\Users\\Anna\\picked-folder\\"');
  const link = new URL((await ask.getByRole('link', { name: 'Open in the Claude app' }).getAttribute('href')) ?? '');
  expect(`${link.protocol}//${link.host}${link.pathname}`).toBe('claude://cowork/new');
  expect(link.searchParams.get('folder')).toBe('C:\\Users\\Anna\\picked-folder');
  expect(link.searchParams.get('q')).toMatch(/^Make the title shorter\n/);
  expect(link.searchParams.get('q')).toContain('change the files in the folder directly');
  await ask.getByRole('button', { name: 'Cancel' }).click();

  // The path is remembered for the project.
  await page.getByRole('button', { name: 'Ask Claude', exact: true }).click();
  await expect(page.getByLabel('Where the folder "picked-folder" is on this computer')).toHaveValue('C:\\Users\\Anna\\picked-folder');
}

test('backs a project up to GitHub and restores it from there', async ({ page }) => {
  const github = new FakeGitHub();
  github.isPrivate = false;
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
  await page.route('https://api.github.com/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const response = await github.fetch(request.url(), {
      method: request.method(),
      headers: { Authorization: request.headers()['authorization'] ?? '' },
      body: request.postData() ?? undefined,
    });
    return route.fulfill({ status: response.status, headers: cors, json: await response.json() });
  });

  await start(page);
  await createProject(page, 'Backed up', 'Article');
  await panel(page, 'Saving and backup').click();
  await page.getByRole('button', { name: 'Set up…' }).click();
  await page.getByRole('textbox', { name: 'Repository', exact: true }).fill('me/backups');
  await page.getByLabel('Token', { exact: true }).fill('wrong-token');
  await page.getByRole('button', { name: 'Connect and back up' }).click();
  await expect(page.getByRole('alert')).toContainText('did not accept the token');
  await page.getByLabel('Token', { exact: true }).fill('good-token');
  await page.getByRole('button', { name: 'Connect and back up' }).click();
  await expect(page.locator('.save-chip')).toContainText('Backed up to GitHub');
  expect(Object.keys(github.files())).toEqual(['Backed up/main.tex', 'Backed up/references.bib', 'README.md']);

  // Made private on GitHub: the warning goes once the person is back in this tab.
  const publicWarning = page.getByText('This repository is public.');
  await expect(publicWarning).toBeVisible();
  github.isPrivate = true;
  await page.waitForTimeout(5_500);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(publicWarning).toBeHidden();

  await page.getByRole('button', { name: 'All projects' }).click();
  await page.getByRole('button', { name: 'Restore from GitHub' }).click();
  await page.getByRole('textbox', { name: 'Repository', exact: true }).fill('me/backups');
  await page.getByRole('button', { name: 'Show the backups' }).click();
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.locator('.topbar .title')).toHaveText('Backed up');
  await expect(row(page, 'references.bib')).toBeVisible();
  await expect(page.locator('.save-chip')).toContainText('Backed up to GitHub');
});

test.describe('with the LaTeX engine', () => {
  test.skip(!engineReady, 'run "npm run engine:prepare" and build first');
  test.setTimeout(300_000);

  test('compiles a project with chapters in folders and a bibliography', async ({ page }) => {
    await start(page);
    await createProject(page, 'Compile', 'Report');
    await expect(page.locator('.pdf-page canvas').first()).toBeVisible({ timeout: 240_000 });
    await expect(page.locator('.pdf-bar')).toContainText('6 pages');
    await expect(page.locator('.statusbar')).toContainText('Compiled in');
  });

  test('shows an error with its file and line, and keeps the last good PDF', async ({ page }) => {
    await start(page);
    await createProject(page, 'Broken', 'Article');
    await expect(page.locator('.pdf-page canvas').first()).toBeVisible({ timeout: 240_000 });
    await row(page, 'main.tex').click();
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+Home');
    await page.keyboard.type('\\undefinedcommandhere\n');
    // New projects do not compile while typing.
    await page.waitForTimeout(1500);
    await expect(page.locator('.statusbar')).not.toContainText('error');
    await page.keyboard.press('ControlOrMeta+Enter');
    // One mistake is one error: the line that says the run ended is not counted.
    await expect(page.locator('.statusbar')).toContainText('1 error,', { timeout: 120_000 });
    await expect(page.getByText('Showing the last version that compiled')).toBeVisible();
    await page.locator('.statusbar button').first().click();
    await expect(page.locator('.problem').first()).toContainText('main.tex:1');

    // Asking Claude about it: without a linked folder, the question carries the error and the file.
    await page.locator('.problem-row').first().getByRole('button', { name: 'Ask Claude' }).click();
    const ask = page.getByRole('dialog', { name: 'Ask Claude' });
    await expect(ask.getByLabel('Your question')).toHaveValue('Please explain this error and show me how to fix it.');
    const link = new URL((await ask.getByRole('link', { name: 'Open in the Claude app' }).getAttribute('href')) ?? '');
    expect(`${link.protocol}//${link.host}${link.pathname}`).toBe('claude://claude.ai/new');
    const prompt = link.searchParams.get('q') ?? '';
    expect(prompt).toContain('Error (main.tex, line 1): Undefined control sequence.');
    expect(prompt).toContain('   1  \\undefinedcommandhere');

    // claude.ai in the browser gets the same question through the clipboard.
    await page.evaluate(() => {
      const record = window as unknown as { copied: string[]; opened: string[] };
      record.copied = [];
      record.opened = [];
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => void record.copied.push(text) }, configurable: true });
      window.open = (url?: string | URL) => {
        record.opened.push(String(url));
        return null;
      };
    });
    await ask.getByRole('button', { name: 'Use claude.ai in the browser' }).click();
    await expect(ask).toBeHidden();
    const record = await page.evaluate(() => {
      const { copied, opened } = window as unknown as { copied: string[]; opened: string[] };
      return { copied, opened };
    });
    expect(record.opened).toEqual(['https://claude.ai/new']);
    expect(record.copied).toEqual([prompt]);
  });

  test('loads fonts and language files that a document needs without naming them', async ({ page }) => {
    await start(page);
    await createProject(page, 'Fonts', 'Article');
    await expect(page.locator('.pdf-page canvas').first()).toBeVisible({ timeout: 240_000 });
    await row(page, 'main.tex').click();
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+a');
    // T1 encoding without a font package needs the cm-super fonts, and babel
    // needs french.ldf. TeX names neither file when it is missing.
    await page.keyboard.insertText(
      ['\\documentclass{article}', '\\usepackage[T1]{fontenc}', '\\usepackage[french]{babel}', '\\begin{document}', 'Voici un \\textbf{texte} en \\textit{italique}.', '\\end{document}', ''].join('\n'),
    );
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(page.locator('.statusbar')).toContainText(/0 errors, [1-9]\d* warnings?/, { timeout: 240_000 });
    await page.locator('.statusbar button').first().click();
    await expect(page.locator('.problem').first()).toContainText('French');
    await expect(page.locator('.pdf-bar')).toContainText('1 page');
  });

  test('fetches the Times, Helvetica and Courier fonts when a document uses them', async ({ page }) => {
    await start(page);
    await createProject(page, 'Times', 'Blank');
    await row(page, 'main.tex').click();
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+a');
    // TeX only names the missing metric file (ptmr8t), never the package that has it.
    await page.keyboard.insertText(
      [
        '\\documentclass{article}',
        '\\usepackage[T1]{fontenc}',
        '\\usepackage{mathptmx}',
        '\\usepackage[scaled]{helvet}',
        '\\usepackage{courier}',
        '\\begin{document}',
        'Times, \\textsf{Helvetica} and \\texttt{Courier}.',
        '\\end{document}',
        '',
      ].join('\n'),
    );
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(page.locator('.statusbar')).toContainText('No problems', { timeout: 240_000 });
    await expect(page.locator('.pdf-bar')).toContainText('1 page');
  });
});
