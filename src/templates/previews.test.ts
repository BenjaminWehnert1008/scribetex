import { describe, expect, it } from 'vitest';
import { TEMPLATES } from './index';
import { builtInPreview, templateFingerprint } from './previews';
import recorded from './previews/previews.json';

const entries: Record<string, { fingerprint: string; picture: boolean } | undefined> = recorded;

describe('pictures of the built-in templates', () => {
  it('has a picture of every template but Blank, whose page is empty', () => {
    for (const template of TEMPLATES) expect(builtInPreview(template.id) !== null, template.id).toBe(template.id !== 'blank');
  });

  it('shows the current version of every template', async () => {
    expect(Object.keys(entries)).toEqual(TEMPLATES.map((template) => template.id));
    for (const template of TEMPLATES) {
      const entry = entries[template.id];
      expect(entry?.fingerprint, `The picture of ${template.name} shows an older version: run npm run previews`).toBe(await templateFingerprint(template));
      expect(entry?.picture, template.id).toBe(builtInPreview(template.id) !== null);
    }
  });
});
