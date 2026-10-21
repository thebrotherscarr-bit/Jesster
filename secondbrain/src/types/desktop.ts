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

export interface InboxStatus {
  clone: string | null;
  every: number;
  running: boolean;
  error: string | null;
  last: { pulled: string | null; filed: { id: string; title: string }[]; skipped: { file: string; why: string }[]; at: string } | null;
}

export type SettingsData = Record<string, Record<string, unknown>> & {
  inbox: { clone: string | null; every: number };
};

export interface SettingsBridge {
  get: () => Promise<SettingsData>;
  set: (section: string, value: Record<string, unknown>) => Promise<SettingsData>;
}

export interface InboxBridge {
  status: () => Promise<InboxStatus>;
  sync: () => Promise<InboxStatus>;
  connect: () => Promise<InboxStatus>;
  disconnect: () => Promise<InboxStatus>;
  onStatus: (cb: (s: InboxStatus) => void) => () => void;
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
  settings?: SettingsBridge;
  inbox?: InboxBridge;
}

declare global {
  interface Window {
    secondbrainDesktop?: DesktopBridge;
  }
}
