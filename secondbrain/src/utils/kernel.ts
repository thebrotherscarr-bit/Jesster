import { Note, NoteCategory } from '../types/index.ts';

/**
 * Jesster notes kernel bridge.
 *
 * When this app is served by the kernel (`python notes/cli.py serve`), notes
 * live in the kernel's vault as Markdown files and every save is deposited on
 * the vault's provenance chain. Served any other way (Vite dev, Electron), the
 * kernel is absent and the app keeps using localStorage exactly as before.
 */

export type StorageMode = 'detecting' | 'kernel' | 'local' | 'error';

export interface KernelNote {
  id: string;
  title: string;
  body: string;
  tags: string[];
  category: string;
  pinned: boolean;
  created: string;
  updated: string;
  hash: string;
}

export interface SyncedState {
  sig: string;
  hash: string;
}

export type SyncOp =
  | { kind: 'create'; note: Note }
  | { kind: 'update'; note: Note; base: string }
  | { kind: 'remove'; id: string };

const CATEGORIES: NoteCategory[] = ['projects', 'areas', 'resources', 'archives', 'inbox'];
const KERNEL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class KernelError extends Error {
  reason?: string;
  constructor(message: string, reason?: string) {
    super(message);
    this.reason = reason;
  }
}

/** The kernel writes `%z` offsets (+0000); make them ones Date.parse accepts. */
export function kernelTimeToMs(stamp: string): number {
  const iso = (stamp || '').replace(/([+-]\d\d)(\d\d)$/, '$1:$2');
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Date.now();
}

export function fromKernel(n: KernelNote): Note {
  return {
    id: n.id,
    title: n.title,
    content: n.body,
    category: CATEGORIES.includes(n.category as NoteCategory)
      ? (n.category as NoteCategory)
      : 'inbox',
    tags: n.tags,
    isPinned: n.pinned,
    createdAt: kernelTimeToMs(n.created),
    updatedAt: kernelTimeToMs(n.updated),
  };
}

/** What a save changes. Timestamps are left out: the kernel stamps saves. */
export function signature(n: Note): string {
  return JSON.stringify([n.title, n.content, n.category, n.tags, n.isPinned]);
}

export function isKernelId(id: string): boolean {
  return KERNEL_ID.test(id);
}

/** The writes that bring the vault level with what the app holds. */
export function planSync(synced: Map<string, SyncedState>, notes: Note[]): SyncOp[] {
  const ops: SyncOp[] = [];
  const present = new Set<string>();
  for (const note of notes) {
    present.add(note.id);
    const was = synced.get(note.id);
    if (!was) ops.push({ kind: 'create', note });
    else if (was.sig !== signature(note)) ops.push({ kind: 'update', note, base: was.hash });
  }
  for (const id of synced.keys()) {
    if (!present.has(id)) ops.push({ kind: 'remove', id });
  }
  return ops;
}

let seq = 0;

export async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch('rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }),
  });
  if (res.status === 401) throw new KernelError('The kernel needs its access token.', 'token');
  const msg = await res.json();
  if (msg.error) throw new KernelError(msg.error.message, msg.error.data?.reason);
  return msg.result as T;
}

/** True only when this page was served by the notes kernel. */
export async function detectKernel(): Promise<boolean> {
  try {
    const res = await fetch('health', { cache: 'no-store' });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.ok === true && typeof body?.version === 'string';
  } catch {
    return false;
  }
}

export async function loadVault(): Promise<KernelNote[]> {
  return rpc<KernelNote[]>('notes.dump');
}

/**
 * Apply one op. Returns the kernel's id and hash for the note (the id differs
 * from the app's only when the app's id is not a valid kernel id).
 */
export async function applyOp(op: SyncOp): Promise<{ id: string; hash: string } | null> {
  if (op.kind === 'remove') {
    await rpc('notes.remove', { id: op.id });
    return null;
  }
  const n = op.note;
  const fields = {
    title: n.title || 'Untitled Note',
    body: n.content,
    tags: n.tags,
    category: n.category,
    pinned: n.isPinned,
  };
  if (op.kind === 'create') {
    const r = await rpc<{ id: string; hash: string }>('notes.create', {
      ...fields,
      ...(isKernelId(n.id) ? { id: n.id } : {}),
      created: n.createdAt,
      updated: n.updatedAt,
    });
    return { id: r.id, hash: r.hash };
  }
  const r = await rpc<{ id: string; hash: string }>('notes.update', {
    id: n.id,
    base: op.base,
    ...fields,
  });
  return { id: r.id, hash: r.hash };
}

export interface ChainStatus {
  intact: boolean;
  links: number;
  head: string;
  detail: string;
}

export async function chainStatus(): Promise<ChainStatus> {
  return rpc<ChainStatus>('provenance.verify');
}
