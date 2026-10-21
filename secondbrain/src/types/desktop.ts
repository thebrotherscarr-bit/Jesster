import { Note } from './index.ts';

/** What the desktop shell (electron/preload.cjs) offers the page. */
export interface VaultBridge {
  info: () => Promise<{ dir: string }>;
  load: () => Promise<Note[]>;
  save: (note: Note) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  reveal: () => Promise<string>;
  choose: () => Promise<{ dir: string; changed: boolean }>;
  importFiles: (paths?: string[]) => Promise<{
    imported: { id: string; title: string }[];
    skipped: { file: string; why: string }[];
  }>;
  pathForFile: (file: File) => string;
  onChanged: (cb: () => void) => () => void;
}

export interface DesktopBridge {
  version: () => Promise<{ build: number; commit: string } | null>;
  checkUpdate: () => Promise<{
    current: { build: number; commit: string };
    latest: { build: number; title: string } | null;
    available: boolean;
    canApply: boolean;
  }>;
  applyUpdate: () => Promise<{ updated: boolean; detail?: string }>;
  vault?: VaultBridge;
}

declare global {
  interface Window {
    secondbrainDesktop?: DesktopBridge;
  }
}
