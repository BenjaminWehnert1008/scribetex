/**
 * Shared domain types. This file has no runtime code and no imports, so every
 * module (core, workers, UI, tests) can depend on it.
 */

/** Opaque, URL-safe project identifier (lowercase letters and digits). */
export type ProjectId = string;

/**
 * A normalized project-relative POSIX path: forward slashes, no leading or
 * trailing slash, no empty, "." or ".." segments, Unicode NFC.
 * The project root itself is the empty string. Build values with `paths.ts`.
 */
export type Path = string;

/** Milliseconds since the Unix epoch. */
export type Millis = number;

/** Lowercase hex SHA-256 of a file's bytes. */
export type Hash = string;

export type TexEngine = 'pdflatex' | 'xelatex' | 'lualatex';

/** How the bibliography tool is chosen. `auto` inspects the sources and the .aux/.bcf files. */
export type BibMode = 'auto' | 'bibtex' | 'biber' | 'off';

export interface FolderLink {
  /** Name of the linked directory (the handle's `name`), for display only. */
  folderName: string;
  linkedAt: Millis;
  /** Completion time of the last sync pass that ended with nothing pending. */
  lastSyncAt: Millis | null;
  /** Also write the compiled PDF next to the main file in the linked folder. */
  writePdf: boolean;
}

export interface ProjectMeta {
  id: ProjectId;
  name: string;
  createdAt: Millis;
  /** Last change to any file or to the project settings. */
  updatedAt: Millis;
  lastOpenedAt: Millis;
  /** Root .tex file. `null` means "detect automatically". */
  mainFile: Path | null;
  engine: TexEngine;
  bib: BibMode;
  /** Recompile automatically after edits settle. */
  autoCompile: boolean;
  /** Present when the project is anchored to a folder on disk. */
  link: FolderLink | null;
  /** Last time the user downloaded a ZIP backup of this project. */
  lastExportAt: Millis | null;
  /** Denormalized totals for the project list. */
  fileCount: number;
  totalBytes: number;
}

export type EntryKind = 'file' | 'dir';

/** Metadata of one file or directory in the vault (content is stored separately). */
export interface FileEntry {
  projectId: ProjectId;
  path: Path;
  kind: EntryKind;
  /** Size in bytes; 0 for directories. */
  size: number;
  /** Last modification inside the vault. */
  mtime: Millis;
  /** Content hash; `null` for directories. */
  hash: Hash | null;
  /** True when the bytes are valid UTF-8 text that the editor may open. */
  text: boolean;
}

/** Who caused a vault change. Consumers use it to avoid feedback loops. */
export type ChangeOrigin =
  | 'editor' // autosave of an open buffer
  | 'ui' // file tree actions: create, rename, move, delete, upload
  | 'folder' // pulled in from the linked folder on disk
  | 'restore' // snapshot restore
  | 'import' // ZIP import or template
  | 'journal'; // crash-recovery replay at startup

export type VaultChange =
  | { type: 'write'; projectId: ProjectId; path: Path; entry: FileEntry; origin: ChangeOrigin }
  | { type: 'mkdir'; projectId: ProjectId; path: Path; entry: FileEntry; origin: ChangeOrigin }
  | { type: 'remove'; projectId: ProjectId; paths: Path[]; origin: ChangeOrigin }
  | { type: 'move'; projectId: ProjectId; from: Path; to: Path; origin: ChangeOrigin }
  /** Many paths changed at once (restore, import). Consumers should reload the tree. */
  | { type: 'bulk'; projectId: ProjectId; origin: ChangeOrigin }
  | { type: 'project'; projectId: ProjectId; project: ProjectMeta | null };

export type SnapshotReason =
  | 'manual' // user pressed "Create snapshot"
  | 'auto' // periodic, while editing
  | 'session-start' // first change after opening the project
  | 'before-restore'
  | 'before-import'
  | 'before-folder-pull' // disk changes are about to overwrite or delete vault files
  | 'before-delete' // user is deleting files or folders
  | 'before-link'; // a folder is about to be linked or unlinked

export interface SnapshotFile {
  path: Path;
  kind: EntryKind;
  hash: Hash | null;
  size: number;
  text: boolean;
}

export interface SnapshotMeta {
  id: string;
  projectId: ProjectId;
  createdAt: Millis;
  reason: SnapshotReason;
  /** User-given name; snapshots with a label or `pinned` are never pruned. */
  label: string | null;
  pinned: boolean;
  fileCount: number;
  totalBytes: number;
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

/** One problem extracted from the TeX log. */
export interface Diagnostic {
  severity: DiagnosticSeverity;
  message: string;
  /** Project path of the file, when the log allows it to be attributed. */
  file: Path | null;
  /** 1-based line number in `file`. */
  line: number | null;
  /** Source excerpt TeX printed after "l.NN", when there was one. */
  context: string | null;
  /** The log excerpt this diagnostic was built from. */
  raw: string;
}

/** A file handed to the compile engine. */
export interface CompileFile {
  path: Path;
  bytes: Uint8Array;
}
