import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { FakeGitHub } from '../src/core/github/fake-github';
import { sampleThesis } from '../src/core/docx/test-docx';

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

async function createFromCommunity(page: Page, name: string, template: string): Promise<void> {
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'From the community' }).click();
  await page.locator('button.template', { hasText: template }).click();
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.locator('.topbar .title')).toHaveText(name);
}

async function typeInEditor(page: Page, text: string): Promise<void> {
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(text);
}

/** Selects `words` with the mouse, in the text under `root` (the source editor or the PDF's text). */
async function selectWords(page: Page, root: string, words: string): Promise<void> {
  const find = ({ root, words, scroll }: { root: string; words: string; scroll: boolean }) => {
    const nodes: Text[] = [];
    for (const element of document.querySelectorAll(root)) {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
    }
    const places: [Text, number][] = [];
    let joined = '';
    for (const node of nodes) {
      for (let index = 0; index < node.data.length; index++) places.push([node, index]);
      joined += node.data;
    }
    const at = joined.indexOf(words);
    if (at < 0) return null;
    // Words below the fold are scrolled into view first; a drag only selects what can be seen.
    if (scroll) places[at]![0].parentElement?.scrollIntoView({ block: 'center' });
    const rectOf = ([node, index]: [Text, number]): DOMRect => {
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      return range.getBoundingClientRect();
    };
    const first = rectOf(places[at]!);
    const last = rectOf(places[at + words.length - 1]!);
    return { x1: first.left + 0.5, y1: first.top + first.height / 2, x2: last.right - 0.5, y2: last.top + last.height / 2 };
  };
  await page.evaluate(find, { root, words, scroll: true });
  await page.waitForTimeout(150);
  const box = await page.evaluate(find, { root, words, scroll: false });
  if (!box) throw new Error(`"${words}" was not found in ${root}`);
  await page.mouse.move(box.x1, box.y1);
  await page.mouse.down();
  await page.mouse.move(box.x2, box.y2, { steps: 6 });
  await page.mouse.up();
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

test('suggests Chrome or Edge and guides through the GitHub setup where folders cannot be used', async ({ page }) => {
  // Safari and Firefox have no folder picker; removing it here shows what they show.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true });
  });
  await page.goto('./');
  const notice = page.getByRole('dialog', { name: 'Where your work is saved' });
  await expect(notice).toContainText('Tip: for saving to a folder, open scribeTeX in Chrome or Edge.');
  await expect(notice).toContainText('equally safe');
  await expect(notice.getByRole('link', { name: 'Get Chrome' })).toHaveAttribute('href', 'https://www.google.com/chrome/');
  await notice.getByRole('button', { name: 'Show me how, step by step' }).click();

  const guide = page.getByRole('dialog', { name: 'Set up a GitHub backup, step by step' });
  await expect(guide.getByRole('link', { name: 'Sign up on GitHub' })).toHaveAttribute('href', 'https://github.com/signup');
  const forms = guide.getByRole('link', { name: 'Open the form, already filled in' });
  await expect(forms.first()).toHaveAttribute('href', /^https:\/\/github\.com\/new\?.*visibility=private/);
  await expect(forms.nth(1)).toHaveAttribute('href', /^https:\/\/github\.com\/settings\/personal-access-tokens\/new\?.*contents=write/);
  await guide.getByRole('button', { name: 'Got it' }).click();
  await expect(guide).toBeHidden();

  // The first-visit notice counts as seen; the home screen keeps the tip and the guide.
  await page.reload();
  await expect(notice).toBeHidden();
  await page.getByRole('note').getByRole('button', { name: 'Show me how, step by step' }).click();
  await expect(guide).toBeVisible();
});

