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
  | { sessionId: string; type: 'thinking'; text: string }
  | { sessionId: string; type: 'delta'; text: string }
  | { sessionId: string; type: 'answer'; text: string }
  | { sessionId: string; type: 'check'; text: string }
  | { sessionId: string; type: 'error'; text: string }
  | { sessionId: string; type: 'done' };

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  name: string;
  args: Record<string, unknown>;
  summary: string;
  /** 'review': the improvement loop's review (Allow keeps the change, Deny drops it); never Always */
  kind?: 'review';
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
  /** a card answered anywhere: it leaves every view */
  onAnswered?: (cb: (done: { id: string; sessionId: string }) => void) => () => void;
  onShow?: (cb: (sessionId: string) => void) => () => void;
}

export interface ScheduleView {
  id: string;
  name: string;
  prompt: string;
  whenText: string;
  whenLabel: string;
  deliver: string[];
  /** 'steward': the prompt goes to Steward as an automation's turn; 'local' (or absent): the local agent loop */
  backend?: 'local' | 'steward';
  /** a workflow (electron/agent/workflows.cjs): its steps, from the fixed list, and the one Steward turn's prompt */
  steps?: (string | { step: string; [arg: string]: unknown })[];
  summarize?: string;
  /** a workflow parked on eval_wait: the eval run it waits for */
  pending?: { tag?: string; label?: string; until: number } | null;
  /** tags: "example" marks the Flows shelf's built-in examples (electron/agent/flowExamples.cjs) */
  tags?: string[];
  enabled: boolean;
  next: number | null;
  lastRun: number | null;
  lastResult: string | null;
  running?: boolean;
}

/** A new schedule, or (Partial) a change to one: the when is plain text, parsed by schedules.cjs parseWhen. */
export interface ScheduleSpec {
  name: string;
  prompt: string;
  /** empty: no schedule, it runs only on Run now */
  when: string;
  tags?: string[];
  deliver?: string[];
  backend?: 'local' | 'steward';
  steps?: (string | { step: string; [arg: string]: unknown })[];
  summarize?: string;
}

