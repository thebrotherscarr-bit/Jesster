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

export type AgentEvent =
  | { sessionId: string; type: 'user'; text: string; source: string }
  | { sessionId: string; type: 'step'; step: number }
  | { sessionId: string; type: 'tool'; name: string; args: Record<string, unknown> }
  | { sessionId: string; type: 'result'; name: string; text: string }
  | { sessionId: string; type: 'answer'; text: string }
  | { sessionId: string; type: 'error'; text: string }
  | { sessionId: string; type: 'done' };

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  name: string;
  args: Record<string, unknown>;
  summary: string;
}

export interface AgentBridge {
  send: (text: string, sessionId?: string | null, model?: { host: string; model: string } | null) => Promise<{ sessionId: string }>;
  sessions: () => Promise<{ id: string; title: string; updatedAt: number; source?: string }[]>;
  open: (id: string) => Promise<{ sessionId: string; busy: boolean; messages: { role: string; content: string }[] }>;
  stop: (id: string) => Promise<boolean>;
  approve: (id: string, allow: boolean, always?: boolean) => Promise<boolean>;
  tools: () => Promise<{ name: string; description: string }[]>;
  onEvent: (cb: (e: AgentEvent) => void) => () => void;
  onApproval: (cb: (r: ApprovalRequest) => void) => () => void;
}

export interface ScheduleView {
  id: string;
  name: string;
  prompt: string;
  whenText: string;
  whenLabel: string;
  deliver: string[];
  enabled: boolean;
  next: number | null;
  lastRun: number | null;
  lastResult: string | null;
  running?: boolean;
}

export interface SchedulesBridge {
  list: () => Promise<ScheduleView[]>;
  add: (spec: { name: string; prompt: string; when: string; deliver?: string[] }) => Promise<ScheduleView[]>;
  update: (id: string, patch: { enabled?: boolean }) => Promise<ScheduleView[]>;
  remove: (id: string) => Promise<ScheduleView[]>;
  run: (id: string) => Promise<{ note: string; ok: boolean; schedules: ScheduleView[] }>;
}

export interface McpState {
  config: string;
  file: string;
  status: { name: string; status: string; error: string | null; tools: string[]; trusted: boolean }[];
}

export interface McpBridge {
  get: () => Promise<McpState>;
  save: (text: string) => Promise<McpState>;
  reconnect: () => Promise<McpState>;
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
  agent?: AgentBridge;
  schedules?: SchedulesBridge;
  mcp?: McpBridge;
}

declare global {
  interface Window {
    secondbrainDesktop?: DesktopBridge;
  }
}
