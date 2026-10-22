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
  report?: (note?: string) => Promise<{ file: string; at: string; text: string }>;
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
  status: { name: string; status: string; error: string | null; tools: string[]; trusted: boolean; offered?: number }[];
}

export interface McpBridge {
  get: () => Promise<McpState>;
  save: (text: string) => Promise<McpState>;
  reconnect: () => Promise<McpState>;
}

export interface TelegramState {
  running: boolean;
  bot: string | null;
  error: string | null;
  pending: { id: string; name: string; at: number }[];
  allowed: string[];
}

export interface TelegramBridge {
  state: () => Promise<TelegramState>;
  pair: (chatId: string, allow: boolean) => Promise<TelegramState>;
  test: () => Promise<boolean>;
  onState: (cb: (s: TelegramState) => void) => () => void;
}

export interface VoiceBridge {
  onTranscribe: (cb: (job: { id: string; bytes: string; mime: string }) => void) => () => void;
  result: (id: string, text: string, error?: string | null) => Promise<boolean>;
  /** 16 kHz mono samples -> text, on this machine's whisper.cpp (electron/whisper.cjs) */
  local?: (samples: Float32Array) => Promise<string>;
  /** where whisper.cpp was found, or why not */
  where?: () => Promise<{ bin?: string; model?: string; error?: string }>;
}

export type ProviderId = 'anthropic' | 'openai' | 'google';

export interface IntegrationsState {
  providers: { id: ProviderId; label: string; hasKey: boolean; key: string; model: string }[];
  capture: boolean;
  kernel: { command: string; args: string[] } | null;
  apps: { id: string; label: string; file: string; connected: boolean }[];
  claudeCode: string | null;
}

export interface ProviderChatRequest {
  provider: ProviderId;
  model?: string;
  system?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  /** what to keep as the question in the capture note (default: the last user message) */
  question?: string;
}

export interface ArchiveProgress {
  started: string | false;
  updated?: string | null;
  written?: string | null;
  notes_done?: number;
  notes_total?: number;
  finished?: boolean;
  chunks?: number;
  failed_chunks?: number;
  topics?: number;
  decisions?: number;
  ideas?: number;
  threads_open?: number;
  events?: number;
  errors?: string[];
}

export interface ArchiveStatus {
  sources: string[];
  raw_notes: number;
  distill: ArchiveProgress;
}

export interface ArchiveState {
  job: 'digging' | 'distilling' | 'writing' | null;
  pausing: boolean;
  status: ArchiveStatus | null;
  error: string | null;
  last: { job: string; at: string; out: unknown } | null;
}

export interface ArchiveSettings {
  python: string;
  cli: string;
  model: string;
  found: string | null;
  state: ArchiveState;
}

export interface ShareState {
  enabled: boolean;
  writes: boolean;
  url: string;
  key: string;
}

export interface AtlasOptions {
  exe: string;
  ground: string;
  python?: string;
  engine?: boolean;
  trusted?: boolean;
  all?: boolean;
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
  telegram?: TelegramBridge;
  voice?: VoiceBridge;
  share?: { get: (reveal?: boolean) => Promise<ShareState>; set: (patch: { enabled?: boolean; writes?: boolean; rotate?: boolean }) => Promise<ShareState> };
  atlas?: { connect: (opts: AtlasOptions) => Promise<McpState> };
  integrations?: {
    get: () => Promise<IntegrationsState>;
    set: (provider: ProviderId | 'capture', patch: { key?: string; model?: string } | boolean) => Promise<IntegrationsState>;
    models: (provider: ProviderId) => Promise<string[]>;
    chat: (id: string, req: ProviderChatRequest) => Promise<{ text: string; model: string }>;
    stop: (id: string) => Promise<void>;
    connectApp: (app: string) => Promise<IntegrationsState & { wrote: { file: string; backup: string | null } }>;
    onChunk: (cb: (c: { id: string; text: string }) => void) => () => void;
  };
  archive?: {
    get: () => Promise<ArchiveSettings>;
    set: (patch: { python?: string; cli?: string; model?: string }) => Promise<ArchiveSettings>;
    status: () => Promise<ArchiveStatus>;
    sources: (change?: { add?: string; remove?: string }) => Promise<string[]>;
    dig: () => Promise<unknown>;
    distill: (opts?: { restart?: boolean }) => Promise<ArchiveProgress>;
    write: () => Promise<unknown>;
    pause: () => Promise<void>;
    stop: () => Promise<void>;
    onState: (cb: (s: ArchiveState) => void) => () => void;
  };
  computer?: { models: () => Promise<string[]> };
  pick?: (kind: 'file' | 'folder' | 'exe', title: string) => Promise<string | null>;
}

declare global {
  interface Window {
    secondbrainDesktop?: DesktopBridge;
  }
}
