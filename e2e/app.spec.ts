import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';

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
    await expect(page.locator('.statusbar')).toContainText(/[1-9]\d* errors?,/, { timeout: 120_000 });
    await expect(page.getByText('Showing the last version that compiled')).toBeVisible();
    await page.locator('.statusbar button').first().click();
    await expect(page.locator('.problem').first()).toContainText('main.tex:1');
  });
});
