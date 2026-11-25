#!/usr/bin/env node
/**
 * Writes public/licenses/THIRD-PARTY-NOTICES.txt: the licence of every npm
 * package whose code or fonts end up in the built site, with the full text
 * each package ships. The list is read from package-lock.json, so it follows
 * the installed versions by itself. Runs before every build.
 *
 * The compile engine under public/engine is not an npm package. It is
 * described in public/engine/SOURCE.md, which the build publishes next to it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public/licenses/THIRD-PARTY-NOTICES.txt');
const LICENCE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i;

const MIT_TERMS = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));

function repositoryUrl(pkg) {
  const raw = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (!raw) return pkg.homepage ?? '';
  return raw
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^github:/, 'https://github.com/')
    .replace(/\.git$/, '');
}

const entries = [];
const problems = [];
for (const [key, meta] of Object.entries(lock.packages)) {
  // Development tools and platform-specific optional binaries are not part of the site.
  if (!key.startsWith('node_modules/') || meta.dev || meta.devOptional || meta.optional) continue;
  const dir = path.join(ROOT, key);
  if (!fs.existsSync(dir)) {
    problems.push(`${key} is in package-lock.json but not installed. Run "npm ci" first.`);
    continue;
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const licence = pkg.license ?? meta.license;
  if (!licence) problems.push(`${pkg.name} does not state a licence.`);
  const texts = fs
    .readdirSync(dir)
    .filter((name) => LICENCE_FILE.test(name) && fs.statSync(path.join(dir, name)).isFile())
    .sort()
    .map((name) => fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n').trim());
  if (texts.length === 0) {
    // A package that only names its licence in package.json still needs the notice the licence asks for.
    const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name;
    if (licence === 'MIT' && author) texts.push(`Copyright (c) ${author}\n\n${MIT_TERMS}\n\n(This package ships no licence file. The text above is the MIT licence that its package.json names.)`);
    else problems.push(`${pkg.name} ships no licence file, and none can be written for "${licence}" from its package.json.`);
  }
  entries.push({ name: pkg.name, version: pkg.version, licence, url: repositoryUrl(pkg), texts });
}

if (problems.length > 0) {
  console.error(problems.map((line) => `[notices] ${line}`).join('\n'));
  process.exit(1);
}

entries.sort((a, b) => a.name.localeCompare(b.name));
const rule = '='.repeat(78);
const header = `THIRD-PARTY NOTICES

This site is a LaTeX editor that runs in the browser. Its own code is under the
MIT licence.
It also contains the software and fonts listed below, each under its own licence.

The LaTeX engine that compiles the documents is separate from all of this: it
is served unchanged from the "engine" folder of this site. What it consists of,
its licences and where its source code can be downloaded is written down in
engine/SOURCE.md. The licence texts that apply to it are in this folder:
GPL-2.0-or-later.txt, LGPL-2.1-or-later.txt and LPPL-1.3c.txt. The fonts of the
editor itself are under OFL-1.1.txt.

Packages: ${entries.map((entry) => entry.name).join(', ')}
`;

const body = entries
  .map((entry) => `${rule}\n${entry.name} ${entry.version}\nLicence: ${entry.licence}${entry.url ? `\nSource: ${entry.url}` : ''}\n${rule}\n\n${entry.texts.join('\n\n')}\n`)
  .join('\n');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${header}\n${body}`);
console.log(`[notices] ${entries.length} packages written to ${path.relative(ROOT, OUT)}`);