export interface SchedulesBridge {
  list: () => Promise<ScheduleView[]>;
  add: (spec: ScheduleSpec) => Promise<ScheduleView[]>;
  update: (id: string, patch: { enabled?: boolean }) => Promise<ScheduleView[]>;
  /** a change from the Flows shelf's Set up panel: only the fields given, checked as add checks them */
  edit?: (id: string, spec: Partial<ScheduleSpec>) => Promise<ScheduleView[]>;
  /** whether any conversation is mid-turn now (Steward busy) */
  busy?: () => Promise<boolean>;
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

/** Discord (electron/agent/discord.cjs): the same shape; `allowed` holds paired user ids. */
export type DiscordState = TelegramState;
export type DiscordBridge = TelegramBridge;

/** WhatsApp (electron/agent/whatsapp.cjs): his own account linked as a device; `allowed` holds approved chat ids. */
export interface WhatsAppState {
  running: boolean;
  connected: boolean;
  /** a link's keys are kept (it reconnects without a QR) */
  linked: boolean;
  /** his number once linked */
  bot: string | null;
  /** the QR code to scan (a data: URL), while one is shown */
  qr: string | null;
  error: string | null;
  /** answered in his own "Message yourself" chat */
  selfChat: boolean;
  pending: { id: string; name: string; number?: string | null; at: number }[];
  allowed: string[];
}

export interface WhatsAppBridge {
  state: () => Promise<WhatsAppState>;
  pair: (chatId: string, allow: boolean) => Promise<WhatsAppState>;
  test: () => Promise<boolean>;
  unlink: () => Promise<WhatsAppState>;
  onState: (cb: (s: WhatsAppState) => void) => () => void;
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

/** A phone channel; all three are wired. */
export type PhoneChannel = 'telegram' | 'whatsapp' | 'discord';

/** One line of a phone conversation (electron/agent/phone.cjs): what was said, a card, or its answer. */
export interface PhoneEntry {
  at: string;
  channel: PhoneChannel;
  chatId: string;
  title?: string;
  sessionId?: string | null;
  kind: 'user' | 'reply' | 'card' | 'answer';
  text: string;
  cardId?: string;
  name?: string;
  answer?: string;
  where?: string;
}

/** One phone conversation in the Phone view's list. */
export interface PhoneConversation {
  channel: PhoneChannel;
  chatId: string;
  title: string;
  label: string;
  at: string;
  last: string;
}

export interface PhoneBridge {
  list: () => Promise<PhoneConversation[]>;
  /** a conversation's lines, newest first, and the card ids still waiting */
  read: (channel: PhoneChannel, chatId: string) => Promise<{ entries: PhoneEntry[]; open: string[] }>;
  onEntry: (cb: (e: PhoneEntry) => void) => () => void;
}

export interface DesktopBridge {
  phone?: PhoneBridge;
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
  discord?: DiscordBridge;
  whatsapp?: WhatsAppBridge;
  voice?: VoiceBridge;
  share?: { get: (reveal?: boolean) => Promise<ShareState>; set: (patch: { enabled?: boolean; writes?: boolean; rotate?: boolean }) => Promise<ShareState> };
  atlas?: {
    connect: (opts: AtlasOptions) => Promise<McpState>;
    /** launch the Atlas web app in its own window, starting Atlas when it is not running */
    open?: () => Promise<{ url?: string; window?: string; error?: string }>;
  };
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
  /** the door's git and hold tools, as the operator: the GitHub shelf's hand (door:call) */
  door?: {
    call: (name: string, args?: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
  };
  pick?: (kind: 'file' | 'folder' | 'exe', title: string) => Promise<string | null>;
  /** Steward's button (electron/agent/system.cjs): the pieces he runs on, and what he works with */
  steward?: {
    status: () => Promise<StewardStatus>;
    uses: () => Promise<StewardUses>;
    /** Start, stop or restart his service, his MCP door, or both */
    control: (piece: StewardControlPiece, action: 'start' | 'stop' | 'restart') => Promise<StewardControlResult>;
  };
  /** The Services window's Servers shelf: every server SecondBrain runs or watches, with start, stop, restart and its log */
  services?: ServicesBridge;
  /** The Services window's Approvals shelf: open cards of both planes, Always allow, Steward's tool policy */
  approvals?: ApprovalsBridge;
  /** The Agent tab's console (electron/console.cjs): Steward's evals, runs, skills and memory, read from his folder */
  stewardConsole?: StewardConsoleBridge;
}

export interface EvalRun {
  ts: string;
  set: string;
  passed: number;
  total: number;
  checksPassed: number;
  checksTotal: number;
  model: string;
  gitHead: string;
  exitCode: number | null;
  cases: { input: string; passed: boolean; failed: { name: string; reason: string }[] }[];
  /** a steps run's CHECK and REPAIR progress lines, in order ("checking: pytest -q ...", "check failed", "repair attempt 1/3") */
  progress: string[];
}

export interface EvalsView {
  file: string;
  history: EvalRun[];
  /** eval_baselines.json as he writes it: { set: { checks, of, from } } */
  baseline: unknown;
  baselineError?: string;
}

export interface TraceRun {
  traceId: string;
  start: string;
  end: string;
  root: string;
  spans: number;
  tools: { at: string; name: string; args: string; ok: boolean }[];
  errors: { name: string; message: string }[];
}

export interface RunsView {
  file: string;
  /** the traces file's size, and how much of its end was read */
  size: number;
  read: number;
  runs: TraceRun[];
  background: number;
  backgroundErrors: number;
}

export interface SkillInfo {
  folder: string;
  name: string;
  description: string;
}

export interface MemoryFile {
  path: string;
  size: number;
}

export interface StewardConsoleBridge {
  evals: () => Promise<EvalsView>;
  runs: () => Promise<RunsView>;
  skills: () => Promise<{ skills: SkillInfo[] }>;
  memory: () => Promise<{ files: MemoryFile[] }>;
  /** one memory file's text, by its path from memory() */
  memoryRead: (path: string) => Promise<{ path: string; size: number; text: string; cut: boolean }>;
}

/** One open card: the Agent tab's (answered with agent.approve) or the door's hold (answered with door.call). */
export type ApprovalItem =
  | { plane: 'agent'; id: string; tool: string; sessionId: string; summary: string; args: Record<string, unknown>; at: number; kind?: 'review' }
  | { plane: 'door'; id: string; tool: string; project: string; caller: string; when: string; args: Record<string, unknown>; at: number };

/** A standing Always allow: one tool with the exact text its card showed (for Steward's cards, its exact arguments). */
export interface AlwaysEntry {
  key: string;
  name: string;
  summary: string;
  at: number;
}

export type ToolApproval = 'always' | 'never' | 'rule';

export type ToolPolicy =
  | { state: 'absent'; file: string | null }
  | { state: 'malformed'; file: string; error: string }
  | { state: 'ok'; file: string; ts: string | null; tools: { name: string; source: string; approval: ToolApproval; notes?: string }[] };

export interface ApprovalsBridge {
  /** every open card, newest first; doorError when the door's could not be read */
  list: () => Promise<{ items: ApprovalItem[]; doorError?: string }>;
  always: () => Promise<AlwaysEntry[]>;
  /** forget one entry by its key, or all when no key is given; the entries left */
  reset: (key?: string) => Promise<AlwaysEntry[]>;
  /** Steward's storage/tool-policy.json, read only */
  policy: () => Promise<ToolPolicy>;
  /** the answered cards, newest first (at most 200) */
  history: (limit?: number) => Promise<AnsweredCard[]>;
}

/** One answered card, as approvals-history.jsonl keeps it. */
export interface AnsweredCard {
  id: string;
  tool: string;
  summary: string;
  answer: 'allow' | 'always' | 'deny' | 'timeout' | 'keep' | 'drop' | 'guidance';
  where: 'window' | 'telegram' | 'discord' | 'whatsapp';
  time: string;
}

export type ServiceKind = 'owned' | 'external';

export type ServiceStatus = 'up' | 'down' | 'starting' | 'held';

export interface ServiceInfo {
  id: string;
  label: string;
  port: number | null;
  /** owned: SecondBrain runs it; external: something else does (Ollama's own app) */
  kind: ServiceKind;
  status: ServiceStatus;
  canControl: boolean;
  /** why a control would be refused, when it would */
  why?: string;
  /** why a server SecondBrain keeps up is no longer started again (five quick deaths), until Start */
  error?: string;
  settings?: Record<string, unknown>;
  logPath?: string | null;
  /** the process SecondBrain runs it as, and since when (null when it runs none) */
  pid?: number | null;
  started?: string | null;
}

export interface ServicesBridge {
  list: () => Promise<ServiceInfo[]>;
  control: (id: string, action: 'start' | 'stop' | 'restart') => Promise<{ ok: boolean; error?: string }>;
  /** the last `lines` lines of its log */
  log: (id: string, lines: number) => Promise<{ ok: true; file: string | null; text: string } | { ok: false; error: string }>;
}

export type StewardControlPiece = 'service' | 'mcp' | 'all';

export interface StewardControlResult {
  errors: string[];
  status: StewardStatus;
}

export interface StewardPiece {
  id: string;
  label: string;
  port: number;
  what: string;
  up: boolean;
}

export interface StewardStatus {
  /** his service and the door both answer */
  ready: boolean;
  pieces: StewardPiece[];
  /** the models Ollama has loaded now */
  models: string[];
}

export interface StewardUses {
  /** SecondBrain's /mcp is on (Settings → Share) */
  shareOn: boolean;
  tools: string[];
  skillNotes: string[];
  fileSkills: string[];
  workspace: string;
}

declare global {
  interface Window {
    secondbrainDesktop?: DesktopBridge;
  }
}