test('shows a picture of every built-in template when a project is started', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: 'New project' }).click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  const cards = dialog.locator('button.template');
  await expect(cards.first()).toBeVisible();
  const count = await cards.count();
  expect(count).toBeGreaterThan(4);
  // Blank shows an empty page; every other template a picture of its first page.
  await expect(cards.filter({ hasText: 'Blank' }).locator('.empty-page')).toBeVisible();
  const pictures = dialog.locator('button.template .template-preview > img');
  await expect(pictures).toHaveCount(count - 1);
  await expect.poll(() => pictures.evaluateAll((images) => images.filter((image) => (image as HTMLImageElement).naturalWidth > 0).length)).toBe(count - 1);
  await expect(dialog.locator('.template-detail')).toHaveText('An empty document and an images folder.');
  await cards.filter({ hasText: 'Thesis' }).click();
  await expect(dialog.locator('.template-detail')).toHaveText('Chapters, front matter, appendix, images and a bibliography.');
});

test('remembers the colour scheme and recolours the logo', async ({ page }) => {
  await start(page);
  const accent = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
  const green = await accent();
  await createProject(page, 'Colours', 'Blank');
  await page.getByRole('button', { name: 'Colour scheme: Green' }).click();
  await page.getByRole('menuitemradio', { name: 'Rose' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'rose');
  expect(await accent()).not.toBe(green);
  // The typewriter's body takes the scheme's colour; its outline stays as it is.
  const body = page.locator('.topbar-mark path[style*="--logo-G"]');
  await expect(body).toHaveCSS('fill', 'rgb(168, 50, 79)');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'rose');
  await page.getByRole('button', { name: 'Colour scheme: Rose' }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Rose' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('menuitemradio', { name: 'Green' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-accent', /.*/);
  expect(await accent()).toBe(green);
  await expect(body).toHaveCSS('fill', 'rgb(23, 113, 91)');
});

test('opens the colour scheme menu above its button at the end of the home page', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 700 });
  await start(page);
  await page.locator('.home').evaluate((home) => home.scrollTo(0, home.scrollHeight));
  const button = page.getByRole('button', { name: 'Colour scheme: Green' });
  await button.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  // There is no room below, so the menu opens above instead of over the button ...
  const [buttonBox, menuBox] = [(await button.boundingBox())!, (await menu.boundingBox())!];
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(buttonBox.y);
  await expect(menu.getByRole('menuitemradio', { name: 'Blue' })).toHaveCSS('font-size', '14px');
  // ... and a second click on the button does not choose a scheme.
  await button.click();
  await expect(page.locator('html')).not.toHaveAttribute('data-accent', /.*/);
});

