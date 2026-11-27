import type { Path } from '../core/types';

/** A file in a template: text, or bytes made when the project is created (pictures). */
export type TemplateFile = { path: Path; text: string } | { path: Path; bytes: () => Uint8Array };

export interface Template {
  id: string;
  name: string;
  description: string;
  mainFile: Path | null;
  files: TemplateFile[];
  /** Empty folders to create, for files the user adds later. */
  dirs?: Path[];
}