test('types on a typewriter while the first PDF is being prepared', async ({ page }) => {
  // The engine's files never arrive, so the first compile stays at loading the engine.
  await page.route((url) => url.pathname.startsWith('/engine/'), () => undefined);
  await start(page);
  await createProject(page, 'Waiting', 'Blank');
  await expect(page.getByText('Preparing the first PDF')).toBeVisible();
  await expect(page.getByText(/The first compile loads the LaTeX engine/)).toBeVisible();
  const typewriter = page.locator('.paper-pile');
  await expect(typewriter).toBeVisible();
  const before = await typewriter.innerHTML();
  await expect.poll(() => typewriter.innerHTML()).not.toBe(before);
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

async function importWord(page: Page): Promise<void> {
  await page.getByLabel('Word file to import').setInputFiles({
    name: 'My thesis.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: Buffer.from(sampleThesis()),
  });
  const dialog = page.getByRole('dialog', { name: 'Word file imported' });
  await expect(dialog).toContainText('Moving from Word to LaTeX is now a LaTeX project.');
  await expect(dialog).toContainText('3 section files · 1 picture · 1 table · 1 equation · 2 lists · 1 footnote · 1 reference');
  await dialog.getByRole('button', { name: 'Open the project' }).click();
  await expect(page.locator('.topbar .title')).toHaveText('Moving from Word to LaTeX');
}

test('turns a Word file into a project with sections, pictures and references', async ({ page }) => {
  await start(page);
  await importWord(page);
  await expect(row(page, 'sections')).toBeVisible();
  await expect(row(page, 'images')).toBeVisible();
  await expect(row(page, 'references.bib')).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('\\input{sections/01-introduction}');
});

test('explains why an old .doc file cannot be imported', async ({ page }) => {
  await start(page);
  await page.getByLabel('Word file to import').setInputFiles({
    name: 'old.doc',
    mimeType: 'application/msword',
    buffer: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]),
  });
  const dialog = page.getByRole('dialog', { name: 'The Word file could not be imported' });
  await expect(dialog).toContainText('save it as .docx');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByText('No projects yet.')).toBeVisible();
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

test('keeps a comment on its words while the text around them changes', async ({ page }) => {
  await start(page);
  await createProject(page, 'Commented', 'Blank');
  await row(page, 'main.tex').click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('The results were clearly better than expected.');
  await panel(page, 'Review').click();

  await selectWords(page, '.cm-content', 'clearly better');
  await page.getByRole('toolbar', { name: 'Comment on the selection' }).getByRole('button', { name: 'Comment' }).click();
  const name = page.getByRole('dialog', { name: 'Your name' });
  await name.getByLabel('Name').fill('Anna Schmidt');
  await name.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('dialog', { name: 'New comment' }).getByLabel('Comment').fill('By how much?');
  await page.keyboard.press('Enter');
  const card = page.locator('.rv-card', { hasText: 'By how much?' });
  await expect(card).toContainText('Anna Schmidt');
  await expect(page.locator('.cm-rv-comment')).toHaveText('clearly better');

  // Text typed before the comment does not move it off its words, also after a reload.
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.type('In short: ');
  await expect(page.locator('.cm-rv-comment')).toHaveText('clearly better');
  await expect(page.locator('.save-chip')).toHaveText('Saved in this browser only');
  await page.reload();
  await panel(page, 'Review').click();
  await expect(page.locator('.cm-content')).toContainText('In short: The results');
  await expect(page.locator('.cm-rv-comment')).toHaveText('clearly better');
  await card.getByRole('button', { name: 'Resolve' }).click();
  await expect(page.locator('.cm-rv-comment')).toHaveCount(0);
  await page.getByRole('tab', { name: /Done/ }).click();
  await expect(card).toContainText('Resolved');
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

  test('compiles a project imported from a Word file', async ({ page }) => {
    await start(page);
    await importWord(page);
    await expect(page.locator('.pdf-page canvas').first()).toBeVisible({ timeout: 240_000 });
    await expect(page.locator('.statusbar')).toContainText('Compiled in');
    await expect(page.locator('.statusbar')).toContainText('No problems');
    await expect(page.locator('.pdf-bar')).toContainText('2 pages');
  });

  test('jumps between a line in a subfolder file and its place in the PDF', async ({ page }) => {
    await start(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await createProject(page, 'Sync', 'Report');
    await expect(page.locator('.pdf-page canvas').first()).toBeVisible({ timeout: 240_000 });
    await expect(page.locator('.statusbar')).toContainText('Compiled in');

    // From the source to the PDF: line 4 of chapters/methods.tex is marked.
    await row(page, 'methods.tex').click();
    await page.locator('.cm-line').nth(3).click();
    await page.getByRole('button', { name: 'Show the cursor position in the PDF' }).click();
    const mark = page.locator('.pdf-mark').first();
    await expect(mark).toBeVisible();
    // Without animations the preview jumps there at once, so the mark is where it stays.
    const box = (await mark.boundingBox())!;

    // From the PDF back to the source, from another file: a double-click on
    // the first word of the marked line opens that file there, word selected.
    await row(page, 'main.tex').click();
    await expect(page.locator('.tab[aria-selected=true]')).toContainText('main.tex');
    await page.mouse.dblclick(box.x + 12, box.y + box.height / 2);
    await expect(page.locator('.statusbar')).toContainText('Line 4, column 4');
    await expect(page.locator('.cm-content')).toContainText('How the work was done.');
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('How');
  });

  test('compiles again from the precompiled preamble with the same pages and jumps', async ({ page }) => {
    await start(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await createProject(page, 'Again', 'Report');
    await expect(page.locator('.pdf-page canvas').first()).toBeVisible({ timeout: 240_000 });
    await expect(page.locator('.statusbar')).toContainText('Compiled in');
    await page.locator('.statusbar button').first().click();
    await page.getByRole('tab', { name: 'Full log' }).click();
    const log = page.locator('pre.log');
    await expect(log).toContainText('preloaded format=pdflatex');

    // While it waits after the second compile, the engine makes a format of
    // the preamble and checks it. The compile after that loads it, and its
    // log names that format (main, after main.tex) in the first line.
    await row(page, 'main.tex').click();
    await expect(async () => {
      await page.locator('.cm-content').click();
      await page.keyboard.press('ControlOrMeta+Enter');
      await expect(log).toContainText('preloaded format=main', { timeout: 15_000 });
    }).toPass({ timeout: 180_000 });
    await expect(page.locator('.statusbar')).toContainText('Compiled in');
    await expect(page.locator('.statusbar')).toContainText('No problems');
    await expect(page.locator('.pdf-bar')).toContainText('6 pages');

    // The SyncTeX data of that compile still leads from the source to the PDF and back.
    await row(page, 'methods.tex').click();
    await page.locator('.cm-line').nth(3).click();
    await page.getByRole('button', { name: 'Show the cursor position in the PDF' }).click();
    const mark = page.locator('.pdf-mark').first();
    await expect(mark).toBeVisible();
    const box = (await mark.boundingBox())!;
    await row(page, 'main.tex').click();
    await expect(page.locator('.tab[aria-selected=true]')).toContainText('main.tex');
    await page.mouse.dblclick(box.x + 12, box.y + box.height / 2);
    await expect(page.locator('.statusbar')).toContainText('Line 4, column 4');
    await expect(page.locator('.cm-content')).toContainText('How the work was done.');
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

  for (const [template, pages] of [
    ['Thesis', 16],
    ['Project Proposal', 3],
    ['CV', 1],
    ['Article', 1],
    ['Report', 6],
    ['Slides', 2],
  ] as const) {
    test(`compiles the ${template} template without errors`, async ({ page }) => {
      await start(page);
      await createProject(page, template, template);
      await expect(page.locator('.pdf-page canvas').first()).toBeVisible({ timeout: 240_000 });
      await expect(page.locator('.statusbar')).toContainText('Compiled in');
      await expect(page.locator('.statusbar')).toContainText('No problems');
      await expect(page.locator('.pdf-bar')).toContainText(`${pages} page`);
    });
  }

  test('sends a review copy, takes the comments back and accepts a suggestion', async ({ page, browser, baseURL }, testInfo) => {
    await start(page);
    await createProject(page, 'For review', 'Article');
    await expect(page.locator('.pdf-page canvas').first()).toBeVisible({ timeout: 240_000 });
    await expect(page.locator('.statusbar')).toContainText('Compiled in');
    await panel(page, 'Review').click();
    await page.getByRole('button', { name: 'Send for review' }).click();
    const name = page.getByRole('dialog', { name: 'Your name' });
    await name.getByLabel('Name').fill('Benni');
    await name.getByRole('button', { name: 'Continue' }).click();
    const send = page.getByRole('dialog', { name: 'Send for review' });
    const sent = page.waitForEvent('download');
    await send.getByRole('button', { name: 'Download review copy' }).click();
    const copy = testInfo.outputPath('copy.scribetex');
    await (await sent).saveAs(copy);
    await send.getByRole('button', { name: 'Close' }).click();

    // The supervisor, in a browser of their own, comments on the PDF without any LaTeX.
    const other = await browser.newContext({ baseURL });
    const reviewer = await other.newPage();
    await start(reviewer);
    await reviewer.locator('input[type=file][accept=".scribetex"]').setInputFiles(copy);
    await expect(reviewer.locator('.topbar .title')).toHaveText('For review (review)');
    await expect(reviewer.getByText('Review copy of')).toBeVisible();
    await expect(reviewer.locator('.pdf-page .textLayer span').first()).toBeAttached();
    const bar = reviewer.getByRole('toolbar', { name: 'Comment on the selection' });
    await selectWords(reviewer, '.pdf-page .textLayer', 'Start writing here');
    await bar.getByRole('button', { name: 'Comment' }).click();
    const reviewerName = reviewer.getByRole('dialog', { name: 'Your name' });
    await reviewerName.getByLabel('Name').fill('Prof. Weber');
    await reviewerName.getByRole('button', { name: 'Continue' }).click();
    await reviewer.getByRole('dialog', { name: 'New comment' }).getByLabel('Comment').fill('Please add a motivation first.');
    await reviewer.keyboard.press('Enter');
    await expect(reviewer.locator('.cm-rv-comment')).toHaveText('Start writing here');

    // In Suggesting mode, typing over words of the source starts a suggestion; the copy itself does not change.
    await reviewer.getByRole('radio', { name: 'Suggesting' }).first().click();
    await selectWords(reviewer, '.cm-content', 'referenced by its label');
    await reviewer.keyboard.type('n');
    const typed = reviewer.getByRole('dialog', { name: 'Suggest a change' });
    await expect(typed.getByLabel('Suggested text')).toHaveValue('n');
    await reviewer.keyboard.press('Escape');
    await expect(typed).toBeHidden();
    await expect(reviewer.locator('.cm-content')).toContainText('is referenced by its label');

    await selectWords(reviewer, '.pdf-page .textLayer', 'short summary');
    await bar.getByRole('button', { name: 'Suggest a change' }).click();
    const suggest = reviewer.getByRole('dialog', { name: 'Suggest a change' });
    await expect(suggest.getByLabel('Suggested text')).toHaveValue('short summary');
    await suggest.getByLabel('Suggested text').fill('brief summary');
    await reviewer.keyboard.press('Enter');
    await expect(reviewer.locator('.cm-rv-del')).toHaveText('short');
    await expect(reviewer.locator('.cm-rv-ins')).toHaveText('brief');
    await expect(reviewer.locator('.pdf-rv-pin')).toHaveCount(2);

    await reviewer.getByRole('button', { name: 'Send comments back' }).first().click();
    const back = reviewer.getByRole('dialog', { name: 'Send your comments back' });
    const returned = reviewer.waitForEvent('download');
    await back.getByRole('button', { name: 'Download comments' }).click();
    const comments = testInfo.outputPath('comments.scribetex');
    await (await returned).saveAs(comments);
    await other.close();

    // The author takes them in: each shows where it was made, and the suggestion can be accepted.
    await page.locator('input[type=file][accept=".scribetex"]').setInputFiles(comments);
    await expect(page.getByText('2 new comments and suggestions from Prof. Weber added.')).toBeVisible();
    await expect(page.locator('.rv-card')).toHaveCount(2);
    await expect(page.locator('.cm-rv-comment')).toHaveText('Start writing here');
    await expect(page.locator('.pdf-rv-pin')).toHaveCount(2);
    await page.locator('.rv-card', { hasText: 'brief' }).getByRole('button', { name: 'Accept' }).click();
    await expect(page.locator('.cm-content')).toContainText('A brief summary of the article.');
    await expect(page.locator('.rv-card')).toHaveCount(1);

    // The same file again adds nothing.
    await page.locator('input[type=file][accept=".scribetex"]').setInputFiles(comments);
    await expect(page.getByText('Nothing new: everything in this file was already here.')).toBeVisible();
  });

  // The community templates need packages that only the full engine build has
  // (engine/extra-packages.txt); without them, a template is skipped here.
  const community = JSON.parse(fs.readFileSync(path.join(root, 'public/templates/index.json'), 'utf8')) as {
    templates: { name: string; packages: string[] }[];
  };
  const packagesFile = path.join(root, 'dist/engine/packages/index.json');
  const installed = new Set(
    fs.existsSync(packagesFile) ? (JSON.parse(fs.readFileSync(packagesFile, 'utf8')) as { name: string }[]).map((entry) => entry.name) : [],
  );
  for (const template of community.templates) {
    const missing = template.packages.filter((name) => !installed.has(name));
    test(`compiles the community template ${template.name}`, async ({ page }) => {
      test.skip(missing.length > 0, `needs ${missing.join(', ')}`);
      await start(page);
      await createFromCommunity(page, template.name, template.name);
      await expect(row(page, 'TEMPLATE-LICENSE.txt')).toBeVisible();
      const status = page.locator('.statusbar');
      await expect(status).toContainText(/Compiled in|The last compile failed/, { timeout: 240_000 });
      // A failed compile shows no PDF. Its problems go into the report, so the
      // workflow log says what is missing instead of only "no PDF".
      if (!(await status.innerText()).includes('Compiled in')) {
        await status.locator('button').first().click();
        expect(await page.locator('.problem').allInnerTexts(), `problems of ${template.name}`).toEqual([]);
      }
      await expect(page.locator('.pdf-page canvas').first()).toBeVisible();
      await expect(status).not.toContainText(/\b[1-9]\d* errors?\b/);
    });
  }
});

test.describe('in browsers of different ages', () => {
  test('shows no update tip in an up-to-date browser', async ({ page }) => {
    await start(page);
    await createProject(page, 'Up to date', 'Blank');
    await expect(page.locator('.cm-content')).toBeVisible();
    await expect(page.getByText('a few updates behind')).toHaveCount(0);
  });

  test.describe('a few updates behind', () => {
    // Safari before 26.2 lacks some of these features, and older versions lack
    // all of them. Removing them shows what such a browser gets: the legacy
    // build of pdf.js (src/ui/pdf/pdfjs.ts) and a tip to update.
    const remove = [
      'for (const C of [Map, WeakMap]) { delete C.prototype.getOrInsert; delete C.prototype.getOrInsertComputed; }',
      'delete Math.sumPrecise; delete Promise.try; delete URL.parse; delete globalThis.Iterator;',
      'for (const name of ["fromBase64", "fromHex"]) delete Uint8Array[name];',
      'for (const name of ["toBase64", "toHex", "setFromBase64", "setFromHex"]) delete Uint8Array.prototype[name];',
      'for (const name of ["union", "intersection", "difference", "symmetricDifference", "isSubsetOf", "isSupersetOf", "isDisjointFrom"]) delete Set.prototype[name];',
    ].join('\n');
    test.use({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15' });

    test('draws the PDF all the same and suggests updating Safari', async ({ page }) => {
      test.skip(!engineReady, 'run "npm run engine:prepare" and build first');
      test.setTimeout(300_000);
      await page.addInitScript(remove);
      // The worker of pdf.js runs on its own, so it loses the features too.
      await page.route(/pdf\.worker[^/]*\.mjs/, async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, body: `${remove}\n${await response.text()}` });
      });
      await start(page);
      await createProject(page, 'Older Safari', 'CV');
      await expect(page.locator('.pdf-page canvas').first()).toBeVisible({ timeout: 240_000 });
      await expect(page.locator('.pdf-trouble')).toHaveCount(0);

      const tip = page.getByRole('status').filter({ hasText: 'this version of Safari is a few updates behind' });
      await expect(tip).toContainText('update Safari or open scribeTeX in Chrome or Edge');
      await expect(tip.getByRole('link', { name: 'Get Chrome' })).toHaveAttribute('href', 'https://www.google.com/chrome/');
      await tip.getByRole('button', { name: 'Dismiss the tip' }).click();
      await expect(tip).toBeHidden();

      // Dismissed for good: not shown again after a reload.
      await page.reload();
      await expect(page.locator('.topbar .title')).toHaveText('Older Safari');
      await expect(page.locator('.pdf-page canvas').first()).toBeVisible({ timeout: 240_000 });
      await expect(tip).toHaveCount(0);
    });
  });
});
